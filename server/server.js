// server/server.js
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core"; // puppeteer-core for custom Chrome path
import OpenAI from "openai";
import { analyzeWebsite } from "../lib/analyze.mjs";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "10mb" }));

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

    const isHeading = headings.find(h => line.toLowerCase().startsWith(h.toLowerCase()));
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
    const chromeDir = entries.find(e => e.isDirectory() && e.name === "chrome") || entries.find(e => e.isDirectory());
    if (!chromeDir) return null;

    const chromeDirPath = path.join(chromeRoot, chromeDir.name);
    const versions = fs.readdirSync(chromeDirPath, { withFileTypes: true }).filter(d => d.isDirectory());
    if (versions.length === 0) return null;

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
    const exe = puppeteer.executablePath && fs.existsSync(puppeteer.executablePath()) ? puppeteer.executablePath() : null;
    if (exe) {
      console.log("Using puppeteer.executablePath():", exe);
      return puppeteer.launch({
        executablePath: exe,
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
    }
  } catch (e) { /** ignore */ }

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
      error: err.message,
    };
  }
}

// ---------------- LLM REPORT GENERATION ----------------
const systemMessage = `
You are a senior-level online presence & performance audit engine with expertise in website, SEO, social media, accessibility, performance, design, and brand trust.

Your job: Produce a polished, executive-quality online presence & performanc audit using only the information in the analysis JSON.

STRICT RULES:
- Use JSON data exactly as given. Do not invent numbers, facts, features, or results.
- When data exists in the JSON, refer to it directly.
- When data is missing or empty, do NOT say “missing,” “not found,” or “no data.”
  Instead, use subtle and professional language:
  Examples:
  - “There may be opportunities to refine metadata for clarity and search visibility.”
  - “A more in-depth audit could reveal additional insights into user experience or structure.”
  - “Further review may help uncover expanded opportunities for brand engagement.”

WRITING RULES:
- No markdown formatting.
- No asterisks (*), no bullet points, no numbered lists.
- No tables.
- Write only in clean, formal prose paragraphs.
- Tone: polished, analytical, business-friendly.
- Content must come ONLY from provided JSON.

SECTIONS (in this exact order):
Executive Summary
SEO Analysis
Accessibility Review
Performance Review
Social Media & Brand Presence
Visual & Design Assessment
Reputation & Trust Signals
Keyword Strategy
Critical Issues
Actionable Recommendations
`;

async function generateReportWithData(data) {
  const client = new OpenAI({
    baseURL: process.env.HF_ROUTER_BASEURL || "https://router.huggingface.co/v1",
    apiKey: process.env.OPENAI_API_KEY,
  });

  const model = process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct:novita";

  const userMessage = `
Generate the full online presence & performance audit using the required section structure.

Use the JSON values directly and clearly in prose.
If any category has limited information, apply subtle expert phrasing such as:
"Additional analysis could reveal more insights."
"Further review may help identify new opportunities."

JSON Input:
${JSON.stringify(data)}
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


// ---------------- PDF GENERATION (FIXED) ----------------
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

    // 🚀 KEY FIX — NO external requests & no `networkidle2`
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "stylesheet", "script"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Convert HTML into data URL and load it
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

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Website_Audit.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("PDF generation error:", err);
    if (browser) await browser.close();
    res.status(500).json({ error: "Failed to generate PDF", details: err.message });
  }
});

// ---------------- HEALTH ----------------
app.get("/health", (_req, res) => res.json({ status: "ok", model: process.env.HF_MODEL || "default" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));



