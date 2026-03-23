(function () {
  const doc = document;
  const bodyText = doc.body.innerText || '';

  // --- Detect platform ---
  const hostname = window.location.hostname;
  let source = '';
  if (hostname.includes('tegus')) source = 'Tegus';
  else if (hostname.includes('alpha-sense') || hostname.includes('alphasense')) source = 'AlphaSense';
  else if (hostname.includes('alphasights')) source = 'AlphaSights';
  else source = hostname;

  // --- Detect if this frame has actual transcript content ---
  // AlphaSense: "Client  00:00:00" / "Expert  00:00:20" with timestamps
  const timestampSpeakerCount = (bodyText.match(/\b(Client|Expert|Analyst|Interviewer|Interviewee)\b.*?\d{1,2}:\d{2}:\d{2}/gi) || []).length;
  const hasInterviewTranscriptHeading = /INTERVIEW\s*TRANSCRIPT/i.test(bodyText);
  const clientExpertCount = (bodyText.match(/\b(Client|Expert)\b/gi) || []).length;

  // AlphaSights: "Interviewer" labels appear as headings, may have icons/whitespace around them
  const interviewerCount = (bodyText.match(/\bInterviewer\b/gi) || []).length;

  const isTranscriptFrame =
    timestampSpeakerCount >= 3 ||
    (hasInterviewTranscriptHeading && clientExpertCount >= 4) ||
    (source === 'AlphaSights' && interviewerCount >= 3) ||
    (interviewerCount >= 3 && bodyText.length > 3000);

  if (!isTranscriptFrame) {
    return;
  }

  // --- Extract metadata ---
  let title = '';
  let interviewDate = '';
  let datePublished = '';
  let expertPerspective = '';
  let analystPerspective = '';
  let primaryCompany = '';

  const h1 = doc.querySelector('h1');
  if (h1) title = h1.textContent.trim();

  const metaPatterns = {
    interviewDate: /INTERVIEW\s*DATE\s*\n?\s*(.+)/i,
    datePublished: /DATE\s*PUBLISHED\s*\n?\s*(.+)/i,
    expertPerspective: /EXPERT\s*PERSPECTIVE\s*\n?\s*(.+)/i,
    analystPerspective: /ANALYST\s*PERSPECTIVE\s*\n?\s*(.+)/i,
    primaryCompany: /PRIMARY\s*COMPANY\s*\n?\s*(.+)/i,
  };

  for (const [key, pattern] of Object.entries(metaPatterns)) {
    const match = bodyText.match(pattern);
    if (match) {
      const val = match[1].trim().split('\n')[0].trim();
      if (key === 'interviewDate') interviewDate = val;
      else if (key === 'datePublished') datePublished = val;
      else if (key === 'expertPerspective') expertPerspective = val;
      else if (key === 'analystPerspective') analystPerspective = val;
      else if (key === 'primaryCompany') primaryCompany = val;
    }
  }

  // --- AlphaSights-specific metadata ---
  // Title is in the panel header (e.g., "Fairway Independent Mortgage Corporation - EVP, Enterprise Applications")
  if (source === 'AlphaSights') {
    // Try to get title from the panel header or the visible heading
    if (!title) {
      // Look for headings that contain company + role pattern
      const headings = doc.querySelectorAll('h1, h2, h3, [class*="title"], [class*="header"]');
      for (const h of headings) {
        const text = h.textContent.trim();
        if (text.length > 20 && text.length < 200 && /\s-\s/.test(text)) {
          title = text;
          break;
        }
      }
    }
    // Extract company from title (before the dash)
    if (title && !primaryCompany) {
      const compMatch = title.match(/^(.+?)\s*-\s*/);
      if (compMatch) primaryCompany = compMatch[1].trim();
    }
    // Look for tags/labels that might have the ticker or company
    const tags = doc.querySelectorAll('[class*="tag"], [class*="badge"], [class*="chip"]');
    for (const tag of tags) {
      const text = tag.textContent.trim();
      if (/^[A-Z]{1,5}$/.test(text) && !primaryCompany) {
        primaryCompany = text;
      }
    }
    // Extract date — look for selected/active sidebar item or any date near the title
    if (!interviewDate) {
      // Look for active/selected list item that contains a date
      const activeItems = doc.querySelectorAll('[class*="active"], [class*="selected"], [aria-selected="true"], [class*="highlight"]');
      for (const item of activeItems) {
        const dateMatch = item.textContent.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i);
        if (dateMatch) { interviewDate = dateMatch[1]; break; }
      }
    }
    // Fallback: look for a date pattern anywhere in the page near the "Details" tab content
    if (!interviewDate) {
      const dateMatch = bodyText.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:uary|ruary|ch|il|e|y|ust|ember|ober|ember)?\s+\d{4})/i);
      if (dateMatch) interviewDate = dateMatch[1];
    }
  }

  // --- Extract transcript text ---
  let transcriptText = '';

  if (source === 'AlphaSights') {
    // AlphaSights: transcript is in the "Transcript" tab panel
    // Speaker labels are "Interviewer" or "Company - Role | Name"
    // Collect all visible text in the transcript panel
    // Look for the transcript tab content — it contains Interviewer/Expert alternating blocks

    // Try to find the transcript container
    const allText = bodyText;
    // Find first "Interviewer" occurrence as start of transcript
    const firstInterviewer = allText.search(/\bInterviewer\b/);
    if (firstInterviewer > -1) {
      let asText = allText.slice(Math.max(0, firstInterviewer));
      // Trim trailing sections
      const asEndPatterns = [/Related\s*Interviews/i, /Related\s*Transcripts/i, /Talk\s*to\s*this\s*Expert/i, /EXPERT\s*BIO/i, /Disclaimer/i];
      for (const pat of asEndPatterns) {
        const m = asText.search(pat);
        if (m > 0) asText = asText.slice(0, m);
      }
      transcriptText = asText.trim();
    } else {
      transcriptText = allText;
    }
  } else {
    // AlphaSense / Tegus: start from "INTERVIEW TRANSCRIPT" if present
    let startIdx = bodyText.search(/INTERVIEW\s*TRANSCRIPT/i);
    if (startIdx === -1) startIdx = 0;

    let endIdx = bodyText.length;
    const endPatterns = [/TABLE\s*OF\s*CONTENTS/i, /EXPERT\s*BIO/i, /Talk\s*to\s*this\s*Expert/i, /Related\s*Transcripts/i, /Related\s*Interviews/i, /Disclaimer/i, /View\s*More\s*$/im];
    for (const pat of endPatterns) {
      const m = bodyText.slice(startIdx).search(pat);
      if (m > 0 && (startIdx + m) < endIdx) endIdx = startIdx + m;
    }

    transcriptText = bodyText.slice(startIdx, endIdx).trim();
  }

  if (!transcriptText || transcriptText.length < 500) {
    return;
  }

  if (!title) title = document.title || 'Expert Interview';

  // Try to extract company/ticker from text
  if (!primaryCompany) {
    const tickerMatch = bodyText.match(/^([A-Z]{1,5})\s+[A-Z][a-zA-Z\s]+(?:Corp|Inc|Ltd|Co|Group|Holdings)/m);
    if (tickerMatch) primaryCompany = tickerMatch[1];
  }

  chrome.runtime.sendMessage({
    type: 'expert-transcript',
    data: {
      transcript: transcriptText,
      title,
      interviewDate,
      datePublished,
      expertPerspective,
      primaryCompany,
      analystPerspective,
      source,
      sourceUrl: (() => { try { return window.top.location.href; } catch (e) { return window.location.href; } })()
    }
  });
})();
