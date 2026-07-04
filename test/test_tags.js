const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { extractTagsFromMarkdown, normalizeDateToYMD, isValidTagName } = require("../lib/utils");
const tagsLib = require("../lib/tags");

test("extractTagsFromMarkdown: inline tags, headings and URLs excluded", () => {
  const md = [
    "# A Heading Is Not A Tag",
    "Some text with #history and #wood-working plus nested #topic/subtopic.",
    "A url https://example.com/page#section must not match.",
    "Parenthesized (#cooking) counts. Mid#word does not.",
    "#123 is numeric-only and invalid, #y2024 is fine."
  ].join("\n");
  const tags = extractTagsFromMarkdown(md);
  assert.deepStrictEqual(
    tags.sort(),
    ["cooking", "history", "topic/subtopic", "wood-working", "y2024"].sort()
  );
});

test("extractTagsFromMarkdown: fenced and inline code stripped", () => {
  const md = "```c\n#include <stdio.h>\n```\nUse `#define` inline. Real tag: #programming";
  assert.deepStrictEqual(extractTagsFromMarkdown(md), ["programming"]);
});

test("extractTagsFromMarkdown: frontmatter inline array and dash list", () => {
  const inline = "---\ntags: [alpha, beta-two, \"#gamma\"]\n---\nBody #delta";
  assert.deepStrictEqual(extractTagsFromMarkdown(inline).sort(), ["alpha", "beta-two", "delta", "gamma"]);

  const dashes = "---\ntitle: x\ntags:\n  - one\n  - two/three\n---\nBody";
  assert.deepStrictEqual(extractTagsFromMarkdown(dashes).sort(), ["one", "two/three"]);
});

test("extractTagsFromMarkdown: empty/absent input", () => {
  assert.deepStrictEqual(extractTagsFromMarkdown(""), []);
  assert.deepStrictEqual(extractTagsFromMarkdown(null), []);
});

test("isValidTagName rules", () => {
  assert.ok(isValidTagName("history"));
  assert.ok(isValidTagName("y2024"));
  assert.ok(isValidTagName("a/b"));
  assert.ok(!isValidTagName("123"));       // numeric-only
  assert.ok(!isValidTagName("/lead"));     // leading slash
  assert.ok(!isValidTagName("trail/"));    // trailing slash
  assert.ok(!isValidTagName(""));
});

test("normalizeDateToYMD: ISO datetime, plain date, garbage", () => {
  assert.strictEqual(normalizeDateToYMD("2023-05-12T14:00:00.000Z"), "2023-05-12");
  assert.strictEqual(normalizeDateToYMD("2023-05-12"), "2023-05-12");
  assert.strictEqual(normalizeDateToYMD("May 12, 2023"), "2023-05-12");
  assert.strictEqual(normalizeDateToYMD("not a date"), "");
  assert.strictEqual(normalizeDateToYMD(""), "");
  assert.strictEqual(normalizeDateToYMD(null), "");
});

test("parseExcludeList: separators, #-prefix, case folding", () => {
  const set = tagsLib.parseExcludeList("VN, #todo daily;#Weekly");
  assert.deepStrictEqual([...set].sort(), ["daily", "todo", "vn", "weekly"]);
});

test("scanVaultTags: walks a fixture vault, counts, excludes, skips dot-dirs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  try {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.mkdirSync(path.join(dir, ".obsidian"));
    fs.writeFileSync(path.join(dir, "a.md"), "Note one #history #VN #history-of-art");
    fs.writeFileSync(path.join(dir, "sub", "b.md"), "---\ntags: [History]\n---\nBody #cooking");
    fs.writeFileSync(path.join(dir, ".obsidian", "c.md"), "#ignored");
    fs.writeFileSync(path.join(dir, "not-markdown.txt"), "#also-ignored");

    const result = await tagsLib.scanVaultTags(dir, "VN");
    const byTag = Object.fromEntries(result.tags.map((t) => [t.tag.toLowerCase(), t.count]));

    assert.strictEqual(result.fileCount, 2);
    assert.strictEqual(byTag["history"], 2);          // inline + frontmatter, case-folded
    assert.strictEqual(byTag["cooking"], 1);
    assert.strictEqual(byTag["history-of-art"], 1);
    assert.ok(!("vn" in byTag), "excluded tag must not appear");
    assert.ok(!("ignored" in byTag), ".obsidian must be skipped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scanVaultTags: missing dir throws a clear error", async () => {
  await assert.rejects(
    () => tagsLib.scanVaultTags(path.join(os.tmpdir(), "definitely-missing-vault-xyz"), ""),
    /Vault directory not found/
  );
});
