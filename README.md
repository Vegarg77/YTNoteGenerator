# YT Note Generator

Generate Obsidian-ready notes from YouTube videos by combining transcript extraction + OpenAI cleanup/summarization.

---

## What the project does

For each video, the app:

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

## Architecture

- `server.js`: Serves `webapp/` static files and API routes.
- `GET /api/transcript`: Pulls transcript data through Bright Data dataset API (trigger → poll → snapshot).
- `POST /api/save-note`: Saves generated Markdown note to local disk.
- `webapp/app.js`: Handles multi-video batch processing, OpenAI calls, progress cards, and copy UX.

---

## Requirements

- Node.js 18+ (built-in `fetch` is used by `server.js`).
- OpenAI API key.
- Bright Data dataset API credentials for transcript retrieval:
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
- `BRIGHT_DATA_TIMEOUT_MS` (default `120000`)
- `BRIGHT_DATA_POLL_INTERVAL_MS` (default `2000`)

### 2) (Important) Adjust note-save location

`server.js` currently writes saved notes to a hardcoded directory:

```js
const OBSIDIAN_NOTE_DIR = "G:\\My Drive\\GigaVault\\Video Notes (unsorted)";
```

Update this constant to a valid folder on your machine before relying on `/api/save-note`.

---

## Run

Start server:

```bash
node server.js
```

Open:

- `http://localhost:5173/`

Usage:

1. Paste one or more YouTube URLs (spaces/newlines/comma separated).
2. Enter your OpenAI API key (used in-memory for that run).
3. Choose model (default `gpt-4o-mini`; GPT-5 family routes through the Responses API path).
4. Click **Generate Obsidian Note**.
5. Copy combined markdown output and/or use saved files from the configured note directory.

---

## API endpoints

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

- OpenAI key is provided at runtime and not persisted.
- Web app keeps model preference in browser `localStorage`.
- Transcript retrieval depends on Bright Data API credentials from `.env`.

---

## Troubleshooting

- **`Transcript fetch failed`**
  - Confirm Bright Data env vars are set and valid.
  - Check dataset id/token permissions.
  - Retry with a different video (some videos do not expose usable captions).

- **`Save API error`**
  - Update `OBSIDIAN_NOTE_DIR` to a writable path for your system.

- **OpenAI timeout/rate-limit issues**
  - The app retries cleanup/summary calls once.
  - Very large transcripts are chunked for cleanup.

---

## Repository map

- `server.js` – local server + API
- `webapp/` – web app UI
- `scripts/fetch_transcript.py` – optional Python transcript utility

---

## License

MIT (if a LICENSE file is present).
