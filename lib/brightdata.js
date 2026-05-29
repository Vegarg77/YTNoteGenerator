const config = require("./config");
const { collectStringValues, pickFirstByKeys, asTrimmedString, extractNestedString, extractChannelLabel, pickFirstStringByKeys } = require("./utils");

// ---- HTTP helpers ----

async function fetchJson(url, { method = "GET", headers = {}, body, signal, label } = {}) {
  const resp = await fetch(url, { method, headers, body, signal });
  const prefix = label ? `${label} ` : "";

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${prefix}${method} ${url} failed (${resp.status}): ${text || resp.statusText}`);
  }

  const text = await resp.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${prefix}${method} ${url} returned non-JSON body`);
  }
}

async function fetchText(url, { method = "GET", headers = {}, signal } = {}) {
  const resp = await fetch(url, { method, headers, signal });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${method} ${url} failed (${resp.status}): ${text || resp.statusText}`);
  }
  return resp.text();
}

// ---- Bright Data snapshot helpers ----

function parseBrightDataTriggerResponse(payload) {
  return payload?.snapshot_id || payload?.snapshotId || payload?.id || payload?.data?.snapshot_id || "";
}

async function waitForPollInterval(signal, pollMs) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, pollMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Bright Data polling aborted"));
    }, { once: true });
  });
}

async function pollBrightDataSnapshot(snapshotId, signal, cfg) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < cfg.BRIGHT_DATA_TIMEOUT_MS) {
    const progressUrl = `${cfg.BRIGHT_DATA_API_BASE}/datasets/v3/progress/${encodeURIComponent(snapshotId)}`;
    const progress = await fetchJson(progressUrl, {
      headers: { Authorization: `Bearer ${cfg.BRIGHT_DATA_API_TOKEN}` },
      signal
    });

    const status = String(progress?.status || "").toLowerCase();
    if (status === "ready" || status === "completed" || status === "success") return;

    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`Bright Data snapshot ${snapshotId} failed with status: ${progress?.status || "unknown"}`);
    }

    await waitForPollInterval(signal, cfg.BRIGHT_DATA_POLL_INTERVAL_MS);
  }

  // Snapshot not ready within normal timeout — retry 3 times at 60-second intervals
  const RETRY_INTERVAL_MS = config.SNAPSHOT_RETRY_INTERVAL_MS;
  const MAX_RETRIES = config.SNAPSHOT_MAX_RETRIES;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[${new Date().toLocaleTimeString()}] Snapshot ${snapshotId} timed out — retry ping ${attempt}/${MAX_RETRIES} in 60s`);
    await waitForPollInterval(signal, RETRY_INTERVAL_MS);

    const progressUrl = `${cfg.BRIGHT_DATA_API_BASE}/datasets/v3/progress/${encodeURIComponent(snapshotId)}`;
    const progress = await fetchJson(progressUrl, {
      headers: { Authorization: `Bearer ${cfg.BRIGHT_DATA_API_TOKEN}` },
      signal
    });

    const status = String(progress?.status || "").toLowerCase();
    if (status === "ready" || status === "completed" || status === "success") {
      console.log(`[${new Date().toLocaleTimeString()}] Snapshot ${snapshotId} became ready on retry ping ${attempt}`);
      return;
    }

    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`Bright Data snapshot ${snapshotId} failed with status: ${progress?.status || "unknown"}`);
    }
  }

  throw new Error(`Timed out waiting for Bright Data snapshot ${snapshotId}`);
}

// ---- YouTube transcript ----

function validateBrightDataConfig(cfg) {
  const missing = [];
  if (!cfg.BRIGHT_DATA_API_TOKEN) missing.push("BRIGHT_DATA_API_TOKEN");
  if (!cfg.BRIGHT_DATA_YT_DATASET_ID) missing.push("BRIGHT_DATA_YT_DATASET_ID");
  if (missing.length) {
    throw new Error(`Missing Bright Data env vars: ${missing.join(", ")}`);
  }
}

function parseBrightDataItem(item, fallbackUrl, fallbackVideoId) {
  const transcriptRaw = pickFirstByKeys(item, ["transcript", "captions", "subtitle", "subtitles"]);
  const transcriptCandidates = collectStringValues(transcriptRaw);
  const transcript = transcriptCandidates.join("\n").trim();

  const title = asTrimmedString(pickFirstByKeys(item, ["title", "video_title", "name"]));
  const channel = extractChannelLabel(item?.handle_name) || extractNestedString(item?.handle_name) || "";
  const sourceUrl = asTrimmedString(pickFirstByKeys(item, ["url", "video_url", "link"])) || fallbackUrl;
  const sourceVideoId = asTrimmedString(pickFirstByKeys(item, ["video_id", "id"])) || fallbackVideoId;

  return {
    transcript,
    metadata: {
      title,
      channel,
      url: sourceUrl || (sourceVideoId ? `https://www.youtube.com/watch?v=${sourceVideoId}` : "https://www.youtube.com")
    }
  };
}

async function fetchTranscriptBundle(videoId, rawUrl, signal) {
  const cfg = config.getConfig();
  validateBrightDataConfig(cfg);

  const resolvedUrl = rawUrl || `https://www.youtube.com/watch?v=${videoId}`;
  const triggerUrl = `${cfg.BRIGHT_DATA_API_BASE}/datasets/v3/trigger?dataset_id=${encodeURIComponent(cfg.BRIGHT_DATA_YT_DATASET_ID)}&notify=false&include_errors=true`;

  const triggerResp = await fetchJson(triggerUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.BRIGHT_DATA_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ input: [{ url: resolvedUrl }] }),
    signal
  });

  const snapshotId = parseBrightDataTriggerResponse(triggerResp);
  if (!snapshotId) {
    throw new Error("Bright Data trigger did not return a snapshot id");
  }

  await pollBrightDataSnapshot(snapshotId, signal, cfg);

  const snapshotUrl = `${cfg.BRIGHT_DATA_API_BASE}/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`;
  const snapshotData = await fetchJson(snapshotUrl, {
    headers: { Authorization: `Bearer ${cfg.BRIGHT_DATA_API_TOKEN}` },
    signal
  });

  const items = Array.isArray(snapshotData)
    ? snapshotData
    : (Array.isArray(snapshotData?.data) ? snapshotData.data : []);

  if (!items.length) {
    throw new Error(`Bright Data snapshot ${snapshotId} returned no records`);
  }

  const parsed = parseBrightDataItem(items[0], resolvedUrl, videoId);
  if (!parsed.transcript) {
    throw new Error("Bright Data record did not include transcript text");
  }

  return {
    text: parsed.transcript,
    source: "bright-data-youtube-scraper",
    metadata: parsed.metadata
  };
}

// ---- Wikipedia via Bright Data ----

function validateBrightDataWikiConfig(cfg) {
  const missing = [];
  if (!cfg.BRIGHT_DATA_API_TOKEN) missing.push("BRIGHT_DATA_API_TOKEN");
  if (!cfg.BRIGHT_DATA_WIKI_DATASET_ID) missing.push("BRIGHT_DATA_WIKI_DATASET_ID");
  if (missing.length) {
    throw new Error(`Missing Bright Data env vars: ${missing.join(", ")}`);
  }
}

function extractWikiCoordinates(item) {
  const candidates = [
    item?.coordinates,
    item?.location,
    item?.geo,
    item?.geo_coordinates,
    item?.coords
  ].filter(Boolean);

  for (const cand of candidates) {
    const lat = Number(cand?.lat ?? cand?.latitude ?? cand?.[0]);
    const lon = Number(cand?.lon ?? cand?.lng ?? cand?.longitude ?? cand?.[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon };
    }
  }

  const lat = Number(item?.latitude);
  const lon = Number(item?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat, lon };
  }
  return null;
}

function parseBrightDataWikiItem(item) {
  const title = pickFirstStringByKeys(item, ["title", "page_title", "name", "header_title", "article_title"]);
  const url = pickFirstStringByKeys(item, ["url", "page_url", "link", "input_url", "wiki_url"]);
  const description = pickFirstStringByKeys(item, ["description", "summary", "short_description", "subtitle", "snippet"]);
  let extract = pickFirstStringByKeys(item, [
    "raw_text", "text", "content", "extract", "body", "article_text", "overview", "main_text", "page_text", "plain_text"
  ]);
  if (!extract && Array.isArray(item?.cataloged_text)) {
    for (const entry of item.cataloged_text) {
      const candidate = pickFirstStringByKeys(entry, ["text", "content", "raw_text"]);
      if (candidate) {
        extract = candidate;
        break;
      }
    }
  }
  const location = extractWikiCoordinates(item);

  return { title, url, description, extract, location };
}

async function brightDataWikipediaScrape(articleUrl, signal) {
  const cfg = config.getConfig();
  validateBrightDataWikiConfig(cfg);

  const triggerUrl =
    `${cfg.BRIGHT_DATA_API_BASE}/datasets/v3/trigger` +
    `?dataset_id=${encodeURIComponent(cfg.BRIGHT_DATA_WIKI_DATASET_ID)}` +
    `&notify=false&include_errors=true`;

  const triggerResp = await fetchJson(triggerUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.BRIGHT_DATA_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ input: [{ url: articleUrl }] }),
    signal
  });

  const snapshotId = parseBrightDataTriggerResponse(triggerResp);
  if (!snapshotId) {
    throw new Error("Bright Data Wikipedia trigger did not return a snapshot id");
  }

  await pollBrightDataSnapshot(snapshotId, signal, cfg);

  const snapshotUrl = `${cfg.BRIGHT_DATA_API_BASE}/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`;
  const snapshotData = await fetchJson(snapshotUrl, {
    headers: { Authorization: `Bearer ${cfg.BRIGHT_DATA_API_TOKEN}` },
    signal
  });

  const items = Array.isArray(snapshotData)
    ? snapshotData
    : (Array.isArray(snapshotData?.data) ? snapshotData.data : (Array.isArray(snapshotData?.results) ? snapshotData.results : []));

  return items
    .map(parseBrightDataWikiItem)
    .filter((entry) => entry.title || entry.url || entry.extract);
}

module.exports = {
  fetchJson,
  fetchText,
  parseBrightDataTriggerResponse,
  waitForPollInterval,
  pollBrightDataSnapshot,
  validateBrightDataConfig,
  parseBrightDataItem,
  fetchTranscriptBundle,
  validateBrightDataWikiConfig,
  extractWikiCoordinates,
  parseBrightDataWikiItem,
  brightDataWikipediaScrape,
};
