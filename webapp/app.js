const el = (id) => document.getElementById(id);
const statusEl = el("statusSmall");
const progressContainer = el("progressContainer");
const resultEl = el("result");
const copyBtn = el("copy");
const openSource = el("openSource");
const inputErr = el("inputErr");
const copyStatus = el("copyStatus");

const selectedWikiTerms = [];
const selectedWikiBusinesses = [];

let appSettings = { OPENAI_API_KEY: "", OPENAI_MODEL: "deepseek/deepseek-v4-flash-0731", OPENAI_BASE_URL: "https://openrouter.ai/api" };
let wikiTermSuggestionTimer = null;
let wikiBusinessSuggestionTimer = null;
let wikiTermSuggestionRequestId = 0;
let wikiBusinessSuggestionRequestId = 0;
let activeTab = "youtube";
let isProcessing = false;
let failedVideoUrls = [];

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }
function nowDateTimeStrings() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return { date, time };
}

function buildVideoNoteMarkdown({ date, time, channel, publishedDate, summary, fixedTranscript, videoUrl, tags }) {
  const header = [
    `#### ${date}  ${time}`,
    "",
    `###### Channel: ${channel || ""}`
  ];
  if (publishedDate) {
    header.push("", `###### Published: ${publishedDate}`);
  }
  const tagLine = ["#VN", ...(Array.isArray(tags) ? tags : []).map((t) => `#${t.replace(/^#/, "")}`)].join(" ");
  return [
    ...header,
    "",
    "## Summary:",
    "",
    summary || "",
    "",
    "## Transcript:",
    "",
    fixedTranscript || "",
    "",
    "### Video Link:",
    "",
    videoUrl || "",
    "",
    tagLine
  ].join("\n");
}

// Format tags for a note footer: strip stray '#'/empties, '#'-prefix each.
// Returns "" when there are no tags (callers then omit the line entirely).
function formatTagLine(tags) {
  const names = (Array.isArray(tags) ? tags : [])
    .map((t) => String(t).trim().replace(/^#/, ""))
    .filter(Boolean);
  return names.length ? names.map((t) => `#${t}`).join(" ") : "";
}

function buildDictionaryMarkdown({ date, structuredContent, sourceUrl, location, tags }) {
  const body = (structuredContent || "").trim();
  const frontmatterLines = ["---", "aliases: []"];
  if (location) {
    frontmatterLines.push(`location: ${location.lat}, ${location.lon}`);
  }
  frontmatterLines.push("---");

  const lines = [
    ...frontmatterLines,
    "",
    `#### ${date}`,
    "",
    body || "No article details were generated.",
    "",
    "---",
    "",
    "## References",
    sourceUrl ? `- ${sourceUrl}` : "- https://en.wikipedia.org/"
  ];
  const tagLine = formatTagLine(tags);
  if (tagLine) lines.push("", tagLine);
  return lines.join("\n");
}

function buildBusinessMarkdown({ date, time, title, foundedBy, foundedOn, headquarters, summary, offerings, sourceUrl, location, tags }) {
  const cleanOfferings = Array.isArray(offerings) ? offerings.filter(Boolean) : [];
  const offeringsLines = cleanOfferings.length ? cleanOfferings.map((item) => `- ${item}`) : ["- N/A"];

  const lines = [];
  if (location) {
    lines.push("---", `location: ${location.lat}, ${location.lon}`, "---", "");
  }
  lines.push(`#### ${date}  ${time}`);
  lines.push(
    "",
    `## Founded by: ${foundedBy || "N/A"}`,
    "",
    `## Founded on: ${foundedOn || "N/A"}`,
    "",
    `## Headquarters: ${headquarters || "N/A"}`,
    "",
    "## Summary:",
    "",
    summary || "N/A",
    "",
    "## Offerings, Assets, Services",
    "",
    ...offeringsLines,
    "",
    "## References",
    sourceUrl ? `- ${sourceUrl}` : "- https://en.wikipedia.org/"
  );
  const tagLine = formatTagLine(tags);
  if (tagLine) lines.push("", tagLine);
  return lines.join("\n");
}


// Defensive strip for the video summary: despite the prompt asking for paragraphs only,
// the model sometimes prepends a title/heading line (echoing "Video Title: ..." verbatim,
// or a Markdown heading/bold-only line) before the actual summary. Removes any such leading
// lines so the note's "## Summary:" section isn't followed by a redundant title.
function stripLeadingTitleLine(content) {
  const lines = (content || "").trim().split("\n");
  while (lines.length) {
    const first = lines[0].trim();
    const isHeading = /^#{1,6}\s+\S/.test(first);
    const isBoldOnlyLine = /^\*\*[^*]+\*\*$/.test(first);
    const isTitleEcho = /^(video\s+)?title\s*:/i.test(first);
    if (!first || isHeading || isBoldOnlyLine || isTitleEcho) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join("\n").trim();
}

function normalizeDictionaryContent(content) {
  let text = (content || "").trim();
  if (!text) return "";

  const firstSection = text.search(/^##\s*Summary\b/im);
  if (firstSection > 0) text = text.slice(firstSection).trim();

  const refsSection = text.search(/^##\s*References\b/im);
  if (refsSection >= 0) text = text.slice(0, refsSection).trim();

  return text;
}

function parseBusinessContent(content) {
  const text = (content || "").trim();
  if (!text) {
    return {
      foundedBy: "N/A",
      foundedOn: "N/A",
      headquarters: "N/A",
      summary: "N/A",
      offerings: ["N/A"]
    };
  }

  const normalizedText = text.replace(/\r\n?/g, "\n");

  const findField = (label) => {
    const match = normalizedText.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
    return match?.[1]?.trim() || "N/A";
  };

  const summaryMatch = normalizedText.match(/SUMMARY_START\n([\s\S]*?)\nSUMMARY_END/i);
  const offeringsMatch = normalizedText.match(/OFFERINGS_START\n([\s\S]*?)\nOFFERINGS_END/i);

  const summary = summaryMatch?.[1]?.trim() || "N/A";
  const offerings = (offeringsMatch?.[1] || "")
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  return {
    foundedBy: findField("FOUNDED_BY"),
    foundedOn: findField("FOUNDED_ON"),
    headquarters: findField("HEADQUARTERS"),
    summary,
    offerings: offerings.length ? offerings : ["N/A"]
  };
}


function splitIntoChunks(text, maxLen = 12000) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    const slice = text.slice(i, end);
    const lastBreak = slice.lastIndexOf("\n\n");
    if (end < text.length && lastBreak > maxLen * 0.6) end = i + lastBreak + 2;
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

function cancelledError() {
  const err = new Error("Cancelled by user");
  err.name = "CancelledError";
  return err;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

function withTimeout(promiseFactory, ms, label = "operation", externalSignal = null) {
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) return Promise.reject(cancelledError());
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const t = setTimeout(() => ctrl.abort(), ms);
  return promiseFactory(ctrl.signal)
    .finally(() => {
      clearTimeout(t);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    })
    .catch((err) => {
      if (err?.name === "AbortError") {
        if (externalSignal?.aborted) throw cancelledError();
        throw new Error(`${label} timed out after ${ms}ms`);
      }
      throw err;
    });
}

// ---- per-job elapsed timers: ONE shared 1s ticker drives every active job card ----
const elapsedRegistry = new Set();
let elapsedTimer = null;

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

function ensureElapsedTicker() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    for (const entry of elapsedRegistry) {
      entry.el.textContent = formatElapsed(Date.now() - entry.startedAt);
    }
    if (!elapsedRegistry.size) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }, 1000);
}

function startElapsed(entry) {
  if (elapsedRegistry.has(entry)) return;
  elapsedRegistry.add(entry);
  entry.el.textContent = formatElapsed(Date.now() - entry.startedAt);
  ensureElapsedTicker();
}

function stopElapsed(entry) {
  if (!elapsedRegistry.delete(entry)) return;
  if (!elapsedRegistry.size && elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function createProgressPanel(itemLabel, index) {
  const card = document.createElement("article");
  card.className = "panel video-progress-card";
  card.innerHTML = `
    <div class="panel-header">
      <h3 class="panel-title">Item ${index + 1}</h3>
      <div class="header-actions">
        <span class="badge soft">Queued</span>
        <button type="button" class="cancel-btn" aria-label="Cancel job" title="Cancel job">✕</button>
      </div>
    </div>
    <div class="stepper">
      <div class="step"></div>
      <div class="step"></div>
      <div class="step"></div>
    </div>
    <div class="progress-row">
      <span class="muted status-text">Idle</span>
      <span class="muted pct-text">0%</span>
    </div>
    <div class="progress-bar">
      <div class="progress-fill"></div>
    </div>
    <div class="log" aria-live="polite"></div>
    <div class="job-footer"><span class="elapsed muted"></span></div>
  `;

  const itemLabelEl = document.createElement("p");
  itemLabelEl.className = "muted video-url";
  itemLabelEl.title = itemLabel;
  itemLabelEl.textContent = itemLabel;
  const stepperEl = card.querySelector(".stepper");
  card.insertBefore(itemLabelEl, stepperEl);

  progressContainer.appendChild(card);

  const badge = card.querySelector(".badge");
  const titleEl = card.querySelector(".panel-title");
  const status = card.querySelector(".status-text");
  const pct = card.querySelector(".pct-text");
  const pfill = card.querySelector(".progress-fill");
  const steps = Array.from(card.querySelectorAll(".step"));
  const log = card.querySelector(".log");
  const cancelEl = card.querySelector(".cancel-btn");
  const elapsedEl = card.querySelector(".elapsed");

  let terminal = false;
  let elapsedEntry = null;
  let cancelHandler = null;

  cancelEl.addEventListener("click", () => {
    if (terminal) return;
    cancelEl.disabled = true;
    if (cancelHandler) cancelHandler();
  });

  const api = {
    setTitle(title) {
      if (title && title.trim()) {
        titleEl.textContent = title.trim();
        titleEl.title = title.trim();
      }
    },
    setProgress(stage, value, note) {
      status.textContent = stage || "";
      const pctNum = Math.max(0, Math.min(100, Math.round(value || 0)));
      pct.textContent = `${pctNum}%`;
      pfill.style.width = `${pctNum}%`;
      badge.textContent = pctNum >= 100 ? "Done" : "Running";
      if (pctNum >= 100) {
        // terminal state: stop the elapsed clock and drop the cancel affordance
        terminal = true;
        cancelEl.hidden = true;
        cancelEl.disabled = false;
        if (elapsedEntry) {
          stopElapsed(elapsedEntry);
          elapsedEntry = null;
        }
      } else if (!terminal && !elapsedEntry) {
        elapsedEntry = { el: elapsedEl, startedAt: Date.now() };
        startElapsed(elapsedEntry);
      }
      if (note) api.appendLog(`${stage}: ${note}`);
      if (pctNum >= 25) steps[0].classList.add("fill");
      if (pctNum >= 55) steps[1].classList.add("fill");
      if (pctNum >= 85) steps[2].classList.add("fill");
    },
    appendLog(line) {
      const div = document.createElement("div");
      div.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    },
    setError(message) {
      terminal = true;
      cancelEl.hidden = true;
      cancelEl.disabled = false;
      if (elapsedEntry) {
        stopElapsed(elapsedEntry);
        elapsedEntry = null;
      }
      badge.textContent = "Error";
      badge.classList.add("danger");
      api.setProgress("Error", 100, message || "Failed");
    },
    setCancelled() {
      terminal = true;
      cancelEl.hidden = true;
      cancelEl.disabled = false;
      if (elapsedEntry) {
        stopElapsed(elapsedEntry);
        elapsedEntry = null;
      }
      badge.textContent = "Cancelled";
      badge.classList.remove("danger");
      badge.classList.add("cancelled");
      status.textContent = "Cancelled";
      api.appendLog("Cancelled by user.");
    },
    // wire the red ✕ to this job's AbortController
    onCancel(fn) {
      cancelHandler = fn;
    }
  };

  return api;
}

function resetUi() {
  progressContainer.innerHTML = "";
  statusEl.textContent = "Idle";
  resultEl.value = "";
  copyBtn.disabled = true;
  copyStatus.textContent = "";
  openSource.href = "#";
}

function parseVideoUrls(rawInput) {
  return Array.from(new Set(
    (rawInput || "")
      .split(/[,\n\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

async function fetchTranscriptFromServer(videoUrl, signal) {
  const url = `/api/transcript?url=${encodeURIComponent(videoUrl)}`;
  let resp;
  try {
    resp = await fetch(url, { signal });
  } catch (err) {
    if (signal?.aborted) throw cancelledError();
    throw err;
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Transcript API error: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return {
    transcript: data?.transcript || "",
    source: data?.source || "unknown",
    metadata: {
      title: data?.metadata?.title || "",
      channel: data?.metadata?.channel || "",
      publishedDate: data?.metadata?.publishedDate || "",
      url: data?.metadata?.url || videoUrl
    }
  };
}

async function fetchWikipediaSuggestions(query) {
  const resp = await fetch(`/api/wikipedia-suggest?q=${encodeURIComponent(query)}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return Array.isArray(data?.suggestions) ? data.suggestions : [];
}

async function fetchWikipediaPage(title, articleUrl, signal) {
  const params = new URLSearchParams();
  if (title) params.set("title", title);
  if (articleUrl) params.set("url", articleUrl);
  let resp;
  try {
    resp = await fetch(`/api/wikipedia-page?${params.toString()}`, { signal });
  } catch (err) {
    if (signal?.aborted) throw cancelledError();
    throw err;
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Wikipedia API error: ${resp.status} ${text}`);
  }
  return resp.json();
}

async function saveNoteToServer({ markdown, noteTitle, noteType }) {
  const resp = await fetch("/api/save-note", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ markdown, noteTitle, noteType })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Save API error: ${resp.status} ${text}`);
  }

  return resp.json();
}

// Base URL of the LLM API (OpenAI or any compatible provider, e.g. OpenRouter/DeepSeek).
function llmBaseUrl() {
  return (appSettings.OPENAI_BASE_URL || "https://openrouter.ai/api").replace(/\/+$/, "");
}
function isOpenAIBase(baseUrl) {
  return /(^|\.)openai\.com$/i.test((() => { try { return new URL(baseUrl).hostname; } catch { return ""; } })());
}
function isOpenRouterBase(baseUrl) {
  return /(^|\.)openrouter\.ai$/i.test((() => { try { return new URL(baseUrl).hostname; } catch { return ""; } })());
}
function isDeepSeekBase(baseUrl) {
  return /(^|\.)deepseek\.com$/i.test((() => { try { return new URL(baseUrl).hostname; } catch { return ""; } })());
}
// DeepSeek's v4 models enable thinking mode by default at HIGH effort, which burns
// long reasoning phases (and billed reasoning tokens) before every answer — on
// cleaning/summarization re-emission tasks that means minutes of dead time per chunk.
// This app never needs that reasoning, so disable it on the DeepSeek-direct endpoint.
// OpenRouter/OpenAI would reject the unknown `thinking` param, hence the base gate.
const DEEPSEEK_THINKING_DISABLED = { thinking: { type: "disabled" } };
// Same provider policy as this project's Hermes agent config and CI code-review
// workflow: pin every OpenRouter call to the Reka backend (order:["reka"]) so the
// prompt cache actually builds and hits across all traffic sources, carrying the deep
// cache-read discount (~$0.007/M). allow_fallbacks:false means a Reka outage fails the
// request rather than silently bouncing to a cold provider and nuking the cache.
// Only applies when the base URL is OpenRouter — DeepSeek-direct and OpenAI bases are
// untouched.
const OPENROUTER_PROVIDER_ROUTING = {
  order: ["reka"],
  allow_fallbacks: false
};

async function openaiChatCompletions({ apiKey, body, signal, baseUrl }) {
  const resp = await fetch(`${baseUrl || llmBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Chat API error: ${resp.status} ${t}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

function normalizeResponseOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  if (!Array.isArray(data?.output)) return "";

  const chunks = [];
  for (const item of data.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      const text = part?.text || part?.output_text || "";
      if (text) chunks.push(text);
    }
  }
  return chunks.join("\n").trim();
}

async function openaiResponses({ apiKey, body, signal, baseUrl }) {
  const resp = await fetch(`${baseUrl || llmBaseUrl()}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI responses error: ${resp.status} ${t}`);
  }
  const data = await resp.json();
  return normalizeResponseOutputText(data);
}

async function openaiText({ apiKey, model, messages, temperature, signal }) {
  const baseUrl = llmBaseUrl();
  // The /responses endpoint is OpenAI-specific (gpt-5 family). Compatible providers like DeepSeek
  // only implement /chat/completions, so only take the responses path on the OpenAI base.
  const isGpt5Family = /^gpt-5/i.test(model || "");

  if (isGpt5Family && isOpenAIBase(baseUrl)) {
    return openaiResponses({
      apiKey,
      signal,
      baseUrl,
      body: {
        model,
        input: messages
      }
    });
  }

  return openaiChatCompletions({
    apiKey,
    signal,
    baseUrl,
    body: {
      model,
      temperature,
      messages,
      ...(isOpenRouterBase(baseUrl) ? { provider: OPENROUTER_PROVIDER_ROUTING } : {}),
      ...(isDeepSeekBase(baseUrl) ? DEEPSEEK_THINKING_DISABLED : {})
    }
  });
}

// ---- Note tagging (pool = the user's existing vault tags, scanned server-side) ----

// memoized per page load — the pool changes slowly, and the server caches its scan too
let tagPoolPromise = null;
async function getTagPool() {
  if (!tagPoolPromise) {
    tagPoolPromise = (async () => {
      const ctrl = new AbortController();
      // generous: big vaults on network-backed filesystems can take a while on the
      // first (uncached) scan. Prefetched at batch start, so this rarely blocks.
      const t = setTimeout(() => ctrl.abort(), 120000);
      try {
        const resp = await fetch("/api/tags", { signal: ctrl.signal });
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        return (data.tags || []).map((entry) => entry.tag);
      } catch (err) {
        if (err?.name === "AbortError") {
          throw new Error("vault tag scan timed out (120s) — check Vault Root in Settings / vault size");
        }
        throw err;
      } finally {
        clearTimeout(t);
      }
    })().catch((err) => {
      tagPoolPromise = null; // allow retry on the next video
      throw err;
    });
  }
  return tagPoolPromise;
}

// Parse the model's reply and enforce the pool: accept only tags that exist in the
// pool (case-insensitive, canonical pool casing wins), deduped. Models occasionally
// invent plausible tags no matter the prompt — the guarantee lives here, not there.
function validateTagSelection(rawText, pool) {
  const byLower = new Map(pool.map((t) => [t.toLowerCase(), t]));
  let names = [];
  try {
    const jsonText = String(rawText || "").replace(/```(?:json)?/gi, "").trim();
    const start = jsonText.indexOf("[");
    const end = jsonText.lastIndexOf("]");
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(jsonText.slice(start, end + 1));
      if (Array.isArray(parsed)) names = parsed;
    }
  } catch { /* fall through to empty */ }
  const out = [];
  const seen = new Set();
  for (const raw of names) {
    const canonical = byLower.get(String(raw).trim().replace(/^#/, "").toLowerCase());
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

// Note-kind labels for the tag picker. Video keeps its original wording; the Wikipedia
// flows describe the note without a channel. Dictionary/business notes carry no
// mandatory #VN prefix — tags come purely from the pool.
const TAG_KIND_PROMPTS = {
  video: {
    label: "video note",
    header: (title, channel) => `Video Title: ${title || ""}\nChannel: ${channel || ""}`
  },
  dictionary: {
    label: "dictionary note (a Wikipedia term)",
    header: (title) => `Term: ${title || ""}`
  },
  business: {
    label: "business note (a Wikipedia organization)",
    header: (title) => `Organization: ${title || ""}`
  }
};

// Pick applicable tags for a note from the fixed pool. Empty array is a valid,
// expected outcome (no forced matches). Any failure degrades to no tags.
async function selectNoteTags({ apiKey, model, title, channel, summary, pool, signal, kind = "video" }) {
  if (!pool || pool.length === 0) return [];
  const prompt = TAG_KIND_PROMPTS[kind] || TAG_KIND_PROMPTS.video;
  const messages = [
    { role: "system", content: "You label notes with tags chosen STRICTLY from a fixed list. Never invent tags." },
    {
      role: "user",
      content:
        `Here is the complete list of allowed tags:\n${pool.join(", ")}\n\n` +
        `Select every tag from that list that genuinely applies to the ${prompt.label} below. ` +
        `Only include a tag if the note's content is substantially about that topic. ` +
        `If none apply, return an empty array. ` +
        `Respond with ONLY a JSON array of tag names (no # prefix), nothing else.\n\n` +
        `${prompt.header(title, channel)}\n\nSUMMARY:\n${(summary || "").slice(0, 12000)}`
    }
  ];
  const reply = await openaiText({ apiKey, model, messages, temperature: 0, signal });
  return validateTagSelection(reply, pool);
}

function startHeartbeat(panel, label = "Working…", floorPct = 69) {
  let i = 0;
  return setInterval(() => {
    const pct = floorPct + (i++ % 3);
    panel.setProgress(label, pct, "still running");
  }, 10000);
}

function stopHeartbeat(timer) {
  if (timer) clearInterval(timer);
}

async function processVideo({ apiKey, model, videoUrl, panel, signal }) {
  panel.setProgress("Fetching metadata + transcript", 5);
  const transcriptResult = await fetchTranscriptFromServer(videoUrl, signal);
  throwIfCancelled(signal);
  const transcript = transcriptResult.transcript;
  const meta = transcriptResult.metadata;

  panel.appendLog(`Transcript source: ${transcriptResult.source}`);
  panel.appendLog(`Transcript lines: ${transcript.split("\n").length}`);

  // Update panel title to the actual video title now that we have metadata
  if (meta.title) panel.setTitle(meta.title);

  // Determine chunks upfront so we can calculate accurate progress weights.
  // Weights: 1 (fetch) + numChunks (one per chunk) + 1 (summarize) + 0.3 (tags) + 0.1 (save)
  const chunks = transcript.length > 12000 ? splitIntoChunks(transcript, 12000) : null;
  const numChunks = chunks ? chunks.length : 1;
  const totalWeight = 1 + numChunks + 1 + 0.3 + 0.1;

  function pctAt(unitsComplete) {
    return Math.round((unitsComplete / totalWeight) * 100);
  }

  const fetchDonePct = pctAt(1);
  const summarizeStartPct = pctAt(1 + numChunks);
  const tagStartPct = pctAt(1 + numChunks + 1);
  const savePct = Math.min(99, pctAt(1 + numChunks + 1 + 0.3));

  panel.appendLog(`Transcript chunks: ${numChunks}`);
  panel.setProgress("Cleaning transcript…", fetchDonePct, "Preparing");

  let fixedTranscript = "";
  if (!chunks) {
    // Single-pass clean (transcript fits in one chunk)
    const cleanMessages = [
      { role: "system", content: "You are a precise transcription editor." },
      {
        role: "user",
        content:
          "Clean the following transcript. If any part is not in English, translate it to clear natural English while preserving the original meaning and tone. Fix punctuation, capitalization, and homophones; remove non-speech tags like [Music]/[Applause] unless meaningful. No timestamps. Output ONLY clean Markdown paragraphs in English.\n\nTRANSCRIPT:\n" +
          transcript
      }
    ];
    const hb = startHeartbeat(panel, "Cleaning transcript…", fetchDonePct);
    try {
      try {
        fixedTranscript = await withTimeout((signal) => openaiText({ apiKey, model, messages: cleanMessages, temperature: 0.1, signal }), 300000, "LLM (clean)", signal);
      } catch (err) {
        if (err?.name === "CancelledError") throw err;
        panel.setProgress("Retrying clean…", pctAt(1.5));
        fixedTranscript = await withTimeout((signal) => openaiText({ apiKey, model, messages: cleanMessages, temperature: 0.1, signal }), 300000, "LLM (clean retry)", signal);
      }
    } finally {
      stopHeartbeat(hb);
    }
    fixedTranscript = fixedTranscript.trim();
  } else {
    const out = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunkLabel = `Cleaning chunk ${i + 1}/${chunks.length}`;
      // Progress: after completing i chunks out of numChunks (starting from 1 unit already done for fetch)
      panel.setProgress(chunkLabel, pctAt(1 + i));
      panel.appendLog(chunkLabel);
      const cleanChunkMessages = [
        { role: "system", content: "You are a precise transcription editor." },
        {
          role: "user",
          content:
            `You will clean a chunk of a transcript (part ${i + 1} of ${chunks.length}). If any part is not in English, translate it to clear natural English while preserving the original meaning and tone. Fix punctuation, capitalization, and homophones; remove non-speech tags like [Music]/[Applause] unless meaningful. No timestamps. Output ONLY clean Markdown paragraphs in English.\n\nCHUNK_TEXT:\n` +
            chunks[i]
        }
      ];
      let cleaned;
      try {
        cleaned = await withTimeout((signal) => openaiText({ apiKey, model, messages: cleanChunkMessages, temperature: 0.1, signal }), 300000, `LLM (clean chunk ${i + 1})`, signal);
      } catch (err) {
        if (err?.name === "CancelledError") throw err;
        panel.setProgress(`Retrying chunk ${i + 1}/${chunks.length}`, pctAt(1 + i + 0.5));
        cleaned = await withTimeout(
          (signal) => openaiText({ apiKey, model, messages: cleanChunkMessages, temperature: 0.1, signal }),
          300000,
          `LLM (clean chunk ${i + 1} retry)`,
          signal
        );
      }
      out.push((cleaned || "").trim());
    }
    fixedTranscript = out.join("\n\n");
  }

  panel.setProgress("Summarizing…", summarizeStartPct, "3–5 paragraph summary");
  const summaryMessages = [
    { role: "system", content: "You are an expert at writing structured, detailed summaries." },
    {
      role: "user",
      content:
        `Write a detailed summary (3–5 paragraphs; each 3–6 sentences) of the transcript below. Use concise, readable Markdown. No timestamps. Do not include a title, heading, or the video's name — output only the summary paragraphs themselves.\n\nVideo Title: ${meta.title || ""}\nChannel: ${meta.channel || ""}\n\nTRANSCRIPT:\n` +
        fixedTranscript.slice(0, 180000)
    }
  ];

  let summary = "";
  {
    const hb = startHeartbeat(panel, "Summarizing…", summarizeStartPct);
    try {
      try {
        summary = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.2, signal }), 300000, "LLM (summary)", signal);
      } catch (err) {
        if (err?.name === "CancelledError") throw err;
        panel.setProgress("Retrying summary…", pctAt(1 + numChunks + 0.5));
        summary = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.2, signal }), 300000, "LLM (summary retry)", signal);
      }
    } finally {
      stopHeartbeat(hb);
    }
  }
  summary = stripLeadingTitleLine(summary);

  // Tag selection from the vault pool — silently applied; the user edits during
  // note review. Any failure (scan, LLM, parse) degrades to just #VN, never blocks.
  let noteTags = [];
  panel.setProgress("Selecting tags…", tagStartPct);
  try {
    const pool = await getTagPool();
    noteTags = await withTimeout(
      (signal) => selectNoteTags({ apiKey, model, title: meta.title, channel: meta.channel, summary, pool, signal }),
      300000,
      "LLM (tags)",
      signal
    );
    panel.appendLog(noteTags.length ? `Tags: ${noteTags.map((t) => `#${t}`).join(" ")}` : "Tags: none matched the pool");
  } catch (tagErr) {
    if (tagErr?.name === "CancelledError") throw tagErr;
    panel.appendLog(`Tagging skipped: ${tagErr?.message || "unknown error"}`);
  }

  const { date, time } = nowDateTimeStrings();
  const markdown = buildVideoNoteMarkdown({
    date,
    time,
    channel: meta.channel,
    publishedDate: meta.publishedDate || "",
    summary,
    fixedTranscript,
    videoUrl: meta.url || videoUrl,
    tags: noteTags
  });

  throwIfCancelled(signal);
  panel.setProgress("Saving note file…", savePct);
  let saveResult = null;
  try {
    saveResult = await saveNoteToServer({
      markdown,
      noteTitle: meta.title,
      noteType: "video"
    });
    panel.appendLog(`Saved note: ${saveResult.fileName}`);
  } catch (saveErr) {
    const reason = saveErr?.message || "Unknown save error";
    panel.appendLog(`Note save failed: ${reason}`);
  }

  // honest completion: don't say "Note ready" when the file never landed —
  // the markdown still exists in the output box, so point at Copy Markdown.
  if (saveResult) {
    panel.setProgress("Done", 100, "Note ready");
  } else {
    panel.setProgress("Done — SAVE FAILED", 100, "Note not written; use Copy Markdown below");
  }
  return { markdown, sourceUrl: meta.url || videoUrl, saveResult, title: meta.title };
}

async function processWikipediaTerm({ apiKey, model, entry, panel, signal }) {
  const term = entry.title;
  panel.setProgress("Loading Wikipedia article", 15);
  const fetchHb = startHeartbeat(panel, "Loading Wikipedia article", 15);
  let wikiData;
  try {
    wikiData = await fetchWikipediaPage(term, entry.url, signal);
  } finally {
    stopHeartbeat(fetchHb);
  }
  throwIfCancelled(signal);
  const articleTitle = wikiData?.title || term;
  const articleUrl = wikiData?.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(articleTitle.replace(/\s+/g, "_"))}`;
  const extract = wikiData?.extract || "";

  if (!extract.trim()) {
    throw new Error("Wikipedia article content was empty.");
  }

  panel.appendLog(`Fetched Wikipedia article: ${articleTitle}`);
  panel.setProgress("Summarizing article", 65, "Dictionary note format");

  const summaryMessages = [
    {
      role: "system",
      content: "You are a precise research assistant that fills structured Obsidian templates from source text only."
    },
    {
      role: "user",
      content:
        `Populate this dictionary-note template using ONLY the provided Wikipedia article text.

Rules:
- Return Markdown for these sections only (do not include YAML, date_created line, title, or References):
  ## Summary
  ## Key Points
  ## Details
  ## Context
  ## Applications / Impact
  ## Key Data (If Relevant)
  ## Timeline (If Relevant)
- Keep this exact heading order.
- Use 2-5 sentences in Summary.
- Use bullet points in Key Points.
- Timeline must include a Markdown table with this header row exactly: | Date | Event |
- If details are missing from the source, write "Not clearly stated in source." where needed.
- Neutral factual tone. No speculation.

Article title: ${articleTitle}

ARTICLE TEXT:
${extract.slice(0, 180000)}`
    }
  ];

  const hb = startHeartbeat(panel, "Summarizing article", 65);
  let structuredContent = "";
  try {
    try {
      structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 300000, "LLM (wikipedia summary)", signal);
    } catch (err) {
      if (err?.name === "CancelledError") throw err;
      panel.setProgress("Retrying summary…", 70);
      structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 300000, "LLM (wikipedia summary retry)", signal);
    }
  } finally {
    stopHeartbeat(hb);
  }

  const dictContent = normalizeDictionaryContent(structuredContent);

  // Tag selection from the vault pool — same as video notes EXCEPT dictionary/business
  // notes carry no mandatory #VN prefix: tags come purely from the pool (which already
  // respects the settings exclude list). Failures degrade to no tags, never block save.
  let noteTags = [];
  panel.setProgress("Selecting tags…", 85);
  try {
    const pool = await getTagPool();
    noteTags = await withTimeout(
      (signal) => selectNoteTags({ apiKey, model, title: articleTitle, summary: dictContent, pool, signal, kind: "dictionary" }),
      300000,
      "LLM (tags)",
      signal
    );
    panel.appendLog(noteTags.length ? `Tags: ${noteTags.map((t) => `#${t}`).join(" ")}` : "Tags: none matched the pool");
  } catch (tagErr) {
    if (tagErr?.name === "CancelledError") throw tagErr;
    panel.appendLog(`Tagging skipped: ${tagErr?.message || "unknown error"}`);
  }

  const { date } = nowDateTimeStrings();
  const markdown = buildDictionaryMarkdown({
    date,
    structuredContent: dictContent,
    sourceUrl: articleUrl,
    location: wikiData?.location || null,
    tags: noteTags
  });

  throwIfCancelled(signal);
  panel.setProgress("Saving note file…", 92);
  let saveResult = null;
  try {
    saveResult = await saveNoteToServer({
      markdown,
      noteTitle: articleTitle,
      noteType: "dictionary"
    });
    panel.appendLog(`Saved note: ${saveResult.fileName}`);
  } catch (saveErr) {
    panel.appendLog(`Note save failed: ${saveErr?.message || "Unknown save error"}`);
  }

  panel.setProgress("Done", 100, "Dictionary note ready");
  return { markdown, sourceUrl: articleUrl, saveResult, title: articleTitle, itemType: "dictionary" };
}

async function processWikipediaBusiness({ apiKey, model, entry, panel, signal }) {
  const term = entry.title;
  panel.setProgress("Loading Wikipedia article", 15);
  const fetchHb = startHeartbeat(panel, "Loading Wikipedia article", 15);
  let wikiData;
  try {
    wikiData = await fetchWikipediaPage(term, entry.url, signal);
  } finally {
    stopHeartbeat(fetchHb);
  }
  throwIfCancelled(signal);
  const articleTitle = wikiData?.title || term;
  const articleUrl = wikiData?.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(articleTitle.replace(/\s+/g, "_"))}`;
  const extract = wikiData?.extract || "";

  if (!extract.trim()) {
    throw new Error("Wikipedia article content was empty.");
  }

  panel.appendLog(`Fetched Wikipedia article: ${articleTitle}`);
  panel.setProgress("Summarizing article", 65, "Business note format");

  const summaryMessages = [
    {
      role: "system",
      content: "You are a precise research assistant that fills structured Obsidian templates from source text only."
    },
    {
      role: "user",
      content:
`Populate the business note fields using ONLY the provided Wikipedia article text.

Rules:
- Return plain text using this exact scaffold and markers:
  FOUNDED_BY: <value or N/A>
  FOUNDED_ON: <value or N/A>
  HEADQUARTERS: <value or N/A>
  SUMMARY_START
  <3-5 paragraphs, factual and neutral, using only source information>
  SUMMARY_END
  OFFERINGS_START
  - <offering/asset/service 1 or N/A>
  - <offering/asset/service 2>
  OFFERINGS_END
- If a field is not clearly in the source, use N/A.
- Keep summary to 3-5 paragraphs.
- Do not add extra headings or commentary.

Article title: ${articleTitle}

ARTICLE TEXT:
${extract.slice(0, 180000)}`
    }
  ];

  const hb = startHeartbeat(panel, "Summarizing article", 65);
  let structuredContent = "";
  try {
    try {
      structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 300000, "LLM (wikipedia business summary)", signal);
    } catch (err) {
      if (err?.name === "CancelledError") throw err;
      panel.setProgress("Retrying summary…", 70);
      structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 300000, "LLM (wikipedia business summary retry)", signal);
    }
  } finally {
    stopHeartbeat(hb);
  }

  const parsed = parseBusinessContent(structuredContent);

  // Tag selection from the vault pool — same as dictionary notes above: no mandatory
  // #VN prefix, pool only (exclude list respected), failures degrade to no tags.
  let noteTags = [];
  panel.setProgress("Selecting tags…", 85);
  try {
    const pool = await getTagPool();
    noteTags = await withTimeout(
      (signal) => selectNoteTags({ apiKey, model, title: articleTitle, summary: parsed.summary, pool, signal, kind: "business" }),
      300000,
      "LLM (tags)",
      signal
    );
    panel.appendLog(noteTags.length ? `Tags: ${noteTags.map((t) => `#${t}`).join(" ")}` : "Tags: none matched the pool");
  } catch (tagErr) {
    if (tagErr?.name === "CancelledError") throw tagErr;
    panel.appendLog(`Tagging skipped: ${tagErr?.message || "unknown error"}`);
  }

  const { date, time } = nowDateTimeStrings();
  const markdown = buildBusinessMarkdown({
    date,
    time,
    title: articleTitle,
    foundedBy: parsed.foundedBy,
    foundedOn: parsed.foundedOn,
    headquarters: parsed.headquarters,
    summary: parsed.summary,
    offerings: parsed.offerings,
    sourceUrl: articleUrl,
    location: wikiData?.location || null,
    tags: noteTags
  });

  throwIfCancelled(signal);
  panel.setProgress("Saving note file…", 92);
  let saveResult = null;
  try {
    saveResult = await saveNoteToServer({
      markdown,
      noteTitle: articleTitle,
      noteType: "business"
    });
    panel.appendLog(`Saved note: ${saveResult.fileName}`);
  } catch (saveErr) {
    panel.appendLog(`Note save failed: ${saveErr?.message || "Unknown save error"}`);
  }

  panel.setProgress("Done", 100, "Business note ready");
  return { markdown, sourceUrl: articleUrl, saveResult, title: articleTitle, itemType: "business" };
}

function renderSelectedWikiTerms() {
  const holder = el("wikiSelectedTerms");
  holder.innerHTML = "";

  selectedWikiTerms.forEach((entry) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = entry.title;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove ${entry.title}`);
    removeBtn.addEventListener("click", () => {
      const idx = selectedWikiTerms.indexOf(entry);
      if (idx >= 0) selectedWikiTerms.splice(idx, 1);
      renderSelectedWikiTerms();
    });

    chip.appendChild(removeBtn);
    holder.appendChild(chip);
  });
}

function addWikiTerm(input) {
  const entry = typeof input === "string" ? { title: input, url: "" } : { ...input };
  entry.title = (entry.title || "").trim();
  entry.url = (entry.url || "").trim();
  if (!entry.title) return;
  if (selectedWikiTerms.some((existing) => existing.title.toLowerCase() === entry.title.toLowerCase())) return;
  selectedWikiTerms.push(entry);
  renderSelectedWikiTerms();
}

function renderSelectedWikiBusinesses() {
  const holder = el("wikiSelectedBusinesses");
  holder.innerHTML = "";

  selectedWikiBusinesses.forEach((entry) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = entry.title;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove ${entry.title}`);
    removeBtn.addEventListener("click", () => {
      const idx = selectedWikiBusinesses.indexOf(entry);
      if (idx >= 0) selectedWikiBusinesses.splice(idx, 1);
      renderSelectedWikiBusinesses();
    });

    chip.appendChild(removeBtn);
    holder.appendChild(chip);
  });
}

function addWikiBusiness(input) {
  const entry = typeof input === "string" ? { title: input, url: "" } : { ...input };
  entry.title = (entry.title || "").trim();
  entry.url = (entry.url || "").trim();
  if (!entry.title) return;
  if (selectedWikiBusinesses.some((existing) => existing.title.toLowerCase() === entry.title.toLowerCase())) return;
  selectedWikiBusinesses.push(entry);
  renderSelectedWikiBusinesses();
}

function clearWikiSuggestions(listKey = "all") {
  if (listKey === "term" || listKey === "all") {
    el("wikiSuggestionList").innerHTML = "";
  }
  if (listKey === "business" || listKey === "all") {
    el("wikiBusinessSuggestionList").innerHTML = "";
  }
}

function renderWikiSuggestions(suggestions, listKey) {
  const isBusiness = listKey === "business";
  const listEl = isBusiness ? el("wikiBusinessSuggestionList") : el("wikiSuggestionList");
  listEl.innerHTML = "";

  suggestions.forEach((suggestion) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion-item";
    btn.setAttribute("role", "option");
    const titleDiv = document.createElement("div");
    titleDiv.className = "suggestion-title";
    titleDiv.textContent = suggestion.title;
    const descDiv = document.createElement("div");
    descDiv.className = "suggestion-description";
    descDiv.textContent = suggestion.description || "Wikipedia article";
    btn.appendChild(titleDiv);
    btn.appendChild(descDiv);
    btn.addEventListener("click", () => {
      const entry = { title: suggestion.title, url: suggestion.url || "" };
      if (isBusiness) {
        addWikiBusiness(entry);
        el("wikiBusinessInput").value = "";
        el("wikiBusinessInput").focus();
        clearWikiSuggestions("business");
      } else {
        addWikiTerm(entry);
        el("wikiTermInput").value = "";
        el("wikiTermInput").focus();
        clearWikiSuggestions("term");
      }
    });
    listEl.appendChild(btn);
  });
}

async function updateWikiSuggestions(listKey, requestId) {
  const isBusiness = listKey === "business";
  const inputEl = isBusiness ? el("wikiBusinessInput") : el("wikiTermInput");
  const query = inputEl.value.trim();

  if (query.length < 2) {
    clearWikiSuggestions(listKey);
    return;
  }

  try {
    const suggestions = await fetchWikipediaSuggestions(query);
    const latestId = isBusiness ? wikiBusinessSuggestionRequestId : wikiTermSuggestionRequestId;
    if (requestId !== latestId) return;

    const latestQuery = inputEl.value.trim();
    if (latestQuery !== query) return;

    renderWikiSuggestions(suggestions.slice(0, 8), listKey);
  } catch {
    const latestId = isBusiness ? wikiBusinessSuggestionRequestId : wikiTermSuggestionRequestId;
    if (requestId === latestId) clearWikiSuggestions(listKey);
  }
}

function setActiveTab(tabName) {
  activeTab = tabName;
  const isYoutube = tabName === "youtube";

  el("tabYoutube").classList.toggle("active", isYoutube);
  el("tabWikipedia").classList.toggle("active", !isYoutube);
  el("tabYoutube").setAttribute("aria-selected", isYoutube ? "true" : "false");
  el("tabWikipedia").setAttribute("aria-selected", isYoutube ? "false" : "true");

  el("panelYoutube").classList.toggle("active", isYoutube);
  el("panelWikipedia").classList.toggle("active", !isYoutube);
  el("panelYoutube").hidden = !isYoutube;
  el("panelWikipedia").hidden = isYoutube;
}

async function copyTextareaValue(textareaEl) {
  const text = textareaEl?.value || "";
  if (!text) return false;

  textareaEl.focus();
  textareaEl.select();
  textareaEl.setSelectionRange(0, text.length);

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

async function loadSettings() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch("/api/settings", { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!resp.ok) return;
    const data = await resp.json();
    appSettings = data;
    populateSettingsForm(data);
  } catch { /* settings will use defaults */ }
}

function populateSettingsForm(data) {
  const versionEl = el("appVersion");
  if (versionEl && data.version) versionEl.textContent = `v${data.version}`;
  el("settingNotePath").value = data.OBSIDIAN_NOTE_DIR || "";
  el("settingDictPath").value = data.OBSIDIAN_DICTIONARY_DIR || "";
  el("settingBizPath").value = data.OBSIDIAN_BUSINESS_DIR || "";
  el("settingVaultPath").value = data.OBSIDIAN_VAULT_DIR || "";
  el("settingTagExclude").value = data.TAG_EXCLUDE || "VN";
  el("settingOpenaiKey").value = data.OPENAI_API_KEY || "";
  el("settingBrightKey").value = data.BRIGHT_DATA_API_TOKEN || "";
  el("settingModel").value = data.OPENAI_MODEL || "deepseek/deepseek-v4-flash-0731";
  el("settingBaseUrl").value = data.OPENAI_BASE_URL || "https://openrouter.ai/api";
  el("settingBdTimeout").value = data.BRIGHT_DATA_TIMEOUT_MS || 120000;
}

async function saveSettings() {
  const errEl = el("settingsErr");
  const okEl = el("settingsOk");
  errEl.textContent = "";
  okEl.textContent = "";

  const payload = {
    OBSIDIAN_NOTE_DIR: el("settingNotePath").value.trim(),
    OBSIDIAN_DICTIONARY_DIR: el("settingDictPath").value.trim(),
    OBSIDIAN_BUSINESS_DIR: el("settingBizPath").value.trim(),
    OBSIDIAN_VAULT_DIR: el("settingVaultPath").value.trim(),
    TAG_EXCLUDE: el("settingTagExclude").value.trim() || "VN",
    OPENAI_API_KEY: el("settingOpenaiKey").value.trim(),
    BRIGHT_DATA_API_TOKEN: el("settingBrightKey").value.trim(),
    OPENAI_MODEL: el("settingModel").value.trim() || "deepseek/deepseek-v4-flash-0731",
    OPENAI_BASE_URL: el("settingBaseUrl").value.trim().replace(/\/+$/, "") || "https://openrouter.ai/api",
    BRIGHT_DATA_TIMEOUT_MS: el("settingBdTimeout").value.trim() || "120000",
  };

  try {
    const resp = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(text);
    }
    const data = await resp.json();
    appSettings = data;
    populateSettingsForm(data);
    tagPoolPromise = null; // vault dir / exclude list may have changed — re-fetch next run
    okEl.textContent = "Settings saved.";
    setTimeout(() => { okEl.textContent = ""; }, 3000);
  } catch (err) {
    errEl.textContent = `Save failed: ${err.message}`;
  }
}

function openSettings() {
  populateSettingsForm(appSettings);
  el("settingsOverlay").hidden = false;
  el("settingsErr").textContent = "";
  el("settingsOk").textContent = "";
}

function closeSettings() {
  el("settingsOverlay").hidden = true;
}

function allPanelsSettled() {
  const badges = progressContainer.querySelectorAll(".badge");
  if (!badges.length) return true;
  return Array.from(badges).every(
    (b) => b.textContent === "Done" || b.textContent === "Error" || b.textContent === "Cancelled"
  );
}

function updateActionButtons() {
  el("retryFailed").disabled = isProcessing || !failedVideoUrls.length;
  el("clearWikiFields").disabled = isProcessing;
}

async function runYoutube() {
  inputErr.textContent = "";
  copyStatus.textContent = "";

  const apiKey = (appSettings.OPENAI_API_KEY || "").trim();
  const videoUrlsRaw = el("videoUrl").value;
  const model = (appSettings.OPENAI_MODEL || "deepseek/deepseek-v4-flash-0731").trim();
  const videoUrls = parseVideoUrls(videoUrlsRaw);

  el("videoUrl").value = "";

  if (!apiKey) {
    inputErr.textContent = "Please set your OpenAI API key in Settings (gear icon).";
    return;
  }

  if (!videoUrls.length) {
    inputErr.textContent = "Please enter at least one YouTube video URL.";
    return;
  }

  // warm the vault tag pool NOW — the scan runs concurrently with the (much longer)
  // transcript+clean+summary phase, so tag selection never waits on it. Errors are
  // swallowed here; the per-video tag step reports them properly on retry.
  getTagPool().catch(() => {});

  if (allPanelsSettled()) progressContainer.innerHTML = "";

  isProcessing = true;
  updateActionButtons();

  openSource.href = videoUrls[0];
  statusEl.textContent = `Running ${videoUrls.length} video${videoUrls.length === 1 ? "" : "s"}`;

  const offset = progressContainer.children.length;
  const panels = videoUrls.map((videoUrl, index) => {
    const ctrl = new AbortController();
    const panel = createProgressPanel(videoUrl, offset + index);
    panel.onCancel(() => ctrl.abort());
    return { videoUrl, panel, ctrl };
  });

  const results = await Promise.allSettled(
    panels.map(({ videoUrl, panel, ctrl }) => processVideo({ apiKey, model, videoUrl, panel, signal: ctrl.signal }))
  );

  results.forEach((entry, index) => {
    const url = panels[index].videoUrl;
    if (entry.status === "rejected" && entry.reason?.name !== "CancelledError") {
      if (!failedVideoUrls.includes(url)) failedVideoUrls.push(url);
    } else if (entry.status === "fulfilled") {
      const idx = failedVideoUrls.indexOf(url);
      if (idx >= 0) failedVideoUrls.splice(idx, 1);
    }
  });

  isProcessing = false;
  finalizeRunResults(results, panels, "video");
  updateActionButtons();
}

async function runWikipedia() {
  inputErr.textContent = "";
  copyStatus.textContent = "";

  const apiKey = (appSettings.OPENAI_API_KEY || "").trim();
  const model = (appSettings.OPENAI_MODEL || "deepseek/deepseek-v4-flash-0731").trim();
  const terms = [...selectedWikiTerms];
  const businesses = [...selectedWikiBusinesses];

  if (!apiKey) {
    inputErr.textContent = "Please set your OpenAI API key in Settings (gear icon).";
    return;
  }

  if (!terms.length && !businesses.length) {
    inputErr.textContent = "Please add at least one Wikipedia term or business/organization.";
    return;
  }

  // warm the vault tag pool NOW (mirrors the video flow) so per-note tag selection
  // never waits on the scan; errors are swallowed — the per-note step reports them.
  getTagPool().catch(() => {});

  if (allPanelsSettled()) progressContainer.innerHTML = "";

  isProcessing = true;
  updateActionButtons();
  const totalCount = terms.length + businesses.length;
  statusEl.textContent = `Running ${totalCount} item${totalCount === 1 ? "" : "s"}`;
  const firstEntry = terms[0] || businesses[0];
  const firstLabel = firstEntry?.title || "Wikipedia";
  openSource.href = firstEntry?.url
    || `https://en.wikipedia.org/wiki/${encodeURIComponent(firstLabel.replace(/\s+/g, "_"))}`;

  const workItems = [
    ...terms.map((entry) => ({ entry, itemType: "dictionary" })),
    ...businesses.map((entry) => ({ entry, itemType: "business" }))
  ];

  const offset = progressContainer.children.length;
  const panels = workItems.map(({ entry }, index) => {
    const ctrl = new AbortController();
    const panel = createProgressPanel(entry.title, offset + index);
    panel.onCancel(() => ctrl.abort());
    return { entry, panel, ctrl };
  });

  const results = await Promise.allSettled(
    workItems.map(({ entry, itemType }, index) => {
      const panel = panels[index].panel;
      const signal = panels[index].ctrl.signal;
      return itemType === "business"
        ? processWikipediaBusiness({ apiKey, model, entry, panel, signal })
        : processWikipediaTerm({ apiKey, model, entry, panel, signal });
    })
  );

  isProcessing = false;
  finalizeRunResults(results, panels, "wiki");
  updateActionButtons();
}

async function retryFailed() {
  if (!failedVideoUrls.length || isProcessing) return;

  const apiKey = (appSettings.OPENAI_API_KEY || "").trim();
  const model = (appSettings.OPENAI_MODEL || "deepseek/deepseek-v4-flash-0731").trim();

  if (!apiKey) {
    inputErr.textContent = "Please set your OpenAI API key in Settings (gear icon).";
    return;
  }

  inputErr.textContent = "";
  copyStatus.textContent = "";

  const urlsToRetry = [...failedVideoUrls];
  failedVideoUrls = [];

  isProcessing = true;
  updateActionButtons();

  if (allPanelsSettled()) progressContainer.innerHTML = "";

  statusEl.textContent = `Retrying ${urlsToRetry.length} failed video${urlsToRetry.length === 1 ? "" : "s"}`;

  const offset = progressContainer.children.length;
  const panels = urlsToRetry.map((videoUrl, index) => {
    const ctrl = new AbortController();
    const panel = createProgressPanel(videoUrl, offset + index);
    panel.onCancel(() => ctrl.abort());
    return { videoUrl, panel, ctrl };
  });

  const results = await Promise.allSettled(
    panels.map(({ videoUrl, panel, ctrl }) => processVideo({ apiKey, model, videoUrl, panel, signal: ctrl.signal }))
  );

  results.forEach((entry, index) => {
    if (entry.status === "rejected" && entry.reason?.name !== "CancelledError") {
      const url = panels[index].videoUrl;
      if (!failedVideoUrls.includes(url)) failedVideoUrls.push(url);
    }
  });

  isProcessing = false;
  finalizeRunResults(results, panels, "video");
  updateActionButtons();
}

function clearWikiFields() {
  if (isProcessing) return;
  selectedWikiTerms.length = 0;
  selectedWikiBusinesses.length = 0;
  renderSelectedWikiTerms();
  renderSelectedWikiBusinesses();
  el("wikiTermInput").value = "";
  el("wikiBusinessInput").value = "";
  clearWikiSuggestions();
}

function finalizeRunResults(results, panels, mode) {
  const successful = [];
  let failed = 0;
  let cancelled = 0;

  results.forEach((entry, index) => {
    if (entry.status === "fulfilled") {
      successful.push(entry.value);
    } else if (entry.reason?.name === "CancelledError") {
      cancelled += 1;
      panels[index].panel.setCancelled();
    } else {
      failed += 1;
      panels[index].panel.setError(entry.reason?.message || "Something went wrong.");
    }
  });

  if (!successful.length) {
    if (failed === 0 && cancelled > 0) {
      statusEl.textContent = `Done (${cancelled} cancelled)`;
      return;
    }
    inputErr.textContent = "All items failed. Check the progress panels for details.";
    statusEl.textContent = "Done (with errors)";
    return;
  }

  const label = mode === "wiki" ? "Wikipedia" : "Video";
  const output = successful
    .map((item, idx) => {
      const itemLabel = mode === "wiki"
        ? (item.itemType === "business" ? "Business" : "Term")
        : label;
      return `# ${itemLabel} ${idx + 1}: ${item.title || item.sourceUrl}\n\n${item.markdown}`;
    })
    .join("\n\n---\n\n");

  resultEl.value = resultEl.value ? resultEl.value + "\n\n---\n\n" + output : output;
  copyBtn.disabled = false;
  if (successful[0]?.sourceUrl) openSource.href = successful[0].sourceUrl;
  const parts = [];
  if (successful.length) parts.push(`${successful.length} succeeded`);
  if (failed) parts.push(`${failed} failed`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  statusEl.textContent = `Done (${parts.join(", ")})`;

  const allSaved = successful.every((item) => item.saveResult);
  copyStatus.textContent = allSaved
    ? `Saved ${successful.length} note${successful.length === 1 ? "" : "s"} to disk.`
    : "Some notes could not be saved to disk (all successful notes are still available in the UI).";
}

copyBtn.addEventListener("click", async () => {
  if (!resultEl.value) return;
  const copied = await copyTextareaValue(resultEl);
  if (copied) {
    copyStatus.textContent = "Copied to clipboard.";
  } else {
    copyStatus.textContent = "Copy failed. Please use Ctrl/Cmd+A then Ctrl/Cmd+C.";
  }
});

el("run").addEventListener("click", runYoutube);
el("retryFailed").addEventListener("click", retryFailed);
el("runWikipedia").addEventListener("click", runWikipedia);
el("clearWikiFields").addEventListener("click", clearWikiFields);

el("tabYoutube").addEventListener("click", () => setActiveTab("youtube"));
el("tabWikipedia").addEventListener("click", () => setActiveTab("wikipedia"));

el("wikiTermInput").addEventListener("input", () => {
  clearTimeout(wikiTermSuggestionTimer);
  const requestId = ++wikiTermSuggestionRequestId;
  wikiTermSuggestionTimer = setTimeout(() => {
    updateWikiSuggestions("term", requestId);
  }, 220);
});

el("wikiTermInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    addWikiTerm(el("wikiTermInput").value);
    el("wikiTermInput").value = "";
    clearWikiSuggestions();
  }
  if (event.key === "Backspace" && !el("wikiTermInput").value && selectedWikiTerms.length) {
    selectedWikiTerms.pop();
    renderSelectedWikiTerms();
  }
});

el("wikiBusinessInput").addEventListener("input", () => {
  clearTimeout(wikiBusinessSuggestionTimer);
  const requestId = ++wikiBusinessSuggestionRequestId;
  wikiBusinessSuggestionTimer = setTimeout(() => {
    updateWikiSuggestions("business", requestId);
  }, 220);
});

el("wikiBusinessInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    addWikiBusiness(el("wikiBusinessInput").value);
    el("wikiBusinessInput").value = "";
    clearWikiSuggestions();
  }
  if (event.key === "Backspace" && !el("wikiBusinessInput").value && selectedWikiBusinesses.length) {
    selectedWikiBusinesses.pop();
    renderSelectedWikiBusinesses();
  }
});

document.addEventListener("click", (event) => {
  const multiselect = el("wikiMultiSelect");
  const businessMultiselect = el("wikiBusinessMultiSelect");
  if (!multiselect.contains(event.target) && !businessMultiselect.contains(event.target)) {
    clearWikiSuggestions();
  }
});

el("settingsBtn").addEventListener("click", openSettings);
el("settingsClose").addEventListener("click", closeSettings);
el("settingsSave").addEventListener("click", saveSettings);
el("settingsOverlay").addEventListener("click", (event) => {
  if (event.target === el("settingsOverlay")) closeSettings();
});

window.addEventListener("load", () => {
  loadSettings();
  setActiveTab(activeTab);
});
