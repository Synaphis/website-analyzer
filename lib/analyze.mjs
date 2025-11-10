process.on("unhandledRejection", (reason) => {
  console.warn("⚠️ Global unhandled rejection:", reason);
});

import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import AxeBuilder from "@axe-core/puppeteer";
import lighthouse from "lighthouse";
import { launch } from "chrome-launcher";
import metascraper from "metascraper";
import metascraperTitle from "metascraper-title";
import metascraperDescription from "metascraper-description";
import metascraperAuthor from "metascraper-author";
import metascraperImage from "metascraper-image";
import metascraperPublisher from "metascraper-publisher";
import metascraperLang from "metascraper-lang";
import nlp from "compromise";
import ColorContrastChecker from "color-contrast-checker";

// --- Configure metascraper ---
const scraper = metascraper([
  metascraperTitle(),
  metascraperDescription(),
  metascraperAuthor(),
  metascraperImage(),
  metascraperPublisher(),
  metascraperLang(),
]);

// --- Safe fetch ---
async function safeFetch(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch {
    return null;
  }
}

// --- Analyzer function ---
export async function analyzeWebsite(url) {
  const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
  console.log(`🔹 Starting analysis for: ${normalizedUrl}`);

  const startTime = Date.now();
  const html = await safeFetch(normalizedUrl);
  const loadTime = Date.now() - startTime;

  if (!html) {
    console.log("❌ Error: Page could not be fetched");
    return { error: "Page could not be fetched" };
  }

  const $ = cheerio.load(html);

  // --- HTML metrics ---
  const htmlMetrics = {
    title: $("title").text() || "No title",
    description: $('meta[name="description"]').attr("content") || null,
    h1: $("h1").first().text() || null,
    h2Count: $("h2").length,
    wordCount: $("body").text().split(/\s+/).length,
    links: $("a").length,
    images: $("img").length,
    missingAlt: $("img:not([alt])").length,
  };

  // --- Metascraper metadata ---
  let metadata = {};
  try {
    metadata = await scraper({ html, url: normalizedUrl });
  } catch {}

  // --- robots.txt & sitemap ---
  const base = new URL(normalizedUrl).origin;
  const robotsTxt = await safeFetch(`${base}/robots.txt`);
  const sitemap =
    robotsTxt?.match(/sitemap:\s*(.*)/i)?.[1] || (await safeFetch(`${base}/sitemap.xml`)) || null;

  // --- Puppeteer: Axe + colors ---
  let accessibility = { violations: 0, details: [] };
  let colors = [];

  try {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(normalizedUrl, { waitUntil: "networkidle2", timeout: 60000 });

    try {
      const axeResults = await new AxeBuilder({ page }).analyze();
      accessibility = {
        violations: axeResults.violations.length,
        details: axeResults.violations,
      };
    } catch {}

    colors = await page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll("*").forEach(el => {
        const c = window.getComputedStyle(el).color;
        if (c) set.add(c);
      });
      return [...set].slice(0, 10);
    });

    await browser.close();
  } catch (e) {
    console.log("⚠️ Puppeteer failed:", e.message);
  }

  // --- Lighthouse performance ---
  let performance = { performanceScore: 0, lcp: 0, cls: 0, tbt: 0 };
  try {
    const chrome = await launch({ chromeFlags: ["--headless"] });
    const result = await lighthouse(normalizedUrl, {
      logLevel: "error",
      output: "json",
      onlyCategories: ["performance"],
      port: chrome.port,
    });

    const lhr = result?.lhr;
    performance = {
      performanceScore: (lhr?.categories?.performance?.score ?? 0) * 100,
      lcp: lhr?.audits?.["largest-contentful-paint"]?.numericValue ?? 0,
      cls: lhr?.audits?.["cumulative-layout-shift"]?.numericValue ?? 0,
      tbt: lhr?.audits?.["total-blocking-time"]?.numericValue ?? 0,
    };

    await chrome.kill();
  } catch (e) {
    console.log("⚠️ Lighthouse failed:", e.message);
  }

  // --- NLP keywords ---
  $("nav, footer, script, style").remove();
  const text = $("body").text();
  const doc = nlp(text);
  const keywords = doc.nouns().out("array").slice(0, 15);

  // --- Color contrast ---
  const ccc = new ColorContrastChecker();
  const primaryContrast = colors.length >= 2 ? ccc.getContrastRatio(colors[0], colors[1]) : 0;

  // --- Final result ---
  const result = {
    url: normalizedUrl,
    loadTime,
    htmlMetrics,
    metadata,
    robotsTxtFound: Boolean(robotsTxt),
    sitemap: sitemap || null,
    accessibility,
    performance,
    keywords,
    colors: { palette: colors, primaryContrast },
    analyzedAt: new Date().toISOString(),
  };

  console.log("\n✅ Analysis complete for:", normalizedUrl);
  return result;
}
