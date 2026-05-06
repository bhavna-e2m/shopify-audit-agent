import { SHOPIFY_STANDARDS } from "./shopifyStandards.js";

export function buildAuditPrompt({ storeUrl, pages, date }) {
  const bestPracticeChecklist = {
    homePage: [
      SHOPIFY_STANDARDS.homePage.heroSection?.standard,
      SHOPIFY_STANDARDS.homePage.headerNavigation?.standard,
      SHOPIFY_STANDARDS.homePage.trustSignals?.standard,
      SHOPIFY_STANDARDS.homePage.announcementBar?.standard,
      SHOPIFY_STANDARDS.homePage.featuredCollections?.standard,
      SHOPIFY_STANDARDS.homePage.socialProof?.standard,
      SHOPIFY_STANDARDS.homePage.mobileOptimization?.standard,
      SHOPIFY_STANDARDS.homePage.accessibility?.standard
    ].filter(Boolean),
    collectionPage: [
      SHOPIFY_STANDARDS.collectionPage.filtering?.standard,
      SHOPIFY_STANDARDS.collectionPage.sorting?.standard,
      SHOPIFY_STANDARDS.collectionPage.productGrid?.standard,
      SHOPIFY_STANDARDS.collectionPage.pagination?.standard,
      SHOPIFY_STANDARDS.collectionPage.breadcrumbs?.standard,
      SHOPIFY_STANDARDS.collectionPage.emptyState?.standard 
    ].filter(Boolean),
    productPage: [
      SHOPIFY_STANDARDS.productPage.imageGallery?.standard,
      SHOPIFY_STANDARDS.productPage.pricing?.standard,
      SHOPIFY_STANDARDS.productPage.addToCart?.standard,
      SHOPIFY_STANDARDS.productPage.productDescription?.standard,
      SHOPIFY_STANDARDS.productPage.reviews?.standard,
      SHOPIFY_STANDARDS.productPage.relatedProducts?.standard,
      SHOPIFY_STANDARDS.productPage.inventory?.standard,
      SHOPIFY_STANDARDS.productPage.shipping?.standard
    ].filter(Boolean),
    technical: [
      SHOPIFY_STANDARDS.technical.mobileResponsiveness?.standard,
      SHOPIFY_STANDARDS.technical.security?.standard,
      SHOPIFY_STANDARDS.technical.appIntegration?.standard,
      SHOPIFY_STANDARDS.technical.themeUpdates?.standard
    ].filter(Boolean)
  };

  return `
You are a senior Shopify CRO and UX auditor.
Generate a professional, practical, implementation-ready audit report.
The report must be concise, client-friendly, and similar to a consultant handoff document.

Context:
- Store URL: ${storeUrl}
- Audit date: ${date}
- Platform focus: Shopify only
- Theme clues and page signals are provided as JSON.
- Tie recommendations to Shopify UX/CRO best practices where relevant.

Required structure (exact headings):
1) Shopify Store Audit - "<Store Name or Domain>"
2) Website: <store URL>
3) Summary
4) Home Page - Key Areas of Improvement
5) Collection Page
6) Product Page - Key Areas of Improvement
7) Other Pages - Key Areas of Improvement
8) Final Recommendation

Writing requirements:
- Keep tone consultative and actionable.
- Prioritize conversion-rate improvements, trust-building, merchandising, and usability.
- Do not include SEO recommendations.
- Do not include performance/page-speed optimization recommendations. 
- Do not create dedicated SEO or Performance sections.
- Keep findings practical and easy for merchants/developers to implement.
- Provide concrete recommendations with light rationale.
- Do not invent plugins/apps by name unless clearly needed; stay theme-first.
- If evidence is weak, phrase as "recommended to validate" not absolute.
- Keep output in Markdown.
- Keep markdown minimal and clean: use headings and lists only.
- Start with a clear title line: "Shopify Store Audit - <Store Name or Domain>".
- Keep language client-ready and similar to professional audit documents.
- Avoid robotic phrasing. Do not use "as an AI", "based on provided data", or similar wording.
- Do not use "Ensure/ensure" phrasing in recommendations. Use direct action verbs like "Use", "Add", "Set", "Place", or "Keep".
- Never use placeholders such as "remaining sections" or "similar approach".
- Every required section must be fully written.
- Prioritize readability and concise output over long narrative text.
- Write like a senior Shopify consultant: direct, specific, non-generic.
- Avoid vague phrases such as "can be improved", "could be enhanced", "notably", "overall foundation", unless followed by exact evidence.
- Do not repeat the same recommendation across sections.
- Never recommend adding a feature that is already present in the source data flags (for example product image zoom/lightbox).
- If a feature exists, frame it as optimization of discoverability/quality rather than implementation from scratch.
- In each page section, write in this style:
  - numbered subsection heading (example: "3. Above-the-Fold Trust Signals")
  - one short issue paragraph directly under the heading (human language, not robotic)
  - a "Recommendations:" label
  - 3-7 concrete action bullets
- Do not force "Error:" / "Recommendation:" labels for every line.
- Keep recommendations concise and implementation-ready.
- For each subsection, always keep this exact order:
  1) Heading
  2) Issue/observation sentence(s)
  3) Recommendations bullets
- In "Other Pages - Key Areas of Improvement", include the exact page URL directly under each subsection heading as:
  URL: <full page url>
- Do not include these labels or sections anywhere:
  - Reference
  - Requirement Check
  - Status (Meets/Partially Meets/Needs Improvement)
  - Evidence
  - Quality Scorecard
  - "Nothing to change"
- Do not use tables anywhere.
- Keep each section issue-focused; include only real problems.
- If no fix-required issue is detected for a subsection/page, omit that subsection/page from the report.
- Coverage depth is mandatory: include details that top-performing Shopify stores typically implement, not only high-level suggestions.
- If a critical best-practice item is missing from crawl evidence, add it as "recommended to validate and implement" with practical next steps.
- Keep recommendations theme-first and implementation-ready for Shopify developers.
- Section depth targets:
  - Home Page: 4-6 subsections
  - Collection Page: 3-5 subsections
  - Product Page: 4-6 subsections
  - Other Pages: 2-4 subsections
- Every subsection must include at least 4 recommendation bullets with concrete execution details.
- Summary should be 4 short paragraphs in this flow: 
  1) State this is an audit focused on UX, engagement, and conversion.
  2) Mention current visual/theme foundation and that structure is solid.
  3) Recommend checking/upgrading to the latest theme version for compatibility/features. 
  4) Close with key opportunity areas (conversion, trust, discovery, merchandising).
- Keep summary wording natural and consultant-like, similar to:
  "The store has a solid base... key improvements lie in conversion optimization..."
- Final Recommendation should include top impact actions only (around 5 bullets).
- Prefer specific implementation language a Shopify developer can execute.

Best Shopify benchmark checklist (use this to fill missing details where relevant):
- Home Page:
${bestPracticeChecklist.homePage.map((s) => `  - ${s}`).join("\n")}
- Collection Page:
${bestPracticeChecklist.collectionPage.map((s) => `  - ${s}`).join("\n")}
- Product Page:
${bestPracticeChecklist.productPage.map((s) => `  - ${s}`).join("\n")}
- Technical / UX baseline (exclude SEO and speed):
${bestPracticeChecklist.technical.map((s) => `  - ${s}`).join("\n")}

Source data:
\`\`\`json
${JSON.stringify(pages, null, 2)}
\`\`\`
`; 
}
 