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

module.exports = {
  htmlEscape, slugify, formatDuration, formatUploadDate,
  resolveCaptionTrack, formatMmSs, normalizeChapters,
};
