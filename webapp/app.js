const el = (id) => document.getElementById(id);
const statusEl = el("statusSmall");
const progressContainer = el("progressContainer");
const resultEl = el("result");
const copyBtn = el("copy");
const openVideo = el("openVideo");
const inputErr = el("inputErr");
const copyStatus = el("copyStatus");

const STORAGE_KEY = "yt_obsidian_webapp_model";

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }
function nowDateTimeStrings() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return { date, time };
}

function buildNoteMarkdown({ date, time, channel, summary, fixedTranscript, videoUrl }) {
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

function createProgressPanel(videoUrl, index) {
  const card = document.createElement("article");
  card.className = "panel video-progress-card";
  card.innerHTML = `
    <div class="panel-header">
      <h3>Video ${index + 1}</h3>
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

  const videoUrlEl = document.createElement("p");
  videoUrlEl.className = "muted video-url";
  videoUrlEl.title = videoUrl;
  videoUrlEl.textContent = videoUrl;
  const stepperEl = card.querySelector(".stepper");
  card.insertBefore(videoUrlEl, stepperEl);

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
  openVideo.href = "#";
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

async function saveNoteToServer({ markdown, videoTitle }) {
  const resp = await fetch("/api/save-note", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ markdown, videoTitle })
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

async function openaiText({ apiKey, model, messages, signal }) {
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
    const body = {
      model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "You are a precise transcription editor." },
        {
          role: "user",
          content:
            "Clean the following transcript. Fix punctuation, capitalization, and homophones; remove non-speech tags like [Music]/[Applause] unless meaningful. No timestamps. Output ONLY clean Markdown paragraphs.\n\nTRANSCRIPT:\n" +
            transcript
        }
      ]
    };
    const hb = startHeartbeat(panel, "Cleaning transcript…");
    try {
      try {
        fixedTranscript = await withTimeout((signal) => openaiText({ apiKey, model, messages: body.messages, signal }), 120000, "OpenAI (clean)");
      } catch {
        panel.setProgress("Retrying clean…", 45);
        fixedTranscript = await withTimeout((signal) => openaiText({ apiKey, model, messages: body.messages, signal }), 120000, "OpenAI (clean retry)");
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
      const body = {
        model,
        temperature: 0.1,
        messages: [
          { role: "system", content: "You are a precise transcription editor." },
          {
            role: "user",
            content:
              `You will clean a chunk of a transcript (part ${i + 1} of ${chunks.length}). Fix punctuation, capitalization, homophones; remove non-speech tags like [Music]/[Applause] unless meaningful. No timestamps. Output ONLY clean Markdown paragraphs.\n\nCHUNK_TEXT:\n` +
              chunks[i]
          }
        ]
      };
      let cleaned;
      try {
        cleaned = await withTimeout((signal) => openaiText({ apiKey, model, messages: body.messages, signal }), 120000, `OpenAI (clean chunk ${i + 1})`);
      } catch {
        panel.setProgress(`Retrying chunk ${i + 1}/${chunks.length}`, 48 + Math.round((i / chunks.length) * 20));
        cleaned = await withTimeout(
          (signal) => openaiText({ apiKey, model, messages: body.messages, signal }),
          120000,
          `OpenAI (clean chunk ${i + 1} retry)`
        );
      }
      out.push((cleaned || "").trim());
    }
    fixedTranscript = out.join("\n\n");
  }

  panel.setProgress("Summarizing…", 70, "3–5 paragraph summary");
  const sumBody = {
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are an expert at writing structured, detailed summaries." },
      {
        role: "user",
        content:
          `Write a detailed summary (3–5 paragraphs; each 3–6 sentences) of the transcript below. Use concise, readable Markdown. No timestamps.\n\nVideo Title: ${meta.title || ""}\nChannel: ${meta.channel || ""}\n\nTRANSCRIPT:\n` +
          fixedTranscript.slice(0, 180000)
      }
    ]
  };

  let summary = "";
  {
    const hb = startHeartbeat(panel, "Summarizing…");
    try {
      try {
        summary = await withTimeout((signal) => openaiText({ apiKey, model, messages: sumBody.messages, signal }), 120000, "OpenAI (summary)");
      } catch {
        panel.setProgress("Retrying summary…", 74);
        summary = await withTimeout((signal) => openaiText({ apiKey, model, messages: sumBody.messages, signal }), 120000, "OpenAI (summary retry)");
      }
    } finally {
      stopHeartbeat(hb);
    }
  }
  summary = (summary || "").trim();

  const { date, time } = nowDateTimeStrings();
  const markdown = buildNoteMarkdown({
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
      videoTitle: meta.title
    });
    panel.appendLog(`Saved note: ${saveResult.fileName}`);
  } catch (saveErr) {
    const reason = saveErr?.message || "Unknown save error";
    panel.appendLog(`Note save failed: ${reason}`);
  }

  panel.setProgress("Done", 100, "Note ready");
  return { markdown, videoUrl: meta.url || videoUrl, saveResult, title: meta.title };
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

async function run() {
  inputErr.textContent = "";
  resetUi();

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
  openVideo.href = videoUrls[0];
  statusEl.textContent = `Running ${videoUrls.length} video${videoUrls.length === 1 ? "" : "s"}`;

  const panels = videoUrls.map((videoUrl, index) => ({
    videoUrl,
    panel: createProgressPanel(videoUrl, index)
  }));

  const results = await Promise.allSettled(
    panels.map(({ videoUrl, panel }) => processVideo({ apiKey, model, videoUrl, panel }))
  );

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
    inputErr.textContent = "All videos failed. Check the progress panels for details.";
    statusEl.textContent = "Done (with errors)";
    return;
  }

  const output = successful
    .map((item, idx) => `# Video ${idx + 1}: ${item.title || item.videoUrl}\n\n${item.markdown}`)
    .join("\n\n---\n\n");

  resultEl.value = output;
  copyBtn.disabled = false;
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

el("run").addEventListener("click", run);

window.addEventListener("load", () => {
  const savedModel = localStorage.getItem(STORAGE_KEY);
  if (savedModel) el("model").value = savedModel;
});
