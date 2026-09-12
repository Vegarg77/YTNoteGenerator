const { fetchJson } = require("./http");
const { asTrimmedString, validateWikipediaArticleUrl } = require("./utils");

// Wikipedia article text comes from the official MediaWiki action API — no Bright Data,
// no scraping, no credentials. Suggestions (opensearch) and coordinates were already
// direct API calls; the article body now is too, so the whole Wikipedia leg is one
// plain HTTP path. Bright Data remains in use for YouTube transcripts only.
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_ARTICLE_BASE = "https://en.wikipedia.org/wiki/";

// TextExtracts parameters. `exsectionformat=wiki` renders section headings as
// "== Heading ==" / "=== Subheading ===" lines instead of flattening them away, which
// keeps the article's structure in the text handed to the LLM and lets a caller slice a
// single section subtree out of one response without a second API round trip.
const EXTRACT_PARAMS = {
  explaintext: "1",
  exsectionformat: "wiki"
};

function wikiArticleUrl(title) {
  return `${WIKI_ARTICLE_BASE}${encodeURIComponent(String(title || "").trim().replace(/\s+/g, "_"))}`;
}

// Split an /wiki/<Article>#<Fragment> URL into its article title and section anchor.
// The URL is validated first so a non-Wikipedia host never reaches the API call, then
// re-parsed because validateWikipediaArticleUrl intentionally returns origin + pathname
// only (it drops the fragment, which is exactly the part we need here).
function wikiLookupFromUrl(rawUrl) {
  validateWikipediaArticleUrl(rawUrl);
  const parsed = new URL(rawUrl);
  const title = decodeURIComponent(parsed.pathname.replace(/^\/wiki\//i, "")).replace(/_/g, " ").trim();
  const anchor = decodeURIComponent((parsed.hash || "").replace(/^#/, "")).replace(/_/g, " ").trim();
  return { title, anchor };
}

async function fetchWikipediaCoordinates(title, signal) {
  const params = new URLSearchParams({
    action: "query",
    titles: title,
    prop: "coordinates",
    format: "json"
  });
  try {
    const data = await fetchJson(`${WIKI_API}?${params.toString()}`, { signal, label: "Wikipedia API" });
    const pages = data?.query?.pages;
    if (!pages) return null;
    for (const page of Object.values(pages)) {
      const coords = Array.isArray(page?.coordinates) ? page.coordinates : [];
      for (const coord of coords) {
        const lat = Number(coord?.lat);
        const lon = Number(coord?.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          return { lat, lon };
        }
      }
    }
  } catch {
    // Best-effort — silently skip if Wikipedia API is unreachable
  }
  return null;
}

async function getWikipediaSuggestions(query, signal) {
  const params = new URLSearchParams({
    action: "opensearch",
    limit: "10",
    namespace: "0",
    format: "json",
    search: query
  });
  const payload = await fetchJson(`${WIKI_API}?${params.toString()}`, { signal, label: "Wikipedia API" });
  const titles = Array.isArray(payload?.[1]) ? payload[1] : [];
  const descriptions = Array.isArray(payload?.[2]) ? payload[2] : [];
  const urls = Array.isArray(payload?.[3]) ? payload[3] : [];

  return titles.map((title, idx) => ({
    title: asTrimmedString(title),
    description: asTrimmedString(descriptions[idx]),
    url: asTrimmedString(urls[idx])
  })).filter((entry) => entry.title);
}

// One API call returns everything a note needs: the resolved article title, its plain
// text, the canonical URL, coordinates when the article has them, and — when the
// requested title was a redirect — the section anchor it redirects into.
async function getWikipediaPage(title, signal, providedUrl) {
  let lookupTitle = asTrimmedString(title);
  let urlAnchor = "";

  if (providedUrl && providedUrl.trim()) {
    const fromUrl = wikiLookupFromUrl(providedUrl.trim());
    if (!lookupTitle) lookupTitle = fromUrl.title;
    urlAnchor = fromUrl.anchor;
  }

  if (!lookupTitle) {
    throw new Error("Missing Wikipedia article title");
  }

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    prop: "extracts|coordinates|info",
    inprop: "url",
    titles: lookupTitle,
    ...EXTRACT_PARAMS
  });

  const data = await fetchJson(`${WIKI_API}?${params.toString()}`, { signal, label: "Wikipedia API" });

  if (data?.error) {
    throw new Error(`Wikipedia API error: ${data.error.info || data.error.code || "unknown error"}`);
  }

  const pages = data?.query?.pages;
  const page = Array.isArray(pages) ? pages[0] : Object.values(pages || {})[0];
  if (!page) {
    throw new Error(`Wikipedia returned no page for "${lookupTitle}"`);
  }
  if (page.missing) {
    throw new Error(`Wikipedia has no article titled "${lookupTitle}"`);
  }

  const resolvedTitle = page.title || lookupTitle;

  // query.redirects only appears when the requested title was a redirect. `tofragment` is
  // the section anchor and is present for redirects that land inside a parent article
  // ("Private branch exchange" -> "Business telephone system#Private branch exchange").
  const anchor = (data?.query?.redirects?.[0]?.tofragment || urlAnchor || "").replace(/_/g, " ").trim();

  let location = null;
  const coords = Array.isArray(page.coordinates) ? page.coordinates[0] : null;
  const lat = Number(coords?.lat);
  const lon = Number(coords?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    location = { lat, lon };
  }
  if (!location) {
    location = await fetchWikipediaCoordinates(resolvedTitle, signal);
  }

  return {
    title: resolvedTitle,
    extract: page.extract || "",
    url: page.fullurl || wikiArticleUrl(resolvedTitle),
    location,
    // Extra fields (ignored by existing callers, used by the section-note path):
    // the anchor the request redirected into, and the title as the user asked for it.
    anchor,
    requestedTitle: lookupTitle
  };
}

module.exports = {
  fetchWikipediaCoordinates,
  getWikipediaSuggestions,
  getWikipediaPage,
  wikiArticleUrl,
  wikiLookupFromUrl,
};
