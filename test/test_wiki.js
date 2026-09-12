const { describe, it } = require("node:test");
const assert = require("node:assert");

const wiki = require("../lib/wiki");

// ---- pure helpers ----

describe("wikiLookupFromUrl", () => {
  it("splits an anchored article URL into title and anchor", () => {
    const result = wiki.wikiLookupFromUrl(
      "https://en.wikipedia.org/wiki/Business_telephone_system#Private_branch_exchange"
    );
    assert.deepStrictEqual(result, {
      title: "Business telephone system",
      anchor: "Private branch exchange",
      origin: "https://en.wikipedia.org"
    });
  });

  it("decodes percent-encoded titles and anchors", () => {
    const result = wiki.wikiLookupFromUrl(
      "https://en.wikipedia.org/wiki/Gal%C3%A1pagos_syndrome#Population_decline"
    );
    assert.strictEqual(result.title, "Galápagos syndrome");
    assert.strictEqual(result.anchor, "Population decline");
  });

  it("returns an empty anchor for a plain article URL", () => {
    const result = wiki.wikiLookupFromUrl("https://en.wikipedia.org/wiki/Sumer");
    assert.deepStrictEqual(result, { title: "Sumer", anchor: "", origin: "https://en.wikipedia.org" });
  });

  it("reports the host of a non-English link", () => {
    const result = wiki.wikiLookupFromUrl("https://de.wikipedia.org/wiki/Sumer");
    assert.strictEqual(result.origin, "https://de.wikipedia.org");
  });

  it("does not throw on a title containing a stray percent sign", () => {
    // decodeURIComponent would raise URIError on "/wiki/100%_pure"
    const result = wiki.wikiLookupFromUrl("https://en.wikipedia.org/wiki/100%_pure");
    assert.strictEqual(result.title, "100% pure");
    assert.strictEqual(result.anchor, "");
  });

  it("rejects a non-Wikipedia host", () => {
    assert.throws(
      () => wiki.wikiLookupFromUrl("https://evil.example.com/wiki/Sumer"),
      /host must be a wikipedia\.org subdomain/
    );
  });

  it("rejects a non-article wikipedia path", () => {
    assert.throws(
      () => wiki.wikiLookupFromUrl("https://en.wikipedia.org/w/index.php?title=Sumer"),
      /must be an \/wiki\/<article> path/
    );
  });
});

describe("wikiArticleUrl", () => {
  it("underscores spaces and percent-encodes", () => {
    assert.strictEqual(
      wiki.wikiArticleUrl("Business telephone system"),
      "https://en.wikipedia.org/wiki/Business_telephone_system"
    );
  });
});

// ---- getWikipediaPage against a stubbed API ----

const REAL_FETCH = global.fetch;

function stubFetch(payload, { status = 200 } = {}) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "OK",
      text: async () => JSON.stringify(payload)
    };
  };
  return calls;
}

describe("getWikipediaPage", () => {
  it("resolves a section redirect to its parent article and reports the anchor", async () => {
    const calls = stubFetch({
      query: {
        redirects: [
          { from: "Private branch exchange", to: "Business telephone system", tofragment: "Private branch exchange" }
        ],
        pages: [
          {
            pageid: 1017561,
            ns: 0,
            title: "Business telephone system",
            fullurl: "https://en.wikipedia.org/wiki/Business_telephone_system",
            coordinates: [{ lat: 1, lon: 2 }],
            extract: "== Private branch exchange ==\nA Private Branch Exchange (PBX) system..."
          }
        ]
      }
    });

    try {
      const page = await wiki.getWikipediaPage("Private branch exchange", undefined, undefined);

      assert.strictEqual(page.title, "Business telephone system");
      assert.strictEqual(page.anchor, "Private branch exchange");
      assert.strictEqual(page.requestedTitle, "Private branch exchange");
      assert.strictEqual(page.url, "https://en.wikipedia.org/wiki/Business_telephone_system");
      assert.deepStrictEqual(page.location, { lat: 1, lon: 2 });
      assert.match(page.extract, /Private Branch Exchange/);

      // exactly one request: the article body is not fetched twice, and the inline
      // coordinates mean no follow-up coordinate lookup
      assert.strictEqual(calls.length, 1);
      const sent = new URL(calls[0].url);
      assert.strictEqual(sent.searchParams.get("action"), "query");
      assert.strictEqual(sent.searchParams.get("redirects"), "1");
      assert.strictEqual(sent.searchParams.get("explaintext"), "1");
      assert.strictEqual(sent.searchParams.get("exsectionformat"), "wiki");
      assert.match(sent.searchParams.get("prop"), /extracts/);
      assert.strictEqual(sent.searchParams.get("titles"), "Private branch exchange");

      // Wikimedia's User-Agent policy: a descriptive agent has to be sent, or the request
      // gets throttled (the HTTP 429s seen against the live API).
      const ua = Object.entries(calls[0].headers)
        .find(([key]) => key.toLowerCase() === "user-agent");
      assert.ok(ua, "a User-Agent header must be sent");
      assert.match(ua[1], /^YTNoteGenerator\//);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("reports no anchor for a redirect that targets a whole article", async () => {
    stubFetch({
      query: {
        redirects: [{ from: "Sumerians", to: "Sumer" }],
        pages: [{ pageid: 1, ns: 0, title: "Sumer", fullurl: "https://en.wikipedia.org/wiki/Sumer", extract: "Sumer was..." }]
      }
    });
    try {
      const page = await wiki.getWikipediaPage("Sumerians", undefined, undefined);
      assert.strictEqual(page.title, "Sumer");
      assert.strictEqual(page.anchor, "");
      assert.strictEqual(page.requestedTitle, "Sumerians");
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("uses the anchor from a pasted URL when no title is given", async () => {
    const calls = stubFetch({
      query: {
        pages: [{ pageid: 2, ns: 0, title: "Sumer", fullurl: "https://en.wikipedia.org/wiki/Sumer", extract: "Sumer was..." }]
      }
    });
    try {
      const page = await wiki.getWikipediaPage(
        "",
        undefined,
        "https://en.wikipedia.org/wiki/Sumer#History"
      );
      assert.strictEqual(page.requestedTitle, "Sumer");
      assert.strictEqual(page.anchor, "History");
      assert.strictEqual(new URL(calls[0].url).searchParams.get("titles"), "Sumer");
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("makes a single request for an article with no coordinates", async () => {
    const calls = stubFetch({
      query: {
        pages: [{
          pageid: 3, ns: 0, title: "Business telephone system",
          fullurl: "https://en.wikipedia.org/wiki/Business_telephone_system",
          extract: "A business telephone system is..."
        }]
      }
    });
    try {
      const page = await wiki.getWikipediaPage("Business telephone system", undefined, undefined);
      assert.strictEqual(page.location, null);
      // prop=coordinates is already in the query, so there is no follow-up lookup to make
      assert.strictEqual(calls.length, 1);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("queries the same wiki a pasted link came from", async () => {
    const calls = stubFetch({
      query: {
        pages: [{ pageid: 5, ns: 0, title: "Sumer", fullurl: "https://de.wikipedia.org/wiki/Sumer", extract: "Sumer war..." }]
      }
    });
    try {
      await wiki.getWikipediaPage("", undefined, "https://de.wikipedia.org/wiki/Sumer");
      // pinned to en.wikipedia.org this would have queried the wrong wiki and come back
      // with the wrong article (or a bogus "no article titled …")
      assert.match(calls[0].url, /^https:\/\/de\.wikipedia\.org\/w\/api\.php\?/);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("prefers a pasted fragment over the redirect's own anchor", async () => {
    stubFetch({
      query: {
        redirects: [{ from: "Sumerians", to: "Sumer", tofragment: "Redirect section" }],
        pages: [{ pageid: 1, ns: 0, title: "Sumer", fullurl: "https://en.wikipedia.org/wiki/Sumer", extract: "Sumer was..." }]
      }
    });
    try {
      const page = await wiki.getWikipediaPage("", undefined, "https://en.wikipedia.org/wiki/Sumerians#History");
      assert.strictEqual(page.anchor, "History", "the fragment the caller pasted wins");
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("throws a clear error for a missing article", async () => {
    stubFetch({ query: { pages: [{ ns: 0, title: "Zzzz nope", missing: true }] } });
    try {
      await assert.rejects(
        () => wiki.getWikipediaPage("Zzzz nope", undefined, undefined),
        /no article titled "Zzzz nope"/
      );
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("surfaces an API-level error", async () => {
    stubFetch({ error: { code: "badvalue", info: "Unrecognized value for parameter" } });
    try {
      await assert.rejects(
        () => wiki.getWikipediaPage("Sumer", undefined, undefined),
        /Wikipedia API error: Unrecognized value for parameter/
      );
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("rejects an invalid provided URL before calling the API", async () => {
    const calls = stubFetch({ query: { pages: [] } });
    try {
      await assert.rejects(
        () => wiki.getWikipediaPage("", undefined, "https://evil.example.com/wiki/Sumer"),
        /host must be a wikipedia\.org subdomain/
      );
      assert.strictEqual(calls.length, 0);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });
});
