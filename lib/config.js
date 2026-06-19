const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");

function getPort() {
  return Number(process.env.PORT) || 5173;
}

// Retry constants shared with route handlers for AbortController deadline calculation
const SNAPSHOT_RETRY_INTERVAL_MS = 60000;
const SNAPSHOT_MAX_RETRIES = 3;
const SNAPSHOT_RETRY_GRACE_MS = 15000;

function loadDotenv() {
  if (!fs.existsSync(ENV_PATH)) return;

  const raw = fs.readFileSync(ENV_PATH, "utf8");
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

function getConfig() {
  return {
    OBSIDIAN_NOTE_DIR: (process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    OBSIDIAN_DICTIONARY_DIR: (process.env.OBSIDIAN_DICTIONARY_DIR || process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    OBSIDIAN_BUSINESS_DIR: (process.env.OBSIDIAN_BUSINESS_DIR || process.env.OBSIDIAN_NOTE_DIR || "").trim(),
    OPENAI_API_KEY: (process.env.OPENAI_API_KEY || "").trim(),
    OPENAI_MODEL: (process.env.OPENAI_MODEL || "gpt-4o-mini").trim(),
    // Base URL of the LLM API (any OpenAI-compatible endpoint). Default = OpenAI.
    // For DeepSeek set: https://api.deepseek.com (model e.g. deepseek-v4-flash).
    OPENAI_BASE_URL: (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "").trim(),
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
  const tmpPath = ENV_PATH + ".tmp";
  fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf8");
  fs.renameSync(tmpPath, ENV_PATH);
}

function reloadEnv() {
  const settingsKeys = [
    "OBSIDIAN_NOTE_DIR", "OBSIDIAN_DICTIONARY_DIR", "OBSIDIAN_BUSINESS_DIR",
    "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL",
    "BRIGHT_DATA_API_TOKEN", "BRIGHT_DATA_YT_DATASET_ID", "BRIGHT_DATA_WIKI_DATASET_ID",
    "BRIGHT_DATA_API_BASE", "BRIGHT_DATA_TIMEOUT_MS", "BRIGHT_DATA_POLL_INTERVAL_MS"
  ];
  for (const key of settingsKeys) {
    delete process.env[key];
  }
  loadDotenv();
}

module.exports = {
  ENV_PATH,
  getPort,
  SNAPSHOT_RETRY_INTERVAL_MS,
  SNAPSHOT_MAX_RETRIES,
  SNAPSHOT_RETRY_GRACE_MS,
  loadDotenv,
  getConfig,
  writeEnvFile,
  reloadEnv,
};
