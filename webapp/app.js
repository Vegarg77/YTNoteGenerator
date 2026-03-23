const el = (id) => document.getElementById(id);
const statusEl = el("statusSmall");
const progressContainer = el("progressContainer");
const resultEl = el("result");
const copyBtn = el("copy");
const openSource = el("openSource");
const inputErr = el("inputErr");
const copyStatus = el("copyStatus");

const STORAGE_KEY = "yt_obsidian_webapp_model";
const WIKI_STORAGE_KEY = "yt_obsidian_webapp_wiki_model";

const selectedWikiTerms = [];
const selectedWikiBusinesses = [];
let wikiTermSuggestionTimer = null;
let wikiBusinessSuggestionTimer = null;
let wikiTermSuggestionRequestId = 0;
let wikiBusinessSuggestionRequestId = 0;
let activeTab = "youtube";

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }
function nowDateTimeStrings() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return { date, time };
}

function buildVideoNoteMarkdown({ date, time, channel, summary, fixedTranscript, videoUrl }) {
  return [
    `#### ${date}  ${time}`,
    "",
    `###### Channel: ${channel || ""}`,
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
    "#VN"
  ].join("\n");
}

function buildDictionaryMarkdown({ date, title, structuredContent, sourceUrl }) {
  const body = (structuredContent || "").trim();

  return [
    "---",
    "aliases: []",
    "---",
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

function buildBusinessMarkdown({ date, time, title, foundedBy, foundedOn, headquarters, summary, offerings, sourceUrl }) {
  const cleanOfferings = Array.isArray(offerings) ? offerings.filter(Boolean) : [];
  const offeringsLines = cleanOfferings.length ? cleanOfferings.map((item) => `- ${item}`) : ["- N/A"];

  return [
    `#### ${date}  ${time}`,
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
      <h3>Item ${index + 1}</h3>
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
  const status = card.querySelector(".status-text");
  const pct = card.querySelector(".pct-text");
  const pfill = card.querySelector(".progress-fill");
  const steps = Array.from(card.querySelectorAll(".step"));
  const log = card.querySelector(".log");

  const api = {
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

async function fetchWikipediaPage(term) {
  const resp = await fetch(`/api/wikipedia-page?title=${encodeURIComponent(term)}`);
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

async function openaiChatCompletions({ apiKey, body, signal }) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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
    throw new Error(`OpenAI chat error: ${resp.status} ${t}`);
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

async function openaiResponses({ apiKey, body, signal }) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
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
  const isGpt5Family = /^gpt-5/i.test(model || "");

  if (isGpt5Family) {
    return openaiResponses({
      apiKey,
      signal,
      body: {
        model,
        input: messages
      }
    });
  }

  return openaiChatCompletions({
    apiKey,
    signal,
    body: {
      model,
      temperature,
      messages
    }
  });
}

function startHeartbeat(panel, label = "Working…") {
  let i = 0;
  return setInterval(() => {
    const pct = 69 + (i++ % 3);
    panel.setProgress(label, pct, "still running");
  }, 10000);
}

function stopHeartbeat(timer) {
  if (timer) clearInterval(timer);
}

async function processVideo({ apiKey, model, videoUrl, panel }) {
  panel.setProgress("Fetching metadata + transcript", 12);
  const transcriptResult = await fetchTranscriptFromServer(videoUrl);
  const transcript = transcriptResult.transcript;
  const meta = transcriptResult.metadata;

  panel.appendLog(`Transcript source: ${transcriptResult.source}`);
  panel.appendLog(`Transcript lines: ${transcript.split("\n").length}`);

  panel.setProgress("Cleaning transcript…", 38, "Preparing");
  let fixedTranscript = "";
  if (transcript.length <= 12000) {
    const cleanMessages = [
      { role: "system", content: "You are a precise transcription editor." },
      {
        role: "user",
        content:
          "Clean the following transcript. If any part is not in English, translate it to clear natural English while preserving the original meaning and tone. Fix punctuation, capitalization, and homophones; remove non-speech tags like [Music]/[Applause] unless meaningful. No timestamps. Output ONLY clean Markdown paragraphs in English.\n\nTRANSCRIPT:\n" +
          transcript
      }
    ];
    const hb = startHeartbeat(panel, "Cleaning transcript…");
    try {
      try {
        fixedTranscript = await withTimeout((signal) => openaiText({ apiKey, model, messages: cleanMessages, temperature: 0.1, signal }), 120000, "OpenAI (clean)");
      } catch {
        panel.setProgress("Retrying clean…", 45);
        fixedTranscript = await withTimeout((signal) => openaiText({ apiKey, model, messages: cleanMessages, temperature: 0.1, signal }), 120000, "OpenAI (clean retry)");
      }
    } finally {
      stopHeartbeat(hb);
    }
    fixedTranscript = fixedTranscript.trim();
  } else {
    const chunks = splitIntoChunks(transcript, 12000);
    const out = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunkLabel = `Cleaning chunk ${i + 1}/${chunks.length}`;
      panel.setProgress(chunkLabel, 38 + Math.round((i / chunks.length) * 25));
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
        panel.setProgress(`Retrying chunk ${i + 1}/${chunks.length}`, 48 + Math.round((i / chunks.length) * 20));
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

  panel.setProgress("Summarizing…", 70, "3–5 paragraph summary");
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
    const hb = startHeartbeat(panel, "Summarizing…");
    try {
      try {
        summary = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.2, signal }), 120000, "OpenAI (summary)");
      } catch {
        panel.setProgress("Retrying summary…", 74);
        summary = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.2, signal }), 120000, "OpenAI (summary retry)");
      }
    } finally {
      stopHeartbeat(hb);
    }
  }
  summary = (summary || "").trim();

  const { date, time } = nowDateTimeStrings();
  const markdown = buildVideoNoteMarkdown({
    date,
    time,
    channel: meta.channel,
    summary,
    fixedTranscript,
    videoUrl: meta.url || videoUrl
  });

  panel.setProgress("Saving note file…", 92);
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

async function processWikipediaTerm({ apiKey, model, term, panel }) {
  panel.setProgress("Loading Wikipedia article", 15);
  const wikiData = await fetchWikipediaPage(term);
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

  const hb = startHeartbeat(panel, "Summarizing article");
  let structuredContent = "";
  try {
    structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 120000, "OpenAI (wikipedia summary)");
  } finally {
    stopHeartbeat(hb);
  }

  const { date } = nowDateTimeStrings();
  const markdown = buildDictionaryMarkdown({
    date,
    title: articleTitle,
    structuredContent: normalizeDictionaryContent(structuredContent),
    sourceUrl: articleUrl
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

async function processWikipediaBusiness({ apiKey, model, term, panel }) {
  panel.setProgress("Loading Wikipedia article", 15);
  const wikiData = await fetchWikipediaPage(term);
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

  const hb = startHeartbeat(panel, "Summarizing article");
  let structuredContent = "";
  try {
    structuredContent = await withTimeout((signal) => openaiText({ apiKey, model, messages: summaryMessages, temperature: 0.1, signal }), 120000, "OpenAI (wikipedia business summary)");
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
    sourceUrl: articleUrl
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

  selectedWikiTerms.forEach((term) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = term;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove ${term}`);
    removeBtn.addEventListener("click", () => {
      const idx = selectedWikiTerms.indexOf(term);
      if (idx >= 0) selectedWikiTerms.splice(idx, 1);
      renderSelectedWikiTerms();
    });

    chip.appendChild(removeBtn);
    holder.appendChild(chip);
  });
}

function addWikiTerm(term) {
  const normalized = (term || "").trim();
  if (!normalized) return;
  if (selectedWikiTerms.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) return;
  selectedWikiTerms.push(normalized);
  renderSelectedWikiTerms();
}

function renderSelectedWikiBusinesses() {
  const holder = el("wikiSelectedBusinesses");
  holder.innerHTML = "";

  selectedWikiBusinesses.forEach((term) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = term;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "chip-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove ${term}`);
    removeBtn.addEventListener("click", () => {
      const idx = selectedWikiBusinesses.indexOf(term);
      if (idx >= 0) selectedWikiBusinesses.splice(idx, 1);
      renderSelectedWikiBusinesses();
    });

    chip.appendChild(removeBtn);
    holder.appendChild(chip);
  });
}

function addWikiBusiness(term) {
  const normalized = (term || "").trim();
  if (!normalized) return;
  if (selectedWikiBusinesses.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) return;
  selectedWikiBusinesses.push(normalized);
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
    btn.innerHTML = `
      <div class="suggestion-title">${suggestion.title}</div>
      <div class="suggestion-description">${suggestion.description || "Wikipedia article"}</div>
    `;
    btn.addEventListener("click", () => {
      if (isBusiness) {
        addWikiBusiness(suggestion.title);
        el("wikiBusinessInput").value = "";
        el("wikiBusinessInput").focus();
        clearWikiSuggestions("business");
      } else {
        addWikiTerm(suggestion.title);
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

async function runYoutube() {
  inputErr.textContent = "";

  const apiKey = el("apiKey").value.trim();
  const videoUrlsRaw = el("videoUrl").value;
  const model = el("model").value.trim() || "gpt-4o-mini";
  const videoUrls = parseVideoUrls(videoUrlsRaw);

  el("videoUrl").value = "";

  if (!apiKey) {
    inputErr.textContent = "Please enter your OpenAI API key.";
    return;
  }

  if (!videoUrls.length) {
    inputErr.textContent = "Please enter at least one YouTube video URL.";
    return;
  }

  localStorage.setItem(STORAGE_KEY, model);
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

  finalizeRunResults(results, panels, "video");
}

async function runWikipedia() {
  inputErr.textContent = "";

  const apiKey = el("wikiApiKey").value.trim();
  const model = el("wikiModel").value.trim() || "gpt-4o-mini";
  const terms = [...selectedWikiTerms];
  const businesses = [...selectedWikiBusinesses];

  if (!apiKey) {
    inputErr.textContent = "Please enter your OpenAI API key.";
    return;
  }

  if (!terms.length && !businesses.length) {
    inputErr.textContent = "Please add at least one Wikipedia term or business/organization.";
    return;
  }

  localStorage.setItem(WIKI_STORAGE_KEY, model);
  const totalCount = terms.length + businesses.length;
  statusEl.textContent = `Running ${totalCount} item${totalCount === 1 ? "" : "s"}`;
  const firstLabel = terms[0] || businesses[0] || "Wikipedia";
  openSource.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(firstLabel.replace(/\s+/g, "_"))}`;

  const workItems = [
    ...terms.map((term) => ({ term, itemType: "dictionary" })),
    ...businesses.map((term) => ({ term, itemType: "business" }))
  ];

  const offset = progressContainer.children.length;
  const panels = workItems.map(({ term }, index) => ({
    term,
    panel: createProgressPanel(term, offset + index)
  }));

  const results = await Promise.allSettled(
    workItems.map(({ term, itemType }, index) => {
      const panel = panels[index].panel;
      return itemType === "business"
        ? processWikipediaBusiness({ apiKey, model, term, panel })
        : processWikipediaTerm({ apiKey, model, term, panel });
    })
  );

  finalizeRunResults(results, panels, "wiki");
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
el("runWikipedia").addEventListener("click", runWikipedia);

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

window.addEventListener("load", () => {
  const savedModel = localStorage.getItem(STORAGE_KEY);
  const savedWikiModel = localStorage.getItem(WIKI_STORAGE_KEY);
  if (savedModel) el("model").value = savedModel;
  if (savedWikiModel) el("wikiModel").value = savedWikiModel;
  setActiveTab(activeTab);
});
