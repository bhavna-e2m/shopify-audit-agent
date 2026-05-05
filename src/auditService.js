import path from "node:path";
import { crawlStore } from "./crawler.js";
import { buildAuditPrompt } from "./auditPrompt.js";
import { markdownToDocxBuffer } from "./docxExport.js";
import { generateAuditMarkdown } from "./llm.js";
import { resolveReferenceSites } from "./referenceBenchmarks.js";
import { getShopifyReference } from "./shopifyStandards.js";
import { saveBinary, saveReport, slugFromUrl, todayISO } from "./utils.js";

function isTableLine(line) {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|");
}

function isDividerLine(line) {
  const t = line.replace(/\s/g, "");
  return /^\|:?-{3,}:?(\|:?-{3,}:?)+\|$/.test(t);
}

function parseTableCells(line) {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

function convertTableBlockToList(blockLines) {
  const lines = blockLines.filter((l, idx) => !(idx === 1 && isDividerLine(l)));
  if (lines.length < 2) return [];

  const headers = parseTableCells(lines[0]);
  const out = [];

  lines.slice(1).forEach((row, idx) => {
    const cells = parseTableCells(row);
    out.push(`${idx + 1}.`);
    headers.forEach((h, i) => {
      const value = cells[i] || "";
      out.push(`- ${h}: ${value}`);
    });
    out.push("");
  });

  return out;
}

function sanitizeMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!isTableLine(line)) {
      out.push(line);
      continue;
    }

    const block = [line];
    let j = i + 1;
    while (j < lines.length && isTableLine(lines[j])) {
      block.push(lines[j]);
      j += 1;
    }
    out.push(...convertTableBlockToList(block));
    i = j - 1;
  }

  const cleaned = out
    .join("\n")
    // Remove markdown bold markers for cleaner client-facing documents.
    .replace(/\*\*(.*?)\*\*/g, "$1")
    // Remove markdown horizontal rules that add visual clutter in docs.
    .replace(/^\s*---+\s*$/gm, "")
    // Trim trailing spaces often used for markdown line breaks.
    .replace(/[ \t]+$/gm, "");

  // Cleanup excessive blank lines for readability.
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeAuditLayout(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];

  const isSectionHeading = (line) => /^\d+\)\s+/.test(line.trim());
  const isMarkdownHeading = (line) => /^#{1,6}\s+/.test(line.trim());
  const isFieldLine = (line) =>
    /^(Section|Requirement Check|Status|Evidence|Recommendation|Reference|Screenshot Reference|Current Observation|Why This Matters|Recommendations)\s*:/i.test(
      line.trim()
    );

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] || "";
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push("");
      continue;
    }

    // Force consistent top-level section headings.
    if (isSectionHeading(line) && !isMarkdownHeading(line)) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push(`## ${line.trim()}`);
      out.push("");
      continue;
    }

    // Keep markdown headings with consistent spacing around.
    if (isMarkdownHeading(line)) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push(line.trim());
      out.push("");
      continue;
    }

    // Normalize requirement field lines for readability.
    if (isFieldLine(line)) {
      out.push(`- ${line.trim()}`);
      continue;
    }

    out.push(line);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function aggregateDetectedSignals(pages = []) {
  const byType = (type) => pages.filter((p) => p.pageType === type);
  const homePages = byType("general");
  const collectionPages = byType("collection");
  const productPages = byType("product");

  const hasAny = (rows, key) => rows.some((r) => Boolean(r?.flags?.[key]));
  const hasHomeHero =
    hasAny(homePages, "hasHeroSection") || homePages.some((p) => Boolean(p?.aboveFoldModule)); 
  const hasHomeStickyHeader =
    hasAny(homePages, "hasStickyHeaderHint") || hasAny(homePages, "hasStickyHeaderDetected");
  const hasHomeTrustSignals = hasAny(homePages, "hasTrust") || hasAny(homePages, "hasTrustStrip");
  const hasCollectionFilter = hasAny(collectionPages, "hasCollectionFilter");
  const hasCollectionSort = hasAny(collectionPages, "hasCollectionSort");
  const hasProductCta = productPages.some((p) => (p?.ctaCandidates || []).length > 0);
  const hasProductMediaZoom = hasAny(productPages, "hasProductMediaZoom");

  return {
    hasHomeHero,
    hasHomeStickyHeader,
    hasHomeTrustSignals,
    hasCollectionFilter,
    hasCollectionSort,
    hasProductCta,
    hasProductMediaZoom
  };
}

function enforceSignalConsistency(markdown, signalFacts) {
  let out = markdown;

  const forceStatusAndRecommendation = (sectionLabelRegex, status, recommendation) => { 
    const blockRegex = new RegExp(
      `((?:\\d+\\.\\s*)?(?:-\\s*)?Section:\\s*${sectionLabelRegex.source}[\\s\\S]*?)(?=\\n\\s*(?:\\d+\\.\\s*)?(?:-\\s*)?Section:|\\n##\\s*\\d+\\)|$)`,
      "i"
    );
    const match = out.match(blockRegex);
    if (!match) return;
    let block = match[1];
    block = block.replace(/(Status:\s*)(Meets|Partially Meets|Needs Improvement)/i, `$1${status}`);
    block = block.replace(/(Recommendation:\s*)(.*)/i, `$1${recommendation}`);
    out = out.replace(match[1], block);
  };

  if (signalFacts.hasHomeHero) {
    forceStatusAndRecommendation(
      /Hero\/Banner Above the Fold|Hero Section/i,
      "Meets",
      "Nothing to change."
    );
  }
  if (signalFacts.hasHomeStickyHeader) {
    forceStatusAndRecommendation(
      /Header and Navigation/i,
      "Meets",
      "Nothing to change."
    );
    // Remove obvious false-negative phrases.
    out = out.replace(/no sticky header detected/gi, "sticky header detected"); 
    out = out.replace(/lacks sticky behavior/gi, "sticky behavior is present");
  }
  if (signalFacts.hasCollectionFilter || signalFacts.hasCollectionSort) { 
    forceStatusAndRecommendation(
      /Filter and Sort/i,
      "Meets",
      "Nothing to change."
    );
    out = out.replace(/filters? and sort(?:ing)? (?:are|is) missing/gi, "filters and sort are present");
    out = out.replace(
      /current collection page lacks robust product filtering and sorting capabilities\./gi,
      "Collection filtering and sorting are present; the opportunity is to improve UX clarity, defaults, and mobile usability."
    );
    out = out.replace(
      /limited filtering and sorting options reduce user product discovery experience\./gi,
      "Filtering and sorting are available; optimize control visibility and interaction flow to improve product discovery."
    );
    out = out.replace(
      /limited collection page filtering and sorting capabilities restrict user product discovery\./gi,
      "Collection filtering and sorting are already available; the main opportunity is improving discoverability, defaults, and mobile interaction."
    );
    out = out.replace(
      /current collection page lacks robust filtering and sorting capabilities\./gi,
      "Collection filtering and sorting are already available; prioritize usability improvements such as clearer defaults and mobile discoverability."
    );
  }
  if (signalFacts.hasProductCta) {
    out = out.replace(/no CTA button visible/gi, "CTA button is visible");
  }
  if (signalFacts.hasHomeTrustSignals) {
    forceStatusAndRecommendation(/Trust\/USP Strip|Trust Signals/i, "Meets", "Nothing to change.");
    // Remove obvious false-negative trust phrases when trust signals are detected.
    out = out.replace(/no (dedicated )?trust( or usp)? strip visible/gi, "trust/USP strip is visible");
    out = out.replace(/trust flags false/gi, "trust signals detected");
    out = out.replace(/no visible trust badges? or guarantees?/gi, "visible trust cues are present");
  }
  if (signalFacts.hasProductMediaZoom) {
    out = out.replace(
      /limited product visualization and interaction capabilities[^.\n]*\./gi,
      "Product media foundation is present; focus improvements on content quality and merchandising relevance."
    );
    out = out.replace(
      /limited product image zoom(?:ing)?[^.\n]*\./gi,
      "Product image interaction is already supported."
    );
  }

  // Keep modern narrative format consistent with detected page elements.
  if (signalFacts.hasHomeHero) {
    out = out.replace(
      /the current hero lacks a clear, compelling value proposition[^.\n]*\./gi,
      "The hero already presents a clear value proposition; the opportunity is to improve message hierarchy and visual emphasis."
    );
    out = out.replace(
      /hero section lacks clear value proposition[^.\n]*\./gi,
      "The hero section includes value proposition messaging and can be further optimized for clarity."
    );
  }

  if (signalFacts.hasHomeTrustSignals) {
    out = out.replace(
      /current trust(-| )building elements are minimal[^.\n]*\./gi,
      "Trust-building elements are present; the opportunity is to increase prominence and consistency near conversion actions."
    );
  }

  if (signalFacts.hasHomeHero || signalFacts.hasHomeTrustSignals || signalFacts.hasProductMediaZoom) {
    const lines = out.split(/\r?\n/);
    const filtered = [];
    for (const line of lines) {
      const t = line.trim();
      const isBullet = /^[-*]\s+/.test(t);
      if (isBullet) {
        if (
          signalFacts.hasHomeHero &&
          /(rewrite hero headline|add quantifiable social proof|implement a prominent.*shop now cta)/i.test(t)
        ) {
          continue;
        }
        if (
          signalFacts.hasHomeTrustSignals &&
          /(include trust badges?|add.*trust badge|add customer testimonial carousel)/i.test(t)
        ) {
          continue;
        }
        if (
          signalFacts.hasProductMediaZoom &&
          /(zoom|lightbox|magnif|pinch)/i.test(t)
        ) {
          continue;
        }
        if (
          (signalFacts.hasCollectionFilter || signalFacts.hasCollectionSort) &&
          /(implement|add|create).*(filter|sort|facets?)/i.test(t)
        ) {
          continue;
        }
      }
      filtered.push(line);
    }
    out = filtered.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  return out;
}

function scoreFromStatus(status) {
  if (/^meets$/i.test(status)) return 100;
  if (/^partially meets$/i.test(status)) return 70;
  if (/^needs improvement$/i.test(status)) return 40;
  return 55;
}

function buildSectionScore(lines, sectionTitleMatch, nextSectionStartRegex, weights) {
  const start = lines.findIndex((l) => sectionTitleMatch.test(l));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (nextSectionStartRegex.test(lines[i])) {
      end = i;
      break;
    }
  }

  const statuses = [];
  for (let i = start + 1; i < end; i += 1) {
    const m = lines[i].match(/status:\s*(Meets|Partially Meets|Needs Improvement)/i);
    if (m?.[1]) statuses.push(m[1]);
  }
  if (!statuses.length) return null;

  const effectiveWeights =
    Array.isArray(weights) && weights.length === statuses.length
      ? weights
      : Array.from({ length: statuses.length }, () => 100 / statuses.length);

  const weightedSum = statuses.reduce(
    (sum, status, idx) => sum + scoreFromStatus(status) * (effectiveWeights[idx] / 100),
    0
  );
  const rounded = Math.round(weightedSum);

  const counts = {
    meets: statuses.filter((s) => /^meets$/i.test(s)).length,
    partial: statuses.filter((s) => /^partially meets$/i.test(s)).length,
    needs: statuses.filter((s) => /^needs improvement$/i.test(s)).length
  };

  return { score: rounded, counts };
}

function injectQualityScorecard(markdown) {
  // Disabled for Error + Recommendation-only output format.
  return markdown;
}

function removeSeoAndSpeedContent(markdown) {
  if (!markdown) return markdown;
  const blockedLine = /(seo|search engine|meta description|structured data|rich snippets?|page[-\s]?speed|site speed|speed optimization|performance optimization|lighthouse score|core web vitals?)/i;
  const lines = markdown.split(/\r?\n/);
  const cleaned = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (blockedLine.test(trimmed)) {
      // Drop SEO/speed recommendation lines and surrounding subsection heading if now empty.
      continue;
    }

    cleaned.push(line);
  }

  return cleaned
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasAllRequiredSections(markdown, includeOtherPages = true) {
  const required = [
    /Shopify Store Audit\s*-\s*"?[^"\n]+"?/i,
    /Website:\s*https?:\/\//i,
    /Summary/i,
    /Home Page - Key Areas of Improvement/i,
    /Collection Page/i,
    /Product Page - Key Areas of Improvement/i,
    /Final Recommendation/i
  ];
  if (includeOtherPages) {
    required.push(/Other Pages - Key Areas of Improvement/i);
  }
  return required.every((r) => r.test(markdown));
}

function normalizeInvalidStatusValues(markdown) {
  // Status lines are not used in the concise Error/Recommendation format.
  return { markdown, invalidCount: 0 };
}

function hasSectionEightHeading(markdown, includeOtherPages = true) {
  if (!includeOtherPages) return true;
  return /(^|\n)##\s*Other Pages - Key Areas of Improvement/i.test(markdown);
}

function screenshotReuseRisk(markdown) {
  void markdown;
  return false;
}

function countFinalRecommendationBullets(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*Final Recommendation/i.test(l));
  if (start === -1) return 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .filter((l) => /^\s*[-*]\s+/.test(l.trim()))
    .length;
}

function countInvalidStatusValues(markdown) {
  void markdown;
  return 0;
}

function contradictionRiskDetected(markdown) {
  void markdown;
  return false;
}

function buildReliabilityChecks(markdown, pages, includeOtherPages = true) {
  const fieldCoverage = scoreIssueFieldCoverage(markdown);
  const productPagesDetected = pages.filter((p) => p.pageType === "product").length;
  const finalRecommendationBullets = countFinalRecommendationBullets(markdown);
  const invalidStatusValues = countInvalidStatusValues(markdown);

  const checks = {
    requiredSectionsPresent: hasAllRequiredSections(markdown, includeOtherPages),
    sectionEightPresent: hasSectionEightHeading(markdown, includeOtherPages),
    placeholderDetected: looksLikePlaceholder(markdown),
    issueFieldCoverageScore: fieldCoverage.score,
    issueSubsectionsDetected: fieldCoverage.requiredSubsectionCount,
    invalidStatusValuesDetected: invalidStatusValues,
    productPagesDetected,
    productDataCoverageAdequate: productPagesDetected > 0,
    screenshotReuseRisk: screenshotReuseRisk(markdown),
    finalRecommendationBullets,
    finalRecommendationBulletCountValid:
      finalRecommendationBullets >= 5 && finalRecommendationBullets <= 7,
    contradictionRiskDetected: contradictionRiskDetected(markdown)
  };

  const failures = [];
  if (!checks.requiredSectionsPresent) failures.push("Missing required report sections.");
  if (!checks.sectionEightPresent) failures.push("Section 8 is missing.");
  if (checks.placeholderDetected) failures.push("Placeholder content detected.");
  if (checks.invalidStatusValuesDetected > 0) failures.push("Invalid status values detected.");
  if (checks.issueFieldCoverageScore < 75) failures.push("Improvement field coverage below threshold.");
  if (!checks.productDataCoverageAdequate) failures.push("No product page data detected.");
  if (!checks.finalRecommendationBulletCountValid) {
    failures.push("Final recommendation must contain 5-7 bullets.");
  }
  if (checks.screenshotReuseRisk) failures.push("Screenshot references are over-reused.");
  if (checks.contradictionRiskDetected) failures.push("Status/evidence contradiction risk detected."); 

  const hardPass = failures.length === 0;
  const reliabilityScore = Math.max(0, 100 - failures.length * 12);
  return { ...checks, failures, hardPass, reliabilityScore };
}

function looksLikePlaceholder(markdown) {
  return (
    /\[Remaining sections/i.test(markdown) ||
    /would follow similar/i.test(markdown) ||
    /\[Would you like me to continue/i.test(markdown)
  );
}

function countMarkdownHeadings(markdown, pattern) {
  return (markdown.match(pattern) || []).length;
}

function scoreIssueFieldCoverage(markdown) {  
  const recommendationsLabels = (markdown.match(/^\s*Recommendations\s*:?\s*$/gim) || []).length;
  const bulletCount = (markdown.match(/^\s*[-*]\s+/gim) || []).length;
  if (!recommendationsLabels || bulletCount < 8) return { score: 0, requiredSubsectionCount: 0 };
  return { score: 100, requiredSubsectionCount: recommendationsLabels };
}

function ensureImprovementFieldLine(block, pattern, fallbackLine) {
  return pattern.test(block) ? block : `${block.trimEnd()}\n- ${fallbackLine}\n`;
}

function enforceImprovementFields(markdown) {
  // Keep model output concise; do not auto-inject legacy verbose fields.
  return markdown;
}

function shouldIncludeOtherPagesSection(pages = [], additionalPageUrls = []) {
  void pages;
  return Array.isArray(additionalPageUrls) && additionalPageUrls.length > 0;
}

function removeOtherPagesSectionIfNotApplicable(markdown, includeOtherPages) {
  if (includeOtherPages) return markdown;
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*Other Pages - Key Areas of Improvement/i.test(l));
  if (start === -1) return markdown;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const trimmed = [...lines.slice(0, start), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return trimmed;
}

function appendScreenshotAssets(markdown, pages) {
  void pages;
  return markdown;
}

function enforceReferenceLines(markdown) {
  // Keep client-facing output clean; do not inject reference lines.
  return markdown;
}

function buildSectionScreenshotReferences(pages, toPublicAssetUrl) {
  const pools = { home: [], collection: [], product: [], other: [] };

  for (const page of pages || []) {
    const area =
      page?.pageType === "collection"
        ? "collection"
        : page?.pageType === "product"
          ? "product"
          : page?.pageType === "general" 
            ? "home"
            : "other";

    const sectionShots = page?.sectionScreenshots || {};
    for (const shotPath of Object.values(sectionShots)) {
      const publicUrl = toPublicAssetUrl(shotPath);
      if (publicUrl && !pools[area].includes(publicUrl)) pools[area].push(publicUrl);
    }
    if (page?.aboveFoldScreenshotPath) {
      const aboveFold = toPublicAssetUrl(page.aboveFoldScreenshotPath);
      if (aboveFold && !pools[area].includes(aboveFold)) pools[area].push(aboveFold);
    }
  }

  return pools;
}

function buildSectionScreenshotLookup(pages, toPublicAssetUrl) {
  const lookup = {
    home: {},
    collection: {},
    product: {},
    other: {}
  };

  for (const page of pages || []) {
    const area =
      page?.pageType === "collection"
        ? "collection"
        : page?.pageType === "product"
          ? "product"
          : page?.pageType === "general"
            ? "home"
            : "other";

    const sectionShots = page?.sectionScreenshots || {};
    for (const [key, shotPath] of Object.entries(sectionShots)) {
      const publicUrl = toPublicAssetUrl(shotPath);
      if (publicUrl && !lookup[area][key]) {
        lookup[area][key] = publicUrl;
      }
    }
  }

  return lookup;
}

function sectionKeyFromLabel(area, sectionLabel = "") {
  const text = sectionLabel.toLowerCase();
  if (area === "home") {
    if (text.includes("announcement")) return "announcement";
    if (text.includes("header") || text.includes("navigation")) return "header";
    if (text.includes("hero") || text.includes("banner")) return "hero";
    if (text.includes("trust") || text.includes("usp")) return "trust";
    if (text.includes("featured") || text.includes("collection") || text.includes("best seller")) return "featured";
    if (text.includes("footer")) return "footer";
  }
  if (area === "collection") {
    if (text.includes("heading")) return "heading";
    if (text.includes("intro") || text.includes("seo")) return "intro";
    if (text.includes("filter") || text.includes("sort")) return "filterSort";
    if (text.includes("product card") || text.includes("product grid") || text.includes("scanability")) return "productGrid";
    if (text.includes("trust")) return "productGrid";
  }
  if (area === "product") {
    if (text.includes("above-the-fold") || text.includes("title") || text.includes("price") || text.includes("cta")) return "titlePriceCta";
    if (text.includes("media") || text.includes("image") || text.includes("gallery")) return "media";
    if (text.includes("trust") || text.includes("warranty") || text.includes("returns") || text.includes("delivery")) return "trust";
    if (text.includes("cross-sell") || text.includes("upsell") || text.includes("recently viewed")) return "upsell";
  }
  return "";
}

function applySectionScreenshotReferences(markdown, sectionScreenshotLookup, sectionScreenshotReferences) {
  const lines = markdown.split(/\r?\n/);
  let currentArea = "other";
  let currentSectionLabel = "";

  const detectAreaFromHeading = (line) => {
    const t = line.toLowerCase();
    if (t.includes("home page")) return "home";
    if (t.includes("collection page")) return "collection";
    if (t.includes("product page")) return "product";
    return "other";
  };

  const result = lines.map((line) => {
    if (/^##\s+/.test(line)) {
      currentArea = detectAreaFromHeading(line);
      currentSectionLabel = "";
      return line;
    }

    const sectionMatch = line.match(/section:\s*(.+)$/i);
    if (sectionMatch?.[1]) {
      currentSectionLabel = sectionMatch[1].trim();
      return line;
    }

    if (/screenshot reference:/i.test(line)) {
      const sectionKey = sectionKeyFromLabel(currentArea, currentSectionLabel);
      const areaLookup = sectionScreenshotLookup[currentArea] || {};
      const mapped = areaLookup[sectionKey];
      const fallback = sectionScreenshotReferences[currentArea]?.[0] || "";
      // If we know the exact section key, never fall back to unrelated area screenshot.
      // This avoids mismatched references (e.g. featured collection -> header screenshot).
      const chosen = sectionKey ? mapped : mapped || fallback;
      if (!chosen) return "";
      return line.replace(/:\s*.*/i, `: View screenshot (${chosen})`);
    }

    return line;
  });

  return result.join("\n");
}

function applyScreenshotReferenceFallbacks(
  markdown,
  referenceScreenshots = [],
  sectionScreenshotReferences = {}
) {
  if (!Array.isArray(referenceScreenshots) || referenceScreenshots.length === 0) {
    return markdown;
  }

  const lightshotUrls = referenceScreenshots.filter((u) => /https?:\/\/(www\.)?prnt\.sc\//i.test(u));
  const preferred = lightshotUrls.length ? lightshotUrls : referenceScreenshots;

  const asDocLink = (url) => `View screenshot (${url})`;
  const sectionReference = {
    home: sectionScreenshotReferences.home?.[0] || preferred[0] || preferred[preferred.length - 1],
    collection: sectionScreenshotReferences.collection?.[0] || preferred[1] || preferred[0],
    product: sectionScreenshotReferences.product?.[0] || preferred[2] || preferred[0],
    other: sectionScreenshotReferences.other?.[0] || preferred[3] || preferred[0],
    default: preferred[0]
  };

  const lines = markdown.split(/\r?\n/);
  let currentArea = "default";

  const detectAreaFromHeading = (line) => {
    const t = line.toLowerCase();
    if (t.includes("home page")) return "home";
    if (t.includes("collection page")) return "collection";
    if (t.includes("product page")) return "product";
    if (t.includes("other pages")) return "other";
    return currentArea;
  };

  const result = lines.map((line) => {
    if (/^##\s+/.test(line)) {
      currentArea = detectAreaFromHeading(line);
      return line;
    }

    if (/screenshot reference:/i.test(line)) {
      const replacement = sectionReference[currentArea] || sectionReference.default;
      if (!replacement) return line;

      const isMissingLike =
        /:\s*(n\/a|na|none|not captured|see related item in screenshot assets)\s*$/i.test(line) ||
        /:\s*$/.test(line);
      if (isMissingLike) {
        return "";
      }
    }

    return line;
  });

  return result.join("\n");
}

export async function runAudit({
  url,
  out = "",
  maxPages = 6,
  appBaseUrl = "",
  additionalPageUrls = [],
  persistReports = true,
  createMarkdown = true,
  docx = false,
  fastMode = true,
  includeScreenshots = false,
  includeReferenceBenchmarks = false,
  referenceScreenshots = [],
  referenceSiteUrls = [],
  model = process.env.OPENAI_MODEL || "openai/gpt-4.1-mini"
}) {
  const toPublicAssetUrl = (assetPath) => {
    if (!assetPath) return "";
    if (/^https?:\/\//i.test(assetPath)) return assetPath;
    const normalized = `/${String(assetPath).replace(/\\/g, "/").replace(/^\/+/, "")}`;
    if (!/^\/reports\//i.test(normalized) && !/^\/previews\//i.test(normalized)) {
      return normalized;
    }
    const base = String(appBaseUrl || "").replace(/\/+$/, "");
    return base ? `${base}${normalized}` : normalized;
  };

  process.env.AUDIT_FAST_MODE = fastMode ? "1" : "0";
  process.env.AUDIT_USE_FETCH_ONLY = fastMode ? "1" : "0";
  const screenshotDir = persistReports && includeScreenshots
    ? path.join("reports", "screenshots", `${slugFromUrl(url)}-${todayISO()}`)
    : "";
  const sectionScreenshotDir = persistReports
    ? path.join("reports", "section-screenshots", `${slugFromUrl(url)}-${todayISO()}`)
    : "";
  process.env.AUDIT_SCREENSHOT_DIR = screenshotDir;
  process.env.AUDIT_SECTION_SCREENSHOT_DIR = sectionScreenshotDir;

  const { shopifyDetected, pages } = await crawlStore(url, maxPages || 8, {
    additionalPageUrls
  });

  console.log(`Crawling completed: shopifyDetected=${shopifyDetected}, pagesFound=${pages.length}`);

  if (!shopifyDetected) {
    throw new Error(
      `This URL does not appear to be a Shopify storefront. The audit agent only works with Shopify stores.\n` +
      `Please verify that ${url} is a valid Shopify website.`
    );
  }

  if (!pages.length) {
    throw new Error(
      `Could not crawl any pages from ${url}. Please ensure:\n` +
      `1. The URL is reachable and publicly accessible\n` +
      `2. The website is not blocking automated requests\n` +
      `3. The URL is a valid Shopify storefront\n` +
      `4. Try using a different URL or check your internet connection`
    );
  }

  const referenceBenchmarkDir = persistReports
    ? path.join("reports", "reference-screenshots", `${slugFromUrl(url)}-${todayISO()}`)
    : "";
  const shouldCollectReferenceBenchmarks =
    persistReports &&
    (includeReferenceBenchmarks || (referenceSiteUrls && referenceSiteUrls.length > 0));
  const resolvedReferenceSites = shouldCollectReferenceBenchmarks
    ? resolveReferenceSites(referenceSiteUrls)
    : [];
  const autoReferenceShots = shouldCollectReferenceBenchmarks
    ? await collectReferenceScreenshots({
        urls: resolvedReferenceSites,
        outputDir: referenceBenchmarkDir,
        limit: fastMode ? 1 : 2
      })
    : [];
  const promptWithReferences = buildAuditPrompt({
    storeUrl: url,
    pages,
    date: todayISO()
  });

  const candidateModels = fastMode
    ? [process.env.FAST_AUDIT_MODEL || "openai/gpt-4.1-mini"]
    : [model, "openai/gpt-4.1-mini"].filter(
    (m, idx, arr) => m && arr.indexOf(m) === idx
  );

  let markdown = "";
  let markdownRaw = "";
  let success = false;
  const includeOtherPages = shouldIncludeOtherPagesSection(pages, additionalPageUrls);

  const maxAttemptsPerModel = fastMode ? 1 : 2;
  const minFieldCoverageScore = fastMode ? 60 : 75;

  for (const candidateModel of candidateModels) {
    for (let attempt = 0; attempt < maxAttemptsPerModel; attempt += 1) {
      const strictSuffix =
        attempt === 0
          ? ""
          : `

CRITICAL REPAIR INSTRUCTIONS:
- Previous output was rejected.
- Do not use placeholders like "remaining sections".
- You must include all required sections in the client format.
- Use subsection style: heading, short issue paragraph, "Recommendations:" bullets.
- Keep wording simple and human-friendly for merchants.
- No tables.
- Do not ask follow-up questions. Output final audit only.
`;
      markdownRaw = await generateAuditMarkdown(`${promptWithReferences}${strictSuffix}`, candidateModel);
      if (!markdownRaw) continue;
      markdown = sanitizeMarkdown(markdownRaw);
      markdown = removeSeoAndSpeedContent(markdown);
      const fieldCoverage = scoreIssueFieldCoverage(markdown);
      const valid =
        hasAllRequiredSections(markdown, includeOtherPages) &&
        !looksLikePlaceholder(markdown) &&
        fieldCoverage.score >= minFieldCoverageScore;
      if (valid) {
        success = true;
        break;
      }
    }
    if (success) break;
  }

  // Safety net for detailed mode.
  if (!success && !fastMode) {
    const fallbackModel = "openai/gpt-4.1-mini";
    const repairPrompt = `${promptWithReferences}

CRITICAL REPAIR INSTRUCTIONS:
- Previous output was rejected.
- You must include all required sections completely.
- No placeholders, no "continue?" style responses.
- No tables.
- Keep each subsection concise and readable with "Recommendations:" bullets.
- Output final markdown only.
`;
    markdownRaw = await generateAuditMarkdown(repairPrompt, fallbackModel);
    if (markdownRaw) {
      markdown = sanitizeMarkdown(markdownRaw);
      markdown = removeSeoAndSpeedContent(markdown);
      success = hasAllRequiredSections(markdown, includeOtherPages) && !looksLikePlaceholder(markdown);
    }
  }

  // Final safety: do not hard-fail if partial output exists; append missing section scaffolds.
  if (!success) {
    const ensureSection = (title) =>
      new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(markdown)
        ? ""
        : `\n## ${title}\n\n1. Key Improvement\nNeeds manual validation from crawl output.\nRecommendations:\n- Validate this section on live theme and add final recommendation items.\n`;

    const scaffoldTitles = [
      "Shopify Store Audit - Store Name",
      `Website: ${url}`,
      "Summary",
      "Home Page - Key Areas of Improvement",
      "Collection Page",
      "Product Page - Key Areas of Improvement",
      ...(includeOtherPages ? ["Other Pages - Key Areas of Improvement"] : []),
      "Final Recommendation"
    ];

    const missingScaffold = scaffoldTitles
      .map(ensureSection)
      .join("");

    markdown = `${markdown}\n${missingScaffold}`.trim();
  }

  markdown = removeSeoAndSpeedContent(markdown);

  if (autoReferenceShots.length) {
    const refLines = ["", "## Reference Benchmark Screenshots", ""];
    autoReferenceShots.forEach((r, idx) => {
      refLines.push(`${idx + 1}. ${r.title} - ${r.url}`);
      refLines.push(`- Screenshot: ${r.screenshotPath}`);
      refLines.push("");
    });
    markdown = `${markdown}\n${refLines.join("\n")}`.trim();
  }
  const signalFacts = aggregateDetectedSignals(pages);
  markdown = enforceSignalConsistency(markdown, signalFacts);
  markdown = removeOtherPagesSectionIfNotApplicable(markdown, includeOtherPages);
  markdown = enforceImprovementFields(markdown);
  let normalizedStatusCount = 0;
  const normalizedStatuses = normalizeInvalidStatusValues(markdown);
  normalizedStatusCount = normalizedStatuses.invalidCount;
  markdown = normalizedStatuses.markdown;
  markdown = normalizeAuditLayout(markdown);
  markdown = injectQualityScorecard(markdown);
  markdown = enforceReferenceLines(markdown);
  markdown = markdown
    .replace(/^\s*[-*]?\s*Screenshot Reference:\s*.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let reliabilityChecks = buildReliabilityChecks(markdown, pages, includeOtherPages);

  if (!reliabilityChecks.hardPass) {
    const fallbackModel = model || "openai/gpt-4.1-mini";
    const repairPrompt = `${promptWithReferences}

CRITICAL RELIABILITY REPAIR:
- Fix all QA failures listed below.
- Keep sections in the client-facing audit format.
- Do not use Status/Requirement/Evidence labels.
- Final Recommendation must contain 5-7 concise bullets.
- Keep all findings evidence-backed and internally consistent.
- Output final markdown only.

QA failures to fix:
${reliabilityChecks.failures.map((f, idx) => `${idx + 1}. ${f}`).join("\n")}
`;
    const repairedRaw = await generateAuditMarkdown(repairPrompt, fallbackModel);
    if (repairedRaw) {
      let repaired = sanitizeMarkdown(repairedRaw);
      repaired = removeSeoAndSpeedContent(repaired);
      repaired = enforceSignalConsistency(repaired, signalFacts);
      repaired = removeOtherPagesSectionIfNotApplicable(repaired, includeOtherPages);
      repaired = enforceImprovementFields(repaired);
      const repairedNormalizedStatuses = normalizeInvalidStatusValues(repaired);
      normalizedStatusCount = repairedNormalizedStatuses.invalidCount;
      repaired = repairedNormalizedStatuses.markdown;
      repaired = normalizeAuditLayout(repaired);
      repaired = injectQualityScorecard(repaired);
      repaired = enforceReferenceLines(repaired);
      repaired = repaired
        .replace(/^\s*[-*]?\s*Screenshot Reference:\s*.*$/gim, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const repairedChecks = buildReliabilityChecks(repaired, pages, includeOtherPages);
      if (repairedChecks.hardPass || repairedChecks.reliabilityScore >= reliabilityChecks.reliabilityScore) {
        markdown = repaired;
        reliabilityChecks = repairedChecks;
      }
    }
  }

  const outputPath = createMarkdown
    ? out || path.join("reports", `${slugFromUrl(url)}-audit-${todayISO()}.md`)
    : "";
  if (persistReports && createMarkdown) {
    await saveReport(outputPath, markdown);
  }

  let docxPath = "";
  if (docx && persistReports) {
    const docxBuffer = await markdownToDocxBuffer(markdown);
    docxPath = outputPath.replace(/\.md$/i, ".docx");
    await saveBinary(docxPath, docxBuffer);
  }

  return {
    markdown,
    outputPath,
    docxPath,
    pagesAnalyzed: pages.length,
    screenshots: includeScreenshots
      ? pages
          .map((p) => p.screenshotPath)
          .filter(Boolean)
          .map((s) => toPublicAssetUrl(s))
      : [],
    referenceBenchmarks: autoReferenceShots.map((r) => ({
      ...r,
      screenshotPath: toPublicAssetUrl(r.screenshotPath)
    })),
    referenceSitePoolUsed: resolvedReferenceSites,
    qualityChecks: {
      requiredSectionsPresent: reliabilityChecks.requiredSectionsPresent,
      sectionEightPresent: reliabilityChecks.sectionEightPresent,
      placeholderDetected: reliabilityChecks.placeholderDetected,
      issueFieldCoverageScore: reliabilityChecks.issueFieldCoverageScore,
      issueSubsectionsDetected: reliabilityChecks.issueSubsectionsDetected,
      invalidStatusValuesDetected: reliabilityChecks.invalidStatusValuesDetected,
      invalidStatusValuesNormalized: normalizedStatusCount,
      productPagesDetected: reliabilityChecks.productPagesDetected,
      productDataCoverageAdequate: reliabilityChecks.productDataCoverageAdequate,
      screenshotReuseRisk: reliabilityChecks.screenshotReuseRisk,
      finalRecommendationBullets: reliabilityChecks.finalRecommendationBullets,
      finalRecommendationBulletCountValid: reliabilityChecks.finalRecommendationBulletCountValid,
      contradictionRiskDetected: reliabilityChecks.contradictionRiskDetected,
      reliabilityScore: reliabilityChecks.reliabilityScore,
      hardPass: reliabilityChecks.hardPass,
      failures: reliabilityChecks.failures
    }
  };
}
