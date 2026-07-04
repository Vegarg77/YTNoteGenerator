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

let appSettings = { OPENAI_API_KEY: "", OPENAI_MODEL: "gpt-4o-mini", OPENAI_BASE_URL: "https://api.openai.com" };
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

// "(~3 years before this note)" — the age of the video AT NOTE-CREATION time, so a
// future reader knows how stale the information already was when captured.
// Returns "" for missing/unparseable dates or videos less than a month old.
function publishedAgeLabel(publishedYMD, noteDateMs = Date.now()) {
  if (!publishedYMD) return "";
  const pub = Date.parse(`${publishedYMD}T00:00:00Z`);
  if (!Number.isFinite(pub)) return "";
  const days = Math.floor((noteDateMs - pub) / 86400000);
  if (days < 30) return "";
  const months = Math.floor(days / 30.44);
  if (months < 12) return ` (~${months} month${months === 1 ? "" : "s"} before this note)`;
  const years = Math.floor(days / 365.25);
  return ` (~${years} year${years === 1 ? "" : "s"} before this note)`;
}

function buildVideoNoteMarkdown({ date, time, channel, publishedDate, summary, fixedTranscript, videoUrl, tags }) {
  const header = [
    `#### ${date}  ${time}`,
    "",
    `###### Channel: ${channel || ""}`
  ];
  if (publishedDate) {
    header.push("", `###### Published: ${publishedDate}${publishedAgeLabel(publishedDate)}`);
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

function buildDictionaryMarkdown({ date, title, structuredContent, sourceUrl, location }) {
  const body = (structuredContent || "").trim();
  const frontmatterLines = ["---", "aliases: []"];
  if (location) {
    frontmatterLines.push(`location: ${location.lat}, ${location.lon}`);
  }
  frontmatterLines.push("---");

  return [
    ...frontmatterLines,
    "",
    `#### ${date}`,
    "",
    `# ${title || "Untitled"}`,
    "",
    body || "No article details were generated.",
    "",
    "---",
    "",
    "## References",
    sourceUrl ? `- ${sourceUrl}` : "- https://en.wikipedia.org/"
  ].join("\n");
}

function buildBusinessMarkdown({ date, time, title, foundedBy, foundedOn, headquarters, summary, offerings, sourceUrl, location }) {
  const cleanOfferings = Array.isArray(offerings) ? offerings.filter(Boolean) : [];
  const offeringsLines = cleanOfferings.length ? cleanOfferings.map((item) => `- ${item}`) : ["- N/A"];

  const lines = [];
  if (location) {
    lines.push("---", `location: ${location.lat}, ${location.lon}`, "---", "");
  }
  lines.push(`#### ${date}  ${time}`);

  return [
    ...lines,
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
  ].join("\n");
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

function withTimeout(promiseFactory, ms, label = "operation") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return promiseFactory(ctrl.signal)
    .finally(() => clearTimeout(t))
    .catch((err) => {
      if (err?.name === "AbortError") throw new Error(`${label} timed out after ${ms}ms`);
      throw err;
    });
}

function createProgressPanel(itemLabel, index) {
  const card = document.createElement("article");
  card.className = "panel video-progress-card";
  card.innerHTML = `
    <div class="panel-header">
      <h3 class="panel-title">Item ${index + 1}</h3>
      <span class="badge soft">Queued</span>
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
      badge.textContent = "Error";
      badge.classList.add("danger");
      api.setProgress("Error", 100, message || "Failed");
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

async function fetchTranscriptFromServer(videoUrl) {
  const url = `/api/transcript?url=${encodeURIComponent(videoUrl)}`;
  const resp = await fetch(url);
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

async function fetchWikipediaPage(title, articleUrl) {
  const params = new URLSearchParams();
  if (title) params.set("title", title);
  if (articleUrl) params.set("url", articleUrl);
  const resp = await fetch(`/api/wikipedia-page?${params.toString()}`);
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

// Base URL of the LLM API (OpenAI or any compatible provider, e.g. DeepSeek).
function llmBaseUrl() {
  return (appSettings.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
}
function isOpenAIBase(baseUrl) {
  return /(^|\.)openai\.com$/i.test((() => { try { return new URL(baseUrl).hostname; } catch { return ""; } })());
}

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
      messages
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
      const t = setTimeout(() => ctrl.abort(), 30000);
      try {
        const resp = await fetch("/api/tags", { signal: ctrl.signal });
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        return (data.tags || []).map((entry) => entry.tag);
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

// Pick applicable tags for a note from the fixed pool. Empty array is a valid,
// expected outcome (no forced matches). Any failure degrades to no tags.
async function selectNoteTags({ apiKey, model, title, channel, summary, pool, signal }) {
  if (!pool || pool.length === 0) return [];
  const messages = [
    { role: "system", content: "You label notes with tags chosen STRICTLY from a fixed list. Never invent tags." },
    {
      role: "user",
      content:
        `Here is the complete list of allowed tags:\n${pool.join(", ")}\n\n` +
        `Select every tag from that list that genuinely applies to the video note below. ` +
        `Only include a tag if the note's content is substantially about that topic. ` +
        `If none apply, return an empty array. ` +
        `Respond with ONLY a JSON array of tag names (no # prefix), nothing else.\n\n` +
        `Video Title: ${title || ""}\nChannel: ${channel || ""}\n\nSUMMARY:\n${(summary || "").slice(0, 12000)}`
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

async function processVideo({ apiKey, model, videoUrl, panel }) {
  panel.setProgress("Fetching metadata + transcript", 5);
  const transcriptResult = await fetchTranscriptFromServer(videoUrl);
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
        fixedTranscript = await withTimeout((signal) => openaiText({ apiKey, model, messages: cleanMessages, temperature: 0.1, signal }), 120000, "OpenAI (clean)");
      } catch {
        panel.setProgress("Retrying clean…", pctAt(1.5));
        fixedTranscript = await withTimeout((signal) => openaiText({ apiKey, model, messages: cleanMessages, temperature: 0.1, signal }), 120000, "OpenAI (clean retry)");
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
        cleaned = await withTimeout((signal) => openaiText({ apiKey, model, messages: cleanChunkMessages, temperature: 0.1, signal }), 120000, `OpenAI (clean chunk ${i + 1})`);
      } catch {
        panel.setProgress(`Retrying chunk ${i + 1}/${chunks.length}`, pctAt(1 + i + 0.5));
        cleaned = await withTimeout(
          (signal) => openaiText({ apiKey, model, messages: cleanChunkMessages, temperature: 0.1, signal }),
          120000,
          `OpenAI (clean chunk ${i + 1} retry)`
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
        `Write a detailed summary (3–5 paragraphs; each 3–6 sentences) of the transcript below. Use concise, readable Markdown. No timestamps.\n\nVideo Title: ${meta.title || ""}\nChannel: ${meta.channel || ""}\n\nTRANSCRIPT:\n` +
        fixedTranscript.slice(0, 180000)
    }
  ];

  let summary = "";
  {
    const hb = startHeartbeat(panel, "Summarizing…", summarizeStartPct);
    try {
      try {
        summary = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.2, signal }), 120000, "OpenAI (summary)");
      } catch {
        panel.setProgress("Retrying summary…", pctAt(1 + numChunks + 0.5));
        summary = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.2, signal }), 120000, "OpenAI (summary retry)");
      }
    } finally {
      stopHeartbeat(hb);
    }
  }
  summary = (summary || "").trim();

  // Tag selection from the vault pool — silently applied; the user edits during
  // note review. Any failure (scan, LLM, parse) degrades to just #VN, never blocks.
  let noteTags = [];
  panel.setProgress("Selecting tags…", tagStartPct);
  try {
    const pool = await getTagPool();
    noteTags = await withTimeout(
      (signal) => selectNoteTags({ apiKey, model, title: meta.title, channel: meta.channel, summary, pool, signal }),
      60000,
      "OpenAI (tags)"
    );
    panel.appendLog(noteTags.length ? `Tags: ${noteTags.map((t) => `#${t}`).join(" ")}` : "Tags: none matched the pool");
  } catch (tagErr) {
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

  panel.setProgress("Done", 100, "Note ready");
  return { markdown, sourceUrl: meta.url || videoUrl, saveResult, title: meta.title };
}

async function processWikipediaTerm({ apiKey, model, entry, panel }) {
  const term = entry.title;
  panel.setProgress("Loading Wikipedia article", 15);
  const fetchHb = startHeartbeat(panel, "Loading Wikipedia article", 15);
  let wikiData;
  try {
    wikiData = await fetchWikipediaPage(term, entry.url);
  } finally {
    stopHeartbeat(fetchHb);
  }
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
      structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 120000, "OpenAI (wikipedia summary)");
    } catch {
      panel.setProgress("Retrying summary…", 70);
      structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 120000, "OpenAI (wikipedia summary retry)");
    }
  } finally {
    stopHeartbeat(hb);
  }

  const { date } = nowDateTimeStrings();
  const markdown = buildDictionaryMarkdown({
    date,
    title: articleTitle,
    structuredContent: normalizeDictionaryContent(structuredContent),
    sourceUrl: articleUrl,
    location: wikiData?.location || null
  });

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

async function processWikipediaBusiness({ apiKey, model, entry, panel }) {
  const term = entry.title;
  panel.setProgress("Loading Wikipedia article", 15);
  const fetchHb = startHeartbeat(panel, "Loading Wikipedia article", 15);
  let wikiData;
  try {
    wikiData = await fetchWikipediaPage(term, entry.url);
  } finally {
    stopHeartbeat(fetchHb);
  }
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
      structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 120000, "OpenAI (wikipedia business summary)");
    } catch {
      panel.setProgress("Retrying summary…", 70);
      structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 120000, "OpenAI (wikipedia business summary retry)");
    }
  } finally {
    stopHeartbeat(hb);
  }

  const parsed = parseBusinessContent(structuredContent);
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
    location: wikiData?.location || null
  });

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
  el("settingNotePath").value = data.OBSIDIAN_NOTE_DIR || "";
  el("settingDictPath").value = data.OBSIDIAN_DICTIONARY_DIR || "";
  el("settingBizPath").value = data.OBSIDIAN_BUSINESS_DIR || "";
  el("settingVaultPath").value = data.OBSIDIAN_VAULT_DIR || "";
  el("settingTagExclude").value = data.TAG_EXCLUDE || "VN";
  el("settingOpenaiKey").value = data.OPENAI_API_KEY || "";
  el("settingBrightKey").value = data.BRIGHT_DATA_API_TOKEN || "";
  el("settingModel").value = data.OPENAI_MODEL || "gpt-4o-mini";
  el("settingBaseUrl").value = data.OPENAI_BASE_URL || "https://api.openai.com";
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
    OPENAI_MODEL: el("settingModel").value.trim() || "gpt-4o-mini",
    OPENAI_BASE_URL: el("settingBaseUrl").value.trim().replace(/\/+$/, "") || "https://api.openai.com",
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
  return Array.from(badges).every((b) => b.textContent === "Done" || b.textContent === "Error");
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
  const model = (appSettings.OPENAI_MODEL || "gpt-4o-mini").trim();
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

  if (allPanelsSettled()) progressContainer.innerHTML = "";

  isProcessing = true;
  updateActionButtons();

  openSource.href = videoUrls[0];
  statusEl.textContent = `Running ${videoUrls.length} video${videoUrls.length === 1 ? "" : "s"}`;

  const offset = progressContainer.children.length;
  const panels = videoUrls.map((videoUrl, index) => ({
    videoUrl,
    panel: createProgressPanel(videoUrl, offset + index)
  }));

  const results = await Promise.allSettled(
    panels.map(({ videoUrl, panel }) => processVideo({ apiKey, model, videoUrl, panel }))
  );

  results.forEach((entry, index) => {
    const url = panels[index].videoUrl;
    if (entry.status === "rejected") {
      if (!failedVideoUrls.includes(url)) failedVideoUrls.push(url);
    } else {
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
  const model = (appSettings.OPENAI_MODEL || "gpt-4o-mini").trim();
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
  const panels = workItems.map(({ entry }, index) => ({
    entry,
    panel: createProgressPanel(entry.title, offset + index)
  }));

  const results = await Promise.allSettled(
    workItems.map(({ entry, itemType }, index) => {
      const panel = panels[index].panel;
      return itemType === "business"
        ? processWikipediaBusiness({ apiKey, model, entry, panel })
        : processWikipediaTerm({ apiKey, model, entry, panel });
    })
  );

  isProcessing = false;
  finalizeRunResults(results, panels, "wiki");
  updateActionButtons();
}

async function retryFailed() {
  if (!failedVideoUrls.length || isProcessing) return;

  const apiKey = (appSettings.OPENAI_API_KEY || "").trim();
  const model = (appSettings.OPENAI_MODEL || "gpt-4o-mini").trim();

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
  const panels = urlsToRetry.map((videoUrl, index) => ({
    videoUrl,
    panel: createProgressPanel(videoUrl, offset + index)
  }));

  const results = await Promise.allSettled(
    panels.map(({ videoUrl, panel }) => processVideo({ apiKey, model, videoUrl, panel }))
  );

  results.forEach((entry, index) => {
    if (entry.status === "rejected") {
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

  results.forEach((entry, index) => {
    if (entry.status === "fulfilled") {
      successful.push(entry.value);
    } else {
      failed += 1;
      panels[index].panel.setError(entry.reason?.message || "Something went wrong.");
    }
  });

  if (!successful.length) {
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
  statusEl.textContent = failed ? `Done (${successful.length} succeeded, ${failed} failed)` : `Done (${successful.length} succeeded)`;

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
