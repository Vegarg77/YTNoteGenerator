const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT) || 5173;
const WEBAPP_DIR = path.join(__dirname, "webapp");
const TRANSCRIPT_SCRIPT = path.join(__dirname, "scripts", "fetch_transcript.py");

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

function runTranscriptScript(videoId, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [TRANSCRIPT_SCRIPT, videoId], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error("Transcript fetch aborted"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Failed to execute transcript script: ${err.message}`));
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(new Error((stderr || stdout || "Unknown transcript script failure").trim()));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        if (!parsed?.transcript || typeof parsed.transcript !== "string") {
          throw new Error("Transcript script returned empty transcript");
        }

        resolve({
          text: parsed.transcript,
          source: parsed.source || "yt-transcript-api"
        });
      } catch (err) {
        reject(new Error(`Invalid transcript script output: ${err.message}`));
      }
    });
  });
}

async function fetchVideoMetadata(rawUrl, videoId, signal) {
  const targetUrl = rawUrl || `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", targetUrl);
    endpoint.searchParams.set("format", "json");

    const resp = await fetch(endpoint, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const payload = await resp.json();
    return {
      title: payload?.title || "",
      channel: payload?.author_name || "",
      url: targetUrl
    };
  } catch {
    return {
      title: "",
      channel: "",
      url: targetUrl
    };
  }
}

async function fetchTranscriptBundle(videoId, rawUrl, signal) {
  const transcript = await runTranscriptScript(videoId, signal);
  const metadata = await fetchVideoMetadata(rawUrl, videoId, signal);
  return {
    ...transcript,
    metadata
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

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`YTNoteGenerator server running on http://localhost:${PORT}`);
});
