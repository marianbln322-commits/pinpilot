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
    : [9, 13, 17, 20]).slice().sort((a, b) => a - b);

  const perDay = Math.max(1, Number(settings.pinsPerDay) || hours.length);

  // Start tomorrow at first slot unless a startDate is set.
  const start = settings.startDate ? new Date(settings.startDate) : new Date(Date.now() + 24 * 3600 * 1000);
  start.setHours(0, 0, 0, 0);

  let dayOffset = 0;
  let slotInDay = 0;

  const scheduled = [];
  for (const pin of pins) {
    const hour = hours[slotInDay % hours.length];
    const when = new Date(start);
    when.setDate(start.getDate() + dayOffset);
    when.setHours(hour, (slotInDay * 7) % 60, 0, 0); // spread minutes a bit

    updatePin(pin.id, { scheduledAt: when.toISOString(), status: 'scheduled' });
    scheduled.push({ id: pin.id, scheduledAt: when.toISOString() });

    slotInDay++;
    if (slotInDay >= perDay || slotInDay >= hours.length * Math.ceil(perDay / hours.length)) {
      // move to next day once we've filled the day's slots
      if (slotInDay % hours.length === 0 && slotInDay >= perDay) {
        dayOffset++;
        slotInDay = 0;
      }
    }
    if (slotInDay >= perDay) {
      dayOffset++;
      slotInDay = 0;
    }
  }
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
