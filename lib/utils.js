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

// ---- Obsidian tag extraction (for the vault tag-pool scan) ----

// Obsidian tag characters: letters, digits, underscore, hyphen, forward slash (nested).
// A tag must contain at least one non-numeric character (Obsidian's own rule — "#2024"
// alone is not a tag) and can't start/end with a slash.
function isValidTagName(name) {
  return typeof name === "string" && name.length > 0 &&
    /^[A-Za-z0-9_/-]+$/.test(name) && /[A-Za-z_-]/.test(name) &&
    !name.startsWith("/") && !name.endsWith("/");
}

// Extract every Obsidian tag from a markdown document: YAML frontmatter `tags:` (inline
// array or dash list) + inline `#tags`. Headings never match (the "# " space breaks the
// tag charset); URL fragments are excluded by the preceding-character guard; fenced code
// blocks and inline code are stripped first so `#include` etc. don't pollute the pool.
function extractTagsFromMarkdown(text) {
  const tags = [];
  if (typeof text !== "string" || !text) return tags;

  // Windows-synced notes (Google Drive on Windows) are often CRLF and sometimes carry a
  // UTF-8 BOM; normalize both up front so every pattern below only has to handle "\n".
  let body = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  // frontmatter extraction via indexOf, NOT a lazy regex: /^---\n([\s\S]*?)\n---/ degrades
  // ~quadratically on a large file that opens with '---' but never closes it, which can pin
  // the server's event loop during a vault scan. indexOf is linear and equivalent here.
  let fm = null;
  if (body.startsWith("---\n")) {
    const open = 4;
    // search from open - 1 (the opening fence's own newline) so an empty block
    // "---\n---\n" closes at index 3; the match can never overlap the opening "---"
    const at = body.indexOf("\n---\n", open - 1);
    if (at >= 0) {
      fm = { yaml: body.slice(open, at), end: at + 5 };
    } else if (body.endsWith("\n---")) { // closes at EOF
      fm = { yaml: body.slice(open, body.length - 4), end: body.length };
    }
  }
  if (fm) {
    const yaml = fm.yaml;
    body = body.slice(fm.end);
    const pushClean = (raw) => {
      const t = raw.trim().replace(/^['"#]+|['"]+$/g, "");
      if (isValidTagName(t)) tags.push(t);
    };
    // `tags: [a, b]`, `tags: a, b` and the older space-separated `tags: a b`. Only bare
    // items are split on whitespace: a quoted "my tag" is one (invalid) value and must be
    // dropped whole, not turned into two bogus tags "my" and "tag".
    const inlineList = yaml.match(/^tags?:[ \t]*\[?([^\]\n]*)\]?[ \t]*$/im);
    if (inlineList && inlineList[1].trim()) {
      for (const item of inlineList[1].split(",")) {
        const v = item.trim();
        if (/^(['"]).*\1$/.test(v)) pushClean(v);
        else v.split(/\s+/).forEach(pushClean);
      }
    }
    // dash list, indented (Obsidian's Properties editor) or flush-left (equally valid YAML)
    const dashBlock = yaml.match(/^tags?:[ \t]*\n((?:[ \t]*-[ \t]+.*(?:\n|$))+)/im);
    if (dashBlock) {
      for (const line of dashBlock[1].split("\n")) {
        const m = line.match(/^[ \t]*-[ \t]+(.+?)[ \t]*$/);
        if (m) pushClean(m[1]);
      }
    }
  }

  body = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");

  const inlineTagRe = /(^|[\s(])#([A-Za-z0-9_/-]+)/g;
  let m;
  while ((m = inlineTagRe.exec(body)) !== null) {
    if (isValidTagName(m[2])) tags.push(m[2]);
  }
  return tags;
}

// ---- Published-date normalization (Bright Data metadata) ----

// Accepts ISO datetimes ("2023-05-12T14:00:00.000Z"), plain dates, or anything
// Date.parse understands; returns "YYYY-MM-DD" or "" when unparseable.
function normalizeDateToYMD(value) {
  const s = asTrimmedString(value);
  if (!s) return "";
  // already leads with a plain date — keep verbatim (avoids timezone-shifting a bare date)
  const plain = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/);
  if (plain) return `${plain[1]}-${plain[2]}-${plain[3]}`;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
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
  isValidTagName,
  extractTagsFromMarkdown,
  normalizeDateToYMD,
};
