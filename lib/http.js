// Minimal HTTP helpers shared by the Bright Data dataset client and the Wikipedia client.
//
// These live outside lib/brightdata.js on purpose: they are plain Node `fetch` wrappers
// (no token, no proxy, no dataset), and the Wikipedia code path uses them to talk to the
// official MediaWiki API directly. Keeping them here means lib/wiki.js no longer imports
// Bright Data at all, so "Wikipedia goes through Bright Data" cannot be reintroduced by
// accident via an innocuous-looking helper import.

// Wikimedia's User-Agent policy requires a descriptive agent, and a generic one (Node's
// default included) is throttled or rejected outright — which is what the HTTP 429s seen
// against the API looked like. Identify the app and the project on every request unless
// the caller sets its own header.
let APP_VERSION = "dev";
try {
  APP_VERSION = require("../package.json").version || "dev";
} catch {
  // keep the generic version if package.json is unavailable
}
const DEFAULT_USER_AGENT = `YTNoteGenerator/${APP_VERSION} (+https://github.com/Vegarg77/YTNoteGenerator)`;

function withDefaultUserAgent(headers) {
  const hasUserAgent = Object.keys(headers || {}).some((key) => key.toLowerCase() === "user-agent");
  return hasUserAgent ? headers : { "User-Agent": DEFAULT_USER_AGENT, ...headers };
}

async function fetchJson(url, { method = "GET", headers = {}, body, signal, label } = {}) {
  const resp = await fetch(url, { method, headers: withDefaultUserAgent(headers), body, signal });
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

module.exports = {
  fetchJson,
  DEFAULT_USER_AGENT,
};
