YT → Obsidian Note (Transcript Fix + Summary)

Browser extension (Chrome MV3) that pulls a YouTube video transcript, cleans it with OpenAI, generates a structured summary, and produces a Markdown note suitable for Obsidian. The note is copied to your clipboard and also available on a results page for easy copy.

Features
- Scrape YouTube title, channel, URL, and transcript
- Clean/improve transcript (punctuation, capitalization, remove non‑speech tags)
- Generate a 3–5 paragraph summary in concise Markdown
- Assemble a Markdown note with date/time, channel, summary, transcript, and video link
- One‑click copy to clipboard; fallback results page if clipboard access fails
- Works on `www.youtube.com`, `m.youtube.com`, and `youtu.be`
- Resilient architecture with Offscreen Document and Service Worker fallback

Web App (Windows 11 or any desktop browser)
This repo includes a standalone web app that runs locally in your browser. It fetches a YouTube transcript, calls OpenAI to clean + summarize, and outputs a Markdown note you can copy into Obsidian.

Quick start
1. From this repo, start the local web app + transcript API server:
   - `node server.js`
2. Open `http://localhost:5173/` in your browser.
3. Paste the YouTube URL, your OpenAI API key, and click “Generate Obsidian Note.”

Notes
- The API key is never stored; it is used only in memory for the current run.
- Transcript fetching is asynchronous and uses Bright Data's YouTube dataset API only (trigger -> poll -> snapshot).
- Bright Data credentials are loaded from `.env`; there is no local transcript-script fallback path.
- Some videos (or regions) may still not expose captions.

Permissions
The extension requests:
- activeTab, scripting: Inject/communicate with the content script to scrape the YouTube page
- storage: Persist the most recent result and your model preference
- clipboardWrite: Copy the final Markdown to clipboard
- notifications: Notify when a background run completes
- offscreen: Run long operations in an offscreen document without keeping the popup open
- Host permissions for YouTube and https://api.openai.com/*

Requirements
- A valid OpenAI API key with access to the chosen chat-completions model (default: gpt-4o-mini)
- Bright Data dataset API credentials configured in `.env` (see `.env.example`)

Bright Data (required)
- Copy `.env.example` to `.env` and fill in your credentials.
- Required values:
  - `BRIGHT_DATA_API_TOKEN`
  - `BRIGHT_DATA_YT_DATASET_ID`
- Optional values:
  - `BRIGHT_DATA_API_BASE` (default: `https://api.brightdata.com`)
  - `BRIGHT_DATA_TIMEOUT_MS`
  - `BRIGHT_DATA_POLL_INTERVAL_MS`

Install (Developer/Unpacked)
1. Clone or download this repository.
2. Open Chrome → Extensions → Enable “Developer mode”.
3. Click “Load unpacked” and select the project folder.
4. Verify the extension appears in the toolbar (pin if desired).

Usage
1. Open a YouTube video page (www, m, or youtu.be).
2. Click the extension icon to open the popup.
3. Paste your OpenAI API key (not stored; used in-memory for this run) and Continue.
4. Click “Make Obsidian Note → Clipboard”.
5. Watch progress in the popup. On completion:
   - Markdown is copied to clipboard, and
   - A notification appears. Clicking it opens the results page (also available if clipboard copy fails).

Options
- Open the extension’s Options page (right-click the extension → Options) to set the model name stored in chrome.storage.local.model (default: gpt-4o-mini).

Architecture Overview
- service-worker.js: Orchestrates runs, manages badge spinner, notifications, offscreen lifecycle, and a full fallback path.
- contentScript.js: Runs on YouTube pages; opens the transcript panel and scrapes title/channel/url/transcript.
- offscreen.html + offscreen.js: Preferred long-running worker that calls OpenAI for cleaning and summarization, with heartbeat progress updates.
- popup.html + popup.js: UI for API key entry, progress, and auto-copy.
- result.html + result.js: Displays the most recent note and provides an “Open original video” link.

Progress and Heartbeats
- Real progress updates map to: scrape → clean → summarize → finalize.
- During long OpenAI calls, periodic “still running” heartbeats are sent to keep the UI responsive and show activity.
- The popup ignores heartbeat messages for the percentage bar/step fills to avoid jumpy progress, but keeps the status text updated.

Data Handling & Privacy
- Your API key is typed into the popup and used only for the current run; it is not stored.
- The latest note payload (title, channel, URL, date/time, Markdown) is saved to chrome.storage.local.lastResult for the results page.
- The payload size is guarded and may be truncated if too large for storage limits.

Troubleshooting
- Transcript not found: Some videos do not publish caption tracks (or region/account restrictions may block them). Try a different video or provide one with subtitles enabled.
- Clipboard copy fails: The extension opens the results page for manual copy.
- No progress / fallback used: The offscreen document may be slow to initialize; the extension falls back to running entirely in the Service Worker.
- Rate limits / timeouts: The extension retries once with a short backoff for each OpenAI call. Extremely long transcripts are chunked for cleaning and the summary prompt input is capped.

Known Limitations
- YouTube DOM and labels can change by locale/layout; scraping is best‑effort.
- Very long transcripts may be summarized from a capped cleaned text subset.
- Service Worker long tasks depend on Chrome heuristics; the offscreen path is preferred.

Development
- Manifest V3; all scripts must be external (no inline JS).
- Primary files:
  - manifest.json
  - service-worker.js
  - contentScript.js
  - offscreen.html, offscreen.js
  - popup.html, popup.js
  - result.html, result.js
  - options.html, options.js
- Logging: The popup throttles repeated progress messages and ignores heartbeats for percentage/steps.

Security Notes
- The API key is never persisted; use short‑lived or restricted keys when possible.
- All network calls to OpenAI are sent directly from the extension to https://api.openai.com/v1/chat/completions.

License
MIT (see LICENSE if provided). If no license is present, all rights reserved by the author.

Changelog (highlights)
- v1.3.x:
  - Offscreen detection improved; longer handshake window
  - Fallback heartbeat + retry/backoff
  - Summary input cap; storage size guard
  - Popup URL gating for m.youtube.com and youtu.be
  - Popup progress smoothing; results page link to original video
