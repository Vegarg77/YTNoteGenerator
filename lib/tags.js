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
  for (let i = 0; i < files.length; i += BATCH) {
    const texts = await Promise.all(
      files.slice(i, i + BATCH).map((f) => fs.promises.readFile(f, "utf8").catch(() => ""))
    );
    for (const text of texts) if (text) ingest(text);
  }

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

module.exports = { parseExcludeList, scanVaultTags, getTagPool };
