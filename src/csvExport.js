// Export pins to Pinterest's "Bulk create Pins" CSV format.
// Columns match Pinterest's bulk upload template:
// Title, Media URL, Pinterest board, Thumbnail, Description, Link, Publish date, Keywords
import { config } from './config.js';
import { effectiveBoards } from './store.js';

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build the public URL Pinterest can fetch the image from.
 * Requires PUBLIC_BASE_URL to be a publicly reachable host in production.
 */
function mediaUrl(pin, reqBaseUrl) {
  if (pin.hostedUrl) return pin.hostedUrl; // public URL Pinterest can fetch
  const base = config.publicBaseUrl || reqBaseUrl || '';
  return `${base}/uploads/${pin.filename}`;
}

// Pinterest rejects many pins that share the SAME destination link ("Duplicate
// Pin link"). We append a unique, stable tracking param per pin so every link
// is distinct (still opens the same page) — and you get UTM analytics for free.
function uniqueLink(pin) {
  if (!pin.link) return '';
  const tag = String(pin.id || '').replace(/-/g, '').slice(0, 10) || Math.random().toString(36).slice(2, 10);
  // Split off any #fragment (e.g. affiliate "#aff=xxx"): the tracking params
  // must go in the QUERY (before #), otherwise they land inside the fragment,
  // which Pinterest ignores -> links look identical -> "Duplicate Pin link".
  const hashIdx = pin.link.indexOf('#');
  const base = hashIdx === -1 ? pin.link : pin.link.slice(0, hashIdx);
  const frag = hashIdx === -1 ? '' : pin.link.slice(hashIdx);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}utm_source=pinterest&utm_medium=pin&utm_content=${tag}${frag}`;
}

// Pinterest requires ISO format "YYYY-MM-DDTHH:MM:SS" (UTC) or "YYYY-MM-DD".
// A space separator or missing seconds causes "date not formatted correctly".
function formatPublishDate(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, ''); // e.g. 2026-07-13T07:00:00
}

// Pinterest rejects rows that share the same Title ("Multiple rows with the
// same title"). Make each title unique, staying <= 100 chars.
function makeUniqueTitle(pin, used) {
  const base = String(pin.title || 'Pin').trim().slice(0, 100);
  if (!used.has(base.toLowerCase())) { used.add(base.toLowerCase()); return base; }
  const kw = pin.keywords && pin.keywords[0]
    ? pin.keywords[0].replace(/\b\w/g, (c) => c.toUpperCase())
    : '';
  const candidates = [];
  if (kw) candidates.push(`${base}: ${kw}`.slice(0, 100));
  for (let n = 2; n <= 60; n++) candidates.push(`${base} (${n})`.slice(0, 100));
  for (const c of candidates) {
    if (!used.has(c.toLowerCase())) { used.add(c.toLowerCase()); return c; }
  }
  const fallback = `${base.slice(0, 90)} ${Math.random().toString(36).slice(2, 6)}`;
  used.add(fallback.toLowerCase());
  return fallback;
}

export function pinsToCsv(pins, reqBaseUrl) {
  const boards = effectiveBoards();
  const boardName = (pin) => pin.boardName || boards.find((b) => b.id === pin.boardId)?.name || '';

  const header = ['Title', 'Media URL', 'Pinterest board', 'Thumbnail', 'Description', 'Link', 'Publish date', 'Keywords'];
  const rows = [header.join(',')];
  const usedTitles = new Set();

  for (const pin of pins) {
    const row = [
      csvEscape(makeUniqueTitle(pin, usedTitles)),
      csvEscape(mediaUrl(pin, reqBaseUrl)),
      csvEscape(boardName(pin)),
      '', // Thumbnail (videos only)
      csvEscape(pin.description),
      csvEscape(uniqueLink(pin)),
      csvEscape(formatPublishDate(pin.scheduledAt)),
      csvEscape((pin.keywords || []).join(', ')),
    ];
    rows.push(row.join(','));
  }
  return rows.join('\r\n');
}
