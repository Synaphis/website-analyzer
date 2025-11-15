// analyze-llm-ready-with-impute.mjs
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
import { launch as chromeLaunch } from 'chrome-launcher';
import metascraper from 'metascraper';
import metascraperTitle from 'metascraper-title';
import metascraperDescription from 'metascraper-description';
import metascraperUrl from 'metascraper-url';
import metascraperImage from 'metascraper-image';
import metascraperLogo from 'metascraper-logo';

// ---------------------- METASCRAPER ----------------------
const scraper = metascraper([
  metascraperTitle(),
  metascraperDescription(),
  metascraperUrl(),
  metascraperImage(),
  metascraperLogo(),
]);

// ---------------------- UTILITIES ----------------------
// safeFetch now returns { text, headers, ok, status } or null on failure
async function safeFetch(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const text = await res.text();
    return { text, headers: res.headers, ok: res.ok, status: res.status };
  } catch (err) {
    return null;
  } finally {
    clearTimeout(id);
  }
}

// ---------------------- RESOURCE METRICS (PUPPETEER) ----------------------
// collects resource sizes, DOM size, third-party counts, and also returns html if needed
async function gatherResourceMetrics(url, timeout = 30000) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  const origin = new URL(url).origin;
  const targetHost = new URL(url).hostname;

  const resources = [];
  // capture responses as they arrive (may be heavy but gives actual sizes)
  page.on('response', async (res) => {
    try {
      // ignore data: and other weird schemes
      const rUrl = res.url();
      if (!/^https?:\/\//i.test(rUrl)) return;
      const req = res.request();
      // buffer could fail for opaque responses; wrap in try/catch
      let size = null;
      try {
        const buf = await res.buffer();
        size = buf ? buf.length : null;
      } catch (e) {
        size = null;
      }
      resources.push({
        url: rUrl,
        resourceType: (req && req.resourceType) ? req.resourceType() : null,
        status: res.status(),
        size,
        headers: res.headers(),
      });
    } catch (e) {
      // ignore individual response failures
    }
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
  } catch (e) {
    // continue even if some timeouts happen
  }

  // page content / DOM nodes
  const html = await page.content();
  let domNodes = null;
  try {
    domNodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  } catch (e) {
    domNodes = null;
  }

  // derive metrics
  const images = resources.filter(r => r.resourceType === 'image' || (r.headers && /image\//i.test(r.headers['content-type'] || '')));
  const scripts = resources.filter(r => r.resourceType === 'script' || (r.headers && /javascript/i.test(r.headers['content-type'] || '')));
  const thirdParty = resources.filter(r => {
    try {
      return new URL(r.url).hostname !== targetHost;
    } catch {
      return false;
    }
  });

  const totalImageKB = images.reduce((s, r) => s + (r.size || 0), 0) / 1024;
  const totalJsKB = scripts.reduce((s, r) => s + (r.size || 0), 0) / 1024;
  const thirdPartyScripts = scripts.filter(s => {
    try { return new URL(s.url).hostname !== targetHost; } catch { return false; }
  }).length;

  await browser.close();

  return {
    html,
    domNodes,
    resourcesCount: resources.length,
    totalImageKB: Number(totalImageKB.toFixed(2)),
    totalJsKB: Number(totalJsKB.toFixed(2)),
    thirdPartyRequests: thirdParty.length,
    thirdPartyScripts,
    resourceListSample: resources.slice(0, 50), // small sample for debugging if needed
  };
}

// ---------------------- JSON-LD ----------------------
function extractJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    const raw = $(el).html() || '';
    try {
      const parsed = JSON.parse(raw);
      Array.isArray(parsed) ? out.push(...parsed) : out.push(parsed);
    } catch {}
  });
  return out;
}

// ---------------------- SITEMAP / ROBOTS ----------------------
async function fetchSitemapInfo(url) {
  try {
    const base = new URL(url).origin;
    const candidates = [`${base}/sitemap.xml`, `${base}/sitemap_index.xml`];
    for (const sUrl of candidates) {
      const res = await safeFetch(sUrl, 8000);
      if (!res || !res.text) continue;
      const xml = res.text;
      const $ = cheerio.load(xml, { xmlMode: true });
      const urls = $('url').toArray();
      const lastmods = $('lastmod').map((i, el) => $(el).text()).get();
      const latest = lastmods.length
        ? new Date(Math.max(...lastmods.map((d) => new Date(d).getTime()))).toISOString()
        : null;
      return { sitemapUrl: sUrl, pages: urls.length || null, latestSitemapDate: latest };
    }
  } catch {}
  return { sitemapUrl: null, pages: null, latestSitemapDate: null };
}

async function fetchRobotsInfo(url) {
  try {
    const base = new URL(url).origin;
    const res = await safeFetch(`${base}/robots.txt`, 4000);
    if (!res || !res.text) return { robots: null, crawlAllowed: true, robotsText: null };
    const txt = res.text;
    const disallows = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => /^disallow:/i.test(l));
    return { robots: txt, crawlAllowed: !disallows.some(d => d.match(/:\s*\/\s*$/i)), robotsText: txt };
  } catch {
    return { robots: null, crawlAllowed: true, robotsText: null };
  }
}

// ---------------------- TECH DETECTION ----------------------
function detectTech(html, $) {
  const s = String(html).toLowerCase();
  const techSignals = {
    // CMS / Platforms
    wordpress: /wp-content|wp-json|wordpress/i.test(html),
    shopify: /cdn\.shopify\.com|x-shopify/i.test(html),
    webflow: /webflow/i.test(html),
    wix: /wixstatic|wix-code|wix\.com/i.test(html),
    squarespace: /squarespace/i.test(html),
    ghost: /ghost\.org|ghostapi/i.test(html),
    laravel: /laravel/i.test(html),
    // Frameworks / libs
    nextjs: /_next\//|/__NEXT_DATA__|nextjs/i.test(html),
    react: /react(?:\.|js|-dom)|data-reactroot/i.test(html),
    angular: /ng-version|angular/i.test(html),
    vue: /vue(?:\.js)?|nuxt/i.test(html),
    // misc
    jquery: /jquery\./i.test(html),
    php: /<\?php/i.test(html)
  };

  const analytics = [
    ...( /gtag\(|google-analytics|measurementid=G-/i.test(s) ? ['GA'] : [] ),
    ...( /googletagmanager\.com\/gtm\.js/i.test(s) ? ['GTM'] : [] ),
    ...( /fbq\(|facebook\.net\/tr\.js/i.test(s) ? ['Facebook Pixel'] : [] ),
  ];

  const canonical = $('link[rel="canonical"]').attr('href') || null;

  return { ...techSignals, analytics, canonical };
}

// ---------------------- CONVERSION ----------------------
function detectConversion($, jsonLdBlocks, url) {
  const ctaCount = $('a,button,input[type=submit]').filter((i, el) => {
    const txt = ($(el).text() || $(el).attr('aria-label') || $(el).attr('value') || '').toLowerCase();
    return txt.match(/buy|order|add to cart|subscribe|get started|checkout|pricing/i);
  }).length;
  const forms = $('form').length;
  const hasProductLd = jsonLdBlocks.some(b => JSON.stringify(b).toLowerCase().includes('product'));
  const urlPath = new URL(url).pathname.toLowerCase();
  const pageType = hasProductLd || /\/product|\/item\//i.test(urlPath)
    ? 'product'
    : /\/blog|\/article|\/post/.test(urlPath)
    ? 'article'
    : urlPath === '/' ? 'homepage' : 'landing';
  const hasCart = $('a[href*="cart"], a[href*="checkout"], [class*="cart"]').length > 0;
  return { ctaCount, forms, hasProductLd, pageType, hasCart, isEcommerce: hasProductLd || hasCart };
}

// ---------------------- LIGHTHOUSE ----------------------
async function runLighthouse(url) {
  try {
    const chrome = await chromeLaunch({ chromeFlags: ['--headless', '--no-sandbox'] });
    const { lhr } = await lighthouse(url, { port: chrome.port, output: 'json', onlyCategories: ['performance','accessibility','seo'] });
    await chrome.kill();
    const audits = lhr.audits || {};
    return {
      performanceScore: Math.round(lhr.categories.performance.score*100),
      accessibilityScore: Math.round(lhr.categories.accessibility.score*100),
      seoScore: Math.round(lhr.categories.seo.score*100),
      lcp: audits['largest-contentful-paint']?.numericValue || null,
      cls: audits['cumulative-layout-shift']?.numericValue || null,
      tbt: audits['total-blocking-time']?.numericValue || null,
      keyAudits: {
        renderBlocking: audits['render-blocking-resources']?.displayValue || null,
        unusedJS: audits['unused-javascript']?.displayValue || null,
        imageOptimization: audits['uses-optimized-images']?.displayValue || null,
        thirdPartyRequests: audits['third-party-summary']?.displayValue || null
      }
    };
  } catch {
    return null;
  }
}

// ---------------------- SOCIAL ----------------------
function extractSocialLinks($) {
  const platforms = ['facebook','twitter','instagram','linkedin','youtube','tiktok'];
  const profiles = {};
  platforms.forEach(p => {
    const a = $(`a[href*="${p}.com"]`).attr('href');
    if(a) profiles[p] = a;
  });
  return profiles;
}
function computeSocialScore(profiles) {
  return Math.min(100, Object.keys(profiles).length * 20);
}

// ---------------------- SUPPORT WIDGETS & CRM ----------------------
function detectSupportAndCrm(html) {
  const s = String(html);
  const support = {
    intercom: /widget\.intercom\.io|Intercom\('boot'/.test(s),
    crisp: /client\.crisp\.chat/i.test(s),
    tawk: /embed\.tawk\.to/i.test(s),
    zendesk: /zendesk|zdassets/i.test(s),
    drift: /js\.driftt\.com/i.test(s),
    gorgias: /gorgias/i.test(s)
  };
  const crm = {
    hubspot: /hs-scripts|hubspot\.com|hubspot\.net/i.test(s),
    mailchimp: /list-manage\.com|mc\.embed\.mailchimp\.com/i.test(s),
    activecampaign: /activehosted\.com|activecampaign/i.test(s),
    marketo: /mktoForms2|mktorest/i.test(s)
  };
  return { support, crm };
}

// ---------------------- ACCESSIBILITY SIGNALS ----------------------
function detectAccessibility($) {
  const ariaCount = $('[aria-label], [aria-hidden], [role]').length;
  const unlabeledButtons = $('button').filter((i, el) => {
    const text = $(el).text() || $(el).attr('aria-label') || $(el).attr('title') || '';
    return !text.trim();
  }).length;
  const linksWithoutText = $('a').filter((i, el) => {
    const t = ($(el).text() || $(el).attr('aria-label') || '').trim();
    return !t;
  }).length;
  const semanticTags = {
    main: $('main').length,
    article: $('article').length,
    section: $('section').length,
    nav: $('nav').length,
    header: $('header').length,
    footer: $('footer').length
  };
  return { ariaCount, unlabeledButtons, linksWithoutText, semanticTags };
}

// ---------------------- HOSTING / CDN DETECTION ----------------------
function detectHostingFromHeaders(headersObj) {
  // headersObj may be a node-fetch Headers instance or plain object
  const get = (k) => {
    if (!headersObj) return '';
    if (typeof headersObj.get === 'function') return headersObj.get(k) || '';
    return headersObj[k.toLowerCase()] || headersObj[k] || '';
  };
  const server = (get('server') || get('via') || get('x-powered-by') || '').toString();
  return {
    cloudflare: /cloudflare/i.test(server) || !!get('cf-ray'),
    aws: /amazonaws|awselb|amazons3/i.test(server) || /amazonaws/i.test(get('x-amz-cf-id')+''),
    vercel: /vercel/i.test(server) || /x-vercel-id/i.test(get('x-vercel-id')+''),
    netlify: /netlify/i.test(server) || /x-nf-request-id/i.test(get('x-nf-request-id')+''),
    fastly: /fastly/i.test(server),
    google: /gws|google/i.test(server)
  };
}

// ---------------------- SITE PAGES SCAN ----------------------
function detectSitePages($) {
  return {
    hasPricing: !!$('a[href*="pricing"], a:contains("Pricing")').length,
    hasCareers: !!$('a[href*="careers"], a[href*="jobs"], a:contains("Careers"), a:contains("Jobs")').length,
    hasBlog: !!($('a[href*="/blog"], a[href*="/news"], a[href*="/articles"]').length || $('a:contains("Blog")').length)
  };
}

// ---------------------- LLM-READY TEXT EXTRACTION ----------------------
function extractCleanTextAndSections($) {
  // remove scripts/styles
  const cloned = $('body').clone();
  cloned.find('script,style,noscript,iframe').remove();
  const cleanText = cloned.text().replace(/\s+/g, ' ').trim();
  // headers mapping
  const headers = [];
  $('h1,h2,h3,h4,h5,h6').each((i, el) => {
    headers.push({ tag: el.tagName.toLowerCase(), text: $(el).text().trim() });
  });
  return { cleanText, headers };
}

// ---------------------- BUSINESS INSIGHTS ----------------------
function detectBusinessModel(html, $, tech, conversion, jsonLdBlocks, sitePages, keywords) {
  const s = String(html);

  // CTA-based signals
  const ctaText = $('a,button').map((i, el) => ($(el).text() || $(el).attr('aria-label') || '')).get().join(' ').toLowerCase();

  // url pattern checks
  const urlPatterns = {
    pricing: $('a[href*="pricing"], a:contains("Pricing")').length > 0,
    demo: $('a[href*="demo"], a:contains("Demo")').length > 0,
    features: $('a[href*="features"], a:contains("Features")').length > 0,
    product: /product|shop|cart|checkout/i.test(s) || conversion.isEcommerce
  };

  // json-ld checks
  const hasSoftware = jsonLdBlocks.some(b => JSON.stringify(b).toLowerCase().includes('softwareapplication'));
  const hasProductLd = jsonLdBlocks.some(b => JSON.stringify(b).toLowerCase().includes('product'));
  const hasOrganization = jsonLdBlocks.some(b => JSON.stringify(b).toLowerCase().includes('organization'));

  // tech hints
  const isShopify = !!tech.shopify;
  const usesStripe = /stripe/i.test(s);
  const usesIntercom = /intercom|hs-scripts|hubspot/i.test(s);

  // heuristics to assign model
  const scores = {
    ecommerce: (isShopify || hasProductLd || /add to cart|shop now|buy now/i.test(ctaText) || urlPatterns.product) ? 1 : 0,
    saas: (hasSoftware || /start free trial|book demo|request demo|sign up for free|start free trial/i.test(ctaText) || urlPatterns.pricing || urlPatterns.demo) ? 1 : 0,
    marketplace: /marketplace|sellers|sell on|vendors/i.test(s) ? 1 : 0,
    agency: /agency|services|we help|we build|our services/i.test(s) ? 1 : 0,
    media: /blog|news|editorial|subscribe to our newsletter/i.test(s) ? 1 : 0,
    app_product: /download on the app store|play store|mobile app/i.test(s) ? 1 : 0,
    enterprise: /enterprise|enterprise pricing|contact sales|custom pricing/i.test(s) ? 1 : 0,
    consulting: /consulting|advisory|consultants/i.test(s) ? 1 : 0
  };

  // pick strongest (tie-break by ecommerce > saas > marketplace > media > agency)
  const ordering = ['ecommerce','saas','marketplace','enterprise','agency','media','app_product','consulting'];
  const kind = ordering.find(k => scores[k]) || 'unknown';

  // B2B/B2C/D2C inference
  const audience = /b2b|business customers|enterprise|for teams|for enterprises/i.test(s) ? 'B2B' :
                   /direct to consumer|shop|buy now|for you|for customers/i.test(s) ? 'B2C' :
                   'unknown';

  return {
    inferredModel: kind,
    modelScores: scores,
    audience: audience,
    hints: {
      ctaTextSample: ctaText.slice(0, 400),
      urlPatterns,
      techHints: { isShopify, usesStripe, usesIntercom }
    }
  };
}

function detectPricingStrategy(html, $) {
  const s = String(html).toLowerCase();
  const hasPricingPage = $('a[href*="pricing"], a:contains("Pricing")').length > 0;
  const hasTransparentPricing = /\$\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/.test(s);
  const hasEnterprisePricing = /contact sales|contact us for pricing|custom pricing|enterprise pricing|request demo/i.test(s);
  const isSubscription = /per month|monthly|annual|yearly|billed/i.test(s);
  const hasFreeTrial = /free trial|start free trial|try free/i.test(s);
  const freemium = /free plan|forever free|freemium/i.test(s);

  return {
    hasPricingPage,
    hasTransparentPricing,
    hasEnterprisePricing,
    isSubscription,
    hasFreeTrial,
    freemium,
    pricingTextSample: s.slice(0, 500)
  };
}

function estimateMargin(model, tech, resourceSummary) {
  // base ranges by model
  const base = {
    saas: { low: 70, high: 90 },
    ecommerce: { low: 20, high: 60 },
    marketplace: { low: 10, high: 40 },
    agency: { low: 30, high: 60 },
    media: { low: 10, high: 40 },
    consulting: { low: 30, high: 60 },
    unknown: { low: 20, high: 60 }
  }[model] || { low: 20, high: 60 };

  // adjusters (heuristics)
  let adj = 0;
  if (tech && (tech.shopify || tech.wordpress)) adj -= 10; // likely ecommerce or low margin merchant
  if (tech && tech.nextjs || tech.react) adj += 5; // engineering heavy -> better margins for SaaS
  if (resourceSummary && resourceSummary.totalJsKB && resourceSummary.totalJsKB > 2000) adj -= 5; // heavy frontend might increase costs
  if (tech && tech.cloudflare) adj += 3; // small positive for infra maturity

  const low = Math.max(0, base.low + adj);
  const high = Math.min(100, base.high + adj);
  const band = (low + high) / 2;

  return {
    low, high, estimate: `${Math.round(band)}%`,
    notes: `Heuristic based on model=${model}; adjustments applied: ${adj}`
  };
}

function discoverCompetitors(keywords, html, $) {
  // small open-source keyword -> competitor mapping (expandable)
  const mapping = {
    crm: ['HubSpot', 'Salesforce', 'Zoho CRM'],
    'task management': ['Asana', 'Trello', 'ClickUp', 'Jira'],
    'ecommerce': ['Shopify', 'BigCommerce', 'Magento'],
    'analytics': ['Google Analytics', 'Mixpanel', 'Amplitude'],
    'payment': ['Stripe', 'PayPal', 'Square']
  };

  const s = String(html).toLowerCase();
  const found = new Set();
  keywords.forEach(k => {
    for (const key in mapping) {
      if (k.includes(key) || s.includes(key)) mapping[key].forEach(c => found.add(c));
    }
  });

  // link pattern competitor discovery (/vs/ or "alternative to")
  const vsLinks = $('a[href*="/vs/"], a:contains("vs "), a:contains("vs.")').map((i, el) => $(el).attr('href')).get();
  vsLinks.forEach(h => {
    if (!h) return;
    const parts = h.split('/');
    const last = parts[parts.length-1];
    if (last) found.add(decodeURIComponent(last.replace(/[-_]/g,' ')));
  });

  // textual 'alternative to' patterns
  const altMatches = s.match(/alternative to ([a-z0-9 \-]+)/gi) || [];
  altMatches.forEach(m => found.add(m.replace(/alternative to /i, '').trim()));

  return {
    likelyCompetitors: Array.from(found).slice(0, 20),
    method: 'keyword + link-pattern heuristics'
  };
}

function estimateTrafficClass(sitemapInfo, resourceSummary, $) {
  const pages = sitemapInfo.pages || 0;
  // blog post count approximated via links containing /blog/
  const blogLinks = $('a[href*="/blog"], a[href*="/news"], a[href*="/posts"]').length;
  const languages = !!$('link[rel="alternate"][hreflang]').length || !!$('html[lang]').attr('lang');

  // rough banding
  let classLabel = 'Unknown';
  if (pages > 1000 || blogLinks > 100 || (resourceSummary && resourceSummary.resourcesCount > 1000)) classLabel = 'High (500k+/mo)';
  else if (pages > 200 || blogLinks > 20) classLabel = 'Mid (50k–300k/mo)';
  else classLabel = 'Small (<50k/mo)';

  return {
    estimatedTrafficClass: classLabel,
    indicators: {
      pagesIndexed: pages,
      blogPostsEstimate: blogLinks,
      multiLanguage: Boolean(languages),
      resourceFootprint: resourceSummary ? resourceSummary.resourcesCount : null
    }
  };
}

function detectSalesMaturity($, support, crm, sitePages, html) {
  const hasCaseStudies = $('a[href*="case-study"], a:contains("Case Study"), a:contains("Case studies")').length > 0;
  const hasContactSales = /contact sales|request demo|enterprise/i.test(html);
  const hasLiveChat = Object.values(support || {}).some(Boolean) || Object.values(crm || {}).some(Boolean);
  const hasPricing = sitePages.hasPricing;
  const crmPresent = Object.values(crm || {}).some(Boolean);

  let level = 'Low';
  const score = (hasCaseStudies ? 2 : 0) + (hasContactSales ? 2 : 0) + (hasLiveChat ? 1 : 0) + (hasPricing ? 1 : 0) + (crmPresent ? 1 : 0);
  if (score >= 5) level = 'High';
  else if (score >= 3) level = 'Medium';

  return {
    salesMaturity: level,
    signals: { hasCaseStudies, hasContactSales, hasLiveChat, hasPricing, crmPresent, score }
  };
}

function detectMarketingMaturity($, socialProfiles, metadata, html) {
  const blogLinks = $('a[href*="/blog"], a[href*="/news"], a[href*="/articles"]').length;
  const hasOg = metadata && (metadata.image || metadata.title);
  const socialCount = Object.keys(socialProfiles || {}).length;
  // freshness heuristic: many pages and some blog presence -> active
  let level = 'Low';
  if (blogLinks > 20 && socialCount >= 3 && hasOg) level = 'High';
  else if (blogLinks > 5 && socialCount >= 1 && hasOg) level = 'Medium';

  return {
    marketingMaturity: level,
    signals: { blogLinks, socialCount, hasOg }
  };
}

function inferTargetMarket($, html) {
  const lang = $('html').attr('lang') || null;
  let countryInUrl = null;
  try {
    const m = html.match(/\/(us|uk|ca|au|in|de|fr)\b/i);
    if (m) countryInUrl = m[1];
  } catch {}
  const currency = (html.match(/(USD|GBP|AUD|€|\$|£)/i) || [null])[0];
  // B2B vs B2C hint via keywords
  const b2b = /for teams|for enterprises|enterprise|for businesses|B2B/i.test(html);
  const audience = b2b ? 'B2B' : (/shop|buy now|shop now|retail/i.test(html) ? 'B2C' : 'unknown');

  return {
    language: lang,
    regionHint: countryInUrl,
    currencySample: currency,
    audience: audience
  };
}

function productComplexityScore($, html) {
  const hasDocs = $('a[href*="/docs"], a[href*="/developer"], a[href*="/api"], a:contains("API")').length > 0;
  const integrations = /integrations|zapier|salesforce|slack|github|shopify/i.test(html);
  const featurePages = $('a[href*="features"], a:contains("Features")').length;
  const pages = $('a').length;
  let score = 0;
  if (hasDocs) score += 40;
  if (integrations) score += 30;
  if (featurePages > 3) score += 20;
  if (pages > 200) score += 10;
  const tier = score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low';
  return { productComplexity: tier, score, signals: { hasDocs, integrations, featurePages } };
}

function detectMoatSignals(html, $) {
  const s = String(html).toLowerCase();
  const signals = [];
  if (/patent|patented|patents/i.test(s)) signals.push('Patents mentioned');
  if (/proprietary|proprietary technology|proprietary model/i.test(s)) signals.push('Proprietary tech claims');
  if (/machine learning|deep learning|neural network|ai model|nlp|ml models/i.test(s)) signals.push('ML/AI capability');
  if (/api-first|api-first|api docs|developer api|rest api|open api/i.test(s)) signals.push('API-first architecture');
  if (/salesforce|sap|serviceNow|oracle|workday/i.test(s)) signals.push('Enterprise integrations');

  return { moatSignals: signals.slice(0, 10) };
}

// master function that packages everything
function detectBusinessInsights({ html, $, tech, conversion, jsonLdBlocks, sitePages, keywords, resourceSummary, support, crm, socialProfiles, metadata, sitemapInfo }) {
  const model = detectBusinessModel(html, $, tech, conversion, jsonLdBlocks, sitePages, keywords);
  const pricing = detectPricingStrategy(html, $);
  const margin = estimateMargin(model.inferredModel, tech, resourceSummary);
  const competitors = discoverCompetitors(keywords, html, $);
  const traffic = estimateTrafficClass(sitemapInfo, resourceSummary, $);
  const sales = detectSalesMaturity($, support, crm, sitePages, html);
  const marketing = detectMarketingMaturity($, socialProfiles, metadata, html);
  const target = inferTargetMarket($, html);
  const complexity = productComplexityScore($, html);
  const moat = detectMoatSignals(html, $);

  return {
    businessModel: model,
    pricing,
    marginEstimate: margin,
    competitors,
    trafficEstimate: traffic,
    salesMaturity: sales,
    marketingMaturity: marketing,
    targetMarket: target,
    productComplexity: complexity,
    moatSignals: moat
  };
}

// ---------------------- SANITIZE & IMPUTE ----------------------
// This mutates the result, records what it changed in _imputed and imputationLog, and returns it.
function sanitizeAndImpute(result) {
  const clamp = (v, lo = 0, hi = 100) => (v == null ? null : Math.max(lo, Math.min(hi, v)));
  const isNumber = (v) => typeof v === 'number' && !Number.isNaN(v);
  const log = [];

  result._imputed = result._imputed || {};
  result.imputationLog = result.imputationLog || [];

  // 1) Normalize & clamp visible scores
  if (result.summarySignals) {
    if (!isNumber(result.summarySignals.seoScore) || result.summarySignals.seoScore < 0 || result.summarySignals.seoScore > 100) {
      const s = result;
      let recomputed = 0;
      if (s.htmlMetrics && s.htmlMetrics.title) recomputed += 20;
      if (s.htmlMetrics && s.htmlMetrics.description) recomputed += 20;
      if (s.content && Array.isArray(s.content.keywords) && s.content.keywords.length) recomputed += 20;
      if (s.siteSignals && s.siteSignals.hasSitemap) recomputed += 20;
      if (s.htmlMetrics && s.htmlMetrics.h1_present) recomputed += 20;
      result.summarySignals.seoScore = clamp(recomputed);
      result._imputed.seoScore = { estimated: true, method: 'heuristic: title/meta/h1/keywords/sitemap' };
      log.push(`seoScore missing/invalid -> estimated ${result.summarySignals.seoScore} using title/meta/h1/keywords/sitemap heuristic.`);
    } else {
      const orig = result.summarySignals.seoScore;
      result.summarySignals.seoScore = clamp(orig);
    }

    const lhAcc = result.performance && result.performance.accessibilityScore;
    let acc = result.summarySignals.accessibilityScore;
    if (isNumber(lhAcc)) {
      if (!isNumber(acc)) {
        result.summarySignals.accessibilityScore = clamp(lhAcc);
        result._imputed.accessibilityScore = { estimated: true, method: 'from lighthouse accessibilityScore' };
        log.push(`accessibilityScore missing -> used lighthouse.accessibilityScore = ${lhAcc}.`);
      } else {
        const diff = Math.abs(acc - lhAcc);
        if (diff > 20) {
          const blended = Math.round((acc + lhAcc) / 2);
          result.summarySignals.accessibilityScore = clamp(blended);
          result._imputed.accessibilityScore = { estimated: true, method: `blend heuristic avg(${acc}, ${lhAcc}) due to diff ${diff}` };
          log.push(`accessibilityScore and lighthouse differ by ${diff} -> blended to ${blended}.`);
        } else {
          result.summarySignals.accessibilityScore = clamp((acc + lhAcc) / 2);
          log.push(`accessibilityScore blended with lighthouse to ${result.summarySignals.accessibilityScore}.`);
        }
      }
    } else {
      result.summarySignals.accessibilityScore = clamp(acc != null ? acc : 50);
      if (!isNumber(acc)) {
        result._imputed.accessibilityScore = { estimated: true, method: 'fallback default 50' };
        log.push('accessibilityScore missing -> defaulted to 50.');
      }
    }

    let sec = result.summarySignals.securityScore;
    result.summarySignals.securityScore = clamp(isNumber(sec) ? sec : (result.security ? (
      (result.security.hasCSP ? 33 : 0) + (result.security.hasHSTS ? 33 : 0) + (result.security.hasXFrame ? 34 : 0)
    ) : 0));
    if (!isNumber(sec)) {
      result._imputed.securityScore = { estimated: true, method: 'derived from security headers flags' };
      log.push('securityScore missing -> derived from security header flags.');
    }
  }

  // 2) Performance estimate (summarySignals.performanceEstimate)
  if (result.summarySignals) {
    const perf = result.summarySignals.performanceEstimate;
    if (!isNumber(perf)) {
      const lhPerf = result.performance && result.performance.performanceScore;
      if (isNumber(lhPerf)) {
        result.summarySignals.performanceEstimate = clamp(lhPerf);
        result._imputed.performanceEstimate = { estimated: true, method: 'lighthouse performanceScore' };
        log.push(`performanceEstimate missing -> used lighthouse.performanceScore = ${lhPerf}.`);
      } else {
        const r = result.resources || {};
        const jsKB = Number(r.totalJsKB || 0);
        const imgKB = Number(r.totalImageKB || 0);
        const dom = Number(r.domNodes || 0);
        if (jsKB || imgKB || dom) {
          let est = 100;
          est -= Math.min(60, Math.round(jsKB / 10));
          est -= Math.min(30, Math.round(imgKB / 100));
          est -= Math.min(20, Math.round(dom / 200));
          est = clamp(est);
          result.summarySignals.performanceEstimate = est;
          result._imputed.performanceEstimate = { estimated: true, method: 'heuristic from totalJsKB/totalImageKB/domNodes' };
          log.push(`performanceEstimate missing -> heuristically estimated ${est} from jsKB=${jsKB}, imgKB=${imgKB}, dom=${dom}.`);
        } else {
          result.summarySignals.performanceEstimate = null;
          result._imputed.performanceEstimate = { estimated: false, reason: 'no lighthouse and no resource metrics' };
          log.push('performanceEstimate could not be estimated (no lighthouse and no resource metrics).');
        }
      }
    } else {
      result.summarySignals.performanceEstimate = clamp(perf);
    }
  }

  // 3) Resources: try to estimate totalImageKB / totalJsKB if missing but counts exist
  if (result.resources) {
    if (result.resources.totalImageKB == null && isNumber(result.htmlMetrics && result.htmlMetrics.images)) {
      const images = result.htmlMetrics.images;
      const estImgKB = Math.round(images * 120);
      result._imputed.totalImageKB = { estimated: true, method: `images_count * 120KB (images=${images})` };
      result.resources.totalImageKB = estImgKB;
      log.push(`totalImageKB missing -> estimated ${estImgKB} KB from ${images} img(s) * 120KB.`);
    }
    if (result.resources.totalJsKB == null && isNumber(result.resources.resourcesCount)) {
      const estJsKB = Math.round((result.resources.resourcesCount || 0) * 15);
      result._imputed.totalJsKB = { estimated: true, method: `resources_count * 15KB (resources=${result.resources.resourcesCount})` };
      result.resources.totalJsKB = estJsKB;
      log.push(`totalJsKB missing -> estimated ${estJsKB} KB from resourcesCount * 15KB.`);
    }
  }

  // 4) Traffic estimate fallback
  if (result.trafficEstimate && (!result.trafficEstimate.estimatedTrafficClass || result.trafficEstimate.estimatedTrafficClass === 'Unknown')) {
    const t = result.trafficEstimate || {};
    const pages = t.indicators && t.indicators.pagesIndexed;
    const blog = t.indicators && t.indicators.blogPostsEstimate;
    let guessed = null;
    if (pages >= 1000 || (result.content && result.content.headers && result.content.headers.length > 200)) {
      guessed = 'High (500k+/mo)';
    } else if ((pages >= 200) || (blog >= 20)) {
      guessed = 'Mid (50k–300k/mo)';
    } else if (pages > 0 || blog > 0) {
      guessed = 'Small (<50k/mo)';
    }
    if (guessed) {
      result.trafficEstimate = result.trafficEstimate || {};
      result.trafficEstimate.estimatedTrafficClass = guessed;
      result._imputed.trafficEstimate = { estimated: true, method: 'heuristic from sitemap pages and blog links' };
      log.push(`trafficEstimate missing/unknown -> guessed '${guessed}' from pages=${pages} blog=${blog}.`);
    } else {
      result.trafficEstimate = result.trafficEstimate || {};
      result.trafficEstimate.estimatedTrafficClass = 'Unknown';
      result._imputed.trafficEstimate = { estimated: false, reason: 'insufficient signals (no sitemap/pages/blog links)' };
      log.push('trafficEstimate could not be guessed (insufficient signals).');
    }
  }

  // 5) Business insights: ensure a few key fields exist, otherwise mark unknown
  if (result.businessInsights) {
    const bi = result.businessInsights;
    if (!bi.businessModel || !bi.businessModel.inferredModel || bi.businessModel.inferredModel === 'unknown') {
      const fromTech = (result.hosting && result.hosting.vercel) ? 'saas' : null;
      const conversionSignals = result.conversionSignals || {};
      let guess = null;
      if (conversionSignals.hasCheckout || bi.pricing && bi.pricing.isSubscription === false && bi.pricing.hasTransparentPricing) guess = 'ecommerce';
      else if (bi.pricing && bi.pricing.isSubscription) guess = 'saas';
      else if (fromTech) guess = fromTech;
      if (guess) {
        bi.businessModel = bi.businessModel || {};
        bi.businessModel.inferredModel = guess;
        result._imputed.businessModel = { estimated: true, method: `heuristic based on conversionSignals/tech -> ${guess}` };
        log.push(`businessModel.inferredModel missing/unknown -> guessed '${guess}'.`);
      } else {
        result._imputed.businessModel = { estimated: false, reason: 'no decisive conversion/tech signal' };
        log.push('businessModel.inferredModel could not be determined.');
      }
    }
  }

  // 6) Mark missing metadata fields explicitly
  const watchFields = [
    ['canonical', result.canonical],
    ['metadata.title', result.metadata && result.metadata.title],
    ['openGraph.ogTitle', result.openGraph && result.openGraph.ogTitle],
    ['htmlMetrics.title', result.htmlMetrics && result.htmlMetrics.title]
  ];
  watchFields.forEach(([name, value]) => {
    if (!value) {
      result.imputationLog.push(`Missing: ${name} not found on page.`);
    }
  });

  // 7) Tidy numeric types (ensure numbers where expected)
  try {
    if (result.resources) {
      ['domNodes','resourcesCount','totalImageKB','totalJsKB','thirdPartyRequests','thirdPartyScripts'].forEach(k => {
        if (result.resources[k] != null) result.resources[k] = Number(result.resources[k]);
      });
    }
    if (result.summarySignals) {
      ['seoScore','accessibilityScore','securityScore','performanceEstimate'].forEach(k => {
        if (result.summarySignals[k] != null) result.summarySignals[k] = Number(result.summarySignals[k]);
      });
    }
    if (result.performance) {
      ['performanceScore','accessibilityScore','seoScore','lcp','cls','tbt'].forEach(k => {
        if (result.performance[k] != null) result.performance[k] = Number(result.performance[k]);
      });
    }
  } catch (e) {
    log.push('Type normalization encountered an issue: ' + String(e));
  }

  // 8) Attach imputationLog contents (append our local logs)
  result.imputationLog = result.imputationLog.concat(log);

  return result;
}

// ---------------------- MAIN ----------------------
export async function analyzeWebsite(url, options = { runLighthouse: true, collectResources: true }) {
  const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;

  // 1) Try a fast fetch to get HTML + headers
  const fetchRes = await safeFetch(normalizedUrl, 15000);
  let html = fetchRes?.text || null;
  const fetchHeaders = fetchRes?.headers || null;

  // 2) If html is missing or tiny, use puppeteer to fetch page content and resource metrics
  let resourceMetrics = null;
  if (!html || html.length < 1000 || options.collectResources) {
    try {
      resourceMetrics = await gatherResourceMetrics(normalizedUrl);
      // use the puppeteer-returned html if we didn't get one earlier
      if (!html || html.length < 1000) html = resourceMetrics.html;
    } catch (e) {
      resourceMetrics = resourceMetrics || null;
    }
  }

  // if still no html, bail with minimal info
  if (!html) throw new Error(`Unable to retrieve HTML for ${normalizedUrl}`);

  const $ = cheerio.load(html);

  // json-ld, metascraper, keywords
  const jsonLdBlocks = extractJsonLd($);
  const metadata = await scraper({ html, url: normalizedUrl }).catch(() => ({}));
  const keywords = (function extractKeywordsFromHtmlLocal(htmlContent, limit = 20) {
    const text = cheerio.load(htmlContent)('body').text().replace(/\s+/g, ' ');
    const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    const freq = {};
    const stopwords = new Set(['this','that','with','from','your','have','will','here','true','null','https','http']);
    for (const w of words) if (!stopwords.has(w)) freq[w] = (freq[w] || 0) + 1;
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word]) => word);
  })(html, 20);

  const sitemapInfo = await fetchSitemapInfo(normalizedUrl);
  const robotsInfo = await fetchRobotsInfo(normalizedUrl);

  // tech detection
  const tech = detectTech(html, $);

  // conversion & page type
  const conversion = detectConversion($, jsonLdBlocks, normalizedUrl);

  // social
  const socialProfiles = extractSocialLinks($);

  // support & crm
  const { support, crm } = detectSupportAndCrm(html);

  // accessibility
  const accessibilitySignals = detectAccessibility($);

  // og & twitter meta
  const og = {
    ogTitle: $('meta[property="og:title"]').attr('content') || null,
    ogDescription: $('meta[property="og:description"]').attr('content') || null,
    ogImage: $('meta[property="og:image"]').attr('content') || null,
    twitterCard: $('meta[name="twitter:card"]').attr('content') || null,
    twitterImage: $('meta[name="twitter:image"]').attr('content') || null
  };

  // site pages
  const sitePages = detectSitePages($);

  // security headers (prefer fetch headers; fallback to resourceMetrics main-document headers)
  let securityHeadersSource = fetchHeaders;
  if ((!securityHeadersSource || typeof securityHeadersSource.get !== 'function') && resourceMetrics && resourceMetrics.resourceListSample) {
    const doc = resourceMetrics.resourceListSample.find(r => r.resourceType === 'document' || r.url === normalizedUrl) || resourceMetrics.resourceListSample[0];
    securityHeadersSource = (doc && doc.headers) ? doc.headers : securityHeadersSource;
  }
  const getHeader = (k) => {
    if (!securityHeadersSource) return null;
    if (typeof securityHeadersSource.get === 'function') return securityHeadersSource.get(k) || null;
    return (securityHeadersSource[k.toLowerCase()] || securityHeadersSource[k]) || null;
  };
  const security = {
    hasCSP: !!getHeader('content-security-policy'),
    hasHSTS: !!getHeader('strict-transport-security'),
    hasXFrame: !!getHeader('x-frame-options'),
    hasXSSProtection: !!getHeader('x-xss-protection'),
    serverHeader: getHeader('server') || null
  };

  // hosting / CDN detection
  const hosting = detectHostingFromHeaders(securityHeadersSource);

  // resource metrics fallback shapes if not collected
  const resourceSummary = resourceMetrics ? {
    domNodes: resourceMetrics.domNodes,
    resourcesCount: resourceMetrics.resourcesCount,
    totalImageKB: resourceMetrics.totalImageKB,
    totalJsKB: resourceMetrics.totalJsKB,
    thirdPartyRequests: resourceMetrics.thirdPartyRequests,
    thirdPartyScripts: resourceMetrics.thirdPartyScripts
  } : { domNodes: null, resourcesCount: null, totalImageKB: null, totalJsKB: null, thirdPartyRequests: null, thirdPartyScripts: null };

  // LLM-ready cleaned text + headers
  const { cleanText, headers } = extractCleanTextAndSections($);

  // simple summary-level signals (scores out of 100) - heuristic blends
  const summarySignals = {
    seoScore: Math.max(0, Math.min(100, (
      ( ( $('title').text() ? 20 : 0 ) +
        ( $('meta[name="description"]').attr('content') ? 20 : 0 ) +
        ( $('h1').length ? 20 : 0 ) +
        ( keywords.length ? 20 : 0 ) +
        ( sitemapInfo.sitemapUrl ? 20 : 0 )
      ) ))),
    accessibilityScore: (() => {
      const base = 100;
      let deductions = 0;
      if (accessibilitySignals.unlabeledButtons > 5) deductions += 25;
      if (accessibilitySignals.linksWithoutText > 10) deductions += 25;
      if (accessibilitySignals.ariaCount < 1) deductions += 20;
      return Math.max(0, base - deductions);
    })(),
    securityScore: (() => {
      let s = 0;
      if (security.hasCSP) s += 33;
      if (security.hasHSTS) s += 33;
      if (security.hasXFrame) s += 34;
      return s;
    })(),
    performanceEstimate: (() => {
      if (!resourceMetrics) return null;
      let score = 100;
      if (resourceMetrics.totalJsKB > 500) score -= 30;
      if (resourceMetrics.totalImageKB > 2000) score -= 30;
      if (resourceMetrics.domNodes > 3000) score -= 20;
      return Math.max(0, score);
    })()
  };

  // business insights (new)
  const businessInsights = detectBusinessInsights({
    html,
    $,
    tech,
    conversion,
    jsonLdBlocks,
    sitePages,
    keywords,
    resourceSummary,
    support,
    crm,
    socialProfiles,
    metadata,
    sitemapInfo
  });

  // lighthouse (optional heavy)
  const lighthouseResult = options.runLighthouse ? await runLighthouse(normalizedUrl) : null;

  // final assembled JSON (build it, then sanitize & impute)
  const final = {
    url: normalizedUrl,
    domain: new URL(normalizedUrl).hostname,
    canonical: tech.canonical,
    pageType: conversion.pageType,
    siteSignals: {
      hasSitemap: Boolean(sitemapInfo.sitemapUrl),
      sitemapUrl: sitemapInfo.sitemapUrl,
      pagesIndexedEstimate: sitemapInfo.pages,
      sitemapLatestDate: sitemapInfo.latestSitemapDate,
      robots: Boolean(robotsInfo.robots),
      crawlAllowed: robotsInfo.crawlAllowed,
      analytics: tech.analytics,
      ssl_valid: normalizedUrl.startsWith('https://')
    },
    security,
    hosting,
    htmlMetrics: {
      title: $('title').text().trim() || null,
      description: $('meta[name="description"]').attr('content') || null,
      h1_text: $('h1').first().text().trim() || null,
      h1_present: Boolean($('h1').length && $('h1').text().trim()),
      wordCount: $('body').text().split(/\s+/).filter(Boolean).length,
      links: $('a').length,
      images: $('img').length,
      missingAlt: $('img:not([alt])').length
    },
    metadata,
    openGraph: og,
    seo: {
      titleLength: ($('title').text()||'').length,
      metaDescLength: ($('meta[name="description"]').attr('content')||'').length,
      h1_present: Boolean($('h1').text().trim()),
      structuredDataTypes: Array.from(new Set(jsonLdBlocks.flatMap(b => {
        if(b && b['@type']) return Array.isArray(b['@type']) ? b['@type'] : [b['@type']];
        if(b && b['@graph']) return b['@graph'].map(g => g['@type']);
        return [];
      }))).map(s => String(s).toLowerCase())
    },
    content: {
      keywords,
      contentFreshness: { latest: sitemapInfo.latestSitemapDate || null },
      ctaCount: conversion.ctaCount,
      wordCount: $('body').text().split(/\s+/).filter(Boolean).length,
      images: $('img').length,
      missingAlt: $('img:not([alt])').length,
      cleanText,
      headers
    },
    resources: resourceSummary,
    performance: lighthouseResult,
    social: {
      profiles: socialProfiles,
      presenceScore: computeSocialScore(socialProfiles)
    },
    conversionSignals: {
      hasCheckout: conversion.hasCart,
      hasNewsletter: Boolean($('input[type="email"]').length),
      ctaCount: conversion.ctaCount,
      forms: conversion.forms,
      pricingPage: sitePages.hasPricing,
      careersPage: sitePages.hasCareers,
      blog: sitePages.hasBlog
    },
    supportWidgets: support,
    crmIndicators: crm,
    accessibility: accessibilitySignals,
    summarySignals,
    businessInsights,
    analyzedAt: new Date().toISOString()
  };

  // sanitize, smooth noise, impute reasonable defaults and add imputation logs
  sanitizeAndImpute(final);

  // return the audited, imputation-annotated object (ready for LLM)
  return final;
}
