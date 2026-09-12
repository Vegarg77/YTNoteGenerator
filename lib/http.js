// Minimal HTTP helpers shared by the Bright Data dataset client and the Wikipedia client.
//
// These live outside lib/brightdata.js on purpose: they are plain Node `fetch` wrappers
// (no token, no proxy, no dataset), and the Wikipedia code path uses them to talk to the
// official MediaWiki API directly. Keeping them here means lib/wiki.js no longer imports
// Bright Data at all, so "Wikipedia goes through Bright Data" cannot be reintroduced by
// accident via an innocuous-looking helper import.

async function fetchJson(url, { method = "GET", headers = {}, body, signal, label } = {}) {
  const resp = await fetch(url, { method, headers, body, signal });
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

async function fetchText(url, { method = "GET", headers = {}, signal } = {}) {
  const resp = await fetch(url, { method, headers, signal });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${method} ${url} failed (${resp.status}): ${text || resp.statusText}`);
  }
  return resp.text();
}

module.exports = {
  fetchJson,
  fetchText,
};
