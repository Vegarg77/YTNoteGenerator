// Vault tag-pool scanner. Walks the Obsidian vault (Google Drive mirror = plain local
// files), extracts every tag via utils.extractTagsFromMarkdown, aggregates usage counts,
// applies the settings exclude list, and caches the result (the pool changes slowly —
// a batch of videos shouldn't re-walk the vault per video).
const fs = require("fs");
const path = require("path");
const utils = require("./utils");

const CACHE_TTL_MS = 5 * 60 * 1000;
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

let cache = { key: "", at: 0, result: null };

// "VN, todo daily" → Set of lowercase names without leading '#'
function parseExcludeList(raw) {
  const out = new Set();
  for (const part of String(raw || "").split(/[\s,;]+/)) {
    const t = part.trim().replace(/^#/, "").toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

async function walkMarkdownFiles(dir, files = [], depth = 0) {
  if (depth > 12) return files; // sanity bound for cyclic junctions
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return files; // unreadable subdir — skip, don't fail the scan
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkMarkdownFiles(full, files, depth + 1);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

// → { tags: [{tag, count}...] (count desc), fileCount, scannedAt }
async function scanVaultTags(vaultDir, excludeRaw) {
  const dir = String(vaultDir || "").trim();
  if (!dir) throw new Error("No vault directory configured (OBSIDIAN_VAULT_DIR)");
  const stat = await fs.promises.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`Vault directory not found: ${dir}`);

  const exclude = parseExcludeList(excludeRaw);
  const startedAt = Date.now();
  const files = await walkMarkdownFiles(dir);

  // first-seen casing wins so the pool matches how the user actually writes the tag
  const counts = new Map(); // lowercase -> { tag, count }
  const ingest = (text) => {
    for (const tag of utils.extractTagsFromMarkdown(text)) {
      const key = tag.toLowerCase();
      if (exclude.has(key)) continue;
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { tag, count: 1 });
    }
  };

  // read in parallel batches — sequential per-file awaits are brutally slow on
  // network-backed filesystems (Google Drive mirror on Windows adds ~10-30ms per open)
  const BATCH = 32;
  // Guard on UTF-16 code units (string .length), DELIBERATELY not file bytes: the cost
  // being bounded is regex/ingest CPU + string heap, and both scale with code units.
  // A 5MB UTF-8 CJK file decodes to ~1.7M units — the same work as 1.7MB of ASCII.
  const MAX_INGEST_CHARS = 2 * 1024 * 1024; // ≈ 2MB of ASCII; real notes are KB-scale
  let skippedHuge = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const texts = await Promise.all(
      files.slice(i, i + BATCH).map((f) => fs.promises.readFile(f, "utf8").catch(() => ""))
    );
    for (const text of texts) {
      if (!text) continue;
      if (text.length > MAX_INGEST_CHARS) { skippedHuge += 1; continue; }
      ingest(text);
    }
  }
  if (skippedHuge) console.warn(`[tags] skipped ${skippedHuge} oversized file(s) (>2M chars)`);

  const tags = [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const scanMs = Date.now() - startedAt;
  console.log(`[tags] scanned ${files.length} files in ${scanMs}ms → ${tags.length} tags`);
  return { tags, fileCount: files.length, scanMs, scannedAt: new Date().toISOString() };
}

async function getTagPool(vaultDir, excludeRaw, { refresh = false } = {}) {
  const key = `${vaultDir} ${excludeRaw}`;
  const fresh = cache.result && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS;
  if (fresh && !refresh) return cache.result;
  const result = await scanVaultTags(vaultDir, excludeRaw);
  cache = { key, at: Date.now(), result };
  return result;
}

// ---- Tag definitions (a plain vault note: one "Tag: what it means" per line) ----

const DEFINITIONS_FILE_NAME = "Tag Definitions.md";
const DOCKER_VAULT_ROOT = "/vault"; // docker-compose.yml mounts the whole vault here

// Parse "Tag: meaning" lines. Accepts list bullets, a leading '#' or '\#', **bold** names,
// and ':' / '–' / '—' separators. Frontmatter, headings and code are ignored. A tag named
// twice keeps the LAST definition (append to override). → [{tag, definition}]
function parseTagDefinitions(markdown) {
  let text = String(markdown || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (text.startsWith("---\n")) {
    const at = text.indexOf("\n---", 3);
    if (at >= 0) text = text.slice(at + 4);
  }
  text = text.replace(/```[\s\S]*?```/g, "\n");
  const byLower = new Map();
  for (const line of text.split("\n")) {
    if (/^\s*#{1,6}\s/.test(line)) continue; // heading
    const m = line.match(/^\s*(?:[-*+]\s+)?(?:\*\*)?\\?#?([A-Za-z0-9_/-]+)(?:\*\*)?\s*(?:\*\*)?\s*[:–—]\s*(.+?)\s*$/);
    if (!m || !utils.isValidTagName(m[1]) || !m[2]) continue;
    const definition = m[2].replace(/^\*\*\s*/, "").trim();
    if (definition) byLower.set(m[1].toLowerCase(), { tag: m[1], definition });
  }
  return [...byLower.values()];
}

// The file to read: the TAG_DEFINITIONS_FILE setting, else "Tag Definitions.md" at the
// Docker vault root (/vault), else at the tag-scan root. A missing file = no definitions.
async function resolveDefinitionsFile(configured, vaultDir) {
  const explicit = String(configured || "").trim();
  if (explicit) return explicit;
  const candidates = [path.join(DOCKER_VAULT_ROOT, DEFINITIONS_FILE_NAME)];
  if (String(vaultDir || "").trim()) candidates.push(path.join(String(vaultDir).trim(), DEFINITIONS_FILE_NAME));
  for (const file of candidates) {
    const st = await fs.promises.stat(file).catch(() => null);
    if (st && st.isFile()) return file;
  }
  return "";
}

// Read on every request (one small file) so edits made in Obsidian apply immediately.
// → { file, definitions, error? } — never throws; tagging works without definitions.
async function readTagDefinitions(configured, vaultDir) {
  const file = await resolveDefinitionsFile(configured, vaultDir);
  if (!file) return { file: "", definitions: [] };
  // parsed lines are served over /api/tags, so only ever read a Markdown note — never let
  // the setting turn this into a reader for /etc/passwd-style "name: value" files
  if (!file.toLowerCase().endsWith(".md")) {
    return { file, definitions: [], error: "not a Markdown (.md) file" };
  }
  try {
    return { file, definitions: parseTagDefinitions(await fs.promises.readFile(file, "utf8")) };
  } catch (err) {
    return { file, definitions: [], error: err.code === "ENOENT" ? "file not found" : err.message };
  }
}

module.exports = { parseExcludeList, scanVaultTags, getTagPool, parseTagDefinitions, resolveDefinitionsFile, readTagDefinitions };
