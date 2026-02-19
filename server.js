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
const OBSIDIAN_NOTE_DIR = "G:\\My Drive\\GigaVault\\Video Notes (unsorted)";

const BRIGHT_DATA_API_TOKEN = (process.env.BRIGHT_DATA_API_TOKEN || "").trim();
const BRIGHT_DATA_YT_DATASET_ID = (process.env.BRIGHT_DATA_YT_DATASET_ID || "").trim();
const BRIGHT_DATA_API_BASE = (process.env.BRIGHT_DATA_API_BASE || "https://api.brightdata.com").replace(/\/$/, "");
const BRIGHT_DATA_TIMEOUT_MS = Number(process.env.BRIGHT_DATA_TIMEOUT_MS) || 60000;
const BRIGHT_DATA_POLL_INTERVAL_MS = Number(process.env.BRIGHT_DATA_POLL_INTERVAL_MS) || 2000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
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

function parseBrightDataItem(item, fallbackUrl, fallbackVideoId) {
  const transcriptRaw = pickFirstByKeys(item, ["transcript", "captions", "subtitle", "subtitles"]);
  const transcriptCandidates = collectStringValues(transcriptRaw);
  const transcript = transcriptCandidates.join("\n").trim();

  const title = asTrimmedString(pickFirstByKeys(item, ["title", "video_title", "name"]));
  const channel = asTrimmedString(pickFirstByKeys(item, ["channel", "channel_name", "author", "uploader"]));
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

async function waitForPollInterval(signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, BRIGHT_DATA_POLL_INTERVAL_MS);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Bright Data polling aborted"));
    }, { once: true });
  });
}

async function pollBrightDataSnapshot(snapshotId, signal) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < BRIGHT_DATA_TIMEOUT_MS) {
    const progressUrl = `${BRIGHT_DATA_API_BASE}/datasets/v3/progress/${encodeURIComponent(snapshotId)}`;
    const progress = await fetchJson(progressUrl, {
      headers: { Authorization: `Bearer ${BRIGHT_DATA_API_TOKEN}` },
      signal
    });

    const status = String(progress?.status || "").toLowerCase();
    if (status === "ready" || status === "completed" || status === "success") return;

    if (status === "failed" || status === "error" || status === "cancelled") {
      throw new Error(`Bright Data snapshot ${snapshotId} failed with status: ${progress?.status || "unknown"}`);
    }

    await waitForPollInterval(signal);
  }

  throw new Error(`Timed out waiting for Bright Data snapshot ${snapshotId}`);
}

function validateBrightDataConfig() {
  const missing = [];
  if (!BRIGHT_DATA_API_TOKEN) missing.push("BRIGHT_DATA_API_TOKEN");
  if (!BRIGHT_DATA_YT_DATASET_ID) missing.push("BRIGHT_DATA_YT_DATASET_ID");
  if (missing.length) {
    throw new Error(`Missing Bright Data env vars: ${missing.join(", ")}`);
  }
}

async function fetchTranscriptBundle(videoId, rawUrl, signal) {
  validateBrightDataConfig();

  const resolvedUrl = rawUrl || `https://www.youtube.com/watch?v=${videoId}`;
  const triggerUrl = `${BRIGHT_DATA_API_BASE}/datasets/v3/trigger?dataset_id=${encodeURIComponent(BRIGHT_DATA_YT_DATASET_ID)}&notify=false&include_errors=true`;

  const triggerResp = await fetchJson(triggerUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BRIGHT_DATA_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ input: [{ url: resolvedUrl, video_id: videoId }] }),
    signal
  });

  const snapshotId = parseBrightDataTriggerResponse(triggerResp);
  if (!snapshotId) {
    throw new Error("Bright Data trigger did not return a snapshot id");
  }

  await pollBrightDataSnapshot(snapshotId, signal);

  const snapshotUrl = `${BRIGHT_DATA_API_BASE}/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`;
  const snapshotData = await fetchJson(snapshotUrl, {
    headers: { Authorization: `Bearer ${BRIGHT_DATA_API_TOKEN}` },
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
    const timer = setTimeout(() => ctrl.abort(), BRIGHT_DATA_TIMEOUT_MS + 5000);

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
      const videoTitle = typeof payload?.videoTitle === "string" ? payload.videoTitle : "";

      if (!markdown.trim()) {
        sendText(res, 400, "Missing markdown content");
        return;
      }

      const fileName = sanitizeObsidianFileName(videoTitle);
      const filePath = path.join(OBSIDIAN_NOTE_DIR, fileName);

      await fs.promises.mkdir(OBSIDIAN_NOTE_DIR, { recursive: true });
      await fs.promises.writeFile(filePath, markdown, "utf8");

      sendJson(res, 200, {
        saved: true,
        fileName,
        filePath
      });
    } catch (err) {
      sendText(res, 500, `Failed to save note: ${err.message}`);
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`YTNoteGenerator server running on http://localhost:${PORT}`);
});
