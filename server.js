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

function findJsonAfterMarker(text, marker, openingChar) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = text.indexOf(openingChar, markerIndex + marker.length);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === openingChar) depth += 1;
    if ((openingChar === "{" && ch === "}") || (openingChar === "[" && ch === "]")) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonBlock(text, marker, openingChar = "{") {
  const jsonText = findJsonAfterMarker(text, marker, openingChar);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function extractYtCfg(html) {
  const candidates = [
    parseJsonBlock(html, "ytcfg.set(", "{"),
    parseJsonBlock(html, "ytcfg = ", "{"),
    parseJsonBlock(html, "ytcfg.data_ = ", "{")
  ].filter(Boolean);

  if (candidates.length > 0) return candidates[0];

  const innertubeKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const clientNameMatch = html.match(/"INNERTUBE_CLIENT_NAME":"([^"]+)"/);
  const clientVersionMatch = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  return {
    INNERTUBE_API_KEY: innertubeKeyMatch?.[1],
    INNERTUBE_CLIENT_NAME: clientNameMatch?.[1] || "WEB",
    INNERTUBE_CLIENT_VERSION: clientVersionMatch?.[1] || "2.20240222.01.00"
  };
}

function extractPlayerResponse(html) {
  return parseJsonBlock(html, "ytInitialPlayerResponse = ", "{");
}

function rankCaptionTracks(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return [];

  const rankTrack = (track) => {
    let score = 0;
    if (track?.vssId?.startsWith(".")) score += 20;
    if (track?.languageCode?.startsWith("en")) score += 50;
    if (!track?.kind || track.kind !== "asr") score += 30;
    return score;
  };

  return [...tracks].sort((a, b) => rankTrack(b) - rankTrack(a));
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

function parseXmlAttributes(rawAttrs = "") {
  const attrs = {};
  for (const match of rawAttrs.matchAll(/(\w+)="([^"]*)"/g)) {
    attrs[match[1]] = decodeHtmlEntities(match[2]);
  }
  return attrs;
}

function parseTimedTextTrackList(listXml) {
  if (!listXml || !listXml.includes("<track")) return [];
  const tracks = [];
  for (const match of listXml.matchAll(/<track\s+([^>]*?)\/?>(?:<\/track>)?/g)) {
    const attrs = parseXmlAttributes(match[1] || "");
    tracks.push({
      langCode: attrs.lang_code || "",
      name: attrs.name || "",
      kind: attrs.kind || "",
      vssId: attrs.vss_id || ""
    });
  }
  return tracks;
}

function rankTimedTextTracks(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return [];

  const rankTrack = (track) => {
    let score = 0;
    if (track?.langCode?.startsWith("en")) score += 60;
    if (!track?.kind || track.kind !== "asr") score += 30;
    if (track?.vssId?.startsWith(".")) score += 20;
    return score;
  };

  return [...tracks].sort((a, b) => rankTrack(b) - rankTrack(a));
}

function buildTimedTextUrl(videoId, track) {
  const endpoint = new URL("https://www.youtube.com/api/timedtext");
  endpoint.searchParams.set("v", videoId);

  if (track?.langCode) endpoint.searchParams.set("lang", track.langCode);
  if (track?.name) endpoint.searchParams.set("name", track.name);
  if (track?.kind) endpoint.searchParams.set("kind", track.kind);

  return endpoint.toString();
}

async function fetchTranscriptFromTimedTextTrack(videoId, track, signal) {
  const endpoint = buildTimedTextUrl(videoId, track);
  const xml = await fetchText(endpoint, signal);
  const timedText = parseTranscriptXml(xml).trim();
  if (!timedText) throw new Error("Timedtext track empty");

  return {
    text: timedText,
    source: `timedtext:${track?.langCode || "unknown"}${track?.kind ? `:${track.kind}` : ""}`
  };
}

function extractTranscriptFromJson3(data) {
  if (!data?.events) return "";
  return data.events
    .map((event) => (event.segs ? event.segs.map((seg) => seg.utf8 || "").join("") : ""))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

async function fetchText(url, signal, method = "GET", body = null) {
  const resp = await fetch(url, {
    method,
    body,
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (TranscriptFetcher)",
      "Accept-Language": "en-US,en;q=0.9",
      ...(body ? { "Content-Type": "application/json" } : {})
    }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function fetchJson(url, signal, method = "GET", body = null) {
  const text = await fetchText(url, signal, method, body);
  return JSON.parse(text);
}

function extractMetaFromPlayerResponse(playerResponse, fallbackUrl) {
  return {
    title: playerResponse?.videoDetails?.title || "",
    channel: playerResponse?.videoDetails?.author || "",
    url: fallbackUrl
  };
}

async function fetchTranscriptFromTrack(track, signal) {
  const baseUrl = track?.baseUrl;
  if (!baseUrl) throw new Error("Caption track missing baseUrl");

  const tryUrls = [];
  const asJson3 = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
  tryUrls.push({ url: asJson3, type: "json3" });
  tryUrls.push({ url: baseUrl, type: "xml" });

  for (const candidate of tryUrls) {
    try {
      if (candidate.type === "json3") {
        const data = await fetchJson(candidate.url, signal);
        const text = extractTranscriptFromJson3(data).trim();
        if (text) return { text, source: "captionTracks:json3" };
        continue;
      }
      const xmlText = await fetchText(candidate.url, signal);
      const text = parseTranscriptXml(xmlText).trim();
      if (text) return { text, source: "captionTracks:xml" };
    } catch {
      // Continue trying fallback URLs.
    }
  }
  throw new Error("Caption track empty");
}

async function fetchTranscriptFromTracks(tracks, signal) {
  const rankedTracks = rankCaptionTracks(tracks);
  if (!rankedTracks.length) throw new Error("Caption tracks missing");

  let lastError = null;
  for (const track of rankedTracks) {
    try {
      return await fetchTranscriptFromTrack(track, signal);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Caption track empty");
}

async function fetchViaTimedText(videoId, signal) {
  try {
    const listEndpoint = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
    const listXml = await fetchText(listEndpoint, signal);
    const tracks = rankTimedTextTracks(parseTimedTextTrackList(listXml));

    if (tracks.length) {
      let lastError = null;
      for (const track of tracks) {
        try {
          return await fetchTranscriptFromTimedTextTrack(videoId, track, signal);
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError) throw lastError;
    }
  } catch {
    // Fall through to legacy timedtext fallback URLs.
  }

  const candidates = [
    `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}`,
    `https://www.youtube.com/api/timedtext?lang=en&kind=asr&v=${encodeURIComponent(videoId)}`,
    `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}`
  ];

  for (const endpoint of candidates) {
    try {
      const xml = await fetchText(endpoint, signal);
      const timedText = parseTranscriptXml(xml).trim();
      if (timedText) return { text: timedText, source: "timedtext" };
    } catch {
      // keep trying
    }
  }
  throw new Error("Timedtext transcript empty");
}


async function fetchViaInnertube(videoId, html, signal) {
  const cfg = extractYtCfg(html);
  const key = cfg?.INNERTUBE_API_KEY;
  if (!key) return null;

  const clientName = cfg?.INNERTUBE_CLIENT_NAME || "WEB";
  const clientVersion = cfg?.INNERTUBE_CLIENT_VERSION || "2.20240222.01.00";

  const playerEndpoint = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(key)}`;
  const payload = {
    context: {
      client: {
        clientName,
        clientVersion,
        hl: "en",
        gl: "US"
      }
    },
    videoId
  };

  const playerResponse = await fetchJson(playerEndpoint, signal, "POST", JSON.stringify(payload));
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return null;

  const transcript = await fetchTranscriptFromTracks(tracks, signal);
  return {
    ...transcript,
    metadata: extractMetaFromPlayerResponse(playerResponse, `https://www.youtube.com/watch?v=${videoId}`)
  };
}

async function fetchTranscriptBundle(videoId, signal) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl, signal);

  const playerResponse = extractPlayerResponse(html);
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  if (tracks.length) {
    try {
      const transcript = await fetchTranscriptFromTracks(tracks, signal);
      return {
        ...transcript,
        metadata: extractMetaFromPlayerResponse(playerResponse, watchUrl)
      };
    } catch {
      // Fall through to alternative transcript sources.
    }
  }

  try {
    const innertubeResult = await fetchViaInnertube(videoId, html, signal);
    if (innertubeResult?.text) return innertubeResult;
  } catch {
    // Fall through to timedtext fallback.
  }

  const timed = await fetchViaTimedText(videoId, signal);
  return {
    ...timed,
    metadata: extractMetaFromPlayerResponse(playerResponse, watchUrl)
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
    const timer = setTimeout(() => ctrl.abort(), 25000);

    try {
      const { text, source, metadata } = await fetchTranscriptBundle(videoId, ctrl.signal);
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

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`YTNoteGenerator server running on http://localhost:${PORT}`);
});
