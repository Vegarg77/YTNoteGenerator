const fs = require("fs");
const path = require("path");

// Settings file location. Defaults to the repo-root .env — gitignored, so it survives
// `git pull` on plain-node installs. YTNG_ENV_FILE (launch environment only) redirects
// it, e.g. to a file inside a host directory bind-mounted into a container or kept
// outside the repo so it also survives fresh clones. Read lazily so tests and
// launch-time env can set it. NOTE: in containers mount the parent DIRECTORY, not the
// file itself — writeEnvFile saves atomically via tmp+rename, and rename over a
// single-file bind mount fails (EBUSY).
function getEnvPath() {
  return (process.env.YTNG_ENV_FILE || "").trim() || path.join(__dirname, "..", ".env");
}

// Back-compat export: default location. Prefer getEnvPath() inside this module.
const ENV_PATH = path.join(__dirname, "..", ".env");

// Keys loadDotenv actually injected from the settings file. reloadEnv clears ONLY these,
// never real launch-environment variables (shell export / docker -e / systemd env), so
// launch env keeps its documented precedence over the file across /api/settings reloads.
const envInjectedKeys = new Set();

function getPort() {
  return Number(process.env.PORT) || 5173;
}

// Retry constants shared with route handlers for AbortController deadline calculation
const SNAPSHOT_RETRY_INTERVAL_MS = 60000;
const SNAPSHOT_MAX_RETRIES = 3;
const SNAPSHOT_RETRY_GRACE_MS = 15000;

function loadDotenv() {
  const envFile = getEnvPath();
  if (!fs.existsSync(envFile)) return;

  const raw = fs.readFileSync(envFile, "utf8");
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
      envInjectedKeys.add(key);
    }
  }
}

function getConfig() {
  return {
    OBSIDIAN_NOTE_DIR: (process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    OBSIDIAN_DICTIONARY_DIR: (process.env.OBSIDIAN_DICTIONARY_DIR || process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    OBSIDIAN_BUSINESS_DIR: (process.env.OBSIDIAN_BUSINESS_DIR || process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    // vault ROOT for the tag-pool scan (falls back to the video-notes dir — set the real
    // root in settings so the whole vault's tags form the pool, not just generated notes)
    OBSIDIAN_VAULT_DIR: (process.env.OBSIDIAN_VAULT_DIR || process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    // tags never offered to the tagger (comma/space separated, with or without '#')
    TAG_EXCLUDE: (process.env.TAG_EXCLUDE || "VN").trim(),
    OPENAI_API_KEY: (process.env.OPENAI_API_KEY || "").trim(),
    OPENAI_MODEL: (process.env.OPENAI_MODEL || "deepseek/deepseek-v4-flash-0731").trim(),
    // Base URL of the LLM API (any OpenAI-compatible endpoint). Default = OpenRouter,
    // routed to the cheapest-under-a-ceiling provider (see openaiText's provider-routing
    // injection in webapp/app.js — same policy as this project's Hermes agent + CI review).
    // For DeepSeek direct set: https://api.deepseek.com (model e.g. deepseek-v4-flash).
    // For OpenAI set: https://api.openai.com (model e.g. gpt-4o-mini).
    OPENAI_BASE_URL: (process.env.OPENAI_BASE_URL || "https://openrouter.ai/api").replace(/\/+$/, "").trim(),
    BRIGHT_DATA_API_TOKEN: (process.env.BRIGHT_DATA_API_TOKEN || "").trim(),
    BRIGHT_DATA_YT_DATASET_ID: (process.env.BRIGHT_DATA_YT_DATASET_ID || "").trim(),
    BRIGHT_DATA_WIKI_DATASET_ID: (process.env.BRIGHT_DATA_WIKI_DATASET_ID || "gd_lr9978962kkjr3nx49").trim(),
    BRIGHT_DATA_API_BASE: (process.env.BRIGHT_DATA_API_BASE || "https://api.brightdata.com").replace(/\/$/, ""),
    BRIGHT_DATA_TIMEOUT_MS: Number(process.env.BRIGHT_DATA_TIMEOUT_MS) || 120000,
    BRIGHT_DATA_POLL_INTERVAL_MS: Number(process.env.BRIGHT_DATA_POLL_INTERVAL_MS) || 2000,
  };
}

function writeEnvFile(settings) {
  const envFile = getEnvPath();
  const lines = [];
  if (fs.existsSync(envFile)) {
    const raw = fs.readFileSync(envFile, "utf8");
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
  const tmpPath = envFile + ".tmp";
  fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf8");
  fs.renameSync(tmpPath, envFile);
}

function reloadEnv() {
  // Remove only what loadDotenv injected from the settings file; launch-environment
  // values (docker -e, exported vars) keep their precedence over the file.
  for (const key of envInjectedKeys) {
    delete process.env[key];
  }
  envInjectedKeys.clear();
  loadDotenv();
}

module.exports = {
  ENV_PATH,
  getEnvPath,
  getPort,
  SNAPSHOT_RETRY_INTERVAL_MS,
  SNAPSHOT_MAX_RETRIES,
  SNAPSHOT_RETRY_GRACE_MS,
  loadDotenv,
  getConfig,
  writeEnvFile,
  reloadEnv,
};
