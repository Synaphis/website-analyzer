// analyze.mjs
import fs from "fs";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import lighthouse from "lighthouse";
import { launch as chromeLaunch } from "chrome-launcher";
import metascraper from "metascraper";
import metascraperTitle from "metascraper-title";
import metascraperDescription from "metascraper-description";
import metascraperAuthor from "metascraper-author";
import metascraperImage from "metascraper-image";
import metascraperPublisher from "metascraper-publisher";
import metascraperLang from "metascraper-lang";
import nlp from "compromise";
import ColorContrastChecker from "color-contrast-checker";
import AxeBuilder from "@axe-core/puppeteer";

const scraper = metascraper([
  metascraperTitle(),
  metascraperDescription(),
  metascraperAuthor(),
  metascraperImage(),
  metascraperPublisher(),
  metascraperLang(),
]);

// --------------------- HELPERS ---------------------
async function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function safeFetch(url, timeout = 15000) {
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
      }
    }, timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch {
    return null;
  }
}

async function urlExists(url, timeout = 8000) {
  try {
    const head = await fetchWithTimeout(url, { method: "HEAD", redirect: "follow" }, timeout);
    if (head.ok) return true;
  } catch {}
  try {
    const get = await fetchWithTimeout(url, { method: "GET", redirect: "follow" }, timeout);
    return get.ok;
  } catch {
    return false;
  }
}

function parseFollowersStr(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\u00A0/g, " ").trim();
  const m = s.match(/([\d.,]+)\s*([KMkm])?/);
  if (!m) return null;
  let num = parseFloat(m[1].replace(/,/g, ""));
  const suf = (m[2] || "").toUpperCase();
  if (suf === "K") num *= 1e3;
  if (suf === "M") num *= 1e6;
  return Math.round(num);
}

function extractKeywordsFromHtml(html, max = 15) {
  const $ = cheerio.load(html || "");
  $("script, style, noscript, template, [hidden]").remove();
  const visibleText = $("body").text().replace(/\s+/g, " ").trim();
  const doc = nlp(visibleText || "");
  return doc.nouns().out("array").slice(0, max);
}

function guessHandleUrls(hostname) {
  const base = hostname.replace(/^www\./, "").split(".")[0];
  return {
    facebook: `https://www.facebook.com/${base}`,
    twitter: `https://twitter.com/${base}`,
    instagram: `https://www.instagram.com/${base}`,
    linkedin: `https://www.linkedin.com/company/${base}`,
    youtube: `https://www.youtube.com/@${base}`,
    tiktok: `https://www.tiktok.com/@${base}`,
  };
}

// --------------------- SOCIAL SCANNING ---------------------
async function detectSocialLinksFromSite(html, normalizedUrl) {
  const $ = cheerio.load(html || "");
  const found = {};
  ["facebook", "twitter", "instagram", "linkedin", "youtube", "tiktok"].forEach((k) => (found[k] = null));

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (/facebook\.com/i.test(href)) found.facebook = found.facebook || href;
    if (/twitter\.com/i.test(href)) found.twitter = found.twitter || href;
    if (/instagram\.com/i.test(href)) found.instagram = found.instagram || href;
    if (/linkedin\.com/i.test(href)) found.linkedin = found.linkedin || href;
    if (/youtube\.com/i.test(href)) found.youtube = found.youtube || href;
    if (/tiktok\.com/i.test(href)) found.tiktok = found.tiktok || href;
  });

  // guessed handles if missing
  const guessed = guessHandleUrls(new URL(normalizedUrl).hostname);
  for (const [k, u] of Object.entries(guessed)) {
    if (!found[k]) {
      try {
        if (await urlExists(u)) found[k] = u;
      } catch {}
    }
  }

  return found;
}

async function analyzeSocialProfile(url, browser) {
  const out = { url: url || null, active: false, status: "not-available", followers: null, postsInLast30Days: 0 };
  if (!url || !browser) return out;

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    out.active = true;
    out.status = "ok";
    await page.close();
  } catch {
    out.active = false;
    out.status = "error";
  }
  return out;
}

function calculateReputationScore(socialProfiles, websiteKeywords = []) {
  const profiles = Object.values(socialProfiles);
  const totalPlatforms = profiles.length;
  const activeCount = profiles.filter((p) => p.active).length;
  const presenceScore = Math.round((activeCount / totalPlatforms) * 100);
  return { presenceScore, overall: presenceScore };
}

// --------------------- MAIN ANALYZER ---------------------
export async function analyzeWebsite(url) {
  const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;

  // STEP 1 — Try normal fetch
  let html = await safeFetch(normalizedUrl, 20000);

  // STEP 2 — Fallback to puppeteer if no HTML / bot block
  if (!html || html.length < 500) {
    console.warn("⚠️ safeFetch failed or minimal content — using Puppeteer fallback...");
    try {
      const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
      const page = await browser.newPage();
      await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
      await page.goto(normalizedUrl, { waitUntil: "networkidle2", timeout: 30000 });
      html = await page.content();
      await browser.close();
    } catch (err) {
      return {
        url: normalizedUrl,
        error: "Could not fetch usable HTML (blocked or JS-required site)",
        details: String(err),
        analyzedAt: new Date().toISOString(),
      };
    }
  }

  // At this point, html MUST exist
  const $ = cheerio.load(html);

  const htmlMetrics = {
    title: $("title").first().text() || "No title",
    description: $('meta[name="description"]').attr("content") || null,
    h1: $("h1").first().text() || null,
    wordCount: $("body").text().split(/\s+/).filter(Boolean).length,
    links: $("a").length,
    images: $("img").length,
    missingAlt: $("img:not([alt])").length,
  };

  let metadata = {};
  try {
    metadata = await scraper({ html, url: normalizedUrl });
  } catch {}

  const keywords = extractKeywordsFromHtml(html, 20);
  const detectedLinks = await detectSocialLinksFromSite(html, normalizedUrl);

  // Social scanning with puppeteer
  const socialProfiles = {};
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
    const socialPromises = Object.entries(detectedLinks).map(async ([platform, link]) => {
      socialProfiles[platform] = await analyzeSocialProfile(link, browser);
    });
    await Promise.all(socialPromises);
  } catch {}
  finally {
    if (browser) await browser.close().catch(() => {});
  }

  // Placeholder sections (you can expand with Lighthouse + Axe later)
  const accessibility = { violations: 0, details: [] };
  const visualMetrics = { hero: null };
  const performance = { performanceScore: 0, lcp: 0, cls: 0, tbt: 0 };
  const reputation = calculateReputationScore(socialProfiles, keywords);

  return {
    url: normalizedUrl,
    htmlMetrics,
    metadata,
    keywords,
    detectedLinks,
    socialProfiles,
    accessibility,
    visualMetrics,
    performance,
    reputation,
    analyzedAt: new Date().toISOString(),
  };
}
