const brightdata = require("./brightdata");
const { asTrimmedString, validateWikipediaArticleUrl } = require("./utils");

async function fetchWikipediaCoordinates(title, signal) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=coordinates&format=json`;
  try {
    const data = await brightdata.fetchJson(url, { signal, label: "Wikipedia API" });
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
  const suggestionUrl =
    `https://en.wikipedia.org/w/api.php?action=opensearch&limit=10&namespace=0&format=json&search=${encodeURIComponent(query)}`;
  const rawText = await brightdata.fetchText(suggestionUrl, { signal });
  const payload = JSON.parse(rawText || "[]");
  const titles = Array.isArray(payload?.[1]) ? payload[1] : [];
  const descriptions = Array.isArray(payload?.[2]) ? payload[2] : [];
  const urls = Array.isArray(payload?.[3]) ? payload[3] : [];

  return titles.map((title, idx) => ({
    title: asTrimmedString(title),
    description: asTrimmedString(descriptions[idx]),
    url: asTrimmedString(urls[idx])
  })).filter((entry) => entry.title);
}

async function getWikipediaPage(title, signal, providedUrl) {
  const trimmedTitle = (title || "").trim();
  const urlTitle = trimmedTitle.replace(/\s+/g, "_");
  const articleUrl = providedUrl && providedUrl.trim()
    ? validateWikipediaArticleUrl(providedUrl.trim())
    : `https://en.wikipedia.org/wiki/${encodeURIComponent(urlTitle)}`;
  const items = await brightdata.brightDataWikipediaScrape(articleUrl, signal);

  if (!items.length) {
    throw new Error(`Bright Data returned no Wikipedia results for "${trimmedTitle || articleUrl}"`);
  }

  const normalize = (s) => (s || "").trim().toLowerCase().replace(/[\s_]+/g, " ");

  const slugFromUrl = (rawUrl) => {
    if (!rawUrl) return "";
    try {
      const path = new URL(rawUrl).pathname;
      return normalize(decodeURIComponent(path.replace(/^\/wiki\//i, "")));
    } catch {
      return "";
    }
  };

  const wantTitle = normalize(trimmedTitle);
  const wantSlug = slugFromUrl(articleUrl);

  const match = items.find(
    (item) =>
      (wantTitle && normalize(item.title) === wantTitle) ||
      (wantSlug && slugFromUrl(item.url) === wantSlug)
  );

  if (!match) {
    const returned = items
      .map((item) => item.title || item.url || "(unknown)")
      .slice(0, 5)
      .join(", ");
    throw new Error(
      `Bright Data did not return the requested Wikipedia article "${trimmedTitle || articleUrl}". Candidates: ${returned}`
    );
  }

  const resolvedTitle = match.title || trimmedTitle;

  let location = match.location || null;
  if (!location) {
    location = await fetchWikipediaCoordinates(resolvedTitle, signal);
  }

  return {
    title: resolvedTitle,
    extract: match.extract || match.description || "",
    url: match.url || articleUrl,
    location
  };
}

module.exports = {
  fetchWikipediaCoordinates,
  getWikipediaSuggestions,
  getWikipediaPage,
};
