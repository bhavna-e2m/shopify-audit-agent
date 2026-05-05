import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit } from "./auditService.js";
import { createGoogleDocFromMarkdown } from "./googleDocs.js";
import { normalizeUrl } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const app = express();
const basePort = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(rootDir, "public")));
app.use("/reports", express.static(path.join(rootDir, "reports")));
app.use("/previews", express.static(path.join(rootDir, "previews")));

function detectThemeFromHtml(html) {
  const patterns = [
    /"theme_name"\s*:\s*"([^"]+)"/i,
    /Shopify\.theme\s*=\s*\{[^}]*name:\s*"([^"]+)"/i,
    /window\.theme\s*=\s*\{[^}]*name:\s*"([^"]+)"/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "Not clearly detected";
}

app.post("/api/preview", async (req, res) => {
  try {
    const { url } = req.body || {};
    const normalized = normalizeUrl(url || "");
    if (!normalized) {
      return res.status(400).json({ error: "Invalid or missing URL." }); 
    }

    const response = await fetch(normalized, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
      }
    });
    const html = await response.text();

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || new URL(normalized).hostname;
    const isShopify = /shopify|cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.theme/i.test(html);
    const themeName = detectThemeFromHtml(html);
    const ogImageMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );

    return res.json({
      success: true,
      url: normalized,
      title,
      isShopify,
      themeName,
      previewImage: ogImageMatch?.[1] || ""
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Preview failed." });
  }
});

async function handleAuditRequest(req, res) {
  try {
    const {
      url,
      maxPages,
      appBaseUrl,
      createMarkdown,
      createGoogleDoc,
      fastMode,
      includeScreenshots,
      includeReferenceBenchmarks,
      referenceScreenshots,
      referenceSiteUrls,
      additionalPageUrls
    } = req.body || {};
    const normalized = normalizeUrl(url || "");
    const isVercel = Boolean(process.env.VERCEL);
    const defaultMaxPages = isVercel ? 1 : fastMode === false ? 6 : 2; 
    const resolvedMaxPages = Number(maxPages || defaultMaxPages);

    if (!normalized) {
      return res.status(400).json({ error: "Invalid or missing URL." });
    }

    if (!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "Missing API key. Set OPENROUTER_API_KEY (recommended) or OPENAI_API_KEY."
      });
    }

    const rootHostname = new URL(normalized).hostname.replace(/^www\./, "");
    const normalizedAdditionalPages = Array.isArray(additionalPageUrls)
      ? additionalPageUrls
          .map((u) => normalizeUrl(String(u || "").trim()))
          .filter(Boolean)
          .filter((u) => new URL(u).hostname.replace(/^www\./, "") === rootHostname)
          .filter((u, idx, arr) => arr.indexOf(u) === idx)
      : [];

    const result = await runAudit({
      url: normalized,
      maxPages: resolvedMaxPages,
      appBaseUrl: typeof appBaseUrl === "string" ? appBaseUrl : "", 
      createMarkdown: createMarkdown !== false,
      additionalPageUrls: normalizedAdditionalPages,
      persistReports: !isVercel,
      docx: false,
      fastMode: isVercel ? true : fastMode !== false,
      includeScreenshots: isVercel ? false : includeScreenshots === true,
      includeReferenceBenchmarks: isVercel ? false : includeReferenceBenchmarks === true,
      referenceScreenshots: Array.isArray(referenceScreenshots) ? referenceScreenshots : [],
      referenceSiteUrls: Array.isArray(referenceSiteUrls) ? referenceSiteUrls : []
    });

    const relativeMdPath =
      result.outputPath && !isVercel ? `/${result.outputPath.replace(/\\/g, "/")}` : "";
    let googleDocUrl = "";
    let googleDocNote = "";  
    if (createGoogleDoc) {
      try {
        const host = new URL(normalized).hostname.replace(/^www\./, "");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const docResult = await createGoogleDocFromMarkdown({
          title: `Shopify Audit - ${host} - ${stamp}`,
          markdown: result.markdown
        });
        if (docResult.enabled) {
          googleDocUrl = docResult.url;
        } else {
          googleDocNote = docResult.reason;
        }
      } catch (docError) {
        googleDocNote = docError?.message || "Google Doc creation failed.";
      }
    }

    return res.json({
      success: true,
      url: normalized,
      pagesAnalyzed: result.pagesAnalyzed,
      markdownPath: relativeMdPath,
      markdownContent: isVercel && createMarkdown !== false ? result.markdown : "",
      screenshots: result.screenshots || [],
      referenceBenchmarks: result.referenceBenchmarks || [],
      referenceSitePoolUsed: result.referenceSitePoolUsed || [],
      qualityChecks: result.qualityChecks || null,
      googleDocUrl,
      googleDocNote
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Audit generation failed." });
  }
}

app.post("/api/audit", handleAuditRequest);
// Backward-compatibility: older/cached frontend may call POST /api
app.post("/api", handleAuditRequest);  

// Some browsers/proxies always request favicon.ico; return empty response
// to avoid unnecessary serverless invocation failures/noise on Vercel.
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("*", (req, res) => {
  res.sendFile(path.join(rootDir, "public", "index.html"));
});

function startServer(port, retriesLeft = 10) {
  const server = app.listen(port, () => {
    console.log(`Shopify Audit frontend running: http://localhost:${port}`);   
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && retriesLeft > 0) {
      const nextPort = port + 1;
      console.warn(`Port ${port} in use, retrying on ${nextPort}...`);
      startServer(nextPort, retriesLeft - 1);
      return;
    }

    console.error("Failed to start server:", error.message);
    process.exit(1);
  });
}

if (!process.env.VERCEL) {
  startServer(basePort);
}

export default app;
      