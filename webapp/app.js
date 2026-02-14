const el = (id) => document.getElementById(id);
const logEl = el("log");
const statusEl = el("statusSmall");
const pctEl = el("pct");
const pfill = el("pfill");
const s1 = el("s1");
const s2 = el("s2");
const s3 = el("s3");
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

function setProgress(stage, pct, note) {
  statusEl.textContent = stage || "";
  const pctNum = Math.max(0, Math.min(100, Math.round(pct || 0)));
  pctEl.textContent = `${pctNum}%`;
  pfill.style.width = `${pctNum}%`;
  if (note) appendLog(`${stage}: ${note}`);
  if (pctNum >= 25) s1.classList.add("fill");
  if (pctNum >= 55) s2.classList.add("fill");
  if (pctNum >= 85) s3.classList.add("fill");
}

function appendLog(line) {
  const div = document.createElement("div");
  div.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function resetUi() {
  logEl.innerHTML = "";
  statusEl.textContent = "Idle";
  pctEl.textContent = "0%";
  pfill.style.width = "0%";
  s1.classList.remove("fill");
  s2.classList.remove("fill");
  s3.classList.remove("fill");
  resultEl.value = "";
  copyBtn.disabled = true;
  copyStatus.textContent = "";
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

function startHeartbeat(label = "Working…") {
  let i = 0;
  return setInterval(() => {
    const pct = 69 + (i++ % 3);
    setProgress(label, pct, "still running");
  }, 10000);
}
function stopHeartbeat(timer) { if (timer) clearInterval(timer); }

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
  const videoUrl = el("videoUrl").value.trim();
  const model = el("model").value.trim() || "gpt-4o-mini";

  if (!apiKey) {
    inputErr.textContent = "Please enter your OpenAI API key.";
    return;
  }
  if (!videoUrl) {
    inputErr.textContent = "Please enter a YouTube video URL.";
    return;
  }

  localStorage.setItem(STORAGE_KEY, model);
  openVideo.href = videoUrl;

  try {
    setProgress("Fetching metadata + transcript", 12);
    const transcriptResult = await fetchTranscriptFromServer(videoUrl);
    const transcript = transcriptResult.transcript;
    const meta = transcriptResult.metadata;

    appendLog(`Transcript source: ${transcriptResult.source}`);
    appendLog(`Transcript lines: ${transcript.split("\n").length}`);

    setProgress("Cleaning transcript…", 38, "Preparing");
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
      let hb = startHeartbeat("Cleaning transcript…");
      try {
        try {
          fixedTranscript = await withTimeout((signal) => openaiText({ apiKey, model, messages: body.messages, signal }), 120000, "OpenAI (clean)");
        } catch {
          setProgress("Retrying clean…", 45);
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
        setProgress(chunkLabel, 38 + Math.round((i / chunks.length) * 25));
        appendLog(chunkLabel);
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
          setProgress(`Retrying chunk ${i + 1}/${chunks.length}`, 48 + Math.round((i / chunks.length) * 20));
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

    setProgress("Summarizing…", 70, "3–5 paragraph summary");
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
      let hb = startHeartbeat("Summarizing…");
      try {
        try {
          summary = await withTimeout((signal) => openaiText({ apiKey, model, messages: sumBody.messages, signal }), 120000, "OpenAI (summary)");
        } catch {
          setProgress("Retrying summary…", 74);
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

    setProgress("Saving note file…", 92);
    let saveResult = null;
    try {
      saveResult = await saveNoteToServer({
        markdown,
        videoTitle: meta.title
      });
      appendLog(`Saved note: ${saveResult.fileName}`);
    } catch (saveErr) {
      const reason = saveErr?.message || "Unknown save error";
      appendLog(`Note save failed: ${reason}`);
    }

    setProgress("Done", 100, "Note ready");
    resultEl.value = markdown;
    copyBtn.disabled = false;
    copyStatus.textContent = saveResult ? `Saved to ${saveResult.filePath}` : "Save failed (note still available in the UI).";
  } catch (err) {
    inputErr.textContent = err.message || "Something went wrong.";
    setProgress("Error", 100, err.message || "Failed");
  }
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
