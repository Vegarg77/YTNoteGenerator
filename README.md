# YT Note Generator

Generate Obsidian-ready notes from YouTube videos and Wikipedia articles by combining transcript/article extraction + OpenAI cleanup/summarization.

---

## What the project does

The app has two main modes, accessible via a tabbed web interface:

### YouTube Notes

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

### Wikipedia Notes

- **Dictionary notes**: Search Wikipedia terms with autocomplete, then generate Obsidian dictionary entries with YAML frontmatter.
- **Business notes**: Extract business/organization info (founders, headquarters, offerings) from Wikipedia into structured notes.

---

## Architecture

- `server.js`: Serves `webapp/` static files and API routes (transcript fetching, note saving, Wikipedia proxy, settings management). Zero npm dependencies — uses only Node.js built-in modules.
- `webapp/app.js`: Handles multi-video and Wikipedia batch processing, OpenAI calls (Chat Completions + Responses API), progress cards, retry logic, and copy UX.
- `webapp/index.html` + `webapp/styles.css`: Tabbed UI for YouTube and Wikipedia workflows.

---

## Requirements

- Node.js 18+ (built-in `fetch` is used — no npm dependencies).
- OpenAI API key (can be set via settings panel or provided at runtime).
- Bright Data dataset API credentials for YouTube transcripts and Wikipedia lookups:
  - `BRIGHT_DATA_API_TOKEN`
  - `BRIGHT_DATA_YT_DATASET_ID`
  - `BRIGHT_DATA_WIKI_DATASET_ID` (defaults to `gd_lr9978962kkjr3nx49`)

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
OPENAI_API_KEY=your-openai-api-key
BRIGHT_DATA_API_TOKEN=...
BRIGHT_DATA_YT_DATASET_ID=...
BRIGHT_DATA_WIKI_DATASET_ID=gd_lr9978962kkjr3nx49
```

Optional overrides supported by the server:

- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `PORT` (default `5173`)
- `BRIGHT_DATA_API_BASE` (default `https://api.brightdata.com`)
- `BRIGHT_DATA_TIMEOUT_MS` (default `120000`)
- `BRIGHT_DATA_POLL_INTERVAL_MS` (default `2000`)
- `OBSIDIAN_NOTE_DIR` — directory for saved video notes
- `OBSIDIAN_DICTIONARY_DIR` — directory for saved dictionary notes
- `OBSIDIAN_BUSINESS_DIR` — directory for saved business notes

Most of these can also be changed at runtime through the in-app settings panel.

### 2) (Important) Adjust note-save locations

Set `OBSIDIAN_NOTE_DIR`, `OBSIDIAN_DICTIONARY_DIR`, and `OBSIDIAN_BUSINESS_DIR` in your `.env` file to valid directories on your machine, or configure them through the in-app settings panel (gear icon).

---

## Run

### Local

Start server:

```bash
node server.js
```

Open `http://localhost:5173/`. The server listens on `0.0.0.0`, so it is accessible from other machines on the network.

### Docker

Build the image:

```bash
docker build -t ytnotegenerator .
```

Run the container:

```bash
docker run -d \
    -p 5173:5173 \
    --name=ytnotegenerator \
    -v /path/to/notes:/data/notes \
    -v /path/to/dictionary:/data/dictionary \
    -v /path/to/business:/data/business \
    -v /etc/localtime:/etc/localtime:ro \
    -e OPENAI_API_KEY=your-openai-api-key \
    -e OPENAI_MODEL=gpt-4o-mini \
    -e BRIGHT_DATA_API_TOKEN=your-bright-data-token \
    -e BRIGHT_DATA_YT_DATASET_ID=your-dataset-id \
    -e BRIGHT_DATA_WIKI_DATASET_ID=gd_lr9978962kkjr3nx49 \
    -e OBSIDIAN_NOTE_DIR=/data/notes \
    -e OBSIDIAN_DICTIONARY_DIR=/data/dictionary \
    -e OBSIDIAN_BUSINESS_DIR=/data/business \
    ytnotegenerator
```

Replace the `/path/to/...` volume mounts with directories on your host where you want notes saved. A ready-to-edit version of this command is available in `docker-run.sh`.

### YouTube tab

1. Paste one or more YouTube URLs (spaces/newlines/comma separated).
2. Enter your OpenAI API key (or set it in settings).
3. Choose model (default `gpt-4o-mini`; GPT-5 family routes through the Responses API path).
4. Click **Generate Obsidian Note**.
5. Copy combined markdown output and/or use saved files from the configured note directory.
6. Use **Retry Failed** to re-process any videos that failed.

### Wikipedia tab

1. Search for a term using the autocomplete search box.
2. Select one or more terms or businesses from suggestions.
3. Click **Generate** to create dictionary or business notes.
4. Copy or save the generated markdown.

---

## API endpoints

### `GET /api/transcript?url=<youtube_url>`

- Resolves video id from URL.
- Calls Bright Data dataset API (trigger → poll → snapshot).
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
- Writes `.md` file into configured `OBSIDIAN_NOTE_DIR` with collision detection.

### `GET /api/wikipedia-suggest?q=<query>`

- Returns autocomplete suggestions for Wikipedia articles via the Bright Data Wikipedia dataset.

### `GET /api/wikipedia-page?title=<title>`

- Fetches the full content of a Wikipedia article via the Bright Data Wikipedia dataset.

### `GET /api/settings`

- Returns current application configuration.

### `POST /api/settings`

- Updates application settings and persists them to `.env`.

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

- `server.js` – local server + API (zero npm dependencies)
- `webapp/index.html` – tabbed web UI structure
- `webapp/app.js` – frontend logic (YouTube + Wikipedia processing, OpenAI integration)
- `webapp/styles.css` – UI styles
- `scripts/fetch_transcript.py` – optional Python transcript utility (legacy)
- `.env.example` – environment variable template
- `Dockerfile` – container image definition (Node.js + Python)
- `docker-run.sh` – ready-to-edit `docker run` command
- `.dockerignore` – files excluded from the Docker build context

---

## Project status

The core YouTube-to-Obsidian note pipeline is fully functional. Recent additions include:

- **Wikipedia integration** — dictionary and business note generation from Wikipedia articles.
- **Settings panel** — in-app gear icon to configure API keys, model, and save directories without editing `.env` manually.
- **Network accessibility** — server binds to `0.0.0.0` so it can be accessed from other devices on the LAN.
- **Retry failed** — re-process any videos/terms that failed during a batch run.
- **GPT-5 support** — routes GPT-5 family models through the OpenAI Responses API.
- **Docker support** — run the app as a container with environment variables and volume mounts for note storage.

---

## License

MIT (if a LICENSE file is present).
