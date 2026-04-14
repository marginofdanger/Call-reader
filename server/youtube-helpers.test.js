const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  htmlEscape,
  slugify,
  formatDuration,
  formatUploadDate,
} = require('./youtube-helpers');

test('htmlEscape escapes the five basic characters', () => {
  assert.equal(htmlEscape('<p>"a" & \'b\'</p>'), '&lt;p&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/p&gt;');
});

test('htmlEscape passes through plain text', () => {
  assert.equal(htmlEscape('hello world'), 'hello world');
});

test('htmlEscape handles empty string and non-string inputs gracefully', () => {
  assert.equal(htmlEscape(''), '');
  assert.equal(htmlEscape(null), '');
  assert.equal(htmlEscape(undefined), '');
});

test('slugify lowercases and replaces non-alphanumerics with hyphens', () => {
  assert.equal(slugify('The GPU Economics of Frontier Labs'), 'the-gpu-economics-of-frontier-labs');
});

test('slugify collapses runs of separators and trims edges', () => {
  assert.equal(slugify('  Hello!!  World??  '), 'hello-world');
});

test('slugify truncates to 60 characters at a word boundary', () => {
  const long = 'this is a very long title that keeps going and going past sixty characters easily';
  const result = slugify(long);
  assert.ok(result.length <= 60, `expected <=60, got ${result.length}: ${result}`);
  assert.ok(!result.endsWith('-'), 'should not end with a hyphen');
});

test('slugify returns "untitled" for empty or symbol-only input', () => {
  assert.equal(slugify(''), 'untitled');
  assert.equal(slugify('!!!'), 'untitled');
  assert.equal(slugify(null), 'untitled');
});

test('formatDuration under one hour shows minutes only', () => {
  assert.equal(formatDuration(42 * 60), '42m');
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(59), '0m');
  assert.equal(formatDuration(60), '1m');
});

test('formatDuration one hour or more shows hours and minutes', () => {
  assert.equal(formatDuration(3600), '1h 0m');
  assert.equal(formatDuration(3600 + 47 * 60), '1h 47m');
  assert.equal(formatDuration(2 * 3600 + 5 * 60), '2h 5m');
});

test('formatDuration accepts numeric string input (YT returns strings)', () => {
  assert.equal(formatDuration('6420'), '1h 47m');
});

test('formatUploadDate renders ISO YYYY-MM-DD as "Mon D, YYYY"', () => {
  assert.equal(formatUploadDate('2026-04-02'), 'Apr 2, 2026');
  assert.equal(formatUploadDate('2025-12-31'), 'Dec 31, 2025');
});

test('formatUploadDate handles full ISO datetime strings', () => {
  assert.equal(formatUploadDate('2026-04-02T12:34:56Z'), 'Apr 2, 2026');
});

test('formatUploadDate returns empty string on invalid input', () => {
  assert.equal(formatUploadDate(''), '');
  assert.equal(formatUploadDate('not-a-date'), '');
  assert.equal(formatUploadDate(null), '');
});

const { resolveCaptionTrack } = require('./youtube-helpers');

const track = (languageCode, kind, baseUrl) => ({ languageCode, kind, baseUrl });

test('resolveCaptionTrack prefers human English over auto English', () => {
  const tracks = [
    track('en', 'asr', 'auto-en'),
    track('en', undefined, 'human-en'),
    track('es', undefined, 'human-es'),
  ];
  assert.equal(resolveCaptionTrack(tracks).baseUrl, 'human-en');
});

test('resolveCaptionTrack falls back to auto English if no human English', () => {
  const tracks = [
    track('en', 'asr', 'auto-en'),
    track('es', undefined, 'human-es'),
  ];
  assert.equal(resolveCaptionTrack(tracks).baseUrl, 'auto-en');
});

test('resolveCaptionTrack returns null when no English track exists', () => {
  const tracks = [
    track('es', undefined, 'human-es'),
    track('fr', 'asr', 'auto-fr'),
  ];
  assert.equal(resolveCaptionTrack(tracks), null);
});

test('resolveCaptionTrack returns null on null/empty input', () => {
  assert.equal(resolveCaptionTrack(null), null);
  assert.equal(resolveCaptionTrack([]), null);
});

test('resolveCaptionTrack treats en-US, en-GB as English', () => {
  const tracks = [
    track('en-GB', undefined, 'human-gb'),
    track('es', undefined, 'human-es'),
  ];
  assert.equal(resolveCaptionTrack(tracks).baseUrl, 'human-gb');
});
