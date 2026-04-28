import path from "node:path";
import { crawlStore } from "./crawler.js";
import { buildAuditPrompt } from "./auditPrompt.js";
import { markdownToDocxBuffer } from "./docxExport.js";
import { generateAuditMarkdown } from "./llm.js";
import { resolveReferenceSites } from "./referenceBenchmarks.js";
import { getShopifyReference } from "./shopifyStandards.js";
import { runPerformanceAudit } from "./performanceAudit.js";
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

  return {
    hasHomeHero,
    hasHomeStickyHeader,
    hasHomeTrustSignals,
    hasCollectionFilter,
    hasCollectionSort,
    hasProductCta
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
  const lines = markdown.split(/\r?\n/);
  const home = buildSectionScore(
    lines,
    /Home Page - Shopify Requirements Verification/i,
    /^##\s*3\)/,
    [8, 14, 14, 14, 10, 10, 10, 10, 10]
  );
  const collection = buildSectionScore(
    lines,
    /Collection Page - Shopify Requirements Verification/i,
    /^##\s*5\)/,
    [18, 14, 20, 16, 16, 16]
  );
  const product = buildSectionScore(
    lines,
    /Product Page - Shopify Requirements Verification/i, 
    /^##\s*7\)/,
    [18, 20, 18, 16, 14, 14]
  );

  if (!home && !collection && !product) return markdown;

  const scorecard = [
    "## Quality Scorecard (0-100)",
    "",
    home
      ? `- Home Page: ${home.score}/100 (Meets: ${home.counts.meets}, Partially Meets: ${home.counts.partial}, Needs Improvement: ${home.counts.needs})`
      : "- Home Page: Not enough verification data.",
    collection
      ? `- Collection Page: ${collection.score}/100 (Meets: ${collection.counts.meets}, Partially Meets: ${collection.counts.partial}, Needs Improvement: ${collection.counts.needs})`
      : "- Collection Page: Not enough verification data.",
    product
      ? `- Product Page: ${product.score}/100 (Meets: ${product.counts.meets}, Partially Meets: ${product.counts.partial}, Needs Improvement: ${product.counts.needs})`
      : "- Product Page: Not enough verification data.",
    "",
    "- Weighted criteria emphasize conversion clarity, trust reinforcement, merchandising, and mobile-first usability.",
    ""
  ];

  const insertAt = lines.findIndex((l) => /^##\s*2\)/.test(l));
  if (insertAt === -1) {
    return `${markdown.trim()}\n\n${scorecard.join("\n")}`.trim();
  }

  const before = lines.slice(0, insertAt).join("\n").trimEnd();
  const after = lines.slice(insertAt).join("\n").trimStart();
  return `${before}\n\n${scorecard.join("\n")}\n${after}`.trim();
}

function hasAllRequiredSections(markdown) {
  const required = [
    /Home Page - Shopify Requirements Verification/i,
    /Collection Page - Shopify Requirements Verification/i,
    /Collection Page - Key Areas of Improvement/i,
    /Product Page - Shopify Requirements Verification/i,
    /Product Page - Key Areas of Improvement/i,
    /Other Pages - Key Areas of Improvement/i,
    /SEO and Technical Audit/i,
    /Final Recommendation/i
  ];
  const hasCore = required.every((r) => r.test(markdown));
  // Enforce detailed product audit presence (sections 6.x + 7.x)
  const productChecks =
    (markdown.match(/###\s*6\.\d+/g) || []).length >= 6 &&
    (markdown.match(/###\s*7\.\d+/g) || []).length >= 4;
  // Enforce SEO audit presence (section 9.x)
  const seoChecks = (markdown.match(/###\s*9\.\d+/g) || []).length >= 5;
  return hasCore && productChecks && seoChecks;
}

function normalizeInvalidStatusValues(markdown) {
  const allowed = /^(Meets|Partially Meets|Needs Improvement)$/i;
  const lines = markdown.split(/\r?\n/);
  let invalidCount = 0;
  const out = lines.map((line) => {
    const m = line.match(/^(\s*[-*]?\s*Status:\s*)(.+)$/i);
    if (!m) return line;
    const value = (m[2] || "").trim();
    if (allowed.test(value)) return line;
    invalidCount += 1;
    return `${m[1]}Partially Meets`;
  });
  return {
    markdown: out.join("\n"),
    invalidCount
  };
}

function hasSectionEightHeading(markdown) {
  return /(^|\n)##\s*8\)\s*Other Pages - Key Areas of Improvement/i.test(markdown);
}

function screenshotReuseRisk(markdown) {
  const refs = [...markdown.matchAll(/Screenshot Reference:\s*.*\((https?:\/\/[^)]+)\)/gi)].map(
    (m) => m[1]
  );
  if (refs.length < 4) return false;
  const counts = refs.reduce((acc, url) => {
    acc[url] = (acc[url] || 0) + 1;
    return acc;
  }, {});
  const maxUse = Math.max(...Object.values(counts));
  return maxUse / refs.length >= 0.7;
}

function countFinalRecommendationBullets(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*9\)\s*Final Recommendation/i.test(l));
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
  const allowed = /^(Meets|Partially Meets|Needs Improvement)$/i;
  const statuses = [...markdown.matchAll(/^\s*[-*]?\s*Status:\s*(.+)$/gim)].map((m) =>
    (m[1] || "").trim()
  );
  if (!statuses.length) return 0;
  return statuses.filter((s) => !allowed.test(s)).length;
}

function contradictionRiskDetected(markdown) {
  const lines = markdown.split(/\r?\n/);
  let hasRisk = false;
  for (let i = 0; i < lines.length; i += 1) {
    const statusMatch = lines[i].match(/^\s*[-*]?\s*Status:\s*(Meets)\s*$/i);
    if (!statusMatch) continue;
    const window = lines.slice(i + 1, Math.min(i + 6, lines.length)).join(" ").toLowerCase();
    if (
      /evidence:/.test(window) &&
      /(no |not visible|missing|lacks|not clearly present)/.test(window)
    ) {
      hasRisk = true;
      break;
    }
  }
  return hasRisk;
}

function buildReliabilityChecks(markdown, pages) {
  const fieldCoverage = scoreIssueFieldCoverage(markdown);
  const productPagesDetected = pages.filter((p) => p.pageType === "product").length;
  const finalRecommendationBullets = countFinalRecommendationBullets(markdown);
  const invalidStatusValues = countInvalidStatusValues(markdown);

  const checks = {
    requiredSectionsPresent: hasAllRequiredSections(markdown),
    sectionEightPresent: hasSectionEightHeading(markdown),
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
  const requiredFieldPatterns = [
    /Current Observation:/gi, 
    /Why This Matters:/gi,
    /Recommended Action:/gi,
    /Impact:\s*(High|Medium|Low)/gi,
    /Effort:\s*(High|Medium|Low)/gi,
    /Priority:\s*P[123]/gi,
    /Confidence:\s*(High confidence|Recommended to validate on live theme)/gi
  ];
  const requiredSubsectionCount =
    countMarkdownHeadings(markdown, /^###\s*3\.\d+/gim) +
    countMarkdownHeadings(markdown, /^###\s*5\.\d+/gim) +
    countMarkdownHeadings(markdown, /^###\s*7\.\d+/gim) +
    countMarkdownHeadings(markdown, /^###\s*8\.\d+/gim) +
    countMarkdownHeadings(markdown, /^###\s*9\.\d+/gim);

  if (!requiredSubsectionCount) return { score: 0, requiredSubsectionCount };

  const expectedTotalFieldLines = requiredSubsectionCount * requiredFieldPatterns.length;
  const presentFieldLines = requiredFieldPatterns.reduce((sum, pattern) => {
    return sum + countMarkdownHeadings(markdown, pattern);
  }, 0);
  const score = Math.round(Math.min(100, (presentFieldLines / expectedTotalFieldLines) * 100));
  return { score, requiredSubsectionCount };
}

function ensureImprovementFieldLine(block, pattern, fallbackLine) {
  return pattern.test(block) ? block : `${block.trimEnd()}\n- ${fallbackLine}\n`;
}

function enforceImprovementFields(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let inImprovementSection = false;
  let buffer = [];

  const flushBuffer = () => {
    if (!buffer.length) return;
    let block = buffer.join("\n");
    if (/^###\s*(3|5|7|8|9)\.\d+/im.test(block)) {
      block = ensureImprovementFieldLine(
        block,
        /(^|\n)\s*[-*]?\s*Current Observation:/i,
        "Current Observation: Recommended to validate on live theme."
      );
      block = ensureImprovementFieldLine(
        block,
        /(^|\n)\s*[-*]?\s*Why This Matters:/i,
        "Why This Matters: Aligns with Shopify UX standards and proven conversion optimization patterns."
      );
      block = ensureImprovementFieldLine(
        block,
        /(^|\n)\s*[-*]?\s*Recommended Action:/i,
        "Recommended Action: Update theme code to align with Shopify UX standards and validate conversion impact."
      );
      block = ensureImprovementFieldLine(block, /(^|\n)\s*[-*]?\s*Impact:/i, "Impact: Medium");
      block = ensureImprovementFieldLine(block, /(^|\n)\s*[-*]?\s*Effort:/i, "Effort: Medium");
      block = ensureImprovementFieldLine(block, /(^|\n)\s*[-*]?\s*Priority:/i, "Priority: P2");
      block = ensureImprovementFieldLine(
        block,
        /(^|\n)\s*[-*]?\s*Confidence:/i,
        "Confidence: Recommended to validate on live theme"
      );
    }
    out.push(block.trimEnd());
    buffer = [];
  };

  for (const line of lines) {
    if (/^##\s*(3|5|7|8|9)\)/i.test(line)) {
      flushBuffer();
      inImprovementSection = true;
      out.push(line);
      continue;
    }
    if (/^##\s+/i.test(line)) {
      flushBuffer();
      inImprovementSection = false;
      out.push(line);
      continue;
    }
    if (inImprovementSection && /^###\s+/.test(line)) {
      flushBuffer();
      buffer.push(line);
      continue;
    }
    if (buffer.length) {
      buffer.push(line);
      continue;
    }
    out.push(line);
  }
  flushBuffer();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function shouldIncludeOtherPagesSection(pages = [], additionalPageUrls = []) {
  const hasUtilityPages = pages.some((p) =>
    ["faq", "contact", "warranty"].includes(String(p?.pageType || "").toLowerCase())
  );
  return hasUtilityPages || (Array.isArray(additionalPageUrls) && additionalPageUrls.length > 0);
}

function removeOtherPagesSectionIfNotApplicable(markdown, includeOtherPages) {
  // Keep section 8 in all reports for a stable client-facing structure.
  return markdown;
}

function appendScreenshotAssets(markdown, pages) {
  const rows = pages.filter((p) => p.screenshotPath);
  if (!rows.length) return markdown;

  const lines = ["", "## Screenshot Assets", ""];
  rows.forEach((p, idx) => {
    lines.push(`${idx + 1}. ${p.pageType.toUpperCase()} - ${p.url}`);
    lines.push(`- Screenshot: ${p.screenshotPath}`);
    lines.push("");
  });
  return `${markdown.trim()}\n${lines.join("\n")}`.trim();
}

function enforceReferenceLines(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let buffer = [];
  let inSubsection = false;

  const flushBuffer = () => {
    if (!buffer.length) return;
    const blockText = buffer.join("\n");
    const hasReference = /(^|\n)\*?\*?Reference:\*?\*?/i.test(blockText);
    const hasShotRef = /(^|\n)\*?\*?Screenshot Reference:\*?\*?/i.test(blockText);
    if (!hasReference) buffer.push("- Reference: Shopify UX and conversion optimization standards.");
    if (!hasShotRef) {
      // Screenshot references are optional and only included when a concrete image exists.
    }
    out.push(...buffer);
    buffer = [];
  };

  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      flushBuffer();
      inSubsection = true;
      buffer.push(line);
      continue;
    }
    if (/^##\s+/.test(line)) {
      flushBuffer();
      inSubsection = false;
      out.push(line);
      continue;
    }
    if (inSubsection) {
      buffer.push(line);
    } else {
      out.push(line);
    }
  }
  flushBuffer();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

  // Run performance audit on home page
  const performanceData = await runPerformanceAudit(url);

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
  const mergedReferenceScreenshots = [
    ...referenceScreenshots,
    ...autoReferenceShots.map((r) => toPublicAssetUrl(r.screenshotPath))
  ]
    .map((s) => toPublicAssetUrl(s))
    .filter(Boolean);
  const sectionScreenshotReferences = buildSectionScreenshotReferences(pages, toPublicAssetUrl);
  const sectionScreenshotLookup = buildSectionScreenshotLookup(pages, toPublicAssetUrl);

  const promptWithReferences = buildAuditPrompt({
    storeUrl: url,
    pages,
    date: todayISO(),
    screenshotDir,
    referenceScreenshots: mergedReferenceScreenshots,
    performanceData
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
- You must include all sections 1-9 completely.
- You must include one-by-one checks for Home, Collection, and Product verification sections.
- For each non-compliant check include "Screenshot Reference:" and map it to a screenshotPath from source data when available.
- No tables.
- Do not ask follow-up questions. Output final audit only.
`;
      markdownRaw = await generateAuditMarkdown(`${promptWithReferences}${strictSuffix}`, candidateModel);
      if (!markdownRaw) continue;
      markdown = sanitizeMarkdown(markdownRaw);
      const fieldCoverage = scoreIssueFieldCoverage(markdown);
      const valid =
        hasAllRequiredSections(markdown) &&
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
- You must include all required sections completely (1-9).
- No placeholders, no "continue?" style responses.
- No tables.
- Include references and screenshot references for each subsection.
- Output final markdown only.
`;
    markdownRaw = await generateAuditMarkdown(repairPrompt, fallbackModel);
    if (markdownRaw) {
      markdown = sanitizeMarkdown(markdownRaw);
      success = hasAllRequiredSections(markdown) && !looksLikePlaceholder(markdown);
    }
  }

  // Final safety: do not hard-fail if partial output exists; append missing section scaffolds.
  if (!success) {
    const ensureSection = (title) =>
      new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(markdown)
        ? ""
        : `\n## ${title}\n\n- Current Observation: Needs manual verification from crawl output.\n- Why This Matters: Section required for Shopify-standard audit completeness.\n- Recommendation: Validate manually and update.\n- Reference: Auto-recovery placeholder due model format mismatch.\n- Screenshot Reference: See Screenshot Assets.\n`;

    const scaffoldTitles = [
      "4) Collection Page - Shopify Requirements Verification",
      "5) Collection Page - Key Areas of Improvement",
      "6) Product Page - Shopify Requirements Verification",
      "7) Product Page - Key Areas of Improvement",
      ...(includeOtherPages ? ["8) Other Pages - Key Areas of Improvement"] : []),
      "9) Final Recommendation"
    ];

    const missingScaffold = scaffoldTitles
      .map(ensureSection)
      .join("");

    markdown = `${markdown}\n${missingScaffold}`.trim();
  }

  if (includeScreenshots) {
    markdown = appendScreenshotAssets(markdown, pages);
  }
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
  markdown = applySectionScreenshotReferences(
    markdown,
    sectionScreenshotLookup,
    sectionScreenshotReferences
  );
  markdown = injectQualityScorecard(markdown);
  markdown = enforceReferenceLines(markdown);
  markdown = applyScreenshotReferenceFallbacks(
    markdown,
    mergedReferenceScreenshots,
    sectionScreenshotReferences
  );
  markdown = markdown
    .replace(/^\s*[-*]?\s*Screenshot Reference:\s*(N\/A|NA|none|not captured|see related item in screenshot assets)?\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let reliabilityChecks = buildReliabilityChecks(markdown, pages);

  if (!reliabilityChecks.hardPass) {
    const fallbackModel = model || "openai/gpt-4.1-mini";
    const repairPrompt = `${promptWithReferences}

CRITICAL RELIABILITY REPAIR:
- Fix all QA failures listed below.
- Keep sections 1-9 exactly.
- Use only Status: Meets / Partially Meets / Needs Improvement.
- Final Recommendation must contain 5-7 concise bullets.
- Keep all findings evidence-backed and internally consistent.
- Output final markdown only.

QA failures to fix:
${reliabilityChecks.failures.map((f, idx) => `${idx + 1}. ${f}`).join("\n")}
`;
    const repairedRaw = await generateAuditMarkdown(repairPrompt, fallbackModel);
    if (repairedRaw) {
      let repaired = sanitizeMarkdown(repairedRaw);
      repaired = enforceSignalConsistency(repaired, signalFacts);
      repaired = removeOtherPagesSectionIfNotApplicable(repaired, includeOtherPages);
      repaired = enforceImprovementFields(repaired);
      const repairedNormalizedStatuses = normalizeInvalidStatusValues(repaired);
      normalizedStatusCount = repairedNormalizedStatuses.invalidCount;
      repaired = repairedNormalizedStatuses.markdown;
      repaired = normalizeAuditLayout(repaired);
      repaired = applySectionScreenshotReferences(
        repaired,
        sectionScreenshotLookup,
        sectionScreenshotReferences
      );
      repaired = injectQualityScorecard(repaired);
      repaired = enforceReferenceLines(repaired);
      repaired = applyScreenshotReferenceFallbacks(
        repaired,
        mergedReferenceScreenshots,
        sectionScreenshotReferences
      );
      repaired = repaired
        .replace(
          /^\s*[-*]?\s*Screenshot Reference:\s*(N\/A|NA|none|not captured|see related item in screenshot assets)?\s*$/gim,
          ""
        )
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const repairedChecks = buildReliabilityChecks(repaired, pages);
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
