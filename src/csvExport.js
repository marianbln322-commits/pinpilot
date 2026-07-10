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
  const base = config.publicBaseUrl || reqBaseUrl || '';
  return `${base}/uploads/${pin.filename}`;
}

// Pinterest expects publish date like "YYYY-MM-DD HH:mm" (24h).
function formatPublishDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function pinsToCsv(pins, reqBaseUrl) {
  const boards = effectiveBoards();
  const boardName = (pin) => pin.boardName || boards.find((b) => b.id === pin.boardId)?.name || '';

  const header = ['Title', 'Media URL', 'Pinterest board', 'Thumbnail', 'Description', 'Link', 'Publish date', 'Keywords'];
  const rows = [header.join(',')];

  for (const pin of pins) {
    const row = [
      csvEscape(pin.title),
      csvEscape(mediaUrl(pin, reqBaseUrl)),
      csvEscape(boardName(pin)),
      '', // Thumbnail (videos only)
      csvEscape(pin.description),
      csvEscape(pin.link || ''),
      csvEscape(formatPublishDate(pin.scheduledAt)),
      csvEscape((pin.keywords || []).join(', ')),
    ];
    rows.push(row.join(','));
  }
  return rows.join('\r\n');
}
