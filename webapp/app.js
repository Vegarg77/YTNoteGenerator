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

function parseVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.split("/").filter(Boolean)[0] || null;
    }
    if (u.pathname.startsWith("/shorts/")) {
      return u.pathname.split("/")[2] || null;
    }
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

async function fetchVideoMeta(videoUrl) {
  try {
    const resp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
    if (!resp.ok) throw new Error("oEmbed failed");
    const data = await resp.json();
    return {
      title: data?.title || "",
      channel: data?.author_name || "",
      url: videoUrl
    };
  } catch (err) {
    appendLog(`Metadata lookup failed: ${err.message}`);
    return { title: "", channel: "", url: videoUrl };
  }
}

function extractTranscriptText(data) {
  if (!data) return "";
  const raw = Array.isArray(data) ? data : data.transcript || data.transcriptContent || data.body || null;
  if (Array.isArray(raw)) {
    return raw.map((entry) => entry.text || entry.transcript || "").join("\n");
  }
  if (typeof raw === "string") return raw;
  if (raw?.segments && Array.isArray(raw.segments)) {
    return raw.segments.map((entry) => entry.text || "").join("\n");
  }
  return "";
}

const TRANSCRIPT_PROXIES = [
  {
    name: "corsproxy.io",
    wrap: (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`
  },
  {
    name: "cors.isomorphic-git.org",
    wrap: (url) => `https://cors.isomorphic-git.org/${url}`
  },
  {
    name: "allorigins.win",
    wrap: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  }
];

async function fetchTextWithProxies(url, signal, label) {
  const errors = [];
  for (const proxy of TRANSCRIPT_PROXIES) {
    try {
      appendLog(`Fetching ${label} via ${proxy.name}`);
      const resp = await fetch(proxy.wrap(url), { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (err) {
      errors.push(`${proxy.name}: ${err.message}`);
    }
  }
  throw new Error(`All proxies failed for ${label}:\n${errors.join("\n")}`);
}

async function fetchJsonWithProxies(url, signal, label) {
  const text = await fetchTextWithProxies(url, signal, label);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON response for ${label}: ${err.message}`);
  }
}

function parseTranscriptXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  if (doc.getElementsByTagName("parsererror").length) return "";
  const nodes = Array.from(doc.getElementsByTagName("text"));
  return nodes.map((node) => (node.textContent || "").trim()).filter(Boolean).join("\n");
}

function extractJsonBlock(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;
  const braceStart = text.indexOf("{", markerIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") depth -= 1;
    if (depth === 0) return text.slice(braceStart, i + 1);
  }
  return null;
}

function extractPlayerResponse(html) {
  const jsonText = extractJsonBlock(html, "ytInitialPlayerResponse");
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    appendLog(`Failed to parse player response JSON: ${err.message}`);
    return null;
  }
}

function pickCaptionTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return (
    tracks.find((track) => track.languageCode?.startsWith("en")) ||
    tracks.find((track) => track.languageCode) ||
    tracks[0]
  );
}

function extractTranscriptFromJson3(data) {
  if (!data?.events) return "";
  return data.events
    .map((event) => (event.segs ? event.segs.map((seg) => seg.utf8 || "").join("") : ""))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

async function fetchTranscriptFromTrack(track, signal) {
  const baseUrl = track?.baseUrl;
  if (!baseUrl) throw new Error("Caption track missing baseUrl");
  const jsonUrl = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
  const data = await fetchJsonWithProxies(jsonUrl, signal, "caption track (json3)");
  let text = extractTranscriptFromJson3(data).trim();
  if (text) return text;
  const xmlText = await fetchTextWithProxies(baseUrl, signal, "caption track (xml)");
  text = parseTranscriptXml(xmlText).trim();
  if (!text) throw new Error("Caption track empty");
  return text;
}

async function fetchTranscriptFromPlayer(videoId, signal) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchTextWithProxies(watchUrl, signal, "YouTube watch page");
  const playerResponse = extractPlayerResponse(html);
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error("No caption tracks found on watch page");
  const track = pickCaptionTrack(tracks);
  appendLog(`Using caption track: ${track.languageCode || "unknown"} (${track.name?.simpleText || "auto"})`);
  return fetchTranscriptFromTrack(track, signal);
}

async function fetchTranscriptFromTimedText(videoId, signal) {
  const url = `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}`;
  const xml = await fetchTextWithProxies(url, signal, "timedtext (xml)");
  const text = parseTranscriptXml(xml).trim();
  if (!text) throw new Error("Timedtext transcript empty");
  return text;
}

async function fetchTranscript(videoId) {
  const sources = [
    {
      name: "YouTube watch page captions",
      get: (signal) => fetchTranscriptFromPlayer(videoId, signal)
    },
    {
      name: "YouTube timedtext",
      get: (signal) => fetchTranscriptFromTimedText(videoId, signal)
    }
  ];

  const errors = [];
  for (const source of sources) {
    try {
      appendLog(`Trying transcript source: ${source.name}`);
      const text = await withTimeout((signal) => source.get(signal), 20000, source.name);
      if (text) return text;
      throw new Error("Transcript empty");
    } catch (err) {
      errors.push(`${source.name}: ${err.message}`);
    }
  }
  throw new Error(`Transcript not found. Sources tried:\n${errors.join("\n")}`);
}

async function openaiChat({ apiKey, body, signal }) {
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
    throw new Error(`OpenAI error: ${resp.status} ${t}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

function startHeartbeat(label = "Working…") {
  let i = 0;
  return setInterval(() => {
    const pct = 69 + (i++ % 3);
    setProgress(label, pct, "still running");
  }, 10000);
}
function stopHeartbeat(timer) { if (timer) clearInterval(timer); }

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

  const videoId = parseVideoId(videoUrl);
  if (!videoId) {
    inputErr.textContent = "Could not parse the video ID. Please check the URL.";
    return;
  }

  localStorage.setItem(STORAGE_KEY, model);
  openVideo.href = videoUrl;

  try {
    setProgress("Fetching metadata + transcript", 12);
    const metaPromise = fetchVideoMeta(videoUrl);
    const transcriptPromise = fetchTranscript(videoId);
    const [meta, transcript] = await Promise.all([metaPromise, transcriptPromise]);

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
          fixedTranscript = await withTimeout((signal) => openaiChat({ apiKey, body, signal }), 120000, "OpenAI (clean)");
        } catch {
          setProgress("Retrying clean…", 45);
          fixedTranscript = await withTimeout((signal) => openaiChat({ apiKey, body, signal }), 120000, "OpenAI (clean retry)");
        }
      } finally {
        stopHeartbeat(hb);
      }
      fixedTranscript = fixedTranscript.trim();
    } else {
      const chunks = splitIntoChunks(transcript, 12000);
      const out = [];
      for (let i = 0; i < chunks.length; i += 1) {
        setProgress(`Cleaning chunk ${i + 1}/${chunks.length}`, 38 + Math.round((i / chunks.length) * 25));
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
        let hb = startHeartbeat(`Cleaning chunk ${i + 1}/${chunks.length}`);
        try {
          let cleaned;
          try {
            cleaned = await withTimeout((signal) => openaiChat({ apiKey, body, signal }), 120000, `OpenAI (clean chunk ${i + 1})`);
          } catch {
            setProgress(`Retrying chunk ${i + 1}/${chunks.length}`, 48 + Math.round((i / chunks.length) * 20));
            cleaned = await withTimeout(
              (signal) => openaiChat({ apiKey, body, signal }),
              120000,
              `OpenAI (clean chunk ${i + 1} retry)`
            );
          }
          out.push((cleaned || "").trim());
        } finally {
          stopHeartbeat(hb);
        }
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
          summary = await withTimeout((signal) => openaiChat({ apiKey, body: sumBody, signal }), 120000, "OpenAI (summary)");
        } catch {
          setProgress("Retrying summary…", 74);
          summary = await withTimeout((signal) => openaiChat({ apiKey, body: sumBody, signal }), 120000, "OpenAI (summary retry)");
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
      videoUrl: meta.url
    });

    setProgress("Done", 100, "Note ready");
    resultEl.value = markdown;
    copyBtn.disabled = false;
  } catch (err) {
    inputErr.textContent = err.message || "Something went wrong.";
    setProgress("Error", 100, err.message || "Failed");
  }
}

copyBtn.addEventListener("click", async () => {
  if (!resultEl.value) return;
  try {
    await navigator.clipboard.writeText(resultEl.value);
    copyStatus.textContent = "Copied to clipboard.";
  } catch (err) {
    copyStatus.textContent = `Copy failed: ${err.message}`;
  }
});

el("run").addEventListener("click", run);

window.addEventListener("load", () => {
  const savedModel = localStorage.getItem(STORAGE_KEY);
  if (savedModel) el("model").value = savedModel;
});
