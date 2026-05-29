const fs = require("fs");
const path = require("path");

// ---- value extraction helpers ----

const COLLECT_STRING_MAX_DEPTH = 20;
function collectStringValues(value, results = [], depth = 0) {
  if (depth > COLLECT_STRING_MAX_DEPTH) return results;
  if (typeof value === "string" && value.trim()) {
    results.push(value.trim());
    return results;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, results, depth + 1);
    return results;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStringValues(entry, results, depth + 1);
  }
  return results;
}

function pickFirstByKeys(item, keys) {
  for (const key of keys) {
    if (item?.[key] !== undefined && item?.[key] !== null) return item[key];
  }
  return "";
}

function asTrimmedString(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value !== "object" || value === null) return String(value ?? "").trim();
  return "";
}

function extractNestedString(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const fromItem = extractNestedString(item);
      if (fromItem) return fromItem;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const fromValue = extractNestedString(item);
      if (fromValue) return fromValue;
    }
  }
  return "";
}

function extractChannelLabel(value) {
  if (!value) return "";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) return "";
    if (/^UC[\w-]{6,}$/i.test(trimmed)) return "";
    return trimmed;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const label = extractChannelLabel(item);
      if (label) return label;
    }
    return "";
  }

  if (typeof value === "object") {
    const preferredKeys = [
      "text", "label", "title", "display_text", "displayText",
      "display_name", "displayName", "name", "handle"
    ];

    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const label = extractChannelLabel(value[key]);
        if (label) return label;
      }
    }

    for (const [key, nested] of Object.entries(value)) {
      if (/url|link|href|id|identifier/i.test(key)) continue;
      const label = extractChannelLabel(nested);
      if (label) return label;
    }
  }

  return "";
}

function pickFirstStringByKeys(item, keys) {
  for (const key of keys) {
    const val = item?.[key];
    if (val == null) continue;
    const str = typeof val === "string" ? val.trim() : extractNestedString(val);
    if (str) return str;
  }
  return "";
}

// ---- URL / file helpers ----

function parseVideoId(inputUrl) {
  try {
    const u = new URL(inputUrl);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.split("/").filter(Boolean)[0] || null;
    }
    if (u.pathname.startsWith("/shorts/")) {
      return u.pathname.split("/")[2] || null;
    }
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

function sanitizeObsidianFileName(rawTitle) {
  const fallback = "Untitled Video Note";
  const title = (rawTitle || "").trim();
  const base = (title || fallback)
    .replace(/[\x00-\x1f\x80-\x9f]/g, "")
    .replace(/[\\/:*?"<>|#[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/g, "");

  return (base || fallback) + ".md";
}

async function resolveUniqueFilePath(directory, preferredFileName) {
  const parsed = path.parse(preferredFileName);
  const baseName = parsed.name || "Untitled Video Note";
  const extension = parsed.ext || ".md";

  let candidate = path.join(directory, `${baseName}${extension}`);
  let suffix = 2;

  while (true) {
    try {
      const fh = await fs.promises.open(candidate, "wx");
      await fh.close();
      return candidate;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      candidate = path.join(directory, `${baseName} (${suffix})${extension}`);
      suffix += 1;
    }
  }
}

function validateWikipediaArticleUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid Wikipedia URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Wikipedia URL must use https");
  }
  if (!/^[a-z]{2,3}(-[a-z0-9]+)?\.wikipedia\.org$/i.test(parsed.hostname)) {
    throw new Error("URL host must be a wikipedia.org subdomain");
  }
  if (!/^\/wiki\/[^/]+/i.test(parsed.pathname)) {
    throw new Error("Wikipedia URL must be an /wiki/<article> path");
  }
  return `${parsed.origin}${parsed.pathname}`;
}

module.exports = {
  collectStringValues,
  pickFirstByKeys,
  asTrimmedString,
  extractNestedString,
  extractChannelLabel,
  pickFirstStringByKeys,
  parseVideoId,
  sanitizeObsidianFileName,
  resolveUniqueFilePath,
  validateWikipediaArticleUrl,
};
