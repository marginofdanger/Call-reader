const express = require('express');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = 3210;
const OUTPUT_DIR = path.resolve(__dirname, '..', 'output');
const PROMPT_PATH = path.resolve(__dirname, 'prompt.txt');
const SERVER_LOG = path.resolve(__dirname, 'server.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(SERVER_LOG, line + '\n');
}

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve output files at /output/filename.html
app.use('/output', express.static(OUTPUT_DIR));

// Request queue — one at a time
const queue = [];
let processing = false;
let currentJob = null;
const LOG_PATH = path.resolve(__dirname, '..', 'output', 'history.json');
// Load history from disk
let completedJobs = [];
try { completedJobs = JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8')); } catch (e) {}

// Bookmarks
const BOOKMARKS_PATH = path.resolve(__dirname, '..', 'output', 'bookmarks.json');
let bookmarks = [];
try { bookmarks = JSON.parse(fs.readFileSync(BOOKMARKS_PATH, 'utf-8')); } catch (e) {}

// Job tracking for async polling
let jobCounter = 0;
const jobs = new Map(); // jobId -> { status, filename, error, company, quarter, year }

let queueIdCounter = 0;
function enqueue(fn, label) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject, label, queueId: ++queueIdCounter });
    processQueue();
  });
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  const { fn, resolve, reject } = queue.shift();
  try {
    resolve(await fn());
  } catch (e) {
    reject(e);
  } finally {
    processing = false;
    processQueue();
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', queued: queue.length, processing });
});

// Remove item from queue
app.get('/queue/remove', (req, res) => {
  const id = parseInt(req.query.id);
  const idx = queue.findIndex(q => q.queueId === id);
  if (idx >= 0) {
    const removed = queue.splice(idx, 1)[0];
    removed.reject(new Error('Cancelled by user'));
    log(`Removed from queue: ${removed.label} (queueId=${id})`);
  }
  res.redirect('/status');
});

app.get('/status', (req, res) => {
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Summarizer Status</title>
<meta http-equiv="refresh" content="5">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #faf8f5; color: #2c2418; margin: 0 auto; padding: 1.5rem 2rem; font-size: 0.9rem; max-width: 1600px; }
  h1 { font-size: 1.3rem; border-bottom: 2px solid #c4956a; padding-bottom: 0.5rem; margin-bottom: 1rem; }
  .columns { display: flex; gap: 2rem; }
  .col-status { flex: 1; min-width: 0; }
  .col-bookmarks { flex: 2; min-width: 0; }
  h3 { margin: 0.8rem 0 0.4rem; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
  .active { background: #d4edda; color: #155724; }
  .idle { background: #f0ebe3; color: #8b6d4e; }
  .queued-item { background: #fff3cd; color: #856404; padding: 0.4rem 0.7rem; border-radius: 4px; margin: 0.3rem 0; display: flex; justify-content: space-between; align-items: center; }
  .queued-item .q-remove { color: #b08000; text-decoration: none; font-size: 0.8rem; margin-left: 0.5rem; }
  .queued-item .q-remove:hover { color: #cc0000; }
  .done-item { background: #f0ebe3; padding: 0.4rem 0.7rem; border-radius: 0 4px 4px 0; margin: 0.3rem 0; display: flex; align-items: center; justify-content: space-between; font-size: 0.85rem; border-left: 3px solid #c4956a; gap: 0.5rem; }
  .done-item.expert { background: #edf2f8; border-left-color: #4a7ab5; }
  .done-item .done-left { flex: 1; min-width: 0; }
  .done-item .done-title { color: inherit; text-decoration: none; }
  .done-item .done-title:hover { text-decoration: underline; }
  .done-item .done-expert { font-size: 0.78rem; color: #6b7d94; }
  .done-item .done-right { flex-shrink: 0; white-space: nowrap; text-align: right; font-size: 0.78rem; }
  .time { color: #8b6d4e; }
  .bookmark-item { background: #edf2f8; border-left: 3px solid #4a7ab5; padding: 0.4rem 0.7rem; border-radius: 0 4px 4px 0; margin: 0.3rem 0; display: flex; align-items: center; justify-content: space-between; font-size: 0.85rem; gap: 0.5rem; }
  .bk-table { width: 100%; border-spacing: 0 0.3rem; }
  .bk-table td { vertical-align: middle; }
  .bk-table .bk-cell-title { padding: 0.4rem 0.7rem; background: #edf2f8; border-left: 3px solid #4a7ab5; border-radius: 0 4px 4px 0; }
  .bk-table .bk-cell-title a { color: #2c5282; text-decoration: none; font-weight: 400; font-size: 0.85rem; }
  .bk-table .bk-cell-title a:hover { text-decoration: underline; }
  .bk-table .bk-expert { font-size: 0.78rem; color: #6b7d94; }
  .bk-table .bk-cell-src { padding: 0.4rem 0.2rem; background: #edf2f8; font-size: 0.8rem; color: #4a7ab5; font-weight: 600; text-align: center; white-space: nowrap; width: 1.8rem; }
  .bk-table .bk-cell-date { padding: 0.4rem 0.2rem; background: #edf2f8; font-size: 0.8rem; color: #6b7d94; white-space: nowrap; width: 5rem; }
  .bk-table .bk-cell-remove { padding: 0.4rem 0.2rem 0.4rem 0; background: #edf2f8; width: 0.8rem; border-radius: 0 4px 4px 0; }
  .bk-table .bk-cell-remove a { color: #999; text-decoration: none; font-size: 0.8rem; }
  .bk-table .bk-cell-remove a:hover { color: #cc0000; }
  .bookmark-item .bk-remove { float: right; color: #999; cursor: pointer; text-decoration: none; font-size: 0.8rem; }
  .bookmark-item .bk-remove:hover { color: #cc0000; }
  .empty { color: #8b6d4e; font-style: italic; }
  .toggle-btn { cursor: pointer; user-select: none; }
  .toggle-btn:hover { opacity: 0.7; }
  .col-status { flex: 1.4; overflow: hidden; }
  .col-status.expanded { flex: 2.5; }
  .columns.expanded-status .col-bookmarks { flex: 0.5; }
</style>
<script>
function toggleCompleted() {
  const col = document.getElementById('col-status');
  const columns = document.getElementById('columns');
  const arrow = document.getElementById('toggle-arrow');
  if (col.classList.contains('expanded')) {
    col.classList.remove('expanded');
    columns.classList.remove('expanded-status');
    arrow.textContent = '▶';
    sessionStorage.removeItem('completedOpen');
  } else {
    col.classList.add('expanded');
    columns.classList.add('expanded-status');
    arrow.textContent = '▼';
    sessionStorage.setItem('completedOpen', '1');
  }
}

// Restore state after auto-refresh
if (sessionStorage.getItem('completedOpen') === '1') {
  document.addEventListener('DOMContentLoaded', function() { toggleCompleted(); });
}
</script>
</head><body>
<h1>BamSEC Summarizer</h1>
<p><strong>Status:</strong> <span class="badge ${processing ? 'active' : 'idle'}">${processing ? '⏳ Processing' : '✓ Idle'}</span></p>
${currentJob ? `<p><strong>Current:</strong> ${currentJob.company} ${currentJob.quarter} ${currentJob.year} (started ${Math.round((Date.now() - currentJob.startTime) / 1000)}s ago)</p>` : ''}
${queue.length > 0 ? `<h3>Queue (${queue.length})</h3>` + queue.map((q, i) => `<div class="queued-item"><span>${i + 1}. ${q.label || 'Unknown'}</span><a class="q-remove" href="/queue/remove?id=${q.queueId}" title="Cancel">✕</a></div>`).join('') : '<p>Queue empty</p>'}
<div class="columns" id="columns">
<div class="col-bookmarks" id="col-bookmarks">
<h3>★ Bookmarked (${bookmarks.length})</h3>
${bookmarks.length > 0 ? '<table class="bk-table">' + bookmarks.slice().reverse().map(b => {
  let dateStr = b.date || '';
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      dateStr = String(d.getDate()).padStart(2,'0') + '-' + months[d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
    }
  } catch(e) {}
  const m = dateStr.match(/^(\d{1,2})\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*(\d{4})$/i);
  if (m) dateStr = String(parseInt(m[1])).padStart(2,'0') + '-' + m[2].slice(0,3) + '-' + m[3].slice(-2);
  const isEC = b.source === 'EC';
  const bg = isEC ? '#f0ebe3' : '#edf2f8';
  const border = isEC ? '#c4956a' : '#4a7ab5';
  const srcColor = isEC ? '#8b6d4e' : '#4a7ab5';
  const linkColor = isEC ? '#5a4a3a' : '#2c5282';
  const localUrl = '/output/' + b.filename;
  const srcLink = b.url ? `<a href="${b.url}" target="_blank" style="color:${srcColor};text-decoration:none" title="Open original source">${b.source || ''}</a>` : (b.source || '');
  return `<tr><td class="bk-cell-title" style="background:${bg};border-left:3px solid ${border}"><a href="${localUrl}" target="_blank" style="color:${linkColor}">${b.title}</a>${b.expert ? `<div class="bk-expert">${b.expert}</div>` : ''}</td><td class="bk-cell-src" style="background:${bg}">${srcLink}</td><td class="bk-cell-date" style="background:${bg}">${dateStr}</td><td class="bk-cell-remove" style="background:${bg}"><a href="/bookmark/remove?filename=${encodeURIComponent(b.filename)}" title="Remove">✕</a></td></tr>`;
}).join('') + '</table>' : '<p class="empty">No bookmarks yet</p>'}
</div>
<div class="col-status" id="col-status">
<h3 class="toggle-btn" onclick="toggleCompleted()"><span id="toggle-arrow">▶</span> Completed (${completedJobs.length})</h3>
${completedJobs.length > 0 ? completedJobs.slice().reverse().map(j => {
  const isExpert = (j.company || '').startsWith('[Expert]');
  const cls = isExpert ? 'done-item expert' : 'done-item';
  // Split "[Expert] Title · Expert Role" into title and role
  let title = (j.company || '') + ' ' + (j.quarter || '') + ' ' + (j.year || '');
  let role = '';
  if (isExpert) {
    title = title.replace(/^\[Expert\]\s*/, '');
    const dotIdx = title.indexOf(' · ');
    if (dotIdx > -1) { role = title.slice(dotIdx + 3).trim(); title = title.slice(0, dotIdx).trim(); }
  }
  const link = j.filename ? `<a class="done-title" href="/output/${j.filename}" target="_blank">${title}</a>` : `<span class="done-title">${title}</span>`;
  const timeStr = j.date ? new Date(j.date).toLocaleDateString('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
  return `<div class="${cls}"><div class="done-left">${link}${role ? `<div class="done-expert">${role}</div>` : ''}</div><div class="done-right time">${timeStr} · ${j.timeSeconds}s</div></div>`;
}).join('') : '<p class="empty">None yet</p>'}
</div>
</div>
<p class="time" style="margin-top:1rem;text-align:center">Auto-refreshes every 5s</p>
</body></html>`;
  res.send(html);
});

// Poll for job completion
app.get('/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.post('/summarize', async (req, res) => {
  const { company, quarter, year, eventDate, sourceUrl } = req.body;
  const model = req.body.model || 'opus';

  // Support both split and legacy formats
  let transcript = req.body.transcript || '';
  if (!transcript && (req.body.preparedRemarks || req.body.qanda)) {
    const isConference = !quarter;
    const header = isConference
      ? `${company} - Conference${eventDate ? ` (${eventDate})` : ''}`
      : `${company} - ${quarter} ${year} Earnings Call${eventDate ? ` (${eventDate})` : ''}`;
    transcript = `${header}\n\n`;
    if (sourceUrl) transcript += `Source: ${sourceUrl}\n\n`;
    transcript += `=== PREPARED REMARKS ===\n\n${req.body.preparedRemarks}\n\n`;
    transcript += `=== QUESTIONS AND ANSWERS ===\n\n${req.body.qanda}`;
  }

  if (!transcript) {
    return res.status(400).json({ success: false, error: 'Missing transcript text' });
  }

  log(`POST /summarize: ${company} ${quarter} ${year} (transcript: ${transcript.length} chars)`);

  // Assign job ID and respond immediately
  const jobId = String(++jobCounter);
  jobs.set(jobId, { status: 'queued', company, quarter, year });

  const position = queue.length + (processing ? 1 : 0);
  if (position > 0) {
    log(`Queued: ${company} ${quarter} ${year} (position ${position + 1})`);
  }

  // Respond immediately so the extension doesn't time out
  res.json({ success: true, jobId, queued: position > 0 });

  // Process in background
  const label = `${company} ${quarter} ${year}`;
  enqueue(async () => {
    const startTime = Date.now();
    currentJob = { company, quarter, year, startTime };
    jobs.set(jobId, { status: 'processing', company, quarter, year });
    log(`Summarizing: ${label} [model=${model}]`);

    try {
      const promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf-8');
      const fullPrompt = `${promptTemplate}\n\n---\n\nTRANSCRIPT:\n\n${transcript}`;

      const html = await new Promise((resolve, reject) => {
        const chunks = [];
        const errChunks = [];
        const child = spawn('claude', ['-p', '--output-format', 'text', '--tools', '', '--model', model], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 300000
        });
        child.stdout.on('data', d => chunks.push(d));
        child.stderr.on('data', d => errChunks.push(d));
        child.on('close', code => {
          if (code !== 0) {
            reject(new Error(`Claude exited ${code}: ${Buffer.concat(errChunks).toString()}`));
          } else {
            resolve(Buffer.concat(chunks).toString());
          }
        });
        child.on('error', err => reject(err));
        child.stdin.write(fullPrompt);
        child.stdin.end();
      });

      const sanitized = (company || 'UNKNOWN')
        .replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toUpperCase();
      const filename = `${sanitized}-${quarter || 'QX'}-${year || new Date().getFullYear()}.html`;
      const outputPath = path.join(OUTPUT_DIR, filename);

      // Inject bookmark data attributes server-side for earnings calls — strip any Claude-generated data-* attrs first
      let finalHtml = html;
      const earningsSource = 'EC';
      const earningsDate = eventDate || `${quarter} ${year}`;
      finalHtml = finalHtml.replace(/(<(?:button|a)[^>]*id="bookmark-btn")[^>]*>/, (match, prefix) => {
        const cleaned = prefix.replace(/\s+data-[a-z-]+="[^"]*"/gi, '');
        const hasOnclick = /onclick/.test(cleaned);
        return `${cleaned} data-source-url="${(sourceUrl || '').replace(/"/g, '&quot;')}" data-interview-date="${earningsDate.replace(/"/g, '&quot;')}" data-source="${earningsSource}" data-expert="${(company || '').replace(/"/g, '&quot;')}"${hasOnclick ? '' : ' onclick="bookmarkTranscript()"'}>`;
      });

      // Inject status link before closing </body>
      const statusLink = `\n<footer style="max-width:90ch;margin:2rem auto 1rem;padding-top:0.75rem;border-top:1px solid #e8e0d4;text-align:right;font-size:0.7rem"><a href="http://localhost:3210/status" style="color:#8b6d4e;text-decoration:none">Summarizer Status ↗</a></footer>\n`;
      finalHtml = finalHtml.replace('</body>', statusLink + '</body>');
      fs.writeFileSync(outputPath, finalHtml, 'utf-8');

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`Saved: ${outputPath} (${totalTime}s) [${queue.length} remaining in queue]`);
      completedJobs.push({ company, quarter, year, timeSeconds: parseFloat(totalTime), date: new Date().toISOString(), filename });
      try { fs.writeFileSync(LOG_PATH, JSON.stringify(completedJobs, null, 2)); } catch (e) {}
      currentJob = null;

      jobs.set(jobId, { status: 'done', filename, company, quarter, year, timeSeconds: parseFloat(totalTime) });
    } catch (error) {
      log(`ERROR Summarization failed: ${error.message}`);
      currentJob = null;
      jobs.set(jobId, { status: 'error', error: error.message, company, quarter, year });
    }
  }, label);
});

// Expert transcript summarization
const EXPERT_PROMPT_PATH = path.resolve(__dirname, 'prompt-expert.txt');

app.post('/summarize-expert', async (req, res) => {
  const { title, transcript, primaryCompany, interviewDate, expertPerspective, source, sourceUrl } = req.body;
  const model = req.body.model || 'opus';

  if (!transcript || transcript.length < 200) {
    return res.status(400).json({ success: false, error: 'Missing or too short transcript text' });
  }

  // Build metadata header for Claude
  let header = `Expert Interview: ${title || 'Unknown'}\n`;
  if (primaryCompany) header += `Primary Company: ${primaryCompany}\n`;
  if (expertPerspective) header += `Expert: ${expertPerspective}\n`;
  if (interviewDate) header += `Interview Date: ${interviewDate}\n`;
  if (source) header += `Source: ${source}\n`;
  if (sourceUrl) header += `Source URL: ${sourceUrl}\n`;

  const fullTranscript = `${header}\n---\n\n${transcript}`;

  log(`POST /summarize-expert: "${title}" company=${primaryCompany || 'none'} expert=${expertPerspective || 'none'} source=${source || 'none'} (transcript: ${transcript.length} chars)`);

  // Assign job ID and respond immediately
  const jobId = String(++jobCounter);
  // Build a richer label: company + truncated title + expert perspective
  const labelParts = [];
  if (primaryCompany) labelParts.push(primaryCompany);
  if (expertPerspective) labelParts.push(expertPerspective);
  if (!labelParts.length && title) labelParts.push(title.length > 60 ? title.slice(0, 57) + '...' : title);
  const label = `[Expert] ${labelParts.join(' · ') || 'Unknown'}`;
  jobs.set(jobId, { status: 'queued', company: label, quarter: '', year: '' });

  const position = queue.length + (processing ? 1 : 0);
  if (position > 0) {
    log(`Queued: ${label} (position ${position + 1})`);
  }

  res.json({ success: true, jobId, queued: position > 0 });

  // Process in background
  enqueue(async () => {
    const startTime = Date.now();
    currentJob = { company: label, quarter: '', year: '', startTime };
    jobs.set(jobId, { status: 'processing', company: label, quarter: '', year: '' });
      log(`Summarizing expert transcript: ${label} [model=${model}]`);

    try {
      const promptTemplate = fs.readFileSync(EXPERT_PROMPT_PATH, 'utf-8');
      const fullPrompt = `${promptTemplate}\n\n---\n\nTRANSCRIPT:\n\n${fullTranscript}`;

      const html = await new Promise((resolve, reject) => {
        const chunks = [];
        const errChunks = [];
        const child = spawn('claude', ['-p', '--output-format', 'text', '--tools', '', '--model', model], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 300000
        });
        child.stdout.on('data', d => chunks.push(d));
        child.stderr.on('data', d => errChunks.push(d));
        child.on('close', code => {
          if (code !== 0) {
            reject(new Error(`Claude exited ${code}: ${Buffer.concat(errChunks).toString()}`));
          } else {
            resolve(Buffer.concat(chunks).toString());
          }
        });
        child.on('error', err => reject(err));
        child.stdin.write(fullPrompt);
        child.stdin.end();
      });

      // Generate filename from title or company
      const nameSource = primaryCompany || title || 'EXPERT';
      const sanitized = nameSource
        .replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toUpperCase();
      const datePart = interviewDate ? interviewDate.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '') : new Date().toISOString().slice(0, 10);
      const filename = `EXPERT-${sanitized}-${datePart}.html`;
      const outputPath = path.join(OUTPUT_DIR, filename);

      // Determine source abbreviation
      const srcAbbrev = (source || '').toLowerCase().includes('alphasights') ? 'AS' : 'TG';

      // Extract expert role from Claude's generated header metadata line
      // The metadata line typically contains: "Role, Company · TG · 15 Sep 2025"
      // Look for the meta/subtitle span in the header
      let expertDesc = expertPerspective || '';
      // Extract the full text content of the header-meta div, stripping HTML tags
      const metaMatch = html.match(/class="[^"]*meta[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      if (metaMatch) {
        const metaText = metaMatch[1].replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim();
        const parts = metaText.split('·').map(s => s.trim());
        // The role is everything before the source abbreviation
        const roleParts = [];
        for (const p of parts) {
          if (/^(TG|AS|AlphaSense|AlphaSights)$/i.test(p)) break;
          if (/^\d{1,2}\s/.test(p) || /^\d{4}/.test(p) || /unknown/i.test(p)) break;
          roleParts.push(p);
        }
        if (roleParts.length > 0) expertDesc = roleParts.join(' · ');
      }

      // Inject bookmark data attributes server-side — strip any Claude-generated data-* attrs first to avoid duplicates
      let finalHtml = html;
      finalHtml = finalHtml.replace(/(<(?:button|a)[^>]*id="bookmark-btn")[^>]*>/, (match, prefix) => {
        // Strip all existing data-* attributes
        const cleaned = prefix.replace(/\s+data-[a-z-]+="[^"]*"/gi, '');
        // Re-add onclick if it was removed
        const hasOnclick = /onclick/.test(cleaned);
        return `${cleaned} data-source-url="${(sourceUrl || '').replace(/"/g, '&quot;')}" data-interview-date="${(interviewDate || '').replace(/"/g, '&quot;')}" data-source="${srcAbbrev}" data-expert="${(expertDesc || '').replace(/"/g, '&quot;')}"${hasOnclick ? '' : ' onclick="bookmarkTranscript()"'}>`;
      });

      // Inject status link before closing </body>
      const statusLink = `\n<footer style="max-width:90ch;margin:2rem auto 1rem;padding-top:0.75rem;border-top:1px solid #e8e0d4;text-align:right;font-size:0.7rem"><a href="http://localhost:3210/status" style="color:#8b6d4e;text-decoration:none">Summarizer Status ↗</a></footer>\n`;
      finalHtml = finalHtml.replace('</body>', statusLink + '</body>');
      fs.writeFileSync(outputPath, finalHtml, 'utf-8');

      // Extract richer title from Claude's generated HTML for the completed list
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i) || html.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</i);
      const richTitle = titleMatch ? titleMatch[1].replace(/\s*[-–—]\s*.*Summary$/i, '').trim() : '';
      const richLabel = richTitle ? `[Expert] ${richTitle}` : label;
      const completedLabel = expertDesc ? `${richLabel} · ${expertDesc}` : richLabel;

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`Saved: ${outputPath} (${totalTime}s) [${queue.length} remaining in queue]`);
      completedJobs.push({ company: completedLabel, quarter: '', year: '', timeSeconds: parseFloat(totalTime), date: new Date().toISOString(), filename });
      try { fs.writeFileSync(LOG_PATH, JSON.stringify(completedJobs, null, 2)); } catch (e) {}
      currentJob = null;

      jobs.set(jobId, { status: 'done', filename, company: completedLabel, quarter: '', year: '', timeSeconds: parseFloat(totalTime) });
    } catch (error) {
      log(`ERROR Expert summarization failed: ${error.message}`);
      currentJob = null;
      jobs.set(jobId, { status: 'error', error: error.message, company: label, quarter: '', year: '' });
    }
  }, label);
});

// Bookmark toggle
app.post('/bookmark', (req, res) => {
  const { title, url, filename, interviewDate, source, expert } = req.body;
  const idx = bookmarks.findIndex(b => b.filename === filename);
  if (idx >= 0) {
    bookmarks.splice(idx, 1);
    try { fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2)); } catch (e) {}
    res.json({ bookmarked: false });
  } else {
    bookmarks.push({ title, url, filename, date: interviewDate || '', source: source || '', expert: expert || '' });
    try { fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2)); } catch (e) {}
    res.json({ bookmarked: true });
  }
});

// Remove bookmark via GET (for status page links)
app.get('/bookmark/remove', (req, res) => {
  const filename = req.query.filename;
  const idx = bookmarks.findIndex(b => b.filename === filename);
  if (idx >= 0) bookmarks.splice(idx, 1);
  try { fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(bookmarks, null, 2)); } catch (e) {}
  res.redirect('/status');
});

app.listen(PORT, () => {
  log(`BamSEC Summarizer server running at http://localhost:${PORT}`);
});
