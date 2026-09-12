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

// Wikimedia also rate-limits bursts from a single IP (HTTP 429). A run that fetches
// several terms in parallel can trip it even at interactive volumes, so wiki.js opts into
// a couple of short-backoff retries instead of failing the note. Non-429 errors are never
// retried — a bad title or an API error should surface immediately. The delays are
// overridable so callers (and tests) are not forced to wait them out.
const DEFAULT_RETRY_429_DELAYS_MS = [1500, 3000];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Request aborted"));
    }, { once: true });
  });
}

async function fetchJson(url, {
  method = "GET",
  headers = {},
  body,
  signal,
  label,
  retryOn429 = false,
  retryDelaysMs = DEFAULT_RETRY_429_DELAYS_MS
} = {}) {
  const prefix = label ? `${label} ` : "";
  const delays = Array.isArray(retryDelaysMs) && retryDelaysMs.length ? retryDelaysMs : DEFAULT_RETRY_429_DELAYS_MS;
  const maxAttempts = retryOn429 ? delays.length + 1 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const resp = await fetch(url, { method, headers: withDefaultUserAgent(headers), body, signal });

    if (resp.status === 429 && attempt < maxAttempts) {
      await sleep(delays[attempt - 1], signal);
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 429) {
        // Deliberately generic: this helper is shared, and the caller's own label/route
        // already says which service was being talked to.
        throw new Error(`${prefix}${method} ${url} failed (429): rate-limited — try again in a moment.`);
      }
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

  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error(`${prefix}${method} ${url} failed: request retries exhausted`);
}

module.exports = {
  fetchJson,
  DEFAULT_USER_AGENT,
  DEFAULT_RETRY_429_DELAYS_MS,
};
