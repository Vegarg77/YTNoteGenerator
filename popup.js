// UI elements
const viewKey = document.getElementById('viewKey');
const viewRun = document.getElementById('viewRun');
const nextBtn = document.getElementById('next');
const runBtn = document.getElementById('run');
const apiKeyEl = document.getElementById('apiKey');
const keyErr = document.getElementById('keyErr');
const s1 = document.getElementById('s1');
const s2 = document.getElementById('s2');
const s3 = document.getElementById('s3');
const pfill = document.getElementById('pfill');
const pct = document.getElementById('pct');
const logEl = document.getElementById('log');
const statusSmall = document.getElementById('statusSmall');

let apiKey = "";
let port = null;
let lastLog = "";
let lastLogAt = 0;

function log(line, cls="") {
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.textContent = `[${time}] ${line}`;
  if (cls) div.classList.add(cls);
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function setPct(n) {
  const val = Math.max(0, Math.min(100, Math.round(n)));
  pfill.style.width = val + '%';
  pct.textContent = val + '%';
}
function setStep(n) {
  [s1,s2,s3].forEach((el,i) => el.classList.toggle('fill', i < n));
}

function connectPort() {
  if (port) return;
  try {
    port = chrome.runtime.connect({ name: "popup" });
    port.onMessage.addListener(async (msg) => {
      if (msg?.type === "PROGRESS") {
        const isHeartbeat = (msg.note && /still running/i.test(msg.note));
        statusSmall.textContent = msg.stage || 'Working…';
        // Only update bar/steps on non-heartbeat updates
        if (!isHeartbeat) {
          setPct(msg.pct || 0);
          // Map progress to step fills
          const p = msg.pct || 0;
          if (p < 20) setStep(1);
          else if (p < 80) setStep(2);
          else setStep(3);
        }
        // Throttle log spam; skip heartbeats entirely
        const text = isHeartbeat ? '' : (msg.note || msg.stage);
        const now = Date.now();
        if (text && (text !== lastLog || now - lastLogAt > 1500)) {
          log(text);
          lastLog = text; lastLogAt = now;
        }
      } else if (msg?.type === "DONE") {
        // Service worker now sends markdown in DONE; copy it here (popup context)
        if (msg.markdown) {
          try {
            await navigator.clipboard.writeText(msg.markdown);
            log("Copied to clipboard.", "good");
          } catch (e) {
            log("Failed to copy automatically. Opening result page…", "bad");
            chrome.tabs.create({ url: chrome.runtime.getURL("result.html") });
          }
        }
        setPct(100); setStep(3);
        statusSmall.textContent = "Copied to clipboard!";
      } else if (msg?.type === "ERROR") {
        statusSmall.textContent = "Error";
        log(msg.error || "Unknown error", "bad");
      }
    });
  } catch (e) {
    console.warn("Port connect failed:", e);
  }
}

function goNext() {
  apiKey = apiKeyEl.value.trim();
  if (!apiKey) {
    keyErr.textContent = "Please paste your API key.";
    apiKeyEl.classList.add('shake');
    setTimeout(()=> apiKeyEl.classList.remove('shake'), 450);
    apiKeyEl.focus();
    return;
  }
  keyErr.textContent = "";
  // Switch views
  viewKey.classList.add('hidden');
  viewRun.classList.remove('hidden');
  setStep(1);
  statusSmall.textContent = "Ready";
  connectPort();
}

nextBtn.addEventListener('click', goNext);
apiKeyEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') goNext();
});

runBtn.addEventListener('click', async () => {
  setStep(2);
  setPct(0);
  logEl.textContent = "";
  log("Starting…");
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab || !/^(https:\/\/www\.youtube\.com\/watch|https:\/\/m\.youtube\.com\/watch|https:\/\/youtu\.be\/)/.test(tab.url || "")) {
    statusSmall.textContent = "Open a YouTube video tab.";
    log("Please open a YouTube video page first.", "bad");
    return;
  }
  statusSmall.textContent = "Working…";
  chrome.runtime.sendMessage(
    { type: "RUN_ON_TAB", tabId: tab.id, apiKey, mode: "clipboard" },
    (resp) => {
      // Response may be undefined if the service worker wakes; progress/DONE will stream via port.
      if (!resp) return;
      if (resp?.error) {
        statusSmall.textContent = "Error";
        log(resp.error, "bad");
      }
    }
  );
});

// Auto-focus
apiKeyEl.focus();
