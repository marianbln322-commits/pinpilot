import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { config, pinterestConfigured } from './src/config.js';
import {
  loadDb, getBoards, getSettings, updateSettings, addPin, updatePin,
  deletePin, getPins, getPinterest, setPinterest, setBoards,
} from './src/store.js';
import { generateForImage, aiEnabled, testKey } from './src/aiEngine.js';
import { buildSchedule, startScheduler } from './src/scheduler.js';
import { pinsToCsv } from './src/csvExport.js';
import {
  getAuthUrl, exchangeCodeForToken, fetchUserAccount, fetchBoards, createPinOnPinterest,
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
    pinterest: (() => {
      const p = getPinterest();
      return { connected: p.connected, account: p.account, boardCount: (p.boards || []).length };
    })(),
    settings: (() => {
      const s = { ...getSettings() };
      s.geminiKeySet = Boolean(s.geminiApiKey);
      delete s.geminiApiKey; // never expose the raw key to the client
      return s;
    })(),
    boards: getBoards(),
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
  const allowed = ['destinationUrls', 'pinsPerDay', 'postingHours', 'startDate', 'defaultNiche', 'hashtags', 'language', 'tone', 'geminiApiKey', 'geminiModel', 'aiDelaySeconds'];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  // Don't wipe a saved key when the UI sends an empty field (key is masked there).
  if (patch.geminiApiKey === '') delete patch.geminiApiKey;
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
  const boards = getBoards();
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
      updatePin(pin.id, {
        title: meta.title,
        description: (meta.description + hashtags).slice(0, 500),
        keywords: meta.keywords,
        altText: meta.alt_text,
        boardId: meta.board_id,
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
    const meta = await generateForImage(
      { imagePath: path.join(config.paths.uploads, pin.filename), filename: pin.originalName, mime: pin.mime },
      getBoards(),
      getSettings()
    );
    const updated = updatePin(pin.id, {
      title: meta.title,
      description: meta.description,
      keywords: meta.keywords,
      altText: meta.alt_text,
      boardId: meta.board_id,
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

// --- CSV export ---
app.get('/api/export.csv', (req, res) => {
  const pins = getPins().filter((p) => ['ready', 'scheduled'].includes(p.status) && p.title);
  const csv = pinsToCsv(pins, reqBase(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pinpilot-pinterest-bulk.csv"');
  res.send('\uFEFF' + csv); // BOM for Excel
});

// --- Pinterest OAuth (Stage 2) ---
app.get('/auth/pinterest', (req, res) => {
  if (!pinterestConfigured()) return res.status(400).send('Pinterest app not configured. Set PINTEREST_APP_ID and PINTEREST_APP_SECRET in .env');
  res.redirect(getAuthUrl('pinpilot'));
});

app.get('/auth/pinterest/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?pinterest=error');
  try {
    await exchangeCodeForToken(code);
    await fetchUserAccount();
    await fetchBoards();
    res.redirect('/?pinterest=connected');
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.redirect('/?pinterest=error');
  }
});

app.post('/api/pinterest/sync-boards', async (req, res) => {
  try {
    const boards = await fetchBoards();
    res.json({ boards });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pinterest/disconnect', (req, res) => {
  setPinterest({ connected: false, account: null, accessToken: null, refreshToken: null, expiresAt: null, boards: [] });
  res.json({ ok: true });
});

// Publish a pin immediately (Stage 2)
app.post('/api/pins/:id/publish', async (req, res) => {
  const pin = getPins().find((p) => p.id === req.params.id);
  if (!pin) return res.status(404).json({ error: 'not found' });
  if (!getPinterest().connected) return res.status(400).json({ error: 'Pinterest not connected' });
  try {
    const board = getBoards().find((b) => b.id === pin.boardId);
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
