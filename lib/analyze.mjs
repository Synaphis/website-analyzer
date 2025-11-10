// backend/lib/analyze.mjs
import * as cheerio from "cheerio";
import AxeBuilder from "@axe-core/puppeteer";
import metascraper from "metascraper";
import metascraperTitle from "metascraper-title";
import metascraperDescription from "metascraper-description";
import metascraperAuthor from "metascraper-author";
import metascraperImage from "metascraper-image";
import metascraperPublisher from "metascraper-publisher";
import metascraperLang from "metascraper-lang";
import nlp from "compromise";
import ColorContrastChecker from "color-contrast-checker";

const scraper = metascraper([
  metascraperTitle(),
  metascraperDescription(),
  metascraperAuthor(),
  metascraperImage(),
  metascraperPublisher(),
  metascraperLang(),
]);

async function safeFetch(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch {
    return null;
  }
}

export async function analyzeWebsite(url, puppeteerInstance) {
  const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
  console.log(`🔹 Starting analysis for: ${normalizedUrl}`);

  const html = await safeFetch(normalizedUrl);
  if (!html) return { error: "Page could not be fetched" };

  const $ = cheerio.load(html);

  const htmlMetrics = {
    title: $("title").text() || "No title",
    description: $('meta[name="description"]').attr("content") || null,
    h1: $("h1").first().text() || null,
    h2Count: $("h2").length,
    wordCount: $("body").text().split(/\s+/).filter(Boolean).length,
    links: $("a").length,
    images: $("img").length,
    missingAlt: $("img:not([alt])").length,
  };

  let metadata = {};
  try { metadata = await scraper({ html, url: normalizedUrl }); } catch (e) { /* ignore */ }

  const base = new URL(normalizedUrl).origin;
  const robotsTxt = await safeFetch(`${base}/robots.txt`);
  const sitemap =
    robotsTxt?.match(/sitemap:\s*(.*)/i)?.[1] || (await safeFetch(`${base}/sitemap.xml`)) || null;

  let accessibility = { violations: 0, details: [] };
  let colors = [];

  try {
    const launchOptions = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    };
    // Let puppeteer supply its own executable path if available (installed by postinstall)
    const execPath = puppeteerInstance.executablePath ? puppeteerInstance.executablePath() : undefined;
    if (execPath) launchOptions.executablePath = execPath;

    const browser = await puppeteerInstance.launch(launchOptions);
    const page = await browser.newPage();
    await page.goto(normalizedUrl, { waitUntil: "networkidle2", timeout: 60000 });

    try {
      const axeResults = await new AxeBuilder({ page }).analyze();
      accessibility = { violations: axeResults.violations.length, details: axeResults.violations };
    } catch (e) {
      console.log("⚠️ Axe scan failed:", e?.message || e);
    }

    colors = await page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll("*").forEach((el) => {
        const c = window.getComputedStyle(el).color;
        if (c) set.add(c);
      });
      return [...set].slice(0, 10);
    });

    await browser.close();
  } catch (e) {
    console.log("⚠️ Puppeteer failed:", e?.message || e);
  }

  // We removed lighthouse in this variant to avoid chrome-launcher dependency
  const performance = { note: "skipped (lighthouse removed for deploy stability)" };

  const doc = nlp($("body").text());
  const keywords = doc.nouns().out("array").slice(0, 15);

  const ccc = new ColorContrastChecker();
  const primaryContrast = colors.length >= 2 ? ccc.getContrastRatio(colors[0], colors[1]) : 0;

  return {
    url: normalizedUrl,
    htmlMetrics,
    metadata,
    robotsTxtFound: Boolean(robotsTxt),
    sitemap,
    accessibility,
    performance,
    keywords,
    colors: { palette: colors, primaryContrast },
    analyzedAt: new Date().toISOString(),
  };
}
