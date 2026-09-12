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

// Shaped like a real exsectionformat=wiki extract: level-2 sections, level-3 and level-4
// children, and the trailing boilerplate sections that must fall outside every slice.
const ARTICLE = [
  "A business telephone system is a telephone system typically used in business environments.",
  "",
  "== Key telephone system ==",
  "A key telephone system is one where the user selects the line.",
  "",
  "=== Electronic shared-control system ===",
  "Later electronic variants arrived.",
  "",
  "== Private branch exchange ==",
  "A Private Branch Exchange (PBX) system is a private phone network.",
  "",
  "=== History ===",
  "The term PBX originated when switchboard operators managed company switchboards.",
  "",
  "==== Manual PBX ====",
  "The first manual PBX was installed in 1879.",
  "",
  "=== Hosted PBX systems ===",
  "Hosted PBX runs the call routing in software.",
  "",
  "== See also ==",
  "* Business telephone system",
  "",
  "== References ==",
  "{{reflist}}"
].join("\n");

describe("sliceSectionSubtree", () => {
  it("keeps the section and all of its subsections, and stops at the next peer section", () => {
    const result = wiki.sliceSectionSubtree(ARTICLE, "Private branch exchange");
    assert.ok(result, "expected a slice");
    assert.strictEqual(result.level, 2);
    assert.strictEqual(result.title, "Private branch exchange");

    assert.match(result.text, /A Private Branch Exchange \(PBX\) system/);
    assert.match(result.text, /=== History ===/);
    assert.match(result.text, /==== Manual PBX ====/);
    assert.match(result.text, /=== Hosted PBX systems ===/);

    // the next level-2 section and everything after it is out of scope
    assert.doesNotMatch(result.text, /See also/);
    assert.doesNotMatch(result.text, /References/);
    // and so is the preceding section
    assert.doesNotMatch(result.text, /Key telephone system/);
  });

  it("slices a level-3 section without swallowing its level-2 parent's other children", () => {
    const result = wiki.sliceSectionSubtree(ARTICLE, "History");
    assert.ok(result);
    assert.strictEqual(result.level, 3);
    assert.match(result.text, /==== Manual PBX ====/);
    assert.doesNotMatch(result.text, /Hosted PBX systems/);
  });

  it("matches anchors that use underscores instead of spaces", () => {
    const result = wiki.sliceSectionSubtree(ARTICLE, "Private_branch_exchange");
    assert.ok(result);
    assert.strictEqual(result.title, "Private branch exchange");
  });

  it("returns null when the anchor matches no heading", () => {
    assert.strictEqual(wiki.sliceSectionSubtree(ARTICLE, "Renamed section"), null);
    assert.strictEqual(wiki.sliceSectionSubtree(ARTICLE, ""), null);
  });

  it("does not mistake prose containing '=' for a heading", () => {
    const withFormula = [
      "== Real section ==",
      "The relationship C = 2*pi*r holds.",
      "A = B = C",
      "",
      "== Next ==",
      "unrelated"
    ].join("\n");
    const result = wiki.sliceSectionSubtree(withFormula, "Real section");
    assert.match(result.text, /C = 2\*pi\*r/);
    assert.doesNotMatch(result.text, /unrelated/);
  });
});

describe("parseDisambiguationOptions", () => {
  // Real PBX wikitext: flat bullets, italic labels, a prose entry with no leading link,
  // and a multi-link entry whose second link is inside the description.
  const PBX_WIKITEXT = [
    "'''PBX''' may refer to:",
    "",
    "*[[Pakubuwono X]], the tenth ''Susuhunan'' of Surakarta in Java, Indonesia",
    "*[[Polymer-bonded explosive]]",
    "*[[Pre-B-cell leukemia homeobox]]",
    "*[[Private branch exchange]], a telephone exchange that serves a particular business or office",
    "*''[[PBX Funicular Intaglio Zone]]'', a 2012 album by John Frusciante",
    "*PBX, a rewrite of the [[Project Builder]] IDE for Mac OS X systems, now known as [[Xcode]]",
    "*[[PhotoBox]], a digital photo printing service",
    "",
    "{{disambig}}"
  ].join("\n");

  it("offers each linked topic with its description", () => {
    const options = wiki.parseDisambiguationOptions(PBX_WIKITEXT);
    const titles = options.map((option) => option.title);

    assert.deepStrictEqual(titles, [
      "Pakubuwono X",
      "Polymer-bonded explosive",
      "Pre-B-cell leukemia homeobox",
      "Private branch exchange",
      "PBX Funicular Intaglio Zone",
      "PhotoBox"
    ]);

    const pbe = options.find((option) => option.title === "Private branch exchange");
    assert.strictEqual(pbe.target, "Private branch exchange");
    assert.strictEqual(pbe.description, "a telephone exchange that serves a particular business or office");
    assert.strictEqual(pbe.url, "https://en.wikipedia.org/wiki/Private_branch_exchange");

    // italic label and italic description markup are stripped
    const album = options.find((option) => option.title === "PBX Funicular Intaglio Zone");
    assert.strictEqual(album.description, "a 2012 album by John Frusciante");
  });

  it("skips prose entries that do not lead with a link", () => {
    const options = wiki.parseDisambiguationOptions(PBX_WIKITEXT);
    assert.strictEqual(options.some((option) => option.title.includes("rewrite")), false);
  });

  it("flattens nested sub-bullets into the same list", () => {
    const nested = [
      "*[[Polymer-bonded explosive]]",
      "**[[PBX (explosive)]], a family of related explosives",
      "*[[PhotoBox]]"
    ].join("\n");
    const options = wiki.parseDisambiguationOptions(nested);
    assert.deepStrictEqual(options.map((o) => o.title), ["Polymer-bonded explosive", "PBX (explosive)", "PhotoBox"]);
  });

  it("skips non-article namespaces and dedupes repeated topics", () => {
    const noisy = [
      "*[[File:PBX.jpg|thumb]]",
      "*[[Category:Telephony]]",
      "*[[Private branch exchange]]",
      "*[[Private branch exchange|PBX]]"
    ].join("\n");
    const options = wiki.parseDisambiguationOptions(noisy);
    assert.deepStrictEqual(options.map((o) => o.title), ["Private branch exchange"]);
  });

  it("returns an empty list for a page with no list items", () => {
    assert.deepStrictEqual(wiki.parseDisambiguationOptions("Just prose.\n\n{{disambig}}"), []);
  });
});

// ---- getWikipediaPage against a stubbed API ----

const REAL_FETCH = global.fetch;

// `payloads` may be a single response object (returned for every call) or an array of
// responses consumed in call order.
function stubFetch(payloads, { status = 200 } = {}) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const index = calls.length;
    calls.push({ url: String(url), headers: options.headers || {} });
    const payload = Array.isArray(payloads) ? payloads[Math.min(index, payloads.length - 1)] : payloads;
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
  it("resolves a section redirect and returns only that section's subtree", async () => {
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
            extract: ARTICLE
          }
        ]
      }
    });

    try {
      const page = await wiki.getWikipediaPage("Private branch exchange", undefined, undefined);

      assert.strictEqual(page.title, "Business telephone system");
      assert.strictEqual(page.anchor, "Private branch exchange");
      assert.strictEqual(page.requestedTitle, "Private branch exchange");
      assert.strictEqual(page.sectionTitle, "Private branch exchange");
      assert.strictEqual(page.sectionLevel, 2);
      assert.strictEqual(page.url, "https://en.wikipedia.org/wiki/Business_telephone_system#Private_branch_exchange");
      assert.deepStrictEqual(page.location, { lat: 1, lon: 2 });

      // the note source is the PBX section, not the whole parent article
      assert.match(page.extract, /A Private Branch Exchange \(PBX\) system/);
      assert.match(page.extract, /=== History ===/);
      assert.doesNotMatch(page.extract, /Key telephone system/);
      assert.doesNotMatch(page.extract, /See also/);

      assert.strictEqual(calls.length, 1);
      const sent = new URL(calls[0].url);
      assert.strictEqual(sent.searchParams.get("action"), "query");
      assert.strictEqual(sent.searchParams.get("redirects"), "1");
      assert.strictEqual(sent.searchParams.get("explaintext"), "1");
      assert.strictEqual(sent.searchParams.get("exsectionformat"), "wiki");
      assert.match(sent.searchParams.get("prop"), /extracts/);
      assert.match(sent.searchParams.get("prop"), /pageprops/);
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

  it("returns the full article when the redirect has no section anchor", async () => {
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
      assert.strictEqual(page.sectionTitle, "");
      assert.strictEqual(page.extract, "Sumer was...");
      assert.strictEqual(page.url, "https://en.wikipedia.org/wiki/Sumer");
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("falls back to the full article when a redirect's anchor is stale", async () => {
    // seen live: "spunbond" -> Nonwoven fabric#Spunlaid nonwovens, but the article's
    // headings are "Spunbond nonwovens" / "Spunlace nonwovens"
    stubFetch({
      query: {
        redirects: [{ from: "Spunbond", to: "Business telephone system", tofragment: "Renamed section" }],
        pages: [{
          pageid: 1, ns: 0, title: "Business telephone system",
          fullurl: "https://en.wikipedia.org/wiki/Business_telephone_system",
          coordinates: [{ lat: 1, lon: 2 }],
          extract: ARTICLE
        }]
      }
    });
    try {
      const page = await wiki.getWikipediaPage("Spunbond", undefined, undefined);

      assert.strictEqual(page.anchorStale, true);
      assert.strictEqual(page.sectionTitle, "");
      assert.strictEqual(page.extract, ARTICLE);
      // the dead fragment is never attached to the source link
      assert.strictEqual(page.url, "https://en.wikipedia.org/wiki/Business_telephone_system");
      assert.doesNotMatch(page.url, /#/);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("offers the topics of a disambiguation page instead of its bare list", async () => {
    const calls = stubFetch([
      {
        query: {
          pages: [{
            pageid: 334414,
            ns: 0,
            title: "PBX",
            fullurl: "https://en.wikipedia.org/wiki/PBX",
            coordinates: [{ lat: 1, lon: 2 }],
            pageprops: { disambiguation: "", wikibase_item: "Q3359594" },
            extract: "PBX may refer to:\n\nPakubuwono X\nPolymer-bonded explosive"
          }]
        }
      },
      { parse: { title: "PBX", wikitext: "*[[Private branch exchange]], a telephone exchange that serves a particular business or office\n*[[PhotoBox]], a digital photo printing service" } }
    ]);

    try {
      const page = await wiki.getWikipediaPage("PBX", undefined, undefined);

      assert.strictEqual(page.extract, "");
      assert.deepStrictEqual(page.disambiguation.map((o) => o.title), ["Private branch exchange", "PhotoBox"]);

      assert.strictEqual(calls.length, 2);
      assert.strictEqual(new URL(calls[0].url).searchParams.get("action"), "query");
      assert.strictEqual(new URL(calls[1].url).searchParams.get("action"), "parse");
      assert.strictEqual(new URL(calls[1].url).searchParams.get("page"), "PBX");
      assert.strictEqual(new URL(calls[1].url).searchParams.get("prop"), "wikitext");
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("falls back to the plain extract when a disambiguation page yields no parseable topics", async () => {
    stubFetch([
      {
        query: {
          pages: [{
            pageid: 1, ns: 0, title: "Some index", fullurl: "https://en.wikipedia.org/wiki/Some_index",
            coordinates: [{ lat: 1, lon: 2 }],
            pageprops: { disambiguation: "" },
            extract: "Some index may refer to things."
          }]
        }
      },
      { parse: { title: "Some index", wikitext: "Prose only, no list items." } }
    ]);
    try {
      const page = await wiki.getWikipediaPage("Some index", undefined, undefined);
      assert.strictEqual(page.extract, "Some index may refer to things.");
      assert.strictEqual(page.disambiguation, undefined);
    } finally {
      global.fetch = REAL_FETCH;
    }
  });

  it("uses the anchor from a pasted URL when no title is given", async () => {
    const calls = stubFetch({
      query: {
        pages: [{ pageid: 2, ns: 0, title: "Sumer", fullurl: "https://en.wikipedia.org/wiki/Sumer", extract: "== History ==\nSumer was..." }]
      }
    });
    try {
      const page = await wiki.getWikipediaPage("", undefined, "https://en.wikipedia.org/wiki/Sumer#History");
      assert.strictEqual(page.requestedTitle, "Sumer");
      assert.strictEqual(page.anchor, "History");
      assert.strictEqual(page.sectionTitle, "History");
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
