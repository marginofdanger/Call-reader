// Pure helpers for the YouTube transcript reader endpoint.
// No fs, no network, no express — everything here must be unit-testable.

function htmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(s) {
  if (s == null) return 'untitled';
  const cleaned = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return 'untitled';
  if (cleaned.length <= 60) return cleaned;
  // Truncate at 60 then back off to the last hyphen so we don't cut a word in half.
  let truncated = cleaned.slice(0, 60);
  const lastHyphen = truncated.lastIndexOf('-');
  if (lastHyphen > 30) truncated = truncated.slice(0, lastHyphen);
  return truncated.replace(/-+$/g, '');
}

function formatDuration(secondsLike) {
  const total = Math.max(0, Math.floor(Number(secondsLike) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatUploadDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function isEnglish(code) {
  if (!code) return false;
  const lower = String(code).toLowerCase();
  return lower === 'en' || lower.startsWith('en-');
}

function resolveCaptionTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const englishTracks = tracks.filter(t => t && isEnglish(t.languageCode));
  if (englishTracks.length === 0) return null;
  const human = englishTracks.find(t => t.kind !== 'asr');
  return human || englishTracks[0];
}

function formatMmSs(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function extractRunsText(titleField) {
  if (!titleField) return null;
  if (typeof titleField.simpleText === 'string') return titleField.simpleText;
  if (Array.isArray(titleField.runs)) {
    return titleField.runs.map(r => (r && r.text) || '').join('');
  }
  return null;
}

function normalizeChapters(rawChapters) {
  if (!Array.isArray(rawChapters)) return [];
  const out = [];
  for (const entry of rawChapters) {
    const r = entry && entry.chapterRenderer;
    if (!r) continue;
    const title = extractRunsText(r.title);
    const startMs = Number(r.timeRangeStartMillis);
    if (title && Number.isFinite(startMs)) {
      out.push({ title, startMs });
    }
  }
  return out;
}

function buildClaudeInput(prompt, payload) {
  const meta = {
    title: payload.title || '',
    channel: payload.channel || '',
    uploadDate: payload.uploadDate || '',
    durationSec: Number(payload.durationSec) || 0,
    watchUrl: payload.watchUrl || '',
    chapters: Array.isArray(payload.chapters) ? payload.chapters : [],
    verbosity: Number(payload.verbosity) || 180,
  };
  const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
  const lines = transcript.map(entry => `[${formatMmSs(entry.startMs)}] ${entry.text}`);
  return [
    prompt,
    '',
    'METADATA:',
    JSON.stringify(meta, null, 2),
    '',
    'TRANSCRIPT:',
    lines.join('\n'),
  ].join('\n');
}

function renderYouTubeOutput(meta, bodyFragment) {
  const title = htmlEscape(meta.title);
  const channel = htmlEscape(meta.channel);
  const watchUrl = htmlEscape(meta.watchUrl);
  const thumbnailUrl = htmlEscape(meta.thumbnailUrl);
  const duration = htmlEscape(formatDuration(meta.durationSec));
  const uploadDate = htmlEscape(formatUploadDate(meta.uploadDate));

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="header-title"><strong>${title}</strong> &nbsp; ${channel}</div>
      <a class="header-link" href="${watchUrl}" target="_blank">Watch on YouTube</a>
    </div>
  </header>
  <main>
    <div class="yt-meta-card">
      <a href="${watchUrl}" target="_blank"><img src="${thumbnailUrl}" alt=""></a>
      <div class="yt-meta-body">
        <div class="yt-meta-title">${title}</div>
        <div class="yt-meta-sub">${channel} · ${uploadDate} · ${duration}</div>
        <div class="yt-meta-url">${watchUrl}</div>
      </div>
    </div>
    <div class="yt-body">
    ${bodyFragment}
    </div>
  </main>
</body>
</html>
`;
}

module.exports = {
  htmlEscape, slugify, formatDuration, formatUploadDate,
  resolveCaptionTrack, formatMmSs, normalizeChapters, buildClaudeInput,
  renderYouTubeOutput,
};
