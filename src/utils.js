import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function parseArgs(argv) {
  const args = {
    url: "",
    out: "",
    maxPages: 3,
    docx: false,
    fastMode: true,
    includeScreenshots: false,
    includeReferenceBenchmarks: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--url") args.url = argv[i + 1] || "";
    if (token === "--out") args.out = argv[i + 1] || "";
    if (token === "--max-pages") args.maxPages = Number(argv[i + 1] || "8");
    if (token === "--docx") args.docx = true;
    if (token === "--no-docx") args.docx = false;
    if (token === "--fast") args.fastMode = true;
    if (token === "--no-fast") args.fastMode = false;
    if (token === "--screenshots") args.includeScreenshots = true;
    if (token === "--no-screenshots") args.includeScreenshots = false;
    if (token === "--reference-benchmarks") args.includeReferenceBenchmarks = true;
    if (token === "--no-reference-benchmarks") args.includeReferenceBenchmarks = false;
  }
  return args;
}

export function normalizeUrl(input) {
  try {
    const u = new URL(input);
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

export function slugFromUrl(url) {
  const u = new URL(url);
  return u.hostname.replace(/^www\./, "").replace(/\./g, "-");
}

export async function saveReport(filePath, markdown) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, markdown, "utf8");
}

export async function saveBinary(filePath, content) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10); 
}
