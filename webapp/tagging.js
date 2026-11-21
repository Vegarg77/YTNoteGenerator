// Note-tagging helpers shared by the browser (loaded before app.js, exposes
// window.YTNGTagging) and the Node tests (require). No DOM, no network, no deps.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YTNGTagging = api;
})(typeof self !== "undefined" ? self : this, function () {
  // Hard cap on tags per note, #VN included (video notes therefore get at most 9 pool tags).
  const MAX_NOTE_TAGS = 10;

  // Same tag rule as lib/utils.js isValidTagName (Obsidian's): tag charset only, at least
  // one non-digit, no leading/trailing slash. "#2024" is not a tag; "#1st" is.
  function isTagName(name) {
    return typeof name === "string" && name.length > 0 &&
      /^[A-Za-z0-9_/-]+$/.test(name) && /[A-Za-z_-]/.test(name) &&
      !name.startsWith("/") && !name.endsWith("/");
  }

  // Spans whose '#' is not an Obsidian tag and must stay byte-for-byte: fenced code, inline
  // code, and HTML tags (Highlightr writes <mark style="background: #FFB86CA6;"> — escaping
  // that '#' would break the highlight colour).
  const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|<\/?[A-Za-z][^>\n]*>/g;
  const INLINE_TAG = /(^|[\s(])#([A-Za-z0-9_/-]+)/g;

  // Turn every would-be Obsidian tag in generated text ("#girlmath") into an escaped,
  // visually identical "\#girlmath" so it never becomes a real tag and never leaks into
  // the vault tag pool. Headings ("## Summary"), URL fragments ("page#x"), mid-word '#'
  // ("C#", "m#x"), already-escaped "\#x" and number-only "#2024" are left alone — none
  // of them are tags in Obsidian. Idempotent.
  function escapeInlineTags(text) {
    if (typeof text !== "string" || !text.includes("#")) return text;
    const escapePlain = (s) => s.replace(INLINE_TAG, (m, pre, name) => (isTagName(name) ? `${pre}\\#${name}` : m));
    let out = "";
    let last = 0;
    for (const m of text.matchAll(PROTECTED)) {
      out += escapePlain(text.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + escapePlain(text.slice(last));
  }

  // Parse the model's reply and enforce the pool: accept only tags that exist in the pool
  // (case-insensitive, canonical pool casing wins), deduped, in the model's (relevance)
  // order, truncated to `limit`. A reply with no parseable JSON array throws: that is a
  // failed call, not "no tags apply". So does a reply that lists a large share of the
  // pool — models sometimes echo the whole allowed list back, and saving that as 100+
  // tags is worse than saving none.
  function validateTagSelection(rawText, pool, { limit = MAX_NOTE_TAGS } = {}) {
    const byLower = new Map(pool.map((t) => [t.toLowerCase(), t]));
    let names = null;
    const jsonText = String(rawText || "").replace(/```(?:json)?/gi, "").trim();
    try {
      const start = jsonText.indexOf("[");
      const end = jsonText.lastIndexOf("]");
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(jsonText.slice(start, end + 1));
        if (Array.isArray(parsed)) names = parsed;
      }
    } catch { /* reported below */ }
    if (!names) {
      const preview = jsonText.replace(/\s+/g, " ").slice(0, 120);
      throw new Error(`tag reply was not a JSON array: ${preview ? `"${preview}"` : "(empty reply)"}`);
    }
    const out = [];
    const seen = new Set();
    for (const raw of names) {
      const canonical = byLower.get(String(raw).trim().replace(/^#/, "").toLowerCase());
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        out.push(canonical);
      }
    }
    const dumpAt = Math.max(2 * limit, Math.ceil(pool.length / 3));
    if (out.length > dumpAt) {
      throw new Error(`tag reply listed ${out.length} of ${pool.length} allowed tags (the list was echoed back), so no tags were applied`);
    }
    return out.slice(0, Math.max(0, limit));
  }

  // Prompt block for the definitions of tags that are actually in the pool, or "" when
  // none are. `definitions` is [{tag, definition}] from GET /api/tags.
  function formatTagDefinitions(definitions, pool) {
    const inPool = new Map(pool.map((t) => [t.toLowerCase(), t]));
    const lines = [];
    for (const d of Array.isArray(definitions) ? definitions : []) {
      const canonical = inPool.get(String(d?.tag || "").toLowerCase());
      const text = String(d?.definition || "").trim();
      if (canonical && text) lines.push(`- ${canonical}: ${text}`);
    }
    if (!lines.length) return "";
    return "What these tags mean in this vault (a defined tag applies ONLY when its definition fits the note; never apply it on name alone):\n" +
      lines.join("\n");
  }

  return { MAX_NOTE_TAGS, isTagName, escapeInlineTags, validateTagSelection, formatTagDefinitions };
});
