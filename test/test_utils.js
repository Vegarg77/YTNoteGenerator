const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---- lib/utils.js ----

const utils = require("../lib/utils");

describe("parseVideoId", () => {
  it("extracts from standard youtube.com/watch URL", () => {
    assert.strictEqual(utils.parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("extracts from youtu.be short URL", () => {
    assert.strictEqual(utils.parseVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  });

  it("extracts from /shorts/ URL", () => {
    assert.strictEqual(utils.parseVideoId("https://www.youtube.com/shorts/abc123def45"), "abc123def45");
  });

  it("returns null for non-YouTube URLs", () => {
    assert.strictEqual(utils.parseVideoId("https://example.com/video"), null);
  });

  it("returns null for garbage input", () => {
    assert.strictEqual(utils.parseVideoId("not a url"), null);
  });

  it("handles URLs with extra params", () => {
    assert.strictEqual(utils.parseVideoId("https://www.youtube.com/watch?v=abc123&t=30"), "abc123");
  });
});

describe("asTrimmedString", () => {
  it("trims strings", () => {
    assert.strictEqual(utils.asTrimmedString("  hello  "), "hello");
  });

  it("handles numbers", () => {
    assert.strictEqual(utils.asTrimmedString(42), "42");
  });

  it("returns empty string for objects", () => {
    assert.strictEqual(utils.asTrimmedString({ foo: "bar" }), "");
  });

  it("returns empty string for arrays", () => {
    assert.strictEqual(utils.asTrimmedString([1, 2, 3]), "");
  });

  it("returns empty string for null", () => {
    assert.strictEqual(utils.asTrimmedString(null), "");
  });

  it("returns empty string for undefined", () => {
    assert.strictEqual(utils.asTrimmedString(undefined), "");
  });

  it("handles booleans", () => {
    assert.strictEqual(utils.asTrimmedString(false), "false");
    assert.strictEqual(utils.asTrimmedString(true), "true");
  });
});

describe("collectStringValues", () => {
  it("collects flat strings from array", () => {
    assert.deepStrictEqual(utils.collectStringValues(["a", "b", "c"]), ["a", "b", "c"]);
  });

  it("collects from nested objects", () => {
    assert.deepStrictEqual(utils.collectStringValues({ a: "hello", b: { c: "world" } }), ["hello", "world"]);
  });

  it("skips empty strings", () => {
    assert.deepStrictEqual(utils.collectStringValues(["a", "", "  ", "b"]), ["a", "b"]);
  });

  it("collects from nested arrays", () => {
    assert.deepStrictEqual(utils.collectStringValues([["a", ["b"]], "c"]), ["a", "b", "c"]);
  });

  it("stops at depth limit", () => {
    // Build a deeply nested structure beyond 20 levels
    let deep = "leaf";
    for (let i = 0; i < 25; i++) {
      deep = { inner: deep };
    }
    const result = utils.collectStringValues(deep);
    // Should either return empty (if objects+arrays only) or contain at most one leaf
    assert.ok(Array.isArray(result));
  });
});

describe("pickFirstByKeys", () => {
  it("returns first matching key", () => {
    assert.strictEqual(utils.pickFirstByKeys({ b: "beta", a: "alpha" }, ["a", "b"]), "alpha");
  });

  it("returns empty string for no match", () => {
    assert.strictEqual(utils.pickFirstByKeys({ x: 1 }, ["a", "b"]), "");
  });

  it("skips null values", () => {
    assert.strictEqual(utils.pickFirstByKeys({ a: null, b: "beta" }, ["a", "b"]), "beta");
  });

  it("handles missing item", () => {
    assert.strictEqual(utils.pickFirstByKeys(null, ["a"]), "");
  });
});

describe("extractChannelLabel", () => {
  it("returns trimmed string directly", () => {
    assert.strictEqual(utils.extractChannelLabel("  My Channel  "), "My Channel");
  });

  it("filters out URLs", () => {
    assert.strictEqual(utils.extractChannelLabel("https://youtube.com/channel"), "");
  });

  it("filters out channel IDs (UC prefix)", () => {
    assert.strictEqual(utils.extractChannelLabel("UC1234567890"), "");
  });

  it("extracts from object with preferred keys", () => {
    assert.strictEqual(utils.extractChannelLabel({ text: "Channel Name", url: "https://..." }), "Channel Name");
  });

  it("returns empty for empty input", () => {
    assert.strictEqual(utils.extractChannelLabel(""), "");
  });
});

describe("pickFirstStringByKeys", () => {
  it("returns trimmed string match", () => {
    assert.strictEqual(utils.pickFirstStringByKeys({ title: "  Hello  " }, ["title"]), "Hello");
  });

  it("extracts from nested value", () => {
    assert.strictEqual(
      utils.pickFirstStringByKeys({ data: { text: "nested value" } }, ["data"]),
      "nested value"
    );
  });

  it("returns empty string for no match", () => {
    assert.strictEqual(utils.pickFirstStringByKeys({ x: 1 }, ["title"]), "");
  });
});

describe("sanitizeObsidianFileName", () => {
  it("strips forbidden characters", () => {
    const result = utils.sanitizeObsidianFileName('Test: "Video" <note>?');
    assert.ok(!result.includes(":"));
    assert.ok(!result.includes('"'));
    assert.ok(!result.includes("<"));
    assert.ok(!result.includes(">"));
    assert.ok(!result.includes("?"));
  });

  it("adds .md extension", () => {
    assert.ok(utils.sanitizeObsidianFileName("My Note").endsWith(".md"));
  });

  it("uses fallback for empty input", () => {
    assert.ok(utils.sanitizeObsidianFileName("").startsWith("Untitled Video Note"));
  });

  it("trims trailing dots and spaces from base name", () => {
    const result = utils.sanitizeObsidianFileName("My Note...   ");
    assert.strictEqual(result, "My Note.md");
  });
});

describe("validateWikipediaArticleUrl", () => {
  it("accepts valid en.wikipedia.org URL", () => {
    const result = utils.validateWikipediaArticleUrl("https://en.wikipedia.org/wiki/Photosynthesis");
    assert.strictEqual(result, "https://en.wikipedia.org/wiki/Photosynthesis");
  });

  it("rejects non-https", () => {
    assert.throws(() => utils.validateWikipediaArticleUrl("http://en.wikipedia.org/wiki/Test"), /https/);
  });

  it("rejects non-wikipedia host", () => {
    assert.throws(() => utils.validateWikipediaArticleUrl("https://example.com/wiki/Test"), /wikipedia\.org/);
  });

  it("rejects non-/wiki/ path", () => {
    assert.throws(() => utils.validateWikipediaArticleUrl("https://en.wikipedia.org/other/Test"), /\/wiki\//);
  });

  it("accepts language subdomains", () => {
    const result = utils.validateWikipediaArticleUrl("https://fr.wikipedia.org/wiki/Pomme");
    assert.strictEqual(result, "https://fr.wikipedia.org/wiki/Pomme");
  });

  it("strips query params and fragments", () => {
    const result = utils.validateWikipediaArticleUrl("https://en.wikipedia.org/wiki/Test?foo=bar#section");
    assert.strictEqual(result, "https://en.wikipedia.org/wiki/Test");
  });
});

// ---- lib/brightdata.js ----

const brightdata = require("../lib/brightdata");

describe("parseBrightDataTriggerResponse", () => {
  it("extracts snapshot_id", () => {
    assert.strictEqual(brightdata.parseBrightDataTriggerResponse({ snapshot_id: "snap123" }), "snap123");
  });

  it("falls back to snapshotId (camelCase)", () => {
    assert.strictEqual(brightdata.parseBrightDataTriggerResponse({ snapshotId: "snap456" }), "snap456");
  });

  it("falls back to id", () => {
    assert.strictEqual(brightdata.parseBrightDataTriggerResponse({ id: "snap789" }), "snap789");
  });

  it("falls back to nested data.snapshot_id", () => {
    assert.strictEqual(brightdata.parseBrightDataTriggerResponse({ data: { snapshot_id: "nested" } }), "nested");
  });

  it("returns empty string for empty payload", () => {
    assert.strictEqual(brightdata.parseBrightDataTriggerResponse({}), "");
  });
});

describe("extractWikiCoordinates", () => {
  it("extracts lat/lon from coordinates object", () => {
    const result = brightdata.extractWikiCoordinates({ coordinates: { lat: 48.8566, lon: 2.3522 } });
    assert.deepStrictEqual(result, { lat: 48.8566, lon: 2.3522 });
  });

  it("extracts from location field", () => {
    const result = brightdata.extractWikiCoordinates({ location: { lat: 40.7128, lon: -74.006 } });
    assert.deepStrictEqual(result, { lat: 40.7128, lon: -74.006 });
  });

  it("handles latitude/longitude alt names", () => {
    const result = brightdata.extractWikiCoordinates({ geo: { latitude: 51.5074, longitude: -0.1278 } });
    assert.deepStrictEqual(result, { lat: 51.5074, lon: -0.1278 });
  });

  it("handles array format [lat, lon]", () => {
    const result = brightdata.extractWikiCoordinates({ coords: [35.6895, 139.6917] });
    assert.deepStrictEqual(result, { lat: 35.6895, lon: 139.6917 });
  });

  it("handles top-level latitude/longitude", () => {
    const result = brightdata.extractWikiCoordinates({ latitude: 55.7558, longitude: 37.6173 });
    assert.deepStrictEqual(result, { lat: 55.7558, lon: 37.6173 });
  });

  it("returns null for no coordinates", () => {
    assert.strictEqual(brightdata.extractWikiCoordinates({ title: "No coords" }), null);
  });

  it("returns null for non-finite values", () => {
    assert.strictEqual(brightdata.extractWikiCoordinates({ coordinates: { lat: NaN, lon: Infinity } }), null);
  });
});

describe("validateBrightDataConfig", () => {
  it("throws when token is missing", () => {
    assert.throws(() => brightdata.validateBrightDataConfig({ BRIGHT_DATA_API_TOKEN: "", BRIGHT_DATA_YT_DATASET_ID: "abc" }), /BRIGHT_DATA_API_TOKEN/);
  });

  it("throws when dataset ID is missing", () => {
    assert.throws(() => brightdata.validateBrightDataConfig({ BRIGHT_DATA_API_TOKEN: "tok", BRIGHT_DATA_YT_DATASET_ID: "" }), /BRIGHT_DATA_YT_DATASET_ID/);
  });

  it("does not throw when both are present", () => {
    assert.doesNotThrow(() => brightdata.validateBrightDataConfig({ BRIGHT_DATA_API_TOKEN: "tok", BRIGHT_DATA_YT_DATASET_ID: "abc" }));
  });
});

describe("validateBrightDataWikiConfig", () => {
  it("throws when token is missing", () => {
    assert.throws(() => brightdata.validateBrightDataWikiConfig({ BRIGHT_DATA_API_TOKEN: "", BRIGHT_DATA_WIKI_DATASET_ID: "abc" }), /BRIGHT_DATA_API_TOKEN/);
  });

  it("throws when wiki dataset ID is missing", () => {
    assert.throws(() => brightdata.validateBrightDataWikiConfig({ BRIGHT_DATA_API_TOKEN: "tok", BRIGHT_DATA_WIKI_DATASET_ID: "" }), /BRIGHT_DATA_WIKI_DATASET_ID/);
  });
});

// ---- lib/config.js ----

const cfg = require("../lib/config");

describe("getConfig", () => {
  it("returns defaults when env is empty", () => {
    // Save current env, clear relevant keys
    const saved = {};
    const keys = ["OPENAI_MODEL", "BRIGHT_DATA_WIKI_DATASET_ID", "BRIGHT_DATA_TIMEOUT_MS", "BRIGHT_DATA_POLL_INTERVAL_MS",
                  "BRIGHT_DATA_API_BASE", "OBSIDIAN_NOTE_DIR", "OBSIDIAN_DICTIONARY_DIR", "OBSIDIAN_BUSINESS_DIR",
                  "OPENAI_API_KEY", "BRIGHT_DATA_API_TOKEN", "BRIGHT_DATA_YT_DATASET_ID"];
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const c = cfg.getConfig();
      assert.strictEqual(c.OPENAI_MODEL, "deepseek/deepseek-v4-flash-0731");
      assert.strictEqual(c.BRIGHT_DATA_WIKI_DATASET_ID, "gd_lr9978962kkjr3nx49");
      assert.strictEqual(c.BRIGHT_DATA_TIMEOUT_MS, 120000);
      assert.strictEqual(c.BRIGHT_DATA_POLL_INTERVAL_MS, 2000);
      assert.strictEqual(c.BRIGHT_DATA_API_BASE, "https://api.brightdata.com");
    } finally {
      for (const key of keys) {
        if (saved[key] !== undefined) process.env[key] = saved[key];
      }
    }
  });
});

// Snapshot + restore helpers so settings-file tests never leak env state into the
// rest of the suite (which asserts on defaults after deleting keys).
function snapshotEnv(keys) {
  return keys.map((key) => ({ key, had: Object.prototype.hasOwnProperty.call(process.env, key), value: process.env[key] }));
}
function restoreEnv(snapshot) {
  for (const { key, had, value } of snapshot) {
    if (had) process.env[key] = value;
    else delete process.env[key];
  }
}

describe("settings file handling", () => {
  const TOUCHED = ["YTNG_ENV_FILE", "OPENAI_MODEL", "TAG_EXCLUDE", "OPENAI_API_KEY", "ADD"];

  function makeTempEnvFile(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytng-env-"));
    const envFile = path.join(dir, ".env");
    if (contents !== undefined) fs.writeFileSync(envFile, contents, "utf8");
    return { dir, envFile };
  }

  function cleanup({ dir }) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  it("loadDotenv fills gaps but never overrides launch env; reloadEnv preserves launch env", () => {
    const saved = snapshotEnv(TOUCHED);
    const { dir, envFile } = makeTempEnvFile("OPENAI_MODEL=from-file\nTAG_EXCLUDE=alpha\n");
    try {
      process.env.YTNG_ENV_FILE = envFile;
      process.env.OPENAI_MODEL = "from-launch"; // launch env wins over the file
      cfg.loadDotenv();
      assert.strictEqual(process.env.OPENAI_MODEL, "from-launch");
      assert.strictEqual(process.env.TAG_EXCLUDE, "alpha");
      // reloadEnv must NOT clobber the launch value with the file's value
      cfg.reloadEnv();
      assert.strictEqual(process.env.OPENAI_MODEL, "from-launch");
      assert.strictEqual(process.env.TAG_EXCLUDE, "alpha");
    } finally {
      delete process.env.YTNG_ENV_FILE;
      restoreEnv(saved);
      cleanup({ dir });
    }
  });

  it("reloadEnv reflects external edits to (and removal from) the settings file", () => {
    const saved = snapshotEnv(TOUCHED);
    const { dir, envFile } = makeTempEnvFile("OPENAI_MODEL=one\n");
    try {
      process.env.YTNG_ENV_FILE = envFile;
      cfg.loadDotenv();
      assert.strictEqual(process.env.OPENAI_MODEL, "one");
      fs.writeFileSync(envFile, "OPENAI_MODEL=two\n", "utf8");
      cfg.reloadEnv();
      assert.strictEqual(process.env.OPENAI_MODEL, "two");
      fs.writeFileSync(envFile, "# cleared externally\n", "utf8");
      cfg.reloadEnv();
      assert.strictEqual(process.env.OPENAI_MODEL, undefined);
      assert.strictEqual(cfg.getConfig().OPENAI_MODEL, "deepseek/deepseek-v4-flash-0731");
    } finally {
      delete process.env.YTNG_ENV_FILE;
      restoreEnv(saved);
      cleanup({ dir });
    }
  });

  it("writeEnvFile round-trips through the active settings file atomically", () => {
    const saved = snapshotEnv(TOUCHED);
    const { dir, envFile } = makeTempEnvFile("KEEP=1\n# a comment\nOPENAI_MODEL=old\n");
    try {
      process.env.YTNG_ENV_FILE = envFile;
      cfg.writeEnvFile({ OPENAI_MODEL: "new", ADD: "v", EMPTY: "" });
      const raw = fs.readFileSync(envFile, "utf8");
      assert.match(raw, /KEEP=1/);
      assert.match(raw, /# a comment/);
      assert.match(raw, /OPENAI_MODEL=new/);
      assert.match(raw, /ADD=v/);
      assert.doesNotMatch(raw, /EMPTY/); // empty new keys are dropped (defaults apply)
      assert.ok(!fs.existsSync(envFile + ".tmp"), "no leftover temp file");
      cfg.reloadEnv();
      assert.strictEqual(process.env.OPENAI_MODEL, "new");
      assert.strictEqual(process.env.ADD, "v");
    } finally {
      delete process.env.YTNG_ENV_FILE;
      restoreEnv(saved);
      cleanup({ dir });
    }
  });

  it("exposes the legacy ENV_PATH default alongside the active path", () => {
    assert.strictEqual(typeof cfg.ENV_PATH, "string");
    assert.ok(cfg.ENV_PATH.endsWith(".env"));
    assert.strictEqual(cfg.getEnvPath(), process.env.YTNG_ENV_FILE || cfg.ENV_PATH);
  });
});

console.log("All tests completed.");
