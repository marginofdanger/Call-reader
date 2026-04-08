# Reader

Brave extension for summarizing and re-formatting earnings calls, presentations, and expert calls (AlphaSense, AlphaSights).

Creates HTML output with bookmarking. Summary page includes bookmarks and history of summarized calls with links to original transcripts.

Extension settings include verbosity on a 0-200 scale (0 = extreme bullet points, 200 = close to verbatim).

## Architecture

1. **Browser Extension** — Extracts transcript text from BamSEC pages in Brave/Chrome
2. **Node.js Server** — Receives transcripts on `localhost:3210`, pipes through Claude CLI to produce HTML summaries

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `POST /summarize` | Submit transcript for summarization |

## Key Files

| File | Description |
|------|-------------|
| `extension/manifest.json` | Browser extension manifest |
| `server/server.js` | Express.js server |

## Tech Stack

- JavaScript (Browser Extension + Node.js)
- Express.js
- Claude CLI for summarization
