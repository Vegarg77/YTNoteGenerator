const { fetchJson } = require("./http");
const { asTrimmedString, validateWikipediaArticleUrl } = require("./utils");

// Wikipedia article text comes from the official MediaWiki action API — no Bright Data,
// no scraping, no credentials. Suggestions (opensearch) and coordinates were already
// direct API calls; the article body now is too, so the whole Wikipedia leg is one
// plain HTTP path. Bright Data remains in use for YouTube transcripts only.
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_ARTICLE_BASE = "https://en.wikipedia.org/wiki/";

// Validation and the URL parser both accept any *.wikipedia.org host (de, fr, …), and the
// Bright Data path used to scrape whatever host it was given. So the API host is derived
// from a caller-supplied URL rather than pinned to English, otherwise a pasted
// de.wikipedia.org link would quietly query the English wiki and return the wrong article
// (or a bogus "no article titled …"). Suggestions stay on English Wikipedia: they come from
// the UI's own search box, not from a URL.
function wikiApiUrl(origin) {
  return `${origin || "https://en.wikipedia.org"}/w/api.php`;
}

// TextExtracts parameters. `exsectionformat=wiki` renders section headings as
// "== Heading ==" / "=== Subheading ===" lines instead of flattening them away, which
// keeps the article's structure in the text handed to the LLM and is what makes
// single-section slicing possible without a second API round trip.
const EXTRACT_PARAMS = {
  explaintext: "1",
  exsectionformat: "wiki"
};

// A heading line produced by exsectionformat=wiki: 2-6 leading "=", the title, and the
// same number of trailing "=". Anchored at both ends so prose containing "=" (a formula,
// a table row) is not mistaken for a heading.
const HEADING_RE = /^(={2,6})\s*(.+?)\s*\1$/;

function wikiArticleUrl(title) {
  return `${WIKI_ARTICLE_BASE}${encodeURIComponent(String(title || "").trim().replace(/\s+/g, "_"))}`;
}

// Anchors and headings differ in spelling conventions ("Private_branch_exchange" vs
// "Private branch exchange"), so compare on a normalized form.
function normalizeSectionTitle(value) {
  return String(value || "").replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseHeading(line) {
  const match = HEADING_RE.exec(String(line || "").trim());
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

// decodeURIComponent throws on a stray "%" (a pasted "/wiki/100%_pure" is enough), which
// would surface as a lookup failure rather than a usable title. Fall back to the raw text.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Split an /wiki/<Article>#<Fragment> URL into its article title and section anchor.
// The URL is validated first so a non-Wikipedia host never reaches the API call, then
// re-parsed because validateWikipediaArticleUrl intentionally returns origin + pathname
// only (it drops the fragment, which is exactly the part we need here).
function wikiLookupFromUrl(rawUrl) {
  validateWikipediaArticleUrl(rawUrl);
  const parsed = new URL(rawUrl);
  const title = safeDecode(parsed.pathname.replace(/^\/wiki\//i, "")).replace(/_/g, " ").trim();
  const anchor = safeDecode((parsed.hash || "").replace(/^#/, "")).replace(/_/g, " ").trim();
  return { title, anchor, origin: parsed.origin };
}

// Cut one section subtree out of a full-article plain-text extract: the section whose
// heading matches `anchor`, plus every subsection beneath it, stopping at the next
// heading of the same or higher level. For "Private branch exchange" in
// Business_telephone_system that means the section itself and its History / System
// components / Current trends / PBX functions children, and it stops at "See also".
// Returns null when the anchor matches no heading (a stale fragment, or a title that was
// renamed after the redirect was created).
function sliceSectionSubtree(extract, anchor) {
  const wanted = normalizeSectionTitle(anchor);
  if (!wanted) return null;

  const lines = String(extract || "").split("\n");
  let startIdx = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const heading = parseHeading(lines[i]);
    if (heading && normalizeSectionTitle(heading.title) === wanted) {
      startIdx = i;
      startLevel = heading.level;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const heading = parseHeading(lines[i]);
    if (heading && heading.level <= startLevel) {
      endIdx = i;
      break;
    }
  }

  const text = lines.slice(startIdx, endIdx).join("\n").trim();
  return { text, title: lines[startIdx].trim().replace(/^=+|=+$/g, "").trim(), level: startLevel };
}

// Namespaces that are not article topics. A prefix list rather than a bare ":" check —
// legitimate main-namespace titles contain colons too ("Star Trek: Voyager", "Mission:
// Impossible"), and dropping those would silently lose pickable topics.
const NON_ARTICLE_NAMESPACE_RE = /^(file|image|category|portal|wikipedia|help|template|talk|user|special|mediawiki|module|draft|book|timedtext|mos):/i;

// Turn a disambiguation page's wikitext into pickable topics. Only entries whose own
// text starts with an article link are offered — a page like PBX mixes those with prose
// lines ("PBX, a rewrite of the [[Project Builder]] IDE…") which are not topics a note
// can be built from. Nested bullets are flattened into the same list.
function parseDisambiguationOptions(wikitext) {
  const options = [];
  const seen = new Set();

  for (const rawLine of String(wikitext || "").split("\n")) {
    const bullet = /^(\*{1,3})\s*(.+)$/.exec(rawLine.trim());
    if (!bullet) continue;

    const link = /^'{0,3}\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]'{0,3}/.exec(bullet[2]);
    if (!link) continue;

    const target = link[1].trim();
    if (!target || NON_ARTICLE_NAMESPACE_RE.test(target)) continue;

    const title = (link[2] || target).trim();
    // Two bullets can point at the same article with different labels ("[[X]]" and
    // "[[X|other name]]"). The article is the identity of the option, so dedupe on the
    // target and keep the first label seen.
    const key = target.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);

    const description = bullet[2]
      .slice(link[0].length)
      .replace(/^[\s,;:–—-]+/, "")
      .replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_, plain, label) => label || plain)
      .replace(/'''?/g, "")
      .replace(/\{\{[^}]*\}\}/g, "")
      .replace(/\s+/g, " ")
      .trim();

    options.push({ title, target, description, url: wikiArticleUrl(target) });
  }

  return options;
}

async function fetchDisambiguationOptions(title, signal, apiUrl = WIKI_API) {
  const params = new URLSearchParams({
    action: "parse",
    page: title,
    prop: "wikitext",
    format: "json",
    formatversion: "2"
  });
  const data = await fetchJson(`${apiUrl}?${params.toString()}`, { signal, label: "Wikipedia API", retryOn429: true });
  return parseDisambiguationOptions(data?.parse?.wikitext || "");
}

async function getWikipediaSuggestions(query, signal) {
  const params = new URLSearchParams({
    action: "opensearch",
    limit: "10",
    namespace: "0",
    format: "json",
    search: query
  });
  const payload = await fetchJson(`${WIKI_API}?${params.toString()}`, { signal, label: "Wikipedia API", retryOn429: true });
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
// text, the canonical URL, coordinates when the article has them, whether the page is a
// disambiguation list, and — when the requested title was a redirect — the section
// anchor it redirects into.
//
// Two cases change what `extract` contains:
//   * section anchor  -> `extract` is that section's subtree only, `url` is anchored
//   * disambiguation  -> `extract` is empty and `disambiguation` lists the topics, so a
//                        caller can offer a choice instead of noting the bare list
async function getWikipediaPage(title, signal, providedUrl) {
  let lookupTitle = asTrimmedString(title);
  let urlAnchor = "";
  let apiUrl = WIKI_API;

  if (providedUrl && providedUrl.trim()) {
    const fromUrl = wikiLookupFromUrl(providedUrl.trim());
    if (!lookupTitle) lookupTitle = fromUrl.title;
    urlAnchor = fromUrl.anchor;
    // Query the same wiki the link came from (see wikiApiUrl).
    apiUrl = wikiApiUrl(fromUrl.origin);
  }

  if (!lookupTitle) {
    throw new Error("Missing Wikipedia article title");
  }

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    prop: "extracts|coordinates|info|pageprops",
    inprop: "url",
    titles: lookupTitle,
    ...EXTRACT_PARAMS
  });

  const data = await fetchJson(`${apiUrl}?${params.toString()}`, { signal, label: "Wikipedia API", retryOn429: true });

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
  // MediaWiki does not follow double redirects, so a single-title lookup yields one entry;
  // scanning for a fragment is defensive and stays correct if a batched lookup is added.
  const redirectEntries = Array.isArray(data?.query?.redirects) ? data.query.redirects : [];
  const redirectAnchor = redirectEntries.map((entry) => entry?.tofragment).find(Boolean) || "";
  // A fragment the caller pasted explicitly wins over the redirect's own anchor: it is a
  // direct instruction about which section to note, and the two can disagree.
  const anchor = (urlAnchor || redirectAnchor || "").replace(/_/g, " ").trim();

  let location = null;
  const coords = Array.isArray(page.coordinates) ? page.coordinates[0] : null;
  const lat = Number(coords?.lat);
  const lon = Number(coords?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    location = { lat, lon };
  }
  // No second coordinates lookup: prop=coordinates above is the same module the old
  // fallback called, so on an article without coordinates that request could only come
  // back empty while still costing a round trip (and adding to Wikipedia's burst limit).

  const canonicalUrl = page.fullurl || wikiArticleUrl(resolvedTitle);
  const rawExtract = page.extract || "";

  const result = {
    title: resolvedTitle,
    extract: rawExtract,
    url: canonicalUrl,
    location,
    // Fields consumed by the section-note path in the UI:
    anchor,
    requestedTitle: lookupTitle,
    sectionTitle: "",
    sectionLevel: 0
  };

  // Disambiguation pages ("PBX may refer to: …") carry no article text worth noting, so
  // offer the listed topics instead. This runs BEFORE the anchor handling on purpose: a
  // page can be both, and an anchor must never turn a disambiguation list into a note
  // (a pasted "…/PBX#Foo", or a section redirect that lands on a disambiguation page).
  // If no topics can be parsed, fall through so the note still gets made.
  if (page.pageprops && Object.prototype.hasOwnProperty.call(page.pageprops, "disambiguation")) {
    const options = await fetchDisambiguationOptions(resolvedTitle, signal, apiUrl);
    if (options.length) {
      result.extract = "";
      result.disambiguation = options;
      return result;
    }
  }

  if (anchor) {
    const section = sliceSectionSubtree(rawExtract, anchor);
    if (section) {
      result.extract = section.text;
      result.sectionTitle = section.title || anchor;
      result.sectionLevel = section.level;
      result.url = `${canonicalUrl}#${encodeURIComponent((section.title || anchor).replace(/\s+/g, "_"))}`;
      return result;
    }

    // Wikipedia's own redirect can point at a heading that no longer exists — seen live
    // with "spunbond" -> Nonwoven fabric#Spunlaid nonwovens, where the article's headings
    // are "Spunbond nonwovens" / "Spunlace nonwovens". Refusing to make a note over a
    // Wikipedia defect helps nobody, and quietly attaching the dead fragment to the source
    // link would be worse. Note the whole article and flag why.
    result.anchorStale = true;
    return result;
  }

  return result;
}

module.exports = {
  getWikipediaSuggestions,
  getWikipediaPage,
  wikiArticleUrl,
  wikiLookupFromUrl,
  normalizeSectionTitle,
  parseHeading,
  sliceSectionSubtree,
  parseDisambiguationOptions,
};
