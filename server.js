const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 5173;
const WEBAPP_DIR = path.join(__dirname, "webapp");

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

function extractJsonBlock(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;
  const braceStart = text.indexOf("{", markerIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") depth -= 1;
    if (depth === 0) return text.slice(braceStart, i + 1);
  }
  return null;
}

function extractPlayerResponse(html) {
  const jsonText = extractJsonBlock(html, "ytInitialPlayerResponse");
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function pickCaptionTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return (
    tracks.find((track) => track.languageCode?.startsWith("en")) ||
    tracks.find((track) => track.languageCode) ||
    tracks[0]
  );
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function parseTranscriptXml(xmlText) {
  const matches = [...xmlText.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  return matches
    .map((match) => decodeHtmlEntities(match[1] || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function extractTranscriptFromJson3(data) {
  if (!data?.events) return "";
  return data.events
    .map((event) => (event.segs ? event.segs.map((seg) => seg.utf8 || "").join("") : ""))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

async function fetchText(url, signal) {
  const resp = await fetch(url, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (TranscriptFetcher)",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function fetchJson(url, signal) {
  const text = await fetchText(url, signal);
  return JSON.parse(text);
}

async function fetchTranscriptFromTrack(track, signal) {
  const baseUrl = track?.baseUrl;
  if (!baseUrl) throw new Error("Caption track missing baseUrl");
  const jsonUrl = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
  const data = await fetchJson(jsonUrl, signal);
  let text = extractTranscriptFromJson3(data).trim();
  if (text) return { text, source: "captionTracks:json3" };
  const xmlText = await fetchText(baseUrl, signal);
  text = parseTranscriptXml(xmlText).trim();
  if (!text) throw new Error("Caption track empty");
  return { text, source: "captionTracks:xml" };
}

async function fetchTranscript(videoId, signal) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl, signal);
  const playerResponse = extractPlayerResponse(html);
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (tracks.length) {
    const track = pickCaptionTrack(tracks);
    return fetchTranscriptFromTrack(track, signal);
  }
  const timedTextUrl = `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}`;
  const xml = await fetchText(timedTextUrl, signal);
  const timedText = parseTranscriptXml(xml).trim();
  if (!timedText) throw new Error("Timedtext transcript empty");
  return { text: timedText, source: "timedtext" };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let relativePath = url.pathname;
  if (relativePath === "/") relativePath = "/webapp/index.html";
  if (relativePath === "/webapp") relativePath = "/webapp/index.html";
  const filePath = path.join(__dirname, relativePath);
  if (!filePath.startsWith(WEBAPP_DIR) && !filePath.endsWith("index.html")) {
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
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const { text, source } = await fetchTranscript(videoId, ctrl.signal);
      sendJson(res, 200, {
        videoId,
        source,
        transcript: text
      });
    } catch (err) {
      sendText(res, 502, `Transcript fetch failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`YTNoteGenerator server running on http://localhost:${PORT}`);
});
