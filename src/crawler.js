import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { mkdir } from "node:fs/promises";
import path from "node:path";

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function abs(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return "";
  }
}

function classifyPage(url) {
  if (/\/products\//i.test(url)) return "product";
  if (/\/collections\//i.test(url)) return "collection";
  if (/\/pages\/faq|\/faq/i.test(url)) return "faq";
  if (/\/pages\/contact|\/contact/i.test(url)) return "contact";
  if (/\/pages\/warranty|\/warranty/i.test(url)) return "warranty";
  return "general";
}

function buildElementSelector($, el) {
  if (!el || !el.attribs) return "";
  const tag = el.tagName || el.name || "section";
  if (el.attribs.id) return `#${el.attribs.id}`;
  if (el.attribs["data-section-id"]) {
    return `${tag}[data-section-id="${el.attribs["data-section-id"]}"]`;
  }
  if (el.attribs["data-section-type"]) {
    return `${tag}[data-section-type="${el.attribs["data-section-type"]}"]`;
  }
  if (el.attribs.class) {
    const cls = String(el.attribs.class)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join(".");
    if (cls) return `${tag}.${cls}`;
  }
  return tag;
}

function detectAboveFoldModule($) {
  const prioritySelectors = [
    "section[id*='hero']",
    "section[class*='hero']",
    "section[class*='banner']",
    "section[class*='slideshow']",
    "[data-section-type*='slideshow']",
    "[data-section-type*='hero']",
    ".hero",
    ".banner",
    ".slideshow",
    "main > section:first-child",
    "main > div:first-child"
  ];

  let moduleEl = null;
  for (const selector of prioritySelectors) {
    const candidate = $(selector).first();
    if (candidate.length) {
      moduleEl = candidate.get(0);
      break;
    }
  }

  if (!moduleEl) return null;

  const moduleNode = $(moduleEl);
  const moduleText = cleanText(moduleNode.text()).slice(0, 500);
  const hasHeadline =
    moduleNode.find("h1,h2,[class*='headline'],[class*='title']").length > 0 ||
    moduleText.length > 40;
  const hasCta =
    moduleNode.find("a[href],button").length > 0 &&
    /shop|buy|learn|explore|get|start|view|discover|quote|contact/i.test(moduleText);

  return {
    selector: buildElementSelector($, moduleEl),
    hasHeadline,
    hasCta,
    messageAndCtaPresent: Boolean(hasHeadline && hasCta),
    textSnippet: moduleText
  };
}

function extractSignals(url, html, runtimeHints = {}) {
  const $ = cheerio.load(html);
  const text = cleanText($("body").text()).slice(0, 5000);
  const aboveFoldModule = detectAboveFoldModule($);

  const headerText = cleanText($("header").first().text()).slice(0, 800);
  const footerText = cleanText($("footer").first().text()).slice(0, 1200);
  const heroText = cleanText($("main h1, .banner h1, .hero h1").first().text());
  const ctaCandidates = [
    $("button[name='add'], button:contains('Add to cart')").first().text(),
    $("a:contains('Shop Now'), a:contains('Shop now')").first().text()
  ]
    .map(cleanText)
    .filter(Boolean);

  const hasReviews = /review|star|rated/i.test(text);
  const hasUgc = /instagram|customer photo|testimonial|ugc/i.test(text);
  const hasTrust = /warranty|secure|rfid|guarantee|free shipping|returns/i.test(text);
  const hasStickyHeaderClassHint = /sticky/i.test($("header").attr("class") || "");
  const hasStickyHeaderCssHint = /position\s*:\s*(sticky|fixed)/i.test(html);
  const hasStickyHeaderHint = Boolean(
    runtimeHints.hasStickyHeaderDetected || hasStickyHeaderClassHint || hasStickyHeaderCssHint
  );
  const hasWishlist = /wishlist/i.test(text);
  const hasLiveChat = /chat|intercom|tawk|zendesk/i.test(html);
  const smallFontRisk = /font-size:\s*(10|11|12)px/i.test(html);
  const hasHeroSection =
    $("section[class*='hero'], section[class*='banner'], .hero, .banner, [data-section-type*='slideshow'], .slideshow").length > 
      0 || Boolean(heroText) || Boolean(aboveFoldModule?.selector);
  const hasCollectionFilter =
    /\/collections\//i.test(url) &&
    ($("[class*='filter']").length > 0 ||
      $("[data-filter]").length > 0 ||
      /filter by|sort by|facet|facets/i.test(text));
  const hasCollectionSort =
    /\/collections\//i.test(url) &&
    ($("select[name*='sort'], [class*='sort']").length > 0 || /sort by/i.test(text)); 

  const links = $("a[href]")
    .map((_, a) => $(a).attr("href"))
    .get()
    .map((href) => abs(url, href))
    .filter((u) => /^https?:\/\//.test(u));

  return {
    pageType: classifyPage(url),
    title: cleanText($("title").text()),
    url,
    heroText,
    headerText,
    footerText,
    ctaCandidates,
    flags: {
      hasReviews,
      hasUgc,
      hasTrust,
      hasStickyHeaderHint,
      hasWishlist,
      hasLiveChat,
      smallFontRisk,
      hasHeroSection,
      hasCollectionFilter,
      hasCollectionSort,
      hasStickyHeaderDetected: Boolean(runtimeHints.hasStickyHeaderDetected)
    },
    textSnippet: text,
    aboveFoldModule,
    aboveFoldScreenshotPath: "",
    links
  };
}

async function detectRuntimeHints(page) {
  try {
    return await page.evaluate(async () => {
      const pickHeader = () =>
        document.querySelector("header") ||
        document.querySelector("[id*='header']") ||
        document.querySelector("[class*='header']");

      const header = pickHeader();
      if (!header) return { hasStickyHeaderDetected: false };

      const beforeRect = header.getBoundingClientRect();
      const beforeStyle = window.getComputedStyle(header);

      window.scrollTo({ top: Math.min(800, document.body.scrollHeight), behavior: "instant" });
      await new Promise((r) => setTimeout(r, 180));

      const afterRect = header.getBoundingClientRect();
      const afterStyle = window.getComputedStyle(header);

      const usesStickyStyle =
        /sticky|fixed/i.test(beforeStyle.position || "") ||
        /sticky|fixed/i.test(afterStyle.position || "");
      const remainsPinned = Math.abs(afterRect.top) <= 3;
      const movedAway = afterRect.top < -20;

      const hasStickyHeaderDetected = Boolean(usesStickyStyle || (remainsPinned && !movedAway));
      return { hasStickyHeaderDetected };
    });
  } catch {
    return { hasStickyHeaderDetected: false };
  }
}

function shouldQueueLink(startUrl, link) {
  const sameDomain = new URL(link).hostname === new URL(startUrl).hostname; 
  if (!sameDomain) return false;
  return /\/products\/|\/collections\/|\/pages\/faq|\/faq|\/contact|\/warranty/i.test(  
    link
  );
}

function detectShopifyFromHtml(html) {
  return /shopify|cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme/i.test(html);
}

function safeName(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function saveScreenshotIfEnabled(page, signal, index, screenshotDir) {
  if (!screenshotDir) return "";
  try {
    await mkdir(screenshotDir, { recursive: true });
    const fileName = `${String(index + 1).padStart(2, "0")}-${safeName(
      signal.pageType || "page"
    )}-${safeName(new URL(signal.url).pathname || "home")}.png`;
    const fullPath = path.join(screenshotDir, fileName);
    await page.screenshot({ path: fullPath, fullPage: true });
    return fullPath;
  } catch {
    return "";
  }
}

async function saveAboveFoldScreenshotIfEnabled(page, signal, index, screenshotDir) {
  if (!screenshotDir || !signal?.aboveFoldModule?.selector) return "";
  try {
    await mkdir(screenshotDir, { recursive: true });
    const fileName = `${String(index + 1).padStart(2, "0")}-abovefold-${safeName(
      signal.pageType || "page"
    )}.png`;
    const fullPath = path.join(screenshotDir, fileName);
    const locator = page.locator(signal.aboveFoldModule.selector).first();
    if ((await locator.count()) === 0) return "";
    await locator.screenshot({ path: fullPath });
    return fullPath;
  } catch {
    return "";
  }
}

async function saveSectionScreenshotsIfEnabled(page, signal, index, screenshotDir) {
  if (!screenshotDir) return {};

  const sectionSelectorsByPageType = {
    general: {
      announcement: "[class*='announcement'], [id*='announcement'], .announcement-bar",
      header: "header",
      hero: "section[class*='hero'], section[class*='banner'], .hero, .banner, [data-section-type*='slideshow']",
      trust: "[class*='trust'], [id*='trust'], [class*='usp'], [id*='usp']",
      featured: "section[class*='featured'], [id*='featured'], [class*='best-seller'], [id*='best-seller']",
      footer: "footer"
    },
    collection: {
      heading: "main h1, .collection-hero h1, [class*='collection'] h1",
      intro: ".collection-hero, [class*='collection-description'], [id*='collection-description']",
      filterSort:
        "[class*='filter'], [id*='filter'], [data-filter], [class*='sort'], [id*='sort'], select[name*='sort']",
      productGrid: "[class*='product-grid'], [id*='product-grid'], .grid, main [class*='product']"
    },
    product: {
      titlePriceCta:
        "h1, [class*='product-title'], [id*='product-title'], form[action*='/cart/add'], button[name='add']",
      media: "[class*='product-media'], [id*='product-media'], [class*='gallery'], [id*='gallery']",
      trust: "[class*='shipping'], [class*='warranty'], [class*='guarantee'], [id*='shipping'], [id*='warranty']",
      upsell:
        "[class*='related'], [id*='related'], [class*='recommend'], [id*='recommend'], [class*='recently-viewed']"
    }
  };

  const byType =
    sectionSelectorsByPageType[signal.pageType] || sectionSelectorsByPageType.general;
  const entries = Object.entries(byType);
  const result = {};

  for (const [sectionKey, selector] of entries) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      const fileName = `${String(index + 1).padStart(2, "0")}-section-${safeName(
        signal.pageType || "general"
      )}-${safeName(sectionKey)}.png`;
      const fullPath = path.join(screenshotDir, fileName);
      await locator.screenshot({ path: fullPath });
      result[sectionKey] = fullPath;
    } catch {
      // Ignore section-level screenshot failures and continue.
    }
  }

  return result;
}

async function crawlStoreWithFetch(startUrl, maxPages, initialQueue = [startUrl]) {
  const queue = [...initialQueue];
  const visited = new Set();
  const pages = [];
  let shopifyDetected = false;

  while (queue.length && pages.length < maxPages) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);

    try {
      const res = await fetch(next, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        }
      });
      const html = await res.text();

      if (detectShopifyFromHtml(html)) shopifyDetected = true;

      const signal = extractSignals(next, html);
      signal.screenshotPath = "";
      signal.aboveFoldScreenshotPath = "";
      signal.sectionScreenshots = {};
      pages.push(signal);

      for (const link of signal.links) {
        if (shouldQueueLink(startUrl, link) && !visited.has(link)) queue.push(link);
      }
    } catch {
      // Skip failing pages and continue crawl.
    }
  }

  return { shopifyDetected, pages };
}

export async function crawlStore(startUrl, maxPages = 8, options = {}) {
  const additionalPageUrls = Array.isArray(options.additionalPageUrls)
    ? options.additionalPageUrls.filter(Boolean)
    : [];

  if (process.env.AUDIT_USE_FETCH_ONLY === "1") {
    const queue = [startUrl, ...additionalPageUrls];
    const uniqueQueue = Array.from(new Set(queue));
    return crawlStoreWithFetch(uniqueQueue[0], maxPages, uniqueQueue);
  }

  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const queue = Array.from(new Set([startUrl, ...additionalPageUrls]));
    const visited = new Set();
    const pages = [];
    let shopifyDetected = false;

    while (queue.length && pages.length < maxPages) {
      const next = queue.shift();
      if (!next || visited.has(next)) continue;
      visited.add(next);

      try {
        await page.goto(next, { waitUntil: "domcontentloaded", timeout: 30000 });
        const html = await page.content();

        if (detectShopifyFromHtml(html)) shopifyDetected = true;

        const runtimeHints = await detectRuntimeHints(page);
        const signal = extractSignals(next, html, runtimeHints);
        signal.screenshotPath = await saveScreenshotIfEnabled(
          page,
          signal,
          pages.length,
          process.env.AUDIT_SCREENSHOT_DIR || "" 
        );
        signal.aboveFoldScreenshotPath = await saveAboveFoldScreenshotIfEnabled(
          page,
          signal,
          pages.length,
          process.env.AUDIT_SCREENSHOT_DIR || ""
        );
        signal.sectionScreenshots = await saveSectionScreenshotsIfEnabled(
          page,
          signal,
          pages.length,
          process.env.AUDIT_SECTION_SCREENSHOT_DIR || process.env.AUDIT_SCREENSHOT_DIR || ""
        );
        pages.push(signal);

        for (const link of signal.links) {
          if (shouldQueueLink(startUrl, link) && !visited.has(link)) queue.push(link);
        }
      } catch {
        // Skip failing pages and continue crawl.
      }
    }

    await browser.close();
    return { shopifyDetected, pages };
  } catch {
    // Browser launch can fail in restricted environments; use static HTTP crawl fallback.
    return crawlStoreWithFetch(startUrl, maxPages);
  }
}
