import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { config } from './src/config.js';
import {
  loadDb, getBoards, getSettings, updateSettings, addPin, updatePin,
  deletePin, getPins, setBoards, getAccounts, removeAccount, effectiveBoards,
} from './src/store.js';
import { generateForImage, aiEnabled, testKey } from './src/aiEngine.js';
import { buildSchedule, startScheduler } from './src/scheduler.js';
import { pinsToCsv } from './src/csvExport.js';
import { hostImage } from './src/imageHost.js';
import {
  getAuthUrl, isConfigured as pinterestConfigured, connectAccountFromCode,
  syncAccountBoards, syncAllBoards, createPinOnPinterest,
} from './src/pinterestClient.js';

loadDb();

const app = express();
app.use(express.json({ limit: '2mb' }));

// --- static ---
app.use('/', express.static(config.paths.public));
app.use('/uploads', express.static(config.paths.uploads));

// --- uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.paths.uploads),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`;
    cb(null, unique);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const reqBase = (req) => `${req.protocol}://${req.get('host')}`;

// ============================= API =============================

app.get('/api/health', (req, res) => {
  res.json({ ok: true, aiEnabled: aiEnabled(), pinterestConfigured: pinterestConfigured() });
});

// Verify the Gemini key and list which models actually work for this key.
app.get('/api/ai-test', async (req, res) => {
  res.json(await testKey());
});

app.get('/api/state', (req, res) => {
  const pins = getPins();
  res.json({
    aiEnabled: aiEnabled(),
    pinterestConfigured: pinterestConfigured(),
    accounts: getAccounts().map((a) => ({
      id: a.id, username: a.username, accountType: a.accountType, boardCount: (a.boards || []).length,
    })),
    boardsSource: getAccounts().some((a) => (a.boards || []).length) ? 'pinterest' : 'manual',
    settings: (() => {
      const s = { ...getSettings() };
      s.geminiKeySet = Boolean(s.geminiApiKey);
      s.pinterestSecretSet = Boolean(s.pinterestAppSecret);
      s.imgbbKeySet = Boolean(s.imgbbApiKey);
      delete s.geminiApiKey;        // never expose secrets to the client
      delete s.pinterestAppSecret;
      delete s.imgbbApiKey;
      return s;
    })(),
    boards: effectiveBoards(),
    pins,
    counts: pins.reduce((acc, p) => ((acc[p.status] = (acc[p.status] || 0) + 1), acc), {}),
  });
});

// --- boards ---
app.get('/api/boards', (req, res) => res.json(getBoards()));

app.post('/api/boards', (req, res) => {
  const { name, niche, keywords } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const boards = getBoards();
  if (boards.some((b) => b.id === id)) return res.status(409).json({ error: 'board exists' });
  boards.push({
    id,
    name,
    niche: niche || 'auto',
    keywords: Array.isArray(keywords) ? keywords : String(keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
  });
  updateSettings({}); // triggers save
  res.json(boards);
});

// Bulk import boards from a list of names (paste from Pinterest).
app.post('/api/boards/import', (req, res) => {
  const { names, replace } = req.body || {};
  const clean = (Array.isArray(names) ? names : []).map((s) => String(s).trim()).filter(Boolean);
  const toBoard = (name) => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'board-' + Math.random().toString(36).slice(2, 7),
    name,
    niche: 'auto',
    keywords: name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  });
  let boards = replace ? [] : getBoards().slice();
  const existing = new Set(boards.map((b) => b.id));
  for (const n of clean) {
    const b = toBoard(n);
    if (!existing.has(b.id)) { boards.push(b); existing.add(b.id); }
  }
  res.json(setBoards(boards));
});

app.delete('/api/boards/:id', (req, res) => {
  const boards = getBoards();
  const idx = boards.findIndex((b) => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  boards.splice(idx, 1);
  updateSettings({});
  res.json(boards);
});

// --- settings ---
app.post('/api/settings', (req, res) => {
  const allowed = ['destinationUrls', 'pinsPerDay', 'postingHours', 'startDate', 'defaultNiche', 'hashtags', 'language', 'tone', 'geminiApiKey', 'geminiModel', 'aiDelaySeconds', 'pinterestAppId', 'pinterestAppSecret', 'imgbbApiKey'];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  // Don't wipe saved secrets when the UI sends an empty (masked) field.
  if (patch.geminiApiKey === '') delete patch.geminiApiKey;
  if (patch.pinterestAppSecret === '') delete patch.pinterestAppSecret;
  if (patch.imgbbApiKey === '') delete patch.imgbbApiKey;
  res.json(updateSettings(patch));
});

// --- upload images ---
app.post('/api/upload', upload.array('images', 400), (req, res) => {
  const created = [];
  for (const file of req.files || []) {
    const pin = {
      id: crypto.randomUUID(),
      filename: file.filename,
      originalName: file.originalname,
      mime: file.mimetype,
      title: '',
      description: '',
      keywords: [],
      altText: '',
      boardId: null,
      link: '',
      status: 'uploaded', // uploaded -> ready -> scheduled -> published/error
      scheduledAt: null,
      createdAt: new Date().toISOString(),
    };
    addPin(pin);
    created.push(pin);
  }
  res.json({ created: created.length, pins: created });
});

// --- generate AI metadata ---
function assignLink(index) {
  const urls = getSettings().destinationUrls || [];
  if (!urls.length) return '';
  return urls[index % urls.length];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/api/generate', async (req, res) => {
  const boards = effectiveBoards();
  const settings = getSettings();
  const { ids, all, onlyMissing, limit } = req.body || {};
  // ids -> those pins; all/onlyMissing -> every editable pin; default -> new uploads.
  let selected = getPins().filter((p) => {
    if (ids) return ids.includes(p.id);
    if (all || onlyMissing) return ['uploaded', 'ready', 'error'].includes(p.status);
    return p.status === 'uploaded';
  });
  // onlyMissing: skip pins already written by AI (saves quota on re-runs).
  if (onlyMissing) selected = selected.filter((p) => p.generatedBy !== 'gemini');
  if (limit && limit > 0) selected = selected.slice(0, limit);

  let done = 0, aiUsed = 0, fallback = 0, lastError = null, dailyQuota = false;
  let linkIdx = getPins().filter((p) => p.link).length;
  for (let i = 0; i < selected.length; i++) {
    const pin = selected[i];
    try {
      const meta = await generateForImage(
        { imagePath: path.join(config.paths.uploads, pin.filename), filename: pin.originalName, mime: pin.mime },
        boards,
        settings
      );
      const hashtags = settings.hashtags ? ` ${settings.hashtags}` : '';
      if (meta._ai) aiUsed++; else fallback++;
      if (meta._error) lastError = meta._error;
      if (meta._dailyQuota) dailyQuota = true;
      const chosen = boards.find((b) => b.id === meta.board_id) || null;
      updatePin(pin.id, {
        title: meta.title,
        description: (meta.description + hashtags).slice(0, 500),
        keywords: meta.keywords,
        altText: meta.alt_text,
        boardId: meta.board_id,
        boardName: chosen ? chosen.name : '',
        accountId: chosen ? chosen.accountId || null : null,
        pinterestBoardId: chosen ? chosen.pinterestBoardId || null : null,
        link: pin.link || assignLink(linkIdx++),
        status: 'ready',
        generatedBy: meta._ai ? 'gemini' : 'template',
        genError: meta._error || null,
      });
      done++;
      if (meta._dailyQuota) break; // daily quota exhausted — stop, try again tomorrow
      // Throttle between real AI calls (configurable; lower it if billing is enabled).
      const delayMs = Math.max(0, (Number(settings.aiDelaySeconds ?? 4.5)) * 1000);
      if (aiEnabled() && delayMs && i < selected.length - 1) await sleep(delayMs);
    } catch (e) {
      updatePin(pin.id, { status: 'error', error: e.message });
    }
  }
  const remaining = getPins().filter(
    (p) => ['uploaded', 'ready', 'error'].includes(p.status) && p.generatedBy !== 'gemini'
  ).length;
  res.json({ generated: done, total: selected.length, aiUsed, fallback, lastError, dailyQuota, remaining });
});

// --- edit / delete a pin ---
app.put('/api/pins/:id', (req, res) => {
  const allowed = ['title', 'description', 'keywords', 'boardId', 'link', 'altText', 'scheduledAt', 'status'];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  const pin = updatePin(req.params.id, patch);
  if (!pin) return res.status(404).json({ error: 'not found' });
  res.json(pin);
});

app.post('/api/pins/:id/regenerate', async (req, res) => {
  const pin = getPins().find((p) => p.id === req.params.id);
  if (!pin) return res.status(404).json({ error: 'not found' });
  try {
    const boards = effectiveBoards();
    const meta = await generateForImage(
      { imagePath: path.join(config.paths.uploads, pin.filename), filename: pin.originalName, mime: pin.mime },
      boards,
      getSettings()
    );
    const chosen = boards.find((b) => b.id === meta.board_id) || null;
    const updated = updatePin(pin.id, {
      title: meta.title,
      description: meta.description,
      keywords: meta.keywords,
      altText: meta.alt_text,
      boardId: meta.board_id,
      boardName: chosen ? chosen.name : '',
      accountId: chosen ? chosen.accountId || null : null,
      pinterestBoardId: chosen ? chosen.pinterestBoardId || null : null,
      status: pin.status === 'uploaded' ? 'ready' : pin.status,
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/pins/:id', (req, res) => {
  const pin = getPins().find((p) => p.id === req.params.id);
  if (pin) {
    const f = path.join(config.paths.uploads, pin.filename);
    if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch {} }
  }
  const ok = deletePin(req.params.id);
  res.json({ deleted: ok });
});

// --- scheduling ---
app.post('/api/schedule', (req, res) => {
  const scheduled = buildSchedule();
  res.json({ scheduled: scheduled.length, items: scheduled });
});

// Clear scheduled dates so pins publish immediately (Pinterest caps how many
// FUTURE-scheduled pins it accepts, so "publish now" lets all rows go through).
app.post('/api/schedule/clear', (req, res) => {
  let cleared = 0;
  for (const p of getPins()) {
    if (p.scheduledAt || p.status === 'scheduled') {
      updatePin(p.id, { scheduledAt: null, status: p.status === 'scheduled' ? 'ready' : p.status });
      cleared++;
    }
  }
  res.json({ cleared });
});

// Host images publicly so Pinterest's bulk CSV can fetch them. Batched.
app.post('/api/host-images', async (req, res) => {
  const { limit } = req.body || {};
  const settings = getSettings();
  // Re-host onto the currently-selected host (so adding an imgbb key moves
  // pins off the free host that Pinterest may reject).
  const targetHost = settings.imgbbApiKey ? 'imgbb' : 'litterbox';
  // Needs work if not hosted on the target host yet, OR missing its image hash.
  const needsHost = (p) =>
    ['ready', 'scheduled'].includes(p.status) && p.title &&
    (!p.hostedUrl || p.hostedHost !== targetHost || !p.imageHash);

  let selected = getPins().filter(needsHost);
  if (limit && limit > 0) selected = selected.slice(0, limit);

  let hosted = 0, lastError = null;
  let linkIdx = getPins().filter((p) => p.link).length;
  for (const pin of selected) {
    try {
      const patch = {};
      // Content hash to detect duplicate images (Pinterest rejects reused images).
      if (!pin.imageHash) {
        try {
          const buf = fs.readFileSync(path.join(config.paths.uploads, pin.filename));
          patch.imageHash = crypto.createHash('sha1').update(buf).digest('hex');
        } catch {}
      }
      // Only (re)host when not already on the target host.
      if (!pin.hostedUrl || pin.hostedHost !== targetHost) {
        const { url, host } = await hostImage(pin);
        patch.hostedUrl = url;
        patch.hostedHost = host;
        patch.hostedAt = new Date().toISOString();
      }
      if (!pin.link) patch.link = assignLink(linkIdx++);
      updatePin(pin.id, patch);
      hosted++;
    } catch (e) {
      lastError = e.message;
      updatePin(pin.id, { hostError: e.message });
    }
  }
  const remaining = getPins().filter(needsHost).length;
  res.json({ hosted, total: selected.length, remaining, lastError, host: targetHost });
});

// --- CSV export ---
app.get('/api/export.csv', (req, res) => {
  const onlyNew = req.query.onlyNew === '1'; // skip already-exported pins
  const mark = req.query.mark === '1';       // mark included pins as exported
  const limit = Number(req.query.limit) || 0;
  // Only export rows Pinterest can actually accept: hosted image + title + link.
  let pins = getPins().filter(
    (p) => ['ready', 'scheduled'].includes(p.status) && p.title && p.hostedUrl && p.link
  );
  // Skip duplicate images (Pinterest rejects a reused image: "Duplicate Pin image").
  const seenImg = new Set();
  pins = pins.filter((p) => {
    if (!p.imageHash) return true;
    if (seenImg.has(p.imageHash)) return false;
    seenImg.add(p.imageHash);
    return true;
  });
  if (onlyNew) pins = pins.filter((p) => !p.exportedAt);
  if (limit > 0) pins = pins.slice(0, limit);
  if (mark) {
    const now = new Date().toISOString();
    for (const p of pins) updatePin(p.id, { exportedAt: now });
  }
  const csv = pinsToCsv(pins, reqBase(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pinpilot-pinterest-bulk.csv"');
  res.send(csv); // no BOM — matches Pinterest's official sample exactly
});

// --- Pinterest OAuth (Stage 2) ---
app.get('/auth/pinterest', (req, res) => {
  if (!pinterestConfigured()) return res.status(400).send('Pinterest app not configured. Add your Pinterest App ID & Secret in Settings first.');
  res.redirect(getAuthUrl('pinpilot'));
});

app.get('/auth/pinterest/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?pinterest=error');
  try {
    const acc = await connectAccountFromCode(code);
    res.redirect(`/?pinterest=connected&user=${encodeURIComponent(acc.username)}`);
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.redirect(`/?pinterest=error&msg=${encodeURIComponent(e.message)}`);
  }
});

// Re-sync boards for one account (after adding/renaming boards on Pinterest).
app.post('/api/accounts/:id/sync', async (req, res) => {
  try { res.json({ boards: await syncAccountBoards(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Refresh boards for ALL connected accounts at once.
app.post('/api/accounts/sync-all', async (req, res) => {
  try { res.json({ results: await syncAllBoards() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/accounts/:id', (req, res) => {
  res.json({ removed: removeAccount(req.params.id) });
});

// Publish a pin immediately (Stage 2)
app.post('/api/pins/:id/publish', async (req, res) => {
  const pin = getPins().find((p) => p.id === req.params.id);
  if (!pin) return res.status(404).json({ error: 'not found' });
  if (!getAccounts().length) return res.status(400).json({ error: 'No Pinterest account connected' });
  try {
    const board = effectiveBoards().find((b) => b.id === pin.boardId);
    const result = await createPinOnPinterest(pin, board);
    const updated = updatePin(pin.id, { status: 'published', pinterestPinId: result.id, publishedAt: new Date().toISOString() });
    res.json(updated);
  } catch (e) {
    updatePin(pin.id, { status: 'error', error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// --- fallback to index ---
app.get('*', (req, res) => {
  res.sendFile(path.join(config.paths.public, 'index.html'));
});

const server = app.listen(config.port, () => {
  console.log(`\n  PinPilot running at http://localhost:${config.port}`);
  console.log(`  AI (Gemini): ${aiEnabled() ? 'ENABLED' : 'template fallback (no key)'}`);
  console.log(`  Pinterest API: ${pinterestConfigured() ? 'configured' : 'not configured (CSV export mode)'}\n`);
  startScheduler();
});
// Allow long-running batch generation requests (throttled AI calls).
server.requestTimeout = 0;
