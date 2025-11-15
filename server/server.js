// server.js — Full file with in-memory ZIP workaround for Resend attachments

import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";
import { analyzeWebsite } from "../lib/analyze.mjs";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import os from "os";
import crypto from "crypto";
import archiver from "archiver";
import StreamBuffers from "stream-buffers";

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "15mb" }));
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on("unhandledRejection", (reason) => console.warn("Unhandled promise rejection:", reason));

// ---------------- TEXT → HTML ----------------
function textToHTML(text = "") {
  const lines = text.split("\n");
  let html = "",
    currentSection = "";
  const headings = [
    "Executive Summary",
    "SEO Analysis",
    "Accessibility Review",
    "Performance Review",
    "Social Media and Brand Presence",
    "Visual and Design Assessment",
    "Reputation and Trust Signals",
    "Keyword Strategy",
    "Critical Issues",
    "Actionable Recommendations",
  ];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    const isHeading = headings.find((h) => line.toLowerCase().startsWith(h.toLowerCase()));
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

// ---------------- CHROME LAUNCH ----------------
function findLocalChrome() {
  try {
    const chromeRoot = path.resolve(process.cwd(), "chrome");
    if (!fs.existsSync(chromeRoot)) return null;
    const entries = fs.readdirSync(chromeRoot, { withFileTypes: true });
    const chromeDir = entries.find((e) => e.isDirectory() && e.name === "chrome") || entries.find((e) => e.isDirectory());
    if (!chromeDir) return null;
    const chromeDirPath = path.join(chromeRoot, chromeDir.name);
    const versions = fs.readdirSync(chromeDirPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const v of versions) {
      const candidate = path.join(chromeDirPath, v.name, "chrome-linux64", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  } catch (err) {
    console.warn("findLocalChrome error:", err?.message || err);
    return null;
  }
}

async function launchBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    console.log("Using CHROME_PATH:", process.env.CHROME_PATH);
    return puppeteer.launch({
      executablePath: process.env.CHROME_PATH,
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
    const exe = typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : puppeteer.executablePath;
    if (exe && fs.existsSync(exe)) {
      console.log("Using puppeteer.executablePath():", exe);
      return puppeteer.launch({
        executablePath: exe,
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
    }
  } catch (err) {
    console.warn("puppeteer.executablePath() failed:", err?.message || err);
  }
  console.log("Fallback: launching puppeteer without executablePath");
  return puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
}

// ---------------- SAFE ANALYSIS ----------------
async function safeAnalyzeWebsite(url) {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const analysis = await analyzeWebsite(normalized);
    if (!analysis) throw new Error("Empty analysis result");
    return analysis;
  } catch (err) {
    console.error("Analysis error:", err?.stack || err);
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

// ---------------- LLM REPORT ----------------
const systemMessage = `
You are a senior virtual strategy, marketing, and web audit analyst.
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
  try {
    const client = new OpenAI({ baseURL: process.env.HF_ROUTER_BASEURL || "https://router.huggingface.co/v1", apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct:novita";
    const userMessage = `
Generate a virtual and business insight report from the JSON below.
Use only the provided JSON. Do not output raw JSON, bullets, lists, tables, or markdown.
Keep the headings exactly as listed in the system message, each followed by a plain-text paragraph only.
Do not claim external knowledge; base all statements solely on JSON.
If you make inferences, label them inline as INFERRED (confidence: XX%) and provide numeric estimates with confidence inline.
Focus on revealing the business model, products/services, website effectiveness, technology stack, SEO, content, online presence, competitors, and overall digital health. Provide actionable insights for client acquisition and online presence improvement.
Do not exaggerate or make claims beyond what the data and logical inference support.
If data completeness < 20%, start with "Partial scan — high uncertainty."

JSON Input:
${JSON.stringify(data)}
`;
    const response = await client.chat.completions.create({ model, messages: [{ role: "system", content: systemMessage }, { role: "user", content: userMessage }], max_tokens: 4000, temperature: 0.1 });
    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("LLM returned no report text");
    return text;
  } catch (err) {
    console.error("LLM generation failed:", err?.stack || err);
    return `Executive Summary\nUnable to generate report due to API error.\n\nSEO Analysis\nN/A\n\nAccessibility Review\nN/A\n\nPerformance Review\nN/A\n\nSocial Media and Brand Presence\nN/A\n\nVisual and Design Assessment\nN/A\n\nReputation and Trust Signals\nN/A\n\nKeyword Strategy\nN/A\n\nCritical Issues\nN/A\n\nActionable Recommendations\nN/A`;
  }
}

// ---------------- PDF GENERATION ----------------
async function generatePdfFromHtml(finalHtml) {
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(finalHtml, { waitUntil: "load", timeout: 60000 });
    await page.setViewport({ width: 1200, height: 800 });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    await browser.close();
    return pdfBuffer;
  } catch (err) {
    console.error("generatePdfFromHtml failed:", err?.stack || err);
    if (browser) try { await browser.close(); } catch {}
    throw err;
  }
}

// helper: create zip buffer in memory (returns Buffer)
function createZipBuffer(filenameInZip, fileBuffer) {
  return new Promise((resolve, reject) => {
    try {
      const writable = new StreamBuffers.WritableStreamBuffer({
        initialSize: 100 * 1024,
        incrementAmount: 10 * 1024,
      });

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => reject(err));
      archive.pipe(writable);

      archive.append(fileBuffer, { name: filenameInZip });
      archive.finalize();

      writable.on("finish", () => {
        const contents = writable.getContents();
        if (!contents) return reject(new Error("Empty zip contents"));
        const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
        resolve(buf);
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------- EMAIL VALIDATION ----------------
const forbiddenLocalParts = new Set([
  "support",
  "careers",
  "career",
  "info",
  "admin",
  "contact",
  "webmaster",
  "sales",
  "hello",
  "noreply",
  "no-reply",
  "jobs",
  "hr",
  "team",
  "press",
  "marketing",
  "office",
  "service",
  "services",
]);
function isForbiddenEmailLocalPart(email = "") {
  try {
    return forbiddenLocalParts.has(email.split("@")[0].toLowerCase());
  } catch {
    return false;
  }
}
const freeEmailDomains = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "aol.com", "protonmail.com", "pm.me", "yandex.com", "yandex.ru", "zoho.com", "gmx.com", "gmx.de"]);
function isFreeEmailDomain(email = "") {
  try {
    return freeEmailDomains.has(email.split("@")[1].toLowerCase());
  } catch {
    return false;
  }
}

// ---------------- RATE LIMIT ----------------
const requestLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: "Too many requests. Wait a few minutes." } });

// ---------------- BACKGROUND PROCESS ----------------
async function processReportAndEmail({ url, firstName, lastName, email, company, jobTitle, phone }) {
  try {
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
         please contact us at sales@synaphis.com.</p> </div> `;

    const templatesDir = path.join(__dirname, "templates");
    const templatePath = path.join(templatesDir, "report.html");
    if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
    if (!fs.existsSync(templatePath))
      fs.writeFileSync(
        templatePath,
        `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Arial;margin:40px;}h2{margin-top:25px;border-left:4px solid #007acc;padding-left:10px;}</style></head><body><h1>Online Presence & Performance Audit</h1><p><strong>URL:</strong>{{url}}</p><p><strong>Date:</strong>{{date}}</p><hr>{{{reportText}}}</body></html>`
      );

    const finalHtml = fs.readFileSync(templatePath, "utf8").replace("{{url}}", analysis.url).replace("{{date}}", new Date().toLocaleDateString()).replace("{{{reportText}}}", htmlContent);

    const pdfBuffer = await generatePdfFromHtml(finalHtml);
    if (!pdfBuffer || pdfBuffer.length < 200) throw new Error("Generated PDF is empty/corrupted");

    const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);

    // write a local debug copy & checksum
    try {
      const domain = analysis.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const debugFilename = `resend-sent-${Date.now()}-${domain}.pdf`;
      const debugPath = path.join(os.tmpdir(), debugFilename);
      fs.writeFileSync(debugPath, buf);
      const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      console.log(`Wrote local PDF copy: ${debugPath} (bytes: ${buf.length}, sha256: ${sha256})`);
    } catch (writeErr) {
      console.warn("Failed to write local debug PDF:", writeErr);
    }

    // create zip (in-memory) containing the PDF
    let zipBuffer = null;
    try {
      zipBuffer = await createZipBuffer("audit-report.pdf", buf);
      console.log(`Created in-memory ZIP (bytes: ${zipBuffer.length})`);
    } catch (zipErr) {
      console.error("Failed creating ZIP in memory:", zipErr);
      zipBuffer = null;
    }

    // Build attachment: prefer ZIP base64 (most robust), else fallback to PDF base64
    const domainClean = analysis.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    let attachment;
    if (zipBuffer) {
      attachment = {
        filename: `audit-report-${domainClean}.zip`,
        content: zipBuffer.toString("base64"),
        type: "application/zip",
      };
    } else {
      attachment = {
        filename: `audit-report-${domainClean}.pdf`,
        content: buf.toString("base64"),
        type: "application/pdf",
      };
    }

    // send email via Resend (base64 content)
    try {
      await resend.emails.send({
        from: "sales@synaphis.com",
        to: email,
        subject: `Your Website Audit for ${analysis.url}`,
        text: `Hi ${firstName || ""} ${lastName || ""},

Please find attached your website audit report for ${analysis.url} that you requested.

If you have any questions or would like a deeper review, reply to this email.

Best,
The Synaphis Team
`,
        attachments: [attachment],
      });

      console.log(`✅ Report emailed to ${email} for URL ${analysis.url} via Resend (sent ${attachment.filename})`);
    } catch (sendErr) {
      console.error("Resend email send failed:", sendErr);
      // Save debug file on failure
      try {
        if (zipBuffer) {
          const failPath = path.join(os.tmpdir(), `resend-failed-${Date.now()}-${domainClean}.zip`);
          fs.writeFileSync(failPath, zipBuffer);
          console.log("Wrote failed-send ZIP to:", failPath);
        } else {
          const failPdfPath = path.join(os.tmpdir(), `resend-failed-${Date.now()}-${domainClean}.pdf`);
          fs.writeFileSync(failPdfPath, buf);
          console.log("Wrote failed-send PDF to:", failPdfPath);
        }
      } catch (dbgErr) {
        console.warn("Failed writing debug file after send error:", dbgErr);
      }
      throw sendErr;
    }
  } catch (err) {
    console.error("processReportAndEmail error:", err?.stack || err);
  }
}

// ---------------- ROUTES ----------------
app.post("/report-request", requestLimiter, (req, res) => {
  try {
    const { url, firstName, lastName, email, company, jobTitle, phone } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing URL" });
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: "Invalid email" });
    if (isForbiddenEmailLocalPart(email)) return res.status(400).json({ error: "Role-based emails not allowed" });
    if (isFreeEmailDomain(email)) return res.status(400).json({ error: "Use a company email" });
    const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
    try {
      new URL(normalizedUrl);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }
    res.status(202).json({ status: "accepted" });
    processReportAndEmail({ url: normalizedUrl, firstName, lastName, email, company, jobTitle, phone });
  } catch (err) {
    console.error("/report-request error:", err?.stack || err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/report-pdf", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });
    const analysis = await safeAnalyzeWebsite(url);
    const reportText = await generateReportWithData(analysis);
    let htmlContent = textToHTML(reportText);
    htmlContent += `<div class="section"><h2>Disclaimer</h2><p>...</p></div>`;
    const templatesDir = path.join(__dirname, "templates");
    const templatePath = path.join(templatesDir, "report.html");
    if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
    if (!fs.existsSync(templatePath))
      fs.writeFileSync(
        templatePath,
        `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Arial;margin:40px;}h2{margin-top:25px;border-left:4px solid #007acc;padding-left:10px;}</style></head><body><h1>Online Audit</h1><p><strong>URL:</strong>{{url}}</p><p><strong>Date:</strong>{{date}}</p><hr>{{{reportText}}}</body></html>`
      );
    const finalHtml = fs.readFileSync(templatePath, "utf8").replace("{{url}}", analysis.url).replace("{{date}}", new Date().toLocaleDateString()).replace("{{{reportText}}}", htmlContent);
    const pdfBuffer = await generatePdfFromHtml(finalHtml);
    if (!pdfBuffer || pdfBuffer.length < 200) throw new Error("Generated PDF is corrupted");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=Website_Audit.pdf`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("/report-pdf error:", err?.stack || err);
    res.status(500).json({ error: "Failed PDF generation", details: err?.message || String(err) });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
