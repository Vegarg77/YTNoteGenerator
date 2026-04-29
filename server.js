const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

function loadDotenv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const lineRaw of raw.replaceAll(String.fromCharCode(13), "").split("\n")) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotenv();

const PORT = Number(process.env.PORT) || 5173;
const WEBAPP_DIR = path.join(__dirname, "webapp");
const ENV_PATH = path.join(__dirname, ".env");

function getConfig() {
  return {
    OBSIDIAN_NOTE_DIR: (process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    OBSIDIAN_DICTIONARY_DIR: (process.env.OBSIDIAN_DICTIONARY_DIR || process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    OBSIDIAN_BUSINESS_DIR: (process.env.OBSIDIAN_BUSINESS_DIR || process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    OPENAI_API_KEY: (process.env.OPENAI_API_KEY || "").trim(),
    OPENAI_MODEL: (process.env.OPENAI_MODEL || "gpt-4o-mini").trim(),
    BRIGHT_DATA_API_TOKEN: (process.env.BRIGHT_DATA_API_TOKEN || "").trim(),
    BRIGHT_DATA_YT_DATASET_ID: (process.env.BRIGHT_DATA_YT_DATASET_ID || "").trim(),
    BRIGHT_DATA_WIKI_DATASET_ID: (process.env.BRIGHT_DATA_WIKI_DATASET_ID || "gd_lr9978962kkjr3nx49").trim(),
    BRIGHT_DATA_API_BASE: (process.env.BRIGHT_DATA_API_BASE || "https://api.brightdata.com").replace(/\/$/, ""),
    BRIGHT_DATA_TIMEOUT_MS: Number(process.env.BRIGHT_DATA_TIMEOUT_MS) || 120000,
    BRIGHT_DATA_POLL_INTERVAL_MS: Number(process.env.BRIGHT_DATA_POLL_INTERVAL_MS) || 2000,
  };
}

function writeEnvFile(settings) {
  const lines = [];
  if (fs.existsSync(ENV_PATH)) {
    const raw = fs.readFileSync(ENV_PATH, "utf8");
    for (const lineRaw of raw.replaceAll(String.fromCharCode(13), "").split("\n")) {
      const line = lineRaw.trim();
      if (!line || line.startsWith("#")) {
        lines.push(lineRaw);
        continue;
      }
      const idx = line.indexOf("=");
      if (idx < 0) { lines.push(lineRaw); continue; }
      const key = line.slice(0, idx).trim();
      if (key in settings) {
        lines.push(`${key}=${settings[key]}`);
        delete settings[key];
      } else {
        lines.push(lineRaw);
      }
    }
  }
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined && value !== "") {
      lines.push(`${key}=${value}`);
    }
  }
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf8");
}

function reloadEnv() {
  const settingsKeys = [
    "OBSIDIAN_NOTE_DIR", "OBSIDIAN_DICTIONARY_DIR", "OBSIDIAN_BUSINESS_DIR",
    "OPENAI_API_KEY", "OPENAI_MODEL",
    "BRIGHT_DATA_API_TOKEN", "BRIGHT_DATA_YT_DATASET_ID", "BRIGHT_DATA_WIKI_DATASET_ID",
    "BRIGHT_DATA_API_BASE", "BRIGHT_DATA_TIMEOUT_MS", "BRIGHT_DATA_POLL_INTERVAL_MS"
  ];
  for (const key of settingsKeys) {
    delete process.env[key];
  }
  loadDotenv();
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(text);
}

function sanitizeObsidianFileName(rawTitle) {
  const fallback = "Untitled Video Note";
  const title = (rawTitle || "").trim();
  const base = (title || fallback)
    .replace(/[\x00-\x1f\x80-\x9f]/g, "")
    .replace(/[\\/:*?"<>|#[\]^]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/g, "");

  return (base || fallback) + ".md";
}

async function resolveUniqueFilePath(directory, preferredFileName) {
  const parsed = path.parse(preferredFileName);
  const baseName = parsed.name || "Untitled Video Note";
  const extension = parsed.ext || ".md";

  let candidate = path.join(directory, `${baseName}${extension}`);
  let suffix = 2;

  while (true) {
    try {
      // "wx" opens exclusively — throws EEXIST if file already exists, atomically claiming the name
      const fh = await fs.promises.open(candidate, "wx");
      await fh.close();
      return candidate;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      candidate = path.join(directory, `${baseName} (${suffix})${extension}`);
      suffix += 1;
    }
  }
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function parseVideoId(inputUrl) {
  try {
    const u = new URL(inputUrl);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.split("/").filter(Boolean)[0] || null;
    }
    if (u.pathname.startsWith("/shorts/")) {
      return u.pathname.split("/")[2] || null;
    }
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

async function fetchJson(url, { method = "GET", headers = {}, body, signal } = {}) {
  const resp = await fetch(url, { method, headers, body, signal });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bright Data API ${method} ${url} failed (${resp.status}): ${text || resp.statusText}`);
  }

  const text = await resp.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Bright Data API ${method} ${url} returned non-JSON body`);
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

function parseBrightDataTriggerResponse(payload) {
  return payload?.snapshot_id || payload?.snapshotId || payload?.id || payload?.data?.snapshot_id || "";
}

function collectStringValues(value, results = []) {
  if (typeof value === "string" && value.trim()) {
    results.push(value.trim());
    return results;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, results);
    return results;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStringValues(entry, results);
  }
  return results;
}

function pickFirstByKeys(item, keys) {
  for (const key of keys) {
    if (item?.[key] !== undefined && item?.[key] !== null) return item[key];
  }
  return "";
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : `${value || ""}`.trim();
}

function extractNestedString(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const fromItem = extractNestedString(item);
      if (fromItem) return fromItem;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const fromValue = extractNestedString(item);
      if (fromValue) return fromValue;
    }
  }
  return "";
}

function extractChannelLabel(value) {
  if (!value) return "";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/^https?:\/\//i.test(trimmed)) return "";
    if (/^UC[\w-]{6,}$/i.test(trimmed)) return "";
    return trimmed;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const label = extractChannelLabel(item);
      if (label) return label;
    }
    return "";
  }

  if (typeof value === "object") {
    const preferredKeys = [
      "text",
      "label",
      "title",
      "display_text",
      "displayText",
      "display_name",
      "displayName",
      "name",
      "handle"
    ];

    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const label = extractChannelLabel(value[key]);
        if (label) return label;
      }
    }

    for (const [key, nested] of Object.entries(value)) {
      if (/url|link|href|id|identifier/i.test(key)) continue;
      const label = extractChannelLabel(nested);
      if (label) return label;
    }
  }

  return "";
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

// Retry constants for timed-out snapshots (shared with request deadline)
const SNAPSHOT_RETRY_INTERVAL_MS = 60000;
const SNAPSHOT_MAX_RETRIES = 3;
// Grace period per retry to cover the progress-API HTTP round-trip
const SNAPSHOT_RETRY_GRACE_MS = 15000;

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
  // in case the snapshot is still processing and becomes available shortly after
  const RETRY_INTERVAL_MS = SNAPSHOT_RETRY_INTERVAL_MS;
  const MAX_RETRIES = SNAPSHOT_MAX_RETRIES;

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

function validateBrightDataConfig(cfg) {
  const missing = [];
  if (!cfg.BRIGHT_DATA_API_TOKEN) missing.push("BRIGHT_DATA_API_TOKEN");
  if (!cfg.BRIGHT_DATA_YT_DATASET_ID) missing.push("BRIGHT_DATA_YT_DATASET_ID");
  if (missing.length) {
    throw new Error(`Missing Bright Data env vars: ${missing.join(", ")}`);
  }
}

async function fetchTranscriptBundle(videoId, rawUrl, signal) {
  const cfg = getConfig();
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

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let relativePath = url.pathname;
  if (relativePath === "/") relativePath = "/webapp/index.html";
  if (relativePath === "/webapp") relativePath = "/webapp/index.html";

  const filePath = path.join(__dirname, relativePath);
  const allowed = filePath.startsWith(WEBAPP_DIR) || filePath === path.join(__dirname, "webapp", "index.html");
  if (!allowed) {
    sendText(res, 404, "Not found");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function validateBrightDataWikiConfig(cfg) {
  const missing = [];
  if (!cfg.BRIGHT_DATA_API_TOKEN) missing.push("BRIGHT_DATA_API_TOKEN");
  if (!cfg.BRIGHT_DATA_WIKI_DATASET_ID) missing.push("BRIGHT_DATA_WIKI_DATASET_ID");
  if (missing.length) {
    throw new Error(`Missing Bright Data env vars: ${missing.join(", ")}`);
  }
}

function pickFirstStringByKeys(item, keys) {
  for (const key of keys) {
    const val = item?.[key];
    if (val == null) continue;
    const str = typeof val === "string" ? val.trim() : extractNestedString(val);
    if (str) return str;
  }
  return "";
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
  const extract = pickFirstStringByKeys(item, [
    "text", "content", "extract", "body", "article_text", "overview", "main_text", "page_text", "plain_text"
  ]);
  const location = extractWikiCoordinates(item);

  return { title, url, description, extract, location };
}

async function brightDataWikipediaScrape(keyword, pagesLoad, signal) {
  const cfg = getConfig();
  validateBrightDataWikiConfig(cfg);

  const triggerUrl =
    `${cfg.BRIGHT_DATA_API_BASE}/datasets/v3/trigger` +
    `?dataset_id=${encodeURIComponent(cfg.BRIGHT_DATA_WIKI_DATASET_ID)}` +
    `&notify=false&include_errors=true&type=discover_new&discover_by=keyword`;

  const triggerResp = await fetchJson(triggerUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.BRIGHT_DATA_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ input: [{ keyword, pages_load: pagesLoad }] }),
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

async function getWikipediaSuggestions(query, signal) {
  const items = await brightDataWikipediaScrape(query, 1, signal);

  return items.map((item) => {
    const title = item.title || query;
    const urlTitle = title.replace(/\s+/g, "_");
    return {
      title,
      description: item.description || "Wikipedia article",
      url: item.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(urlTitle)}`
    };
  }).filter((entry) => entry.title);
}

async function getWikipediaPage(title, signal) {
  const items = await brightDataWikipediaScrape(title, 1, signal);

  const normalized = title.trim().toLowerCase();
  const exact = items.find((item) => (item.title || "").trim().toLowerCase() === normalized);
  const match = exact || items[0];

  if (!match) {
    throw new Error(`Bright Data returned no Wikipedia results for "${title}"`);
  }

  const resolvedTitle = match.title || title;
  const urlTitle = resolvedTitle.replace(/\s+/g, "_");

  return {
    title: resolvedTitle,
    extract: match.extract || match.description || "",
    url: match.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(urlTitle)}`,
    location: match.location || null
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/transcript") {
    if (req.method !== "GET") {
      sendText(res, 405, "Method not allowed");
      return;
    }

    const rawUrl = url.searchParams.get("url");
    const videoId = url.searchParams.get("videoId") || (rawUrl ? parseVideoId(rawUrl) : null);
    if (!videoId) {
      sendText(res, 400, "Missing or invalid videoId/url");
      return;
    }

    const ctrl = new AbortController();
    // Normal timeout + retry pings (sleep + HTTP headroom each) + grace for the initial trigger & snapshot fetch
    const retryBudget = SNAPSHOT_MAX_RETRIES * (SNAPSHOT_RETRY_INTERVAL_MS + SNAPSHOT_RETRY_GRACE_MS);
    const timer = setTimeout(() => ctrl.abort(), getConfig().BRIGHT_DATA_TIMEOUT_MS + retryBudget + 5000);

    try {
      const { text, source, metadata } = await fetchTranscriptBundle(videoId, rawUrl, ctrl.signal);
      sendJson(res, 200, {
        videoId,
        source,
        transcript: text,
        metadata: {
          title: metadata?.title || "",
          channel: metadata?.channel || "",
          url: rawUrl || metadata?.url || `https://www.youtube.com/watch?v=${videoId}`
        }
      });
    } catch (err) {
      sendText(res, 502, `Transcript fetch failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (url.pathname === "/api/save-note") {
    if (req.method !== "POST") {
      sendText(res, 405, "Method not allowed");
      return;
    }

    try {
      const payload = await readJsonBody(req);
      const markdown = typeof payload?.markdown === "string" ? payload.markdown : "";
      const noteTitle = typeof payload?.noteTitle === "string" && payload.noteTitle.trim()
        ? payload.noteTitle
        : (typeof payload?.videoTitle === "string" ? payload.videoTitle : "");
      const noteType = typeof payload?.noteType === "string" ? payload.noteType : "video";

      if (!markdown.trim()) {
        sendText(res, 400, "Missing markdown content");
        return;
      }

      const cfg = getConfig();
      const destinationDir = noteType === "dictionary"
        ? cfg.OBSIDIAN_DICTIONARY_DIR
        : noteType === "business"
          ? cfg.OBSIDIAN_BUSINESS_DIR
          : cfg.OBSIDIAN_NOTE_DIR;
      const fileName = sanitizeObsidianFileName(noteTitle);

      await fs.promises.mkdir(destinationDir, { recursive: true });
      const filePath = await resolveUniqueFilePath(destinationDir, fileName);
      await fs.promises.writeFile(filePath, markdown, "utf8");

      sendJson(res, 200, {
        saved: true,
        fileName: path.basename(filePath)
      });
    } catch (err) {
      sendText(res, 500, `Failed to save note: ${err.message}`);
    }
    return;
  }

  if (url.pathname === "/api/wikipedia-suggest") {
    if (req.method !== "GET") {
      sendText(res, 405, "Method not allowed");
      return;
    }

    const query = asTrimmedString(url.searchParams.get("q"));
    if (query.length < 2) {
      sendJson(res, 200, { suggestions: [] });
      return;
    }

    const ctrl = new AbortController();
    const retryBudget = SNAPSHOT_MAX_RETRIES * (SNAPSHOT_RETRY_INTERVAL_MS + SNAPSHOT_RETRY_GRACE_MS);
    const timer = setTimeout(() => ctrl.abort(), getConfig().BRIGHT_DATA_TIMEOUT_MS + retryBudget + 5000);
    try {
      const suggestions = await getWikipediaSuggestions(query, ctrl.signal);
      sendJson(res, 200, { suggestions });
    } catch (err) {
      sendText(res, 502, `Wikipedia suggestions failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (url.pathname === "/api/wikipedia-page") {
    if (req.method !== "GET") {
      sendText(res, 405, "Method not allowed");
      return;
    }

    const title = asTrimmedString(url.searchParams.get("title"));
    if (!title) {
      sendText(res, 400, "Missing title query param");
      return;
    }

    const ctrl = new AbortController();
    const retryBudget = SNAPSHOT_MAX_RETRIES * (SNAPSHOT_RETRY_INTERVAL_MS + SNAPSHOT_RETRY_GRACE_MS);
    const timer = setTimeout(() => ctrl.abort(), getConfig().BRIGHT_DATA_TIMEOUT_MS + retryBudget + 5000);
    try {
      const page = await getWikipediaPage(title, ctrl.signal);
      sendJson(res, 200, page);
    } catch (err) {
      sendText(res, 502, `Wikipedia page lookup failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (url.pathname === "/api/settings") {
    if (req.method === "GET") {
      reloadEnv();
      const cfg = getConfig();
      sendJson(res, 200, {
        OBSIDIAN_NOTE_DIR: cfg.OBSIDIAN_NOTE_DIR,
        OBSIDIAN_DICTIONARY_DIR: cfg.OBSIDIAN_DICTIONARY_DIR,
        OBSIDIAN_BUSINESS_DIR: cfg.OBSIDIAN_BUSINESS_DIR,
        OPENAI_API_KEY: cfg.OPENAI_API_KEY,
        OPENAI_MODEL: cfg.OPENAI_MODEL,
        BRIGHT_DATA_API_TOKEN: cfg.BRIGHT_DATA_API_TOKEN,
        BRIGHT_DATA_TIMEOUT_MS: cfg.BRIGHT_DATA_TIMEOUT_MS,
      });
      return;
    }

    if (req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        const allowedKeys = [
          "OBSIDIAN_NOTE_DIR", "OBSIDIAN_DICTIONARY_DIR", "OBSIDIAN_BUSINESS_DIR",
          "OPENAI_API_KEY", "OPENAI_MODEL",
          "BRIGHT_DATA_API_TOKEN", "BRIGHT_DATA_TIMEOUT_MS"
        ];
        const updates = {};
        for (const key of allowedKeys) {
          if (!(key in payload)) continue;
          const val = String(payload[key]).trim();
          if (key === "BRIGHT_DATA_TIMEOUT_MS") {
            const ms = Number(val);
            if (!Number.isFinite(ms) || ms < 5000 || ms > 600000) {
              sendText(res, 400, "BRIGHT_DATA_TIMEOUT_MS must be between 5000 and 600000");
              return;
            }
            updates[key] = String(ms);
          } else {
            updates[key] = val;
          }
        }
        writeEnvFile(updates);
        reloadEnv();
        const cfg = getConfig();
        sendJson(res, 200, {
          saved: true,
          OBSIDIAN_NOTE_DIR: cfg.OBSIDIAN_NOTE_DIR,
          OBSIDIAN_DICTIONARY_DIR: cfg.OBSIDIAN_DICTIONARY_DIR,
          OBSIDIAN_BUSINESS_DIR: cfg.OBSIDIAN_BUSINESS_DIR,
          OPENAI_API_KEY: cfg.OPENAI_API_KEY,
          OPENAI_MODEL: cfg.OPENAI_MODEL,
          BRIGHT_DATA_API_TOKEN: cfg.BRIGHT_DATA_API_TOKEN,
          BRIGHT_DATA_TIMEOUT_MS: cfg.BRIGHT_DATA_TIMEOUT_MS,
        });
      } catch (err) {
        sendText(res, 500, `Failed to save settings: ${err.message}`);
      }
      return;
    }

    sendText(res, 405, "Method not allowed");
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`YTNoteGenerator server running on http://localhost:${PORT}`);
});
