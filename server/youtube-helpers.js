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

module.exports = { htmlEscape, slugify, formatDuration, formatUploadDate };
