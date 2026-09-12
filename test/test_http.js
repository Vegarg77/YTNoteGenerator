const { describe, it } = require("node:test");
const assert = require("node:assert");

const { fetchJson } = require("../lib/http");

const REAL_FETCH = global.fetch;

// Queue of responses consumed in call order; the last entry repeats.
function stubFetch(responses) {
  const calls = [];
  global.fetch = async (url, options) => {
    const index = calls.length;
    calls.push({ url: String(url), signal: options?.signal });
    const spec = responses[Math.min(index, responses.length - 1)];
    if (spec instanceof Error) throw spec;
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      statusText: spec.statusText || "OK",
      text: async () => spec.body
    };
  };
  return calls;
}

describe("fetchJson", () => {
  it("parses a successful JSON body", async () => {
    const calls = stubFetch([{ status: 200, body: JSON.stringify({ query: { pages: [] } }) }]);
    try {
      const data = await fetchJson("https://example.test/api");
      assert.deepStrictEqual(data, { query: { pages: [] } });
      assert.strictEqual(calls.length, 1);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("retries a 429 when asked and succeeds on the later attempt", async () => {
    const calls = stubFetch([
      { status: 429, statusText: "Too Many Requests", body: "slow down" },
      { status: 200, body: JSON.stringify({ ok: true }) }
    ]);
    try {
      const data = await fetchJson("https://example.test/api", { retryOn429: true });
      assert.deepStrictEqual(data, { ok: true });
      assert.strictEqual(calls.length, 2);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("does not retry a 429 when retryOn429 is off", async () => {
    const calls = stubFetch([{ status: 429, body: "slow down" }]);
    try {
      await assert.rejects(
        () => fetchJson("https://example.test/api"),
        /failed \(429\)/
      );
      assert.strictEqual(calls.length, 1);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("explains a rate limit it could not outlast", async () => {
    const calls = stubFetch([{ status: 429, body: "slow down" }]);
    try {
      await assert.rejects(
        () => fetchJson("https://example.test/api", { retryOn429: true, label: "Wikipedia API" }),
        /Wikipedia is rate-limiting requests — try again in a moment/
      );
      assert.strictEqual(calls.length, 3, "one initial attempt plus two retries");
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("never retries a non-429 failure", async () => {
    const calls = stubFetch([{ status: 500, statusText: "Server Error", body: "boom" }]);
    try {
      await assert.rejects(
        () => fetchJson("https://example.test/api", { retryOn429: true }),
        /failed \(500\): boom/
      );
      assert.strictEqual(calls.length, 1);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("reports a non-JSON body rather than throwing a parse error", async () => {
    stubFetch([{ status: 200, body: "<html>not json</html>" }]);
    try {
      await assert.rejects(
        () => fetchJson("https://example.test/api", { label: "Wikipedia API" }),
        /Wikipedia API GET https:\/\/example\.test\/api returned non-JSON body/
      );
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("returns an empty object for an empty body", async () => {
    stubFetch([{ status: 200, body: "" }]);
    try {
      assert.deepStrictEqual(await fetchJson("https://example.test/api"), {});
    } finally {
      global.fetch = REAL_FETCH;
    }
  });
});
