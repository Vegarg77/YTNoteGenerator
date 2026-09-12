const { describe, it } = require("node:test");
const assert = require("node:assert");

const { fetchJson, DEFAULT_RETRY_429_DELAYS_MS } = require("../lib/http");

const REAL_FETCH = global.fetch;

// Queue of responses consumed in call order; the last entry repeats.
function abortError() {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

function stubFetch(responses) {
  const calls = [];
  global.fetch = async (url, options) => {
    const index = calls.length;
    calls.push({ url: String(url), signal: options?.signal });
    // Real fetch rejects immediately when handed an already-aborted signal; the retry
    // backoff relies on that to surface a cancellation as an AbortError.
    if (options?.signal?.aborted) throw abortError();
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
      const data = await fetchJson("https://example.test/api", { retryOn429: true, retryDelaysMs: [1, 1] });
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
        () => fetchJson("https://example.test/api", { retryOn429: true, retryDelaysMs: [1, 1], label: "Wikipedia API" }),
        /Wikipedia API GET https:\/\/example\.test\/api failed \(429\): rate-limited — try again in a moment/
      );
      assert.strictEqual(calls.length, 3, "one initial attempt plus two retries");
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("keeps the default backoff injectable but defined", () => {
    // asserted as a constant rather than by sleeping: the suite must not wait 1.5s + 3s
    assert.deepStrictEqual(DEFAULT_RETRY_429_DELAYS_MS, [1500, 3000]);
  });

  it("stops retrying as soon as the caller aborts during the backoff", async () => {
    const calls = stubFetch([{ status: 429, body: "slow down" }]);
    const controller = new AbortController();
    const started = Date.now();
    try {
      const pending = fetchJson("https://example.test/api", {
        retryOn429: true,
        retryDelaysMs: [400, 400],
        signal: controller.signal
      });
      setTimeout(() => controller.abort(), 40);

      await assert.rejects(pending, (err) => err.name === "AbortError");
      assert.strictEqual(calls.length, 2, "the initial attempt plus the one that saw the abort");
      assert.ok(Date.now() - started < 300, "must not wait out the 400ms backoff");
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("does not hang on an already-aborted signal", async () => {
    const calls = stubFetch([{ status: 429, body: "slow down" }]);
    const controller = new AbortController();
    controller.abort();
    try {
      await assert.rejects(
        () => fetchJson("https://example.test/api", {
          retryOn429: true,
          retryDelaysMs: [5000, 5000],
          signal: controller.signal
        }),
        (err) => err.name === "AbortError"
      );
      assert.strictEqual(calls.length, 1);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("releases the discarded 429 response before backing off", async () => {
    let cancels = 0;
    global.fetch = async (url, options) => {
      if (options?.signal?.aborted) throw abortError();
      return {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        body: { cancel: async () => { cancels += 1; } },
        text: async () => "slow down"
      };
    };
    try {
      await assert.rejects(
        () => fetchJson("https://example.test/api", { retryOn429: true, retryDelaysMs: [1, 1] }),
        /rate-limited/
      );
      assert.strictEqual(cancels, 2, "one cancel per retried 429");
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
