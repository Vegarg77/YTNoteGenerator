const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MAX_NOTE_TAGS, escapeInlineTags, validateTagSelection, formatTagDefinitions } = require("../webapp/tagging");
const { extractTagsFromMarkdown } = require("../lib/utils");
const tagsLib = require("../lib/tags");

// ---- escapeInlineTags ----

test("escapeInlineTags: would-be tags become \\#, wherever they sit on the line", () => {
  assert.strictEqual(
    escapeInlineTags("it's actually free. #girlmath #DisneyMath. Next"),
    "it's actually free. \\#girlmath \\#DisneyMath. Next"
  );
  assert.strictEqual(escapeInlineTags("#iamatag at line start"), "\\#iamatag at line start");
  assert.strictEqual(escapeInlineTags("from #14-56? and (#nested/tag)"), "from \\#14-56? and (\\#nested/tag)");
  assert.strictEqual(escapeInlineTags("a\n#tag\nb"), "a\n\\#tag\nb");
});

test("escapeInlineTags: escaped output contains no tags by Obsidian's rules", () => {
  const out = escapeInlineTags("Talk about #history and #wood-working, #1st place, #y2024.");
  assert.deepStrictEqual(extractTagsFromMarkdown(out), []);
});

test("escapeInlineTags: leaves non-tags alone", () => {
  const keep = [
    "## Summary:",
    "#### 2026-11-21  10:00",
    "###### Channel: X",
    "Number one is #1 and #2024 is a year.",
    "C# and F# are languages; m#Storage is mid-word.",
    "https://en.wikipedia.org/wiki/Nonwoven_fabric#Spunlaid_nonwovens",
    "[link](https://x.org/page#frag)",
    "Already escaped \\#tag stays.",
    "A lone # symbol, and ## twice.",
  ].join("\n");
  assert.strictEqual(escapeInlineTags(keep), keep);
});

test("escapeInlineTags: highlight colours, HTML and code are untouched", () => {
  const html = '<mark style="background: #FFB86CA6;">Amazon Definition</mark> but #real';
  assert.strictEqual(escapeInlineTags(html), '<mark style="background: #FFB86CA6;">Amazon Definition</mark> but \\#real');
  const code = "Use `#define X` and\n```c\n#include <stdio.h>\n```\nthen #tag";
  assert.strictEqual(escapeInlineTags(code), "Use `#define X` and\n```c\n#include <stdio.h>\n```\nthen \\#tag");
});

test("escapeInlineTags: idempotent and tolerant of empty input", () => {
  const once = escapeInlineTags("x #a #b");
  assert.strictEqual(escapeInlineTags(once), once);
  assert.strictEqual(escapeInlineTags(""), "");
  assert.strictEqual(escapeInlineTags(undefined), undefined);
});

// ---- validateTagSelection ----

const POOL = Array.from({ length: 60 }, (_, i) => `Tag${i}`).concat(["History", "AI", "Energy"]);

test("validateTagSelection: pool enforced, canonical casing, deduped, order kept", () => {
  assert.deepStrictEqual(
    validateTagSelection('["energy", "#AI", "Invented", "ENERGY", "History"]', POOL),
    ["Energy", "AI", "History"]
  );
});

test("validateTagSelection: truncates to the limit, keeping the first (most relevant)", () => {
  const reply = JSON.stringify(POOL.slice(0, 15));
  assert.deepStrictEqual(validateTagSelection(reply, POOL, { limit: 9 }), POOL.slice(0, 9));
  assert.strictEqual(validateTagSelection(reply, POOL).length, MAX_NOTE_TAGS);
  assert.strictEqual(MAX_NOTE_TAGS, 10);
});

test("validateTagSelection: an echoed-back pool is a failed call, not 100 tags", () => {
  assert.throws(() => validateTagSelection(JSON.stringify(POOL), POOL), /echoed back/);
  // just under the threshold (max(2*limit, pool/3) = 21) still succeeds, truncated
  assert.strictEqual(validateTagSelection(JSON.stringify(POOL.slice(0, 21)), POOL).length, 10);
  assert.throws(() => validateTagSelection(JSON.stringify(POOL.slice(0, 22)), POOL), /22 of 63/);
});

test("validateTagSelection: small pools are not mistaken for a dump", () => {
  const small = ["A", "B", "C", "D", "E", "F"];
  assert.deepStrictEqual(validateTagSelection('["A","B","C","D","E","F"]', small), small);
});

test("validateTagSelection: non-array replies still throw, [] is a valid answer", () => {
  assert.throws(() => validateTagSelection("History, AI", POOL), /not a JSON array/);
  assert.throws(() => validateTagSelection("", POOL), /empty reply/);
  assert.deepStrictEqual(validateTagSelection("```json\n[]\n```", POOL), []);
});

// ---- formatTagDefinitions ----

test("formatTagDefinitions: only tags in the pool, canonical casing", () => {
  const block = formatTagDefinitions(
    [
      { tag: "history", definition: "the history of a person, place, thing or idea" },
      { tag: "Entertainment", definition: "video games, plays, musicals" }, // excluded from pool
      { tag: "AI", definition: "  " },
    ],
    POOL
  );
  assert.match(block, /^What these tags mean/);
  assert.match(block, /\n- History: the history of a person, place, thing or idea$/);
  assert.doesNotMatch(block, /Entertainment|AI:/);
  assert.strictEqual(formatTagDefinitions([], POOL), "");
  assert.strictEqual(formatTagDefinitions(undefined, POOL), "");
});

// ---- tag-pool scan ignores HTML (Highlightr colours) ----

test("extractTagsFromMarkdown: highlight colours inside HTML are not tags", () => {
  const md = '## <mark style="background: #FFB86CA6;">Amazon Definition</mark>\n' +
    '11. <mark style="background: #BBFABBA6;">HIPAA rule</mark> #Health';
  assert.deepStrictEqual(extractTagsFromMarkdown(md), ["Health"]);
});

// ---- Tag Definitions note ----

test("parseTagDefinitions: bullets, #, bold, dashes; headings/frontmatter/code ignored; last wins", () => {
  const md = [
    "---",
    "aliases: []",
    "---",
    "# Tag Definitions",
    "One tag per line as `Tag: what it means`.",
    "",
    "Entertainment: video games, plays, musicals, leisure media",
    "- Media: news and social media",
    "* **History**: the history of a person, place, thing or idea",
    "- **AI:** artificial intelligence",
    "\\#Energy — power generation",
    "```",
    "Ignored: inside code",
    "```",
    "Media: news, journalism and social media",
    "not a definition line",
    "Bad Name: has a space",
  ].join("\r\n");
  const defs = tagsLib.parseTagDefinitions(md);
  const map = Object.fromEntries(defs.map((d) => [d.tag, d.definition]));
  assert.deepStrictEqual(map, {
    Entertainment: "video games, plays, musicals, leisure media",
    Media: "news, journalism and social media",
    History: "the history of a person, place, thing or idea",
    AI: "artificial intelligence",
    Energy: "power generation",
  });
});

test("readTagDefinitions: explicit file, scan-root fallback, missing file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytng-defs-"));
  try {
    const none = await tagsLib.readTagDefinitions("", dir);
    // /vault may exist on a dev box running the container; only assert when it does not
    if (!fs.existsSync("/vault/Tag Definitions.md")) assert.deepStrictEqual(none, { file: "", definitions: [] });

    fs.writeFileSync(path.join(dir, "Tag Definitions.md"), "History: the past\n");
    if (!fs.existsSync("/vault/Tag Definitions.md")) {
      const found = await tagsLib.readTagDefinitions("", dir);
      assert.strictEqual(found.file, path.join(dir, "Tag Definitions.md"));
      assert.deepStrictEqual(found.definitions, [{ tag: "History", definition: "the past" }]);
    }

    const custom = path.join(dir, "custom.md");
    fs.writeFileSync(custom, "- AI: machines\n");
    assert.deepStrictEqual((await tagsLib.readTagDefinitions(custom, dir)).definitions, [{ tag: "AI", definition: "machines" }]);

    const missing = await tagsLib.readTagDefinitions(path.join(dir, "nope.md"), dir);
    assert.deepStrictEqual(missing, { file: path.join(dir, "nope.md"), definitions: [], error: "file not found" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
