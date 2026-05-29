const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const cfg = require("./lib/config");
const utils = require("./lib/utils");
const brightdata = require("./lib/brightdata");
const wiki = require("./lib/wiki");

cfg.loadDotenv();

const PORT = cfg.getPort();
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

const { SNAPSHOT_MAX_RETRIES, SNAPSHOT_RETRY_INTERVAL_MS, SNAPSHOT_RETRY_GRACE_MS } = cfg;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/transcript") {
    if (req.method !== "GET") {
      sendText(res, 405, "Method not allowed");
      return;
    }

    const rawUrl = url.searchParams.get("url");
    const videoId = url.searchParams.get("videoId") || (rawUrl ? utils.parseVideoId(rawUrl) : null);
    if (!videoId) {
      sendText(res, 400, "Missing or invalid videoId/url");
      return;
    }

    const ctrl = new AbortController();
    const retryBudget = SNAPSHOT_MAX_RETRIES * (SNAPSHOT_RETRY_INTERVAL_MS + SNAPSHOT_RETRY_GRACE_MS);
    const timer = setTimeout(() => ctrl.abort(), cfg.getConfig().BRIGHT_DATA_TIMEOUT_MS + retryBudget + 5000);

    try {
      const { text, source, metadata } = await brightdata.fetchTranscriptBundle(videoId, rawUrl, ctrl.signal);
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

      const appCfg = cfg.getConfig();
      const destinationDir = noteType === "dictionary"
        ? appCfg.OBSIDIAN_DICTIONARY_DIR
        : noteType === "business"
          ? appCfg.OBSIDIAN_BUSINESS_DIR
          : appCfg.OBSIDIAN_NOTE_DIR;
      const fileName = utils.sanitizeObsidianFileName(noteTitle);

      await fs.promises.mkdir(destinationDir, { recursive: true });
      const filePath = await utils.resolveUniqueFilePath(destinationDir, fileName);
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

    const query = utils.asTrimmedString(url.searchParams.get("q"));
    if (query.length < 2) {
      sendJson(res, 200, { suggestions: [] });
      return;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const suggestions = await wiki.getWikipediaSuggestions(query, ctrl.signal);
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

    const title = utils.asTrimmedString(url.searchParams.get("title"));
    const articleUrlParam = utils.asTrimmedString(url.searchParams.get("url"));
    if (!title && !articleUrlParam) {
      sendText(res, 400, "Missing title or url query param");
      return;
    }
    if (articleUrlParam) {
      try {
        utils.validateWikipediaArticleUrl(articleUrlParam);
      } catch (err) {
        sendText(res, 400, err.message);
        return;
      }
    }

    const ctrl = new AbortController();
    const retryBudget = SNAPSHOT_MAX_RETRIES * (SNAPSHOT_RETRY_INTERVAL_MS + SNAPSHOT_RETRY_GRACE_MS);
    const timer = setTimeout(() => ctrl.abort(), cfg.getConfig().BRIGHT_DATA_TIMEOUT_MS + retryBudget + 5000);
    try {
      const page = await wiki.getWikipediaPage(title, ctrl.signal, articleUrlParam);
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
      cfg.reloadEnv();
      const appCfg = cfg.getConfig();
      sendJson(res, 200, {
        OBSIDIAN_NOTE_DIR: appCfg.OBSIDIAN_NOTE_DIR,
        OBSIDIAN_DICTIONARY_DIR: appCfg.OBSIDIAN_DICTIONARY_DIR,
        OBSIDIAN_BUSINESS_DIR: appCfg.OBSIDIAN_BUSINESS_DIR,
        OPENAI_API_KEY: appCfg.OPENAI_API_KEY,
        OPENAI_MODEL: appCfg.OPENAI_MODEL,
        BRIGHT_DATA_API_TOKEN: appCfg.BRIGHT_DATA_API_TOKEN,
        BRIGHT_DATA_TIMEOUT_MS: appCfg.BRIGHT_DATA_TIMEOUT_MS,
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
        cfg.writeEnvFile(updates);
        cfg.reloadEnv();
        const appCfg = cfg.getConfig();
        sendJson(res, 200, {
          saved: true,
          OBSIDIAN_NOTE_DIR: appCfg.OBSIDIAN_NOTE_DIR,
          OBSIDIAN_DICTIONARY_DIR: appCfg.OBSIDIAN_DICTIONARY_DIR,
          OBSIDIAN_BUSINESS_DIR: appCfg.OBSIDIAN_BUSINESS_DIR,
          OPENAI_API_KEY: appCfg.OPENAI_API_KEY,
          OPENAI_MODEL: appCfg.OPENAI_MODEL,
          BRIGHT_DATA_API_TOKEN: appCfg.BRIGHT_DATA_API_TOKEN,
          BRIGHT_DATA_TIMEOUT_MS: appCfg.BRIGHT_DATA_TIMEOUT_MS,
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
