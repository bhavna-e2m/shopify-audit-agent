import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

function looksLikeShopify(html) {
  return /shopify|cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme/i.test(html);
}

function safeName(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export async function collectReferenceScreenshots({ urls = [], outputDir }) {
  const valid = [...new Set((urls || []).map((u) => String(u).trim()).filter(Boolean))].slice(
    0,
    2
  );
  if (!valid.length) return [];

  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = [];
  for (let i = 0; i < valid.length; i += 1) {
    const url = valid[i];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
      const html = await page.content();
      if (!looksLikeShopify(html)) continue;

      const title = await page.title();
      const fileName = `${String(i + 1).padStart(2, "0")}-${safeName(new URL(url).hostname)}.png`;
      const fullPath = path.join(outputDir, fileName);
      await page.screenshot({ path: fullPath, fullPage: true });

      results.push({
        url,
        title: title || new URL(url).hostname,
        screenshotPath: fullPath
      });
    } catch {
      // Skip invalid reference URLs
    }
  }

  await browser.close();
  return results;
}
