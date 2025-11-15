// server/server.js
// Full server.js — preserves original logic + /report-request + email + rate-limit

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import puppeteer from "puppeteer"; // puppeteer-core for custom Chrome path
import OpenAI from "openai";
import rateLimit from "express-rate-limit";
import { analyzeWebsite } from "../lib/analyze.mjs";
import { fileURLToPath } from "url";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "15mb" }));

const FRONTEND = process.env.FRONTEND_URL || "*";
app.use(cors({ origin: FRONTEND }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on("unhandledRejection", (reason) => {
  console.warn("⚠️ Unhandled promise rejection:", reason);
});

// ---------------- TEXT TO HTML ----------------
function textToHTML(text = "") {
  const lines = text.split("\n");
  let html = "";
  let currentSection = "";

  const headings = [
    "Executive Summary",
    "SEO Analysis",
    "Accessibility Review",
    "Performance Review",
    "Social Media & Brand Presence",
    "Visual & Design Assessment",
    "Reputation & Trust Signals",
    "Keyword Strategy",
    "Critical Issues",
    "Actionable Recommendations",
  ];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    const isHeading = headings.find((h) =>
      line.toLowerCase().startsWith(h.toLowerCase())
    );
    if (isHeading) {
      if (currentSection) {
        html += `<div class="section">${currentSection}</div>`;
        currentSection = "";
      }
      currentSection += `<h2>${line}</h2>`;
      continue;
    }

    if (/^- /.test(line)) {
      if (!currentSection.includes("<ul>")) currentSection += "<ul>";
      currentSection += `<li>${line.replace(/^- /, "")}</li>`;
    } else {
      if (currentSection.includes("<ul>")) currentSection += "</ul>";
      line = line.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
      line = line.replace(/\*(.*?)\*/g, "<em>$1</em>");
      currentSection += `<p>${line}</p>`;
    }
  }

  if (currentSection) html += `<div class="section">${currentSection}</div>`;
  return html;
}

// ---------------- CHROME PATH ----------------
function findLocalChrome() {
  try {
    const chromeRoot = path.resolve(process.cwd(), "chrome");
    if (!fs.existsSync(chromeRoot)) return null;

    const entries = fs.readdirSync(chromeRoot, { withFileTypes: true });
    const chromeDir =
      entries.find((e) => e.isDirectory() && e.name === "chrome") ||
      entries.find((e) => e.isDirectory());
    if (!chromeDir) return null;

    const chromeDirPath = path.join(chromeRoot, chromeDir.name);
    const versions = fs
      .readdirSync(chromeDirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    if (versions.length === 0) return null;

    for (const v of versions) {
      const candidate = path.join(
        chromeDirPath,
        v.name,
        "chrome-linux64",
        "chrome"
      );
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  } catch (err) {
    console.warn("findLocalChrome error:", err?.message || err);
    return null;
  }
}

async function launchBrowser() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log("Using CHROME_PATH from env:", envPath);
    return puppeteer.launch({
      executablePath: envPath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }

  const localChrome = findLocalChrome();
  if (localChrome) {
    console.log("Using local chrome at:", localChrome);
    return puppeteer.launch({
      executablePath: localChrome,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }

  try {
    const exe =
      typeof puppeteer.executablePath === "function" &&
      fs.existsSync(puppeteer.executablePath())
        ? puppeteer.executablePath()
        : null;
    if (exe) {
      console.log("Using puppeteer.executablePath():", exe);
      return puppeteer.launch({
        executablePath: exe,
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
    }
  } catch (e) {}
  throw new Error("Could not locate Chrome. Set CHROME_PATH or install Chrome into ./chrome.");
}

// ---------------- SAFETY ANALYSIS ----------------
async function safeAnalyzeWebsite(url) {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const analysis = await analyzeWebsite(normalized);
    if (!analysis) throw new Error("Empty analysis result");
    return analysis;
  } catch (err) {
    console.error("Analysis error:", err);
    return {
      url,
      htmlMetrics: { title: "Analysis Failed", description: "", h1: null, wordCount: 0 },
      metadata: { title: "Analysis Failed", description: "" },
      keywords: [],
      detectedLinks: {},
      socialProfiles: {},
      accessibility: { violations: 0, details: [] },
      visualMetrics: {},
      performance: { performanceScore: 0 },
      reputation: {},
      analyzedAt: new Date().toISOString(),
      error: err?.message || String(err),
    };
  }
}

// ---------------- LLM REPORT GENERATION ----------------
const systemMessage = `
You are a senior digital strategy, marketing, and web audit analyst.
Produce a professional, executive-friendly report based ONLY on the provided JSON.
Purpose: Convert raw website scan data into a clear, persuasive, and actionable digital business snapshot that shows what the business does, its website performance, technologies used, SEO, content, competitors, and overall online presence. The report should help with instant lead generation.

Hard rules:
- Use the exact section headings and order below. Do not add, remove, rename, or reorder headings.
- Each heading must appear on its own line followed by a plain-text paragraph (no bullets, tables, markdown).
- Use only the JSON. Never claim to have visited or crawled the live site or used external sources.
- If you infer any insight not directly present, mark it inline as: INFERRED (confidence: XX%) with a brief explanation if needed.
- Numeric estimates must include value and confidence inline, e.g., (~31, confidence 78%).
- Do not exaggerate performance, traffic, or impact. Be optimistic but accurate within the data and inferences.
- If data completeness < 20% start with: "Partial scan — high uncertainty."
- Keep tone professional, factual, and actionable, suitable for leads.

Sections (exact, in order):
Executive Summary
SEO Analysis
Accessibility Review
Performance Review
Social Media and Brand Presence
Visual and Design Assessment
Reputation and Trust Signals
Keyword Strategy
Critical Issues
Actionable Recommendations
`;


async function generateReportWithData(data) {
  const client = new OpenAI({
    baseURL: process.env.HF_ROUTER_BASEURL || "https://router.huggingface.co/v1",
    apiKey: process.env.OPENAI_API_KEY,
  });

  const model = process.env.HF_MODEL || "moonshotai/Kimi-K2-Instruct-0905:groq";

const userMessage = `
Generate a digital impact and business insight report from the JSON below.
Use only the provided JSON. Do not output raw JSON, bullets, lists, tables, or markdown.
Keep the headings exactly as listed in the system message, each followed by a plain-text paragraph only.
Do not claim external knowledge; base all statements solely on JSON.
If you make inferences, label them inline as INFERRED (confidence: XX%) and provide numeric estimates with confidence inline.
Focus on revealing the business model, products/services, website effectiveness, technology stack, SEO, content, online presence, competitors, and overall digital health. Provide actionable insights for client acquisition and online presence improvement.
Do not exaggerate or make claims beyond what the data and logical inference support.
If data completeness < 20%, start with "Partial scan — high uncertainty."

JSON:
${safeJSON}
`;


  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ],
    max_tokens: 12000,
    temperature: 0.1,
    top_p: 1.0,
    presence_penalty: 0,
    frequency_penalty: 0,
  });

  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned no report text");

  console.log("LLM report preview:", text.substring(0, 200));
  return text;
}

// ---------------- PDF GENERATION ----------------
async function generatePdfFromHtml(finalHtml) {
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "stylesheet", "script"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const encoded = Buffer.from(finalHtml, "utf8").toString("base64");
    await page.goto(`data:text/html;base64,${encoded}`, {
      waitUntil: "load",
      timeout: 60000,
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    await browser.close();
    browser = null;
    return pdfBuffer;
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }
}

// ---------------- EMAIL / LEAD VALIDATION HELPERS ----------------
const forbiddenLocalParts = new Set([
  "support","careers","career","info","admin","contact","webmaster","sales","hello","noreply","no-reply","jobs","hr","team","press","marketing","office","service","services"
]);

function isForbiddenEmailLocalPart(email = "") {
  try {
    const local = email.split("@")[0].toLowerCase();
    return forbiddenLocalParts.has(local);
  } catch { return false; }
}

const freeEmailDomains = new Set([
  "gmail.com","yahoo.com","outlook.com","hotmail.com","live.com","icloud.com","me.com","aol.com","protonmail.com","pm.me","yandex.com","yandex.ru","zoho.com","gmx.com","gmx.de"
]);

function isFreeEmailDomain(email = "") {
  try { return freeEmailDomains.has(email.split("@")[1].toLowerCase()); }
  catch { return false; }
}

// ---------------- RATE LIMITING ----------------
const requestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: "Too many requests. Please wait a few minutes before trying again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------- BACKGROUND PROCESSING ----------------
async function processReportAndEmail(payload) {
  const { url, firstName, lastName, email, company, jobTitle, phone } = payload;
  try {
    console.log(`Background: starting report for ${email} -> ${url}`);
    const analysis = await safeAnalyzeWebsite(url);
    const reportText = await generateReportWithData(analysis);

    let htmlContent = textToHTML(reportText);
    htmlContent += `
      <div class="section">
        <h2>Disclaimer</h2>
        <p>This automated audit provides a quick snapshot based on limited metrics 
        and may not capture every optimization opportunity. For a more comprehensive, 
        tailored and hands-on support, Synaphis offers expert consultancy and SaaS tools. 
        To explore deeper improvements in SEO, performance, accessibility, design, or overall digital strategy,
         please contact us at sales@synaphis.com.</p>

      </div>
    `;

    const templatesDir = path.join(__dirname, "templates");
    const templatePath = path.join(templatesDir, "report.html");
    if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
    if (!fs.existsSync(templatePath)) {
      fs.writeFileSync(templatePath, `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: Arial, sans-serif; margin: 40px; }
h2 { margin-top: 25px; border-left: 4px solid #007acc; padding-left: 10px; }
.page-break { page-break-before: always; }
</style>
</head>
<body>
<h1>online presence & performanc Audit Report</h1>
<p><strong>URL:</strong> {{url}}</p>
<p><strong>Date:</strong> {{date}}</p>
<hr>
{{{reportText}}}
</body>
</html>`, "utf8");
    }

    let finalHtml = fs.readFileSync(templatePath, "utf8")
      .replace("{{url}}", analysis.url)
      .replace("{{date}}", new Date().toLocaleDateString())
      .replace("{{{reportText}}}", htmlContent);

    const pdfBuffer = await generatePdfFromHtml(finalHtml);

    // ----------------- SEND EMAIL VIA RESEND -----------------
    const domain = analysis.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const filename = `audit-report-${domain}.pdf`;

    await resend.emails.send({
      from: "sales@synaphis.com",
      to: email,
      subject: `Your Website Audit for ${domain}`,
      text: `Hi ${firstName || ""} ${lastName || ""},

Please find attached the website audit report for ${domain} that you requested.

If you have any questions or would like a deeper review, reply to this email.

Best,
The Synaphis Team
`,
      attachments: [
        {
          filename,
          content: pdfBuffer.toString("base64"), // Resend now uses base64
        },
      ],
    });

    console.log(`✅ Report emailed to ${email} for URL ${analysis.url} via Resend`);
  } catch (err) {
    console.error("Error processing report and sending email:", err);
  }
}

// ---------------- REPORT REQUEST ROUTE ----------------
app.post("/report-request", requestLimiter, (req, res) => {
  try {
    const { url, firstName, lastName, email, company, jobTitle, phone } = req.body || {};

    if (!url) return res.status(400).json({ error: "Missing URL" });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: "Invalid email format" });
    if (isForbiddenEmailLocalPart(email)) return res.status(400).json({ error: "Please provide a direct company/work email (no role addresses allowed)." });
    if (isFreeEmailDomain(email)) return res.status(400).json({ error: "Please use a company/work email — free personal email domains are not allowed." });

    const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
    try { new URL(normalizedUrl); } catch { return res.status(400).json({ error: "Invalid URL" }); }

    res.status(202).json({ status: "accepted", message: "Request received. The audit will be emailed to you shortly." });

    processReportAndEmail({
      url: normalizedUrl,
      firstName: String(firstName),
      lastName: String(lastName),
      email: String(email),
      company: String(company),
      jobTitle: String(jobTitle),
      phone: String(phone),
    }).catch((err) => { console.error("Background processing failed:", err); });
  } catch (err) {
    console.error("report-request handler error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------------- PDF GENERATION (/report-pdf) ----------------
app.post("/report-pdf", async (req, res) => {
  let browser = null;
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    const analysis = await safeAnalyzeWebsite(url);
    const reportText = await generateReportWithData(analysis);
    let htmlContent = textToHTML(reportText);

    htmlContent += `
      <div class="section">
        <h2>Disclaimer</h2>
        <p>This automated audit provides a high-level overview based on available data and may not capture every
opportunity for optimization. For a more thorough, tailored analysis and implementation support, Synaphis offers
SaaS tools and expert consultancy. To explore deeper improvements to SEO, performance, accessibility, design, or
overall digital strategy, please contact at sales@synaphis.com.</p>
      </div>
    `;

    const templatesDir = path.join(__dirname, "templates");
    const templatePath = path.join(templatesDir, "report.html");

    if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
    if (!fs.existsSync(templatePath)) {
      fs.writeFileSync(templatePath, `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: Arial, sans-serif; margin: 40px; }
h2 { margin-top: 25px; border-left: 4px solid #007acc; padding-left: 10px; }
.page-break { page-break-before: always; }
</style>
</head>
<body>
<h1>online presence & performanc Audit Report</h1>
<p><strong>URL:</strong> {{url}}</p>
<p><strong>Date:</strong> {{date}}</p>
<hr>
{{{reportText}}}
</body>
</html>`);
    }

    let finalHtml = fs.readFileSync(templatePath, "utf8")
      .replace("{{url}}", analysis.url)
      .replace("{{date}}", new Date().toLocaleDateString())
      .replace("{{{reportText}}}", htmlContent);

    browser = await launchBrowser();
    const page = await browser.newPage();
    console.log("✅ Browser launched:", await browser.version());

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "stylesheet", "script"].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const encoded = Buffer.from(finalHtml, "utf8").toString("base64");
    await page.goto(`data:text/html;base64,${encoded}`, { waitUntil: "load", timeout: 60000 });

    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });

    await browser.close();
    browser = null;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Website_Audit.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("PDF generation error:", err);
    if (browser) await browser.close();
    res.status(500).json({ error: "Failed to generate PDF", details: err?.message || String(err) });
  }
});

// ---------------- HEALTH ----------------
app.get("/health", (_req, res) => res.json({ status: "ok", model: process.env.HF_MODEL || "default" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
