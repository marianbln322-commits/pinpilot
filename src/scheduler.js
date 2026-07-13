// Internal scheduler: spreads pins across days/hours and (Stage 2) publishes
// due pins via the Pinterest API. Pinterest's API has no native "publish
// later" for organic pins, so we queue and release them ourselves.
import { getPins, getSettings, updatePin, effectiveBoards, getAccounts } from './store.js';
import { createPinOnPinterest } from './pinterestClient.js';

/**
 * Assign scheduled times to pins that are approved but not yet scheduled.
 * Distributes `pinsPerDay` pins across the configured posting hours.
 */
export function buildSchedule() {
  const settings = getSettings();
  const pins = getPins().filter((p) => p.status === 'ready' || p.status === 'scheduled');

  const hours = (settings.postingHours && settings.postingHours.length
    ? settings.postingHours
    : [7, 10, 13, 16, 19, 21]).slice().sort((a, b) => a - b);

  const perDay = Math.max(1, Number(settings.pinsPerDay) || hours.length);

  // Start tomorrow at first slot unless a startDate is set.
  const start = settings.startDate ? new Date(settings.startDate) : new Date(Date.now() + 24 * 3600 * 1000);
  start.setHours(0, 0, 0, 0);

  // Build `perDay` DISTINCT times, evenly spread across the day window
  // (from the earliest to the latest posting hour). No two pins share a slot.
  const startMin = hours[0] * 60;
  const endMin = Math.min(23 * 60 + 59, hours[hours.length - 1] * 60 + 59);
  const span = Math.max(1, endMin - startMin);
  const daySlots = [];
  const usedMin = new Set();
  for (let i = 0; i < perDay; i++) {
    let m = perDay === 1 ? startMin : Math.round(startMin + (i * span) / (perDay - 1));
    while (usedMin.has(m)) m++; // guarantee every time is unique
    usedMin.add(m);
    daySlots.push(m);
  }

  const scheduled = [];
  pins.forEach((pin, i) => {
    const dayOffset = Math.floor(i / perDay);
    const m = daySlots[i % perDay];
    const when = new Date(start);
    when.setDate(start.getDate() + dayOffset);
    when.setHours(Math.floor(m / 60), m % 60, 0, 0);

    updatePin(pin.id, { scheduledAt: when.toISOString(), status: 'scheduled' });
    scheduled.push({ id: pin.id, scheduledAt: when.toISOString() });
  });
  return scheduled;
}

let timer = null;

/**
 * Background tick: publishes pins whose scheduledAt is due (Stage 2 only).
 * Safe no-op when Pinterest isn't connected.
 */
async function tick() {
  if (!getAccounts().length) return; // Stage 1: nothing to auto-publish

  const now = Date.now();
  const due = getPins().filter(
    (p) => p.status === 'scheduled' && p.scheduledAt && new Date(p.scheduledAt).getTime() <= now
  );

  const boards = effectiveBoards();
  for (const pin of due) {
    try {
      updatePin(pin.id, { status: 'publishing' });
      const board = boards.find((b) => b.id === pin.boardId);
      const result = await createPinOnPinterest(pin, board);
      updatePin(pin.id, { status: 'published', pinterestPinId: result.id, publishedAt: new Date().toISOString(), error: null });
      console.log(`Published pin ${pin.id} -> Pinterest ${result.id}`);
    } catch (e) {
      updatePin(pin.id, { status: 'error', error: e.message });
      console.error(`Failed to publish pin ${pin.id}: ${e.message}`);
    }
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((e) => console.error('Scheduler tick error:', e.message));
  }, 60 * 1000); // check every minute
  console.log('Scheduler started (checks every 60s).');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
