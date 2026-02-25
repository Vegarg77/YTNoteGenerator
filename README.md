# YT Note Generator

Generate Obsidian-ready notes from YouTube videos by combining transcript extraction + OpenAI cleanup/summarization.

---

## What the project does today

For each video, the app/extension:

- Collects transcript text + basic metadata (title, channel, URL).
- Cleans transcript text (punctuation/capitalization, removes noisy tags, translates non-English transcript text to English).
- Generates a structured summary.
- Builds a Markdown note in this format:
  - Date/time
  - Channel
  - Summary
  - Cleaned transcript
  - Source video link
  - `#VN` tag

---

## Current architecture

### 1) Chrome extension flow

- `contentScript.js`: Scrapes YouTube page data and transcript.
- `service-worker.js`: Orchestrates the run, calls OpenAI, reports progress, manages offscreen fallback, and stores latest result.
- `offscreen.js` (+ `offscreen.html`): Preferred long-running processor for cleanup/summarization.
- `popup.js`/`popup.html`: API key entry and run UI.
- `result.html`/`result.js`: Displays last generated note for manual copy/open-video fallback.

### 2) Local web app flow

- `server.js`: Serves `webapp/` static files and API routes.
- `GET /api/transcript`: Pulls transcript data through Bright Data dataset API (trigger → poll → snapshot).
- `POST /api/save-note`: Saves generated Markdown note to local disk.
- `webapp/app.js`: Handles multi-video batch processing, OpenAI calls, progress cards, and copy UX.

---

## Requirements

- Node.js 18+ (built-in `fetch` is used by `server.js`).
- OpenAI API key.
- Bright Data dataset API credentials for transcript retrieval in web app mode:
  - `BRIGHT_DATA_API_TOKEN`
  - `BRIGHT_DATA_YT_DATASET_ID`

Optional Python helper dependency (legacy/utility script):

- `yt-transcript-api` (listed in `requirements.txt` for `scripts/fetch_transcript.py`).

---

## Setup

### 1) Configure environment

Copy and edit env file:

```bash
cp .env.example .env
```

Set required values:

```env
BRIGHT_DATA_API_TOKEN=...
BRIGHT_DATA_YT_DATASET_ID=...
```

Optional overrides supported by the server:

- `PORT` (default `5173`)
- `BRIGHT_DATA_API_BASE` (default `https://api.brightdata.com`)
- `BRIGHT_DATA_TIMEOUT_MS` (default `60000`)
- `BRIGHT_DATA_POLL_INTERVAL_MS` (default `2000`)

### 2) (Important) Adjust note-save location for web app mode

`server.js` currently writes saved notes to a hardcoded directory:

```js
const OBSIDIAN_NOTE_DIR = "G:\\My Drive\\GigaVault\\Video Notes (unsorted)";
```

Update this constant to a valid folder on your machine before relying on `/api/save-note`.

---

## Run the local web app

Start server:

```bash
node server.js
```

Open:

- `http://localhost:5173/`

Usage:

1. Paste one or more YouTube URLs (spaces/newlines/comma separated).
2. Enter your OpenAI API key (used in-memory for that run).
3. Choose model (default `gpt-4o-mini`; GPT-5 family routes through the Responses API path in the web app).
4. Click **Generate Obsidian Note**.
5. Copy combined markdown output and/or use saved files from the configured note directory.

---

## Install/run the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repo directory.
4. Open a YouTube video page.
5. Click extension icon and run note generation.

Notes:

- Host permissions include `www.youtube.com`, `m.youtube.com`, and `youtu.be`.
- Extension stores latest generated payload in `chrome.storage.local.lastResult` for the result page.
- Model preference is saved in `chrome.storage.local.model` via `options.html`.

---

## API endpoints (local server)

### `GET /api/transcript?url=<youtube_url>`

- Resolves video id from URL.
- Calls Bright Data dataset API.
- Returns transcript + metadata.

### `POST /api/save-note`

Request JSON:

```json
{
  "markdown": "# ...",
  "videoTitle": "Video title"
}
```

- Sanitizes filename from title.
- Writes `.md` file into configured `OBSIDIAN_NOTE_DIR`.

---

## Privacy & data handling

- OpenAI key is provided at runtime and not intentionally persisted by the extension/web app workflow.
- Web app keeps model preference in browser `localStorage`.
- Extension stores only result payload/model preference in `chrome.storage.local` for UX continuity.
- Transcript retrieval in server mode depends on Bright Data API credentials from `.env`.

---

## Troubleshooting

- **`Transcript fetch failed` in web app**
  - Confirm Bright Data env vars are set and valid.
  - Check dataset id/token permissions.
  - Retry with a different video (some videos do not expose usable captions).

- **`Save API error` in web app**
  - Update `OBSIDIAN_NOTE_DIR` to a writable path for your system.

- **OpenAI timeout/rate-limit issues**
  - The app retries cleanup/summary calls once.
  - Very large transcripts are chunked for cleanup.

- **Extension cannot scrape transcript**
  - Ensure you are on a supported YouTube URL and transcript is available.
  - Reload extension after updates and retry.

---

## Repository map

- `manifest.json` – extension manifest (MV3)
- `service-worker.js` – extension orchestration/fallback logic
- `contentScript.js` – YouTube scraping logic
- `offscreen.html` / `offscreen.js` – offscreen processing path
- `popup.*`, `result.*`, `options.*` – extension UI surfaces
- `server.js` – local server + API
- `webapp/` – local web app UI
- `scripts/fetch_transcript.py` – optional Python transcript utility

---

## Version

- `VERSION` file: `1.0`

---

## License

MIT (if a LICENSE file is present).
