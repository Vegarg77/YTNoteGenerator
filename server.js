const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { spawn } = require("child_process");

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
const TRANSCRIPT_SCRIPT = path.join(__dirname, "scripts", "fetch_transcript.py");
const PYTHON_CMD = process.env.PYTHON_CMD || "python";
const OBSIDIAN_NOTE_DIR = "G:\\My Drive\\GigaVault\\Video Notes (unsorted)";

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

function runTranscriptScript(videoId, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_CMD, [TRANSCRIPT_SCRIPT, videoId], {
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

async function fetchVideoMetadata(rawUrl, videoId) {
  const resolvedVideoId = (videoId || parseVideoId(rawUrl || "") || "").trim();
  const targetUrl = rawUrl || (resolvedVideoId ? `https://www.youtube.com/watch?v=${resolvedVideoId}` : "");

  // Keep metadata local to avoid non-proxied outbound requests.
  // Preserve a deterministic, non-empty title so note filenames remain stable per video.
  const fallbackTitle = resolvedVideoId ? `YouTube Video ${resolvedVideoId}` : "YouTube Video";

  return {
    title: fallbackTitle,
    channel: "",
    url: targetUrl || "https://www.youtube.com"
  };
}

async function fetchTranscriptBundle(videoId, rawUrl, signal) {
  const transcript = await runTranscriptScript(videoId, signal);
  const metadata = await fetchVideoMetadata(rawUrl, videoId);
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
