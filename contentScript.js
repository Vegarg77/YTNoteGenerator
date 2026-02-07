// Runs on YouTube hosts per manifest. Listens for CS_SCRAPE and performs all DOM work here.
// Note: Content scripts already run in the page; we don't need chrome.scripting here.

(function () {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function waitForSelector(sel, timeout = 8000) {
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      (function check() {
        const el = document.querySelector(sel);
        if (el) return resolve(el);
        if (performance.now() - t0 > timeout) return reject(new Error("Timeout waiting for " + sel));
        requestAnimationFrame(check);
      })();
    });
  }

  async function ensureTranscriptOpen() {
    // If already open
    if (document.querySelector('ytd-transcript-renderer')) return true;

    // Click the overflow ("...") menu near the title or player actions.
    const buttons = [
      ...document.querySelectorAll('ytd-menu-renderer ytd-button-renderer button, #button-shape button, tp-yt-paper-button')
    ];
    const more = buttons.find(btn =>
      /more|More actions|More options|\.{3}/i.test(btn.getAttribute('aria-label') || btn.textContent || '')
    );
    if (more) more.click();
    await sleep(450);

    // Find menu item labeled "Show transcript"
    const items = [
      ...document.querySelectorAll('ytd-menu-service-item-renderer tp-yt-paper-item, ytd-menu-navigation-item-renderer a, a[role="menuitem"]')
    ];
    const show = items.find(x => /transcript/i.test(x.textContent || ''));
    if (show) {
      show.click();
      await sleep(900);
      return true;
    }
    return false;
  }

  function scrapeTranscriptText() {
    const renderer = document.querySelector('ytd-transcript-renderer');
    if (!renderer) return null;
    const segments = [...renderer.querySelectorAll('ytd-transcript-segment-renderer')];
    if (!segments.length) return null;
    const text = segments.map(li => {
      // robust pick for the actual cue text
      const cue = li.querySelector('#segment-text, .segment-text, .segment-text-content, span');
      return (cue?.textContent || '').trim();
    }).filter(Boolean).join('\n');
    return text || null;
  }

  function getVideoIdFromUrl(url) {
    try { 
      const u = new URL(url);
      if (u.hostname === 'youtu.be') return u.pathname.split('/').pop() || null;
      return u.searchParams.get('v');
    } catch { return null; }
  }

  async function scrapeAll() {
    // Title
    let title = '';
    try {
      const h1 = await waitForSelector('h1.title, h1.ytd-watch-metadata, h1');
      title = (h1.textContent || document.title || '').trim();
    } catch {
      title = (document.title || '').trim();
    }

    // Channel
    let channel = '';
    const ch = document.querySelector('ytd-channel-name a, #channel-name a, #owner-name a');
    if (ch) channel = ch.textContent.trim();

    const url = location.href;
    const videoId = getVideoIdFromUrl(url);

    // Open transcript (best-effort)
    await ensureTranscriptOpen();
    let transcript = scrapeTranscriptText();

    // Fallback: try to pull from transcript container text if segments missing
    if (!transcript) {
      const candidate = [...document.querySelectorAll('ytd-transcript-renderer, ytd-transcript-segment-renderer')]
        .map(n => n.textContent.trim()).join('\n');
      if (candidate && candidate.length > 80) transcript = candidate;
    }

    return { title, channel, url, videoId, transcript };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'CS_SCRAPE') return;
    (async () => {
      try {
        const data = await scrapeAll();
        if (!data.transcript) {
          sendResponse({ ok: false, error: "Transcript not found on this page." });
          return;
        }
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // async
  });
})();
