# Reader

Brave/Chrome extension for reformatting long-form transcripts and podcasts into clean, styled reading pages.

Supports three sources:

- **Earnings call transcripts** from BamSEC — summarized into structured HTML with key takeaways, financial highlights, and a Q&A breakdown.
- **Expert call transcripts** from AlphaSense and AlphaSights — reformatted with speaker roles, interview metadata, and a concise summary of each topic.
- **YouTube videos** — near-verbatim cleanup of podcast/interview captions, with punctuation/paragraphing, filler removal, Q&A-aware styling, and chapter headings when YouTube provides them.

All output pages get bookmarking and appear on a shared status page (`/status`) with a bookmarks sidebar and a completed-jobs column. Each output type has its own Claude prompt and verbosity slider in the extension popup.

## Architecture

1. **Browser Extension** (`extension/`) — detects which source the current tab is on, extracts the relevant transcript text/metadata, and POSTs it to the local server.
2. **Node.js Server** (`server/`) — Express app on `localhost:3210` that queues jobs, pipes each payload through the Claude CLI with a source-specific prompt, wraps the result in an HTML shell with the Reader visual style (`style.css`), and writes output files to `output/`.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /status` | Status page: queue, workers, bookmarks, completed history |
| `GET /settings` / `POST /settings` | Server-side settings (verbosity, model, concurrency) |
| `POST /summarize` | Submit a BamSEC earnings call transcript |
| `POST /summarize-expert` | Submit an AlphaSense / AlphaSights expert call transcript |
| `POST /summarize-youtube` | Submit a scraped YouTube video transcript |
| `GET /job/:id` | Poll job status (used by the extension via `chrome.alarms`) |
| `POST /bookmark` | Toggle a bookmark for an output file |
| `GET /bookmarks` | Return the full bookmark list (used by YT pages to show current state) |
| `GET /bookmark/remove?filename=…` | Remove a bookmark via GET (used by the status page) |
| `GET /output/<filename>.html` | Serve generated output files |
| `GET /style.css` | Serve the shared stylesheet |

## YouTube flow

Clicking the extension on a `youtube.com/watch` page triggers this sequence in `extension/background.js`:

1. Fetch the watch page HTML directly from the service worker and parse `ytInitialPlayerResponse` / `ytInitialData` out of the inline script source (balanced-brace JSON extraction) to get title, channel, duration, thumbnail, chapters, etc.
2. Run a `chrome.scripting.executeScript` in the tab's MAIN world to find the transcript engagement panel, force its `visibility` attribute to `EXPANDED`, and scrape `ytd-transcript-segment-renderer` elements for timestamps and text.
3. POST the payload (metadata + chapters + segments + verbosity) to `/summarize-youtube`.
4. Server queues the job, runs the YouTube prompt through Claude CLI (defaults to Haiku for speed — the other endpoints still use the status-page model selector), and writes an HTML output page with:
   - Sticky header (thumbnail, title, channel · date · length, star bookmark, `YT` link)
   - Body text as near-verbatim paragraphs, with interviewer questions wrapped in `<p class="q">` for visual distinction when the content is clearly a podcast/interview

The YouTube endpoint also supports a `raw: true` body flag which skips Claude entirely and renders the scraped transcript as timestamped paragraphs — useful for quick scrape verification.

## Key files

| File | Description |
|------|-------------|
| `extension/manifest.json` | Browser extension manifest (MV3) |
| `extension/background.js` | Service worker: site detection, script injection, YT scraping |
| `extension/content.js` | BamSEC content script |
| `extension/content-expert.js` | AlphaSense / AlphaSights content script |
| `extension/content-expert-meta.js` | Top-frame metadata extractor for expert calls |
| `extension/popup.html`, `popup.js` | Settings popup with verbosity sliders (EC / Expert / YT) |
| `server/server.js` | Express server, job queue, endpoint handlers, Claude CLI spawn |
| `server/youtube-helpers.js` | Pure helpers for the YouTube flow (escape, slug, duration, chapter normalize, Claude input build, HTML render) |
| `server/youtube-helpers.test.js` | `node:test` unit tests for the YouTube helpers (run with `npm test`) |
| `server/prompt.txt` | Claude prompt for earnings calls |
| `server/prompt-expert.txt` | Claude prompt for expert calls |
| `server/prompt-youtube.txt` | Claude prompt for YouTube transcript cleanup |
| `server/style.css` | Shared Reader visual style (warm cream palette, 78ch column) |
| `output/` | Generated HTML files, bookmarks.json, history.json |

## Development

Run unit tests for the YouTube helpers:

```sh
cd server
npm test
```

Start the server locally:

```sh
cd server
node server.js
# or on Windows:
start-server.bat
```

Design specs and implementation plans live under `docs/superpowers/`.

## Tech Stack

- JavaScript (Browser Extension + Node.js)
- Express.js
- Claude CLI for transcript processing
- Native `node:test` for unit tests (no extra test framework)
