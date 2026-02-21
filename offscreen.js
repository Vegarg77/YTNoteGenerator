// Handshake: answer ping + announce ready
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'OFFSCREEN_PING') {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_PONG' });
  }
});
try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }); } catch {}

// NOTE: Badge spinner is now managed centrally by the Service Worker to avoid conflicts.

// Small utils
function pad2(n){ return n < 10 ? "0"+n : ""+n; }
function nowDateTimeStrings() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return { date, time };
}
function buildNoteMarkdown({ date, time, channel, summary, fixedTranscript, videoUrl }) {
  return [
    `#### ${date}  ${time}`, "",
    `###### Channel: ${channel || ""}`, "",
    "## Summary:", "", (summary || ""), "",
    "## Transcript:", "", (fixedTranscript || ""), "",
    "### Video Link:", "", (videoUrl || ""), "",
    "#VN"
  ].join("\n");
}
function splitIntoChunks(text, maxLen = 12000) {
  const chunks = []; let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    const slice = text.slice(i, end);
    const lastBreak = slice.lastIndexOf("\n\n");
    if (end < text.length && lastBreak > maxLen * 0.6) end = i + lastBreak + 2;
    chunks.push(text.slice(i, end)); i = end;
  }
  return chunks;
}
function withTimeout(promiseFactory, ms, label="operation") {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  return promiseFactory(ctrl.signal)
    .finally(()=>clearTimeout(t))
    .catch(err=>{
      if (err?.name === 'AbortError') throw new Error(`${label} timed out after ${ms}ms`);
      throw err;
    });
}

// ---- Messaging helpers back to SW
function progress(stage, pct, note) { chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROGRESS', stage, pct, note }); }
function done(payload, jobId) { chrome.runtime.sendMessage({ type: 'OFFSCREEN_DONE', payload, jobId }); }
function fail(error, jobId) { chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: String(error), jobId }); }
function ack(jobId) { chrome.runtime.sendMessage({ type: 'OFFSCREEN_ACK', jobId }); }

// ---- RPC to Service Worker for the YouTube scrape (via content script) ----
function swScrape(tabId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'REQ_SCRAPE', tabId }, (resp) => {
      const le = chrome.runtime.lastError;
      if (le) {
        reject(new Error(le.message || "Scrape request failed"));
        return;
      }
      if (!resp || resp.ok === false) {
        reject(new Error(resp?.error || "Scrape failed"));
      } else {
        resolve(resp.data);
      }
    });
  });
}

// ---- OpenAI helper
async function openaiChat({ apiKey, body, signal }) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
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

// ---- Heartbeat while a long call is in-flight (10s interval)
function startHeartbeat(label = "Working…") {
  let i = 0;
  return setInterval(() => {
    const pct = 69 + ((i++) % 3); // keep around 70% to avoid battling staged updates
    progress(label, pct, "still running");
  }, 10000); // 10 seconds
}
function stopHeartbeat(timer) {
  if (timer) clearInterval(timer);
}

// ---- Main runner (end-to-end in offscreen)
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg?.type !== 'OFFSCREEN_RUN') return;

  const jobId = msg.jobId || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_ACK', jobId }); } catch {}

  (async () => {
    try {
      const apiKey = (msg.apiKey || '').trim();
      if (!apiKey) throw new Error("Missing API key.");
      const chosenModel = msg.model || "gpt-4o-mini";

      // 1) Scrape YT (via SW -> content script)
      progress("Fetching title, channel, URL, transcript", 12);
      const { title, channel, url, transcript } = await swScrape(msg.tabId);

      // 2) Clean transcript (single or chunked) with timeouts + retry + heartbeat
      let fixedTranscript = "";
      if (transcript.length <= 12000) {
        progress("Cleaning transcript…", 40, "Single-pass");
        const body = {
          model: chosenModel,
          temperature: 0.1,
          messages: [
            { role: "system", content: "You are a precise transcription editor." },
            { role: "user", content:
              "Clean the following transcript. If any part is not in English, translate it to clear natural English while preserving the original meaning and tone. Fix punctuation, capitalization, and homophones; remove non-speech tags like [Music]/[Applause] unless meaningful. No timestamps. Output ONLY clean Markdown paragraphs in English.\n\nTRANSCRIPT:\n" +
              transcript }
          ]
        };
        let hb = startHeartbeat("Cleaning transcript…");
        try {
          try {
            fixedTranscript = await withTimeout((signal)=>openaiChat({ apiKey, body, signal }), 120000, "OpenAI (clean)");
          } catch (_) {
            progress("Retrying clean…", 45);
            fixedTranscript = await withTimeout((signal)=>openaiChat({ apiKey, body, signal }), 120000, "OpenAI (clean retry)");
          }
        } finally { stopHeartbeat(hb); }
        fixedTranscript = fixedTranscript.trim();
      } else {
        const chunks = splitIntoChunks(transcript, 12000);
        progress(`Cleaning transcript (0/${chunks.length})`, 38);
        const out = [];
        for (let i=0;i<chunks.length;i++) {
          progress(`Cleaning chunk ${i+1}/${chunks.length}`, 38 + Math.round((i/chunks.length)*25));
          const body = {
            model: chosenModel,
            temperature: 0.1,
            messages: [
              { role: "system", content: "You are a precise transcription editor." },
              { role: "user", content:
                `You will clean a chunk of a transcript (part ${i+1} of ${chunks.length}). If any part is not in English, translate it to clear natural English while preserving the original meaning and tone. Fix punctuation, capitalization, homophones; remove non-speech tags like [Music]/[Applause] unless meaningful. No timestamps. Output ONLY clean Markdown paragraphs in English.\n\nCHUNK_TEXT:\n` +
                chunks[i] }
            ]
          };
          let cleaned;
          try {
            cleaned = await withTimeout((signal)=>openaiChat({ apiKey, body, signal }), 120000, `OpenAI (clean chunk ${i+1})`);
          } catch (_) {
            progress(`Retrying chunk ${i+1}/${chunks.length}`, 48 + Math.round((i/chunks.length)*20));
            cleaned = await withTimeout((signal)=>openaiChat({ apiKey, body, signal }), 120000, `OpenAI (clean chunk ${i+1} retry)`);
          }
          out.push((cleaned || "").trim());
        }
        fixedTranscript = out.join("\n\n");
      }

      // 3) Summarize (with timeout + retry + 10s heartbeat)
      progress("Summarizing…", 70, "3–5 paragraph summary");
      const sumBody = {
        model: chosenModel,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are an expert at writing structured, detailed summaries." },
          { role: "user", content:
            `Write a detailed summary (3–5 paragraphs; each 3–6 sentences) of the transcript below. Use concise, readable Markdown. No timestamps.\n\nVideo Title: ${title || ''}\nChannel: ${channel || ''}\n\nTRANSCRIPT:\n` +
            fixedTranscript.slice(0, 90000) }
        ]
      };
      let summary = "";
      {
        let hb = startHeartbeat("Summarizing…");
        try {
          try {
            summary = await withTimeout((signal)=>openaiChat({ apiKey, body: sumBody, signal }), 120000, "OpenAI (summary)");
          } catch (_) {
            progress("Retrying summary…", 74);
            summary = await withTimeout((signal)=>openaiChat({ apiKey, body: sumBody, signal }), 120000, "OpenAI (summary retry)");
          }
        } finally { stopHeartbeat(hb); }
      }
      summary = (summary || "").trim();

      // 4) Assemble + report back to SW
      const { date, time } = nowDateTimeStrings();
      const markdown = buildNoteMarkdown({ date, time, channel, summary, fixedTranscript, videoUrl: url });
      const payload = { ts: Date.now(), title, channel, url, date, time, markdown };
      done(payload, jobId);
    } catch (e) {
      fail(e.message || String(e), jobId);
    }
  })();
});
