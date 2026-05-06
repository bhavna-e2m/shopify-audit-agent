const form = document.getElementById("audit-form");
const statusBox = document.getElementById("status");
const resultBox = document.getElementById("result");
const submitBtn = document.getElementById("submitBtn");
const previewBtn = document.getElementById("previewBtn");
const previewBox = document.getElementById("preview");

function setStatus(message, type = "success", progress = null, eta = "") {
  statusBox.className = `status ${type}`;
  statusBox.innerHTML = `
    <div class="status-title">${message}</div>
    ${
      progress !== null
        ? `<div class="progress"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>`
        : ""
    }
    ${eta ? `<div class="tiny">${eta}</div>` : ""}
  `;
}

function clearResult() {
  resultBox.className = "result hidden";
  resultBox.innerHTML = "";
}

async function parseApiResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const raw = await response.text();
  const snippet = raw.slice(0, 120).replace(/\s+/g, " ");
  throw new Error(
    `Server returned non-JSON response (${response.status}). Please open the latest app URL and retry. Response starts with: ${snippet}` 
  );
}

async function loadPreview() {
  const url = document.getElementById("url").value.trim();
  if (!url) {
    setStatus("Please enter a URL first.", "error");
    return;
  }

  previewBtn.disabled = true;
  previewBox.className = "preview";
  previewBox.innerHTML = "Loading site preview and theme details...";

  try {
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await parseApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Preview failed.");

    previewBox.className = "preview";
    previewBox.innerHTML = `
      ${
        data.previewImage
          ? `<img src="${data.previewImage}" alt="Store preview image" />`
          : `<div style="margin-bottom:8px;color:#475569;">No preview image found on page metadata.</div>`
      }
      <div><strong>Store:</strong> ${data.title}</div>
      <div><strong>URL:</strong> ${data.url}</div>
      <div><strong>Platform:</strong> ${data.isShopify ? "Shopify detected" : "Not clearly Shopify"}</div>
      <div><strong>Theme:</strong> ${data.themeName}</div>
    `;
  } catch (error) {
    previewBox.className = "preview";
    previewBox.innerHTML = `<span style="color:#991b1b;">${error.message}</span>`;
  } finally {
    previewBtn.disabled = false;
  }
}

function startScanProgress() {
  const steps = [
    "Checking Shopify platform and storefront accessibility...",
    "Scanning homepage structure and conversion elements...",
    "Scanning collection and product page patterns...",
    "Evaluating trust signals, social proof, and merchandising...",
    "Preparing Shopify-standard markdown audit report..."
  ];

  let current = 0;
  const percents = [12, 32, 56, 78, 92];
  setStatus(steps[current], "success", percents[current], "Estimated time: 30-60 seconds");

  const interval = setInterval(() => {
    current += 1;
    if (current >= steps.length) current = steps.length - 1;
    setStatus(steps[current], "success", percents[current], "Estimated time: 30-60 seconds");
  }, 2800);

  return () => clearInterval(interval);
}

previewBtn.addEventListener("click", loadPreview);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearResult();
  submitBtn.disabled = true;
  const stopProgress = startScanProgress();

  const url = document.getElementById("url").value.trim();
  const createMarkdown = document.getElementById("createMarkdown").checked;
  const createGoogleDoc = document.getElementById("createGoogleDoc").checked;
  const fastMode = document.getElementById("fastMode").checked;
  const referenceSiteUrls = document
    .getElementById("referenceSiteUrls")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const additionalPageUrls = document
    .getElementById("additionalPageUrls")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const response = await fetch("/api/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        appBaseUrl: window.location.origin,
        createMarkdown,
        createGoogleDoc,
        fastMode,
        referenceSiteUrls,
        additionalPageUrls
      })
    });
    const data = await parseApiResponse(response);
    if (!response.ok) {
      throw new Error(data.error || "Audit generation failed.");
    }

    setStatus("Audit generated successfully. Download your document below.", "success", 100);
    resultBox.className = "result";
    const markdownHref = data.markdownPath
      ? data.markdownPath
      : `data:text/markdown;charset=utf-8,${encodeURIComponent(data.markdownContent || "")}`;

    resultBox.innerHTML = `
      <div><strong>Store:</strong> ${data.url}</div>
      <div><strong>Pages analyzed:</strong> ${data.pagesAnalyzed}</div>
      <div><strong>Format:</strong> ${createMarkdown ? "Markdown (.md)" : "Google Doc only"}</div>
      <div><strong>Mode:</strong> ${data.modeUsed || (fastMode ? "Fast" : "Detailed")}</div>
      ${
        createMarkdown
          ? `<a class="download" href="${markdownHref}" download>Download Markdown</a>`
          : ""
      }
      ${
        data.googleDocUrl
          ? `<div style="margin-top:10px;padding:10px;border:1px solid #dfcdb9;border-radius:10px;background:#fff8ef;">
               <strong>Google Doc Result:</strong>
               <a class="download" href="${data.googleDocUrl}" target="_blank" rel="noopener noreferrer">Open Google Doc</a>
             </div>`
          : ""
      }
      ${
        data.googleDocNote
          ? `<div style="margin-top:10px;color:#64748b;"><strong>Google Doc:</strong> ${data.googleDocNote}</div>`
          : ""
      }
      ${
        Array.isArray(data.referenceBenchmarks) && data.referenceBenchmarks.length
          ? `<div style="margin-top:10px;"><strong>Reference Benchmark Screenshots:</strong><br/>${data.referenceBenchmarks
              .map(
                (r, i) =>
                  `<a class="download" href="${r.screenshotPath}" target="_blank" rel="noopener noreferrer">Reference ${i + 1}: ${r.title}</a>`
              )
              .join("")}</div>`
          : ""
      }
      ${
        Array.isArray(data.referenceSitePoolUsed) && data.referenceSitePoolUsed.length
          ? `<div style="margin-top:10px;color:#64748b;"><strong>Reference Sites Used:</strong> ${data.referenceSitePoolUsed.join(", ")}</div>`  
          : ""
      }
    `;
  } catch (error) {
    setStatus(error.message || "Audit generation failed.", "error", 0);
  } finally {
    stopProgress();
    submitBtn.disabled = false;
  }
});
