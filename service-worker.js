// ---------- Progress Port Handling ----------
let popupPort = null;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    popupPort = port;
    port.onDisconnect.addListener(() => { if (popupPort === port) popupPort = null; });
  }
});
function report(stage, pct, note) { try { if (popupPort) popupPort.postMessage({ type: "PROGRESS", stage, pct, note }); } catch {} }
function reportDone(markdown) { try { if (popupPort) popupPort.postMessage({ type: "DONE", markdown }); } catch {} }
function reportError(err) { try { if (popupPort) popupPort.postMessage({ type: "ERROR", error: String(err) }); } catch {} }

// ---------- Badge spinner (managed centrally in SW for ALL runs) ----------
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let swSpinnerTimer = null;
function startSpinnerSW() {
  if (swSpinnerTimer) return; // already spinning
  try { chrome.action.setBadgeBackgroundColor({ color: '#38bdf8' }); } catch {}
  let i = 0;
  swSpinnerTimer = setInterval(() => {
    try { chrome.action.setBadgeText({ text: SPINNER_FRAMES[i] }); } catch {}
    i = (i + 1) % SPINNER_FRAMES.length;
  }, 120);
}
function stopSpinnerSW() {
  if (swSpinnerTimer) clearInterval(swSpinnerTimer);
  swSpinnerTimer = null;
  try { chrome.action.setBadgeText({ text: '' }); } catch {}
}

// ---------- Small utils ----------
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
  return promiseFactory(ctrl.signal).finally(()=>clearTimeout(t)).catch(err=>{
    if (err?.name === 'AbortError') throw new Error(`${label} timed out after ${ms}ms`);
    throw err;
  });
}

// ---------- Notifications (background completion) ----------
function notifyDone(titleText) {
  chrome.notifications.create({
    type: "basic",
    title: "YT → Obsidian: Note Ready",
    message: titleText ? `“${titleText}” is ready. Click to open & copy.` : "Your note is ready. Click to open & copy.",
    requireInteraction: true,
    priority: 2
  });
}
chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("result.html") });
});

// ---------- Offscreen existence check (prefer API, fallback to Clients API) ----------
async function offscreenExists(urlPath = 'offscreen.html') {
  try {
    if (chrome.offscreen?.hasDocument) {
      return await chrome.offscreen.hasDocument?.();
    }
  } catch {}
  try {
    const offscreenUrl = chrome.runtime.getURL(urlPath);
    const matched = await self.clients.matchAll();
    return matched.some(c => c.url === offscreenUrl);
  } catch { return false; }
}

// ---------- Offscreen management + handshake/ACK ----------
async function ensureOffscreen() {
  if (!chrome.offscreen?.createDocument) throw new Error("Offscreen API not available in this browser.");
  const exists = await offscreenExists('offscreen.html');
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['IFRAME_SCRIPTING'],
      justification: 'Long-running processing and action-badge animation while popup is closed.'
    });
  }

  report("Starting…", 3, "Waiting for offscreen readiness");
  const gotPong = await new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 4000);
    const listener = (msg) => {
      if (msg?.type === 'OFFSCREEN_PONG' || msg?.type === 'OFFSCREEN_READY') {
        if (!settled) {
          settled = true; clearTimeout(timeout); chrome.runtime.onMessage.removeListener(listener);
          resolve(true);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' });
  });
  if (!gotPong) throw new Error("Offscreen did not respond to handshake.");
}
async function closeOffscreenSafely() {
  try {
    const exists = await offscreenExists('offscreen.html');
    if (!exists) return;
    await chrome.offscreen.closeDocument();
  } catch (_) {}
}

// ---------- Receive messages from Offscreen and forward to popup/UI ----------
const jobState = new Map(); // jobId -> { acked, ackReported, fallbackStarted, tabId, apiKey, model }
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg?.type === 'OFFSCREEN_PROGRESS') {
    report(msg.stage || 'Working…', msg.pct ?? 0, msg.note || '');
  }
  if (msg?.type === 'OFFSCREEN_ACK' && msg.jobId) {
    const s = jobState.get(msg.jobId) || {};
    s.acked = true; jobState.set(msg.jobId, s);
    if (!s.ackReported) {
      s.ackReported = true; jobState.set(msg.jobId, s);
      report("Offscreen ACK’d, running…", 8);
    }
  }
  if (msg?.type === 'OFFSCREEN_DONE') {
    chrome.storage.local.set({ lastResult: msg.payload }).catch(()=>{});
    reportDone(msg.payload?.markdown || '');
    notifyDone(msg.payload?.title || '');
    stopSpinnerSW(); // <- ensure spinner stops on success
    closeOffscreenSafely();
  }
  if (msg?.type === 'OFFSCREEN_ERROR') {
    reportError(msg.error || 'Unknown error');
    stopSpinnerSW(); // <- ensure spinner stops on error
    if (msg.jobId) {
      const s = jobState.get(msg.jobId) || {};
      if (!s.fallbackStarted) {
        s.fallbackStarted = true; jobState.set(msg.jobId, s);
        report("Offscreen error → switching to fallback", 9, msg.error || "");
        runInServiceWorker(s.tabId, s.apiKey, s.model); // fallback path restarts spinner below if needed
      }
    }
    closeOffscreenSafely();
  }
});

// ---------- Content-script scraping (with robust auto-inject + retry) ----------
async function waitTabInteractive(tabId, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
}

async function trySendToCS(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'CS_SCRAPE' }, (resp) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(le.message));
        if (!resp || resp.ok === false) return reject(new Error(resp?.error || "Content script did not respond"));
        resolve(resp.data);
      });
    } catch (e) { reject(e); }
  });
}

async function ensureCSInjected(tabId) {
  if (!chrome.scripting?.executeScript) {
    throw new Error("chrome.scripting API unavailable in Service Worker.");
  }
  report("Injecting content script…", 16);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["contentScript.js"]
  });
  await new Promise(r => setTimeout(r, 100));
}

async function scrapeViaContentScript(tabId) {
  report("Fetching title, channel, URL, transcript", 15);
  await waitTabInteractive(tabId, 6000);
  try {
    return await withTimeout(() => trySendToCS(tabId), 12000, "Content script scrape");
  } catch (e1) {
    const msg = String(e1 || "");
    if (msg.includes("Receiving end does not exist")) {
      report("Injecting content script…", 16, "No receiver; injecting then retrying");
      await ensureCSInjected(tabId);
      return await withTimeout(() => trySendToCS(tabId), 12000, "Content script scrape (after inject)");
    }
    throw e1;
  }
}

// RPC endpoint for offscreen to ask SW to scrape (which uses the content script)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'REQ_SCRAPE' && typeof msg.tabId === 'number') {
    (async () => {
      try {
        const data = await scrapeViaContentScript(msg.tabId);
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }
});

// ---------- OpenAI helpers ----------
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
async function cleanAll({ apiKey, model, transcript, signal }) {
  const body = {
    model: model || "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: "You are a precise transcription editor." },
      { role: "user", content:
        "Clean the following transcript. Fix punctuation, capitalization, and homophones; remove non-speech tags like [Music]/[Applause] unless meaningful. No timestamps. Output ONLY clean Markdown paragraphs.\n\nTRANSCRIPT:\n" +
        transcript }
    ]
  };
  return (await openaiChat({ apiKey, body, signal })).trim();
}
async function cleanChunk({ apiKey, model, chunk, idx, total, signal }) {
  const body = {
    model: model || "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: "You are a precise transcription editor." },
      { role: "user", content:
        `You will clean a chunk of a transcript (part ${idx+1} of ${total}). Fix punctuation, capitalization, homophones; remove non-speech tags like [Music]/[Applause] unless meaningful. No timestamps. Output ONLY clean Markdown paragraphs.\n\nCHUNK_TEXT:\n` +
        chunk }
    ]
  };
  return (await openaiChat({ apiKey, body, signal })).trim();
}
async function summarize({ apiKey, model, cleanedTranscript, channel, title, signal }) {
  const body = {
    model: model || "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are an expert at writing structured, detailed summaries." },
      { role: "user", content:
        `Write a detailed summary (3–5 paragraphs; each 3–6 sentences) of the transcript below. Use concise, readable Markdown. No timestamps.\n\nVideo Title: ${title || ''}\nChannel: ${channel || ''}\n\nTRANSCRIPT:\n` +
        cleanedTranscript.slice(0, 90000) }
    ]
  };
  return (await openaiChat({ apiKey, body, signal })).trim();
}

// ---------- SW fallback runner ----------
async function runInServiceWorker(tabId, apiKey, modelFromSW) {
  startSpinnerSW(); // ensure spinner even in fallback
  try {
    const stored = (await (chrome.storage?.local?.get?.(["model"]) || Promise.resolve({}))) || {};
    const chosenModel = modelFromSW || stored.model || "gpt-4o-mini";

    // 1) Scrape YT
    report("Scraping YouTube…", 18);
    const { title, channel, url, transcript } = await scrapeViaContentScript(tabId);

    // Keep-alive heartbeat during long steps (every 10s)
    let hbTimer = null;
    function startHB(label){
      if (hbTimer) clearInterval(hbTimer);
      let i = 0; hbTimer = setInterval(()=>{ report(label, 69 + ((i++)%3), 'still running'); }, 10000);
    }
    function stopHB(){ if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }

    // 2) Clean transcript (single or chunked)
    let fixedTranscript = "";
    if (transcript.length <= 12000) {
      report("Cleaning transcript…", 40, "Single-pass");
      startHB('Cleaning transcript…');
      try {
        try {
          fixedTranscript = await withTimeout(
            (signal)=>cleanAll({ apiKey, model: chosenModel, transcript, signal }),
            120000, "OpenAI (clean)"
          );
        } catch (_) {
          await new Promise(r=>setTimeout(r, 800));
          fixedTranscript = await withTimeout(
            (signal)=>cleanAll({ apiKey, model: chosenModel, transcript, signal }),
            120000, "OpenAI (clean retry)"
          );
        }
      } finally { stopHB(); }
    } else {
      const chunks = splitIntoChunks(transcript, 12000);
      report(`Cleaning transcript (0/${chunks.length})`, 38);
      const out = [];
      for (let i=0;i<chunks.length;i++) {
        report(`Cleaning chunk ${i+1}/${chunks.length}`, 38 + Math.round((i/chunks.length)*25));
        let cleaned;
        try {
          cleaned = await withTimeout(
            (signal)=>cleanChunk({ apiKey, model: chosenModel, chunk: chunks[i], idx: i, total: chunks.length, signal }),
            120000, `OpenAI (clean chunk ${i+1})`
          );
        } catch (_) {
          await new Promise(r=>setTimeout(r, 800));
          cleaned = await withTimeout(
            (signal)=>cleanChunk({ apiKey, model: chosenModel, chunk: chunks[i], idx: i, total: chunks.length, signal }),
            120000, `OpenAI (clean chunk ${i+1} retry)`
          );
        }
        out.push(cleaned);
      }
      fixedTranscript = out.join("\n\n");
    }

    // 3) Summarize
    report("Summarizing…", 70, "3–5 paragraph summary");
    startHB('Summarizing…');
    let summary;
    try {
      try {
        summary = await withTimeout(
          (signal)=>summarize({ apiKey, model: chosenModel, cleanedTranscript: fixedTranscript, channel, title, signal }),
          120000, "OpenAI (summary)"
        );
      } catch (_) {
        await new Promise(r=>setTimeout(r, 800));
        summary = await withTimeout(
          (signal)=>summarize({ apiKey, model: chosenModel, cleanedTranscript: fixedTranscript, channel, title, signal }),
          120000, "OpenAI (summary retry)"
        );
      }
    } finally { stopHB(); }

    // 4) Assemble + persist + notify
    const { date, time } = nowDateTimeStrings();
    const markdown = buildNoteMarkdown({ date, time, channel, summary, fixedTranscript, videoUrl: url });
    const payload = { ts: Date.now(), title, channel, url, date, time, markdown };
    // Storage size guard (~4MB per item practical limit). Truncate if huge.
    try {
      const approxBytes = new Blob([JSON.stringify(payload)]).size;
      if (approxBytes > 3_500_000) {
        const maxMd = Math.max(0, payload.markdown.length - (approxBytes - 3_500_000));
        payload.markdown = payload.markdown.slice(0, maxMd);
      }
    } catch {}
    await chrome.storage.local.set({ lastResult: payload });

    report("Finalizing…", 95, "Almost done");
    reportDone(markdown);
    notifyDone(title);
  } catch (e) {
    reportError(e.message || String(e));
  } finally {
    stopSpinnerSW();
  }
}

// ---------- Orchestration entrypoint (popup triggers this) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "RUN_ON_TAB") {
    (async () => {
      try {
        const tabId = msg.tabId;
        const apiKey = (msg.apiKey || '').trim();
        if (!apiKey) throw new Error("Missing API key.");

        // Start spinner immediately for both offscreen and fallback paths
        startSpinnerSW();

        // Fetch model once here and pass along (avoids offscreen storage race)
        const stored = (await (chrome.storage?.local?.get?.(["model"]) || Promise.resolve({}))) || {};
        const model = stored.model || "gpt-4o-mini";

        // Assign a jobId so we can correlate messages + fallback
        const jobId = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        jobState.set(jobId, { acked: false, ackReported: false, fallbackStarted: false, tabId, apiKey, model });

        // Try Offscreen with handshake
        try {
          await ensureOffscreen();
          report("Offscreen ready", 6);
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_RUN', tabId, apiKey, jobId, model });

          // Wait up to 2s for ACK; otherwise fallback
          const acked = await new Promise((resolve) => {
            const timeout = setTimeout(()=>resolve(false), 2000);
            const listener = (m) => {
              if (m?.type === 'OFFSCREEN_ACK' && m.jobId === jobId) {
                chrome.runtime.onMessage.removeListener(listener);
                clearTimeout(timeout); resolve(true);
              }
            };
            chrome.runtime.onMessage.addListener(listener);
          });

          if (!acked) {
            const s = jobState.get(jobId) || {}; s.fallbackStarted = true; jobState.set(jobId, s);
            report("Offscreen didn’t ACK → using fallback", 7);
            runInServiceWorker(tabId, apiKey, model);
          }
          sendResponse({ ok: true, handedOff: acked });
        } catch (e) {
          const s = jobState.get(jobId) || {}; s.fallbackStarted = true; jobState.set(jobId, s);
          report("Offscreen failed → using fallback", 6, e.message || "No response from offscreen");
          runInServiceWorker(tabId, apiKey, model);
          sendResponse({ ok: true, handedOff: false, fallback: true });
        }
      } catch (e) {
        reportError(e.message || String(e));
        stopSpinnerSW(); // stop spinner on immediate failure
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // keep SW alive for async sendResponse
  }
});
