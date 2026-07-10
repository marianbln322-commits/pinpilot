// AI engine: given an image + your board list, produce a click-optimized
// SEO title, description, and the best-matching board.
//
// Uses Google Gemini (vision) when GEMINI_API_KEY is set. Otherwise falls
// back to a built-in template generator so the app is fully usable offline.
import fs from 'fs';
import { config } from './config.js';
import { getSettings } from './store.js';

// Resolve Gemini credentials from the environment (.env) first, then from
// the in-app settings (entered in the UI and stored in db.json).
function resolveCreds() {
  const settings = getSettings();
  const apiKey = config.gemini.apiKey || settings.geminiApiKey || '';
  const model = process.env.GEMINI_MODEL
    ? config.gemini.model
    : (settings.geminiModel || config.gemini.model || 'gemini-3.1-flash-lite');
  return { apiKey, model };
}

// True when a Gemini API key is available from env OR the UI settings.
export function aiEnabled() {
  return Boolean(resolveCreds().apiKey);
}

// Cache the model we've confirmed works for this key/run.
let cachedWorkingModel = null;

// List model names that support image+text generation for this key.
async function listGenerateModels(apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1000`);
  if (!res.ok) throw new Error(`List models ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = await res.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}

// Priority order: fastest, currently-available "lite" flash models first.
// (Older 2.x/1.x names appear in the model list but 404 for new accounts.)
const PREFERRED_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
];

// Choose the best available model (prefer fast, available lite flash variants).
function pickModel(models, preferred) {
  if (preferred && models.includes(preferred)) return preferred;
  for (const m of PREFERRED_MODELS) if (models.includes(m)) return m;
  // Avoid retired generations (1.5 / 2.0 / 2.5) that 404 for new accounts.
  const notOld = (m) => !/(1\.5|2\.0|2\.5)/.test(m);
  const l = (m) => m.toLowerCase();
  return models.find((m) => l(m).includes('flash-lite') && notOld(m))
    || models.find((m) => l(m).includes('flash') && notOld(m))
    || models.find((m) => notOld(m))
    || models[0];
}

// Do a tiny real generateContent call to see if generation actually works
// (ListModels can succeed while generation is blocked by quota/billing).
async function probeGenerate(apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
      generationConfig: { maxOutputTokens: 10, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (res.ok) return { ok: true, status: 200 };
  const txt = (await res.text()).slice(0, 300);
  return { ok: false, status: res.status, error: `${res.status}: ${txt}` };
}

// Verify the key AND that real generation works; report the working model.
export async function testKey() {
  const { apiKey, model } = resolveCreds();
  if (!apiKey) return { ok: false, error: 'No API key saved. Paste your Gemini key and click Save settings.' };
  let models = [];
  try {
    models = await listGenerateModels(apiKey);
  } catch (e) {
    return { ok: false, stage: 'list', error: e.message };
  }
  if (!models.length) return { ok: false, stage: 'list', error: 'Key works but no usable models found.', models: [] };

  // Try generating with the preferred model, then a couple of alternatives.
  const candidates = [];
  const preferred = pickModel(models, model || cachedWorkingModel);
  if (preferred) candidates.push(preferred);
  for (const m of PREFERRED_MODELS) {
    if (models.includes(m) && !candidates.includes(m)) candidates.push(m);
  }
  let lastError = '';
  for (const m of candidates) {
    const probe = await probeGenerate(apiKey, m);
    if (probe.ok) {
      cachedWorkingModel = m;
      return { ok: true, models, chosen: m, generationWorks: true };
    }
    lastError = probe.error;
    if (probe.status !== 404) break; // 429/403 etc. won't be fixed by another model
  }
  return { ok: false, stage: 'generate', models, chosen: candidates[0], generationWorks: false, error: lastError };
}

const POWER_WORDS = [
  'Easy', 'Quick', 'Simple', 'Best', 'Ultimate', 'Secret', 'Proven',
  'Effortless', 'Genius', 'Must-Try', 'Game-Changing',
];

const FITNESS_CTAS = ['Get the full workout', 'Read the plan', 'See the routine', 'Save this workout'];
const RECIPE_CTAS = ['Get the recipe', 'Grab the recipe', 'Save this recipe', 'See the full recipe'];

/**
 * Build the art-director style instruction for Gemini.
 */
function buildPrompt(boards, ctx) {
  const boardList = boards
    .map((b) => `- id: "${b.id}" | name: "${b.name}" | niche: ${b.niche} | topics: ${b.keywords.join(', ')}`)
    .join('\n');

  return `You are a senior Pinterest art director and conversion copywriter.
You are given ONE image. Your job is to make people scrolling Pinterest STOP and CLICK through to a website.

Look carefully at the image and decide what it actually shows.

Then produce, for this single image:
1. "title": a click-optimized Pinterest pin title. Rules:
   - Max ~8 words, written in ${ctx.language}.
   - Use a click trigger: a number, a curiosity gap, a clear benefit, or "how to".
   - Tone: ${ctx.tone}. Use strong, specific words. No clickbait lies.
2. "description": an SEO-rich Pinterest description, 150-300 characters, in ${ctx.language}.
   - Natural language, keyword-rich (Pinterest is a search engine), ends with a soft CTA.
3. "board_id": choose the SINGLE most relevant board id from the list below (match the image content to the board topics).
4. "keywords": 4-6 short Pinterest search keywords (lowercase), as an array.
5. "alt_text": a short factual description of the image for accessibility.

Available boards:
${boardList}

Respond with ONLY a valid JSON object, no markdown, no commentary:
{"title": "...", "description": "...", "board_id": "...", "keywords": ["..."], "alt_text": "..."}`;
}

function extractJson(text) {
  if (!text) return null;
  // strip code fences if present
  let t = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(imagePath, mime, boards, ctx) {
  const { apiKey, model: requestedModel } = resolveCreds();
  let model = cachedWorkingModel || requestedModel;
  const prompt = buildPrompt(boards, ctx);
  const base64 = fs.readFileSync(imagePath).toString('base64');

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime || 'image/jpeg', data: base64 } },
        ],
      },
    ],
    // thinkingBudget:0 disables slow "thinking" — huge speedup for this task.
    generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
  };

  const backoffs = [4000, 10000, 20000];
  let lastErr = '';
  let triedResolve = false;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
      const parsed = extractJson(text);
      if (!parsed) throw new Error('Gemini returned unparseable output');
      cachedWorkingModel = model; // remember what worked
      return parsed;
    }

    const errText = await res.text();
    lastErr = `Gemini API ${res.status}: ${errText.slice(0, 200)}`;

    // Some models don't accept thinkingConfig -> drop it and retry.
    if (res.status === 400 && body.generationConfig.thinkingConfig && /thinking/i.test(errText)) {
      delete body.generationConfig.thinkingConfig;
      attempt--;
      continue;
    }

    // 404 = model name not found (e.g. a retired model). Auto-discover a working one.
    if (res.status === 404 && !triedResolve) {
      triedResolve = true;
      try {
        const models = await listGenerateModels(apiKey);
        const chosen = pickModel(models, null);
        if (chosen && chosen !== model) {
          model = chosen;
          cachedWorkingModel = chosen;
          attempt--; // don't burn a retry slot for the self-heal
          continue;
        }
      } catch { /* fall through to throw below */ }
      throw new Error(lastErr + ' — model not available for this key');
    }

    // 429 = rate/quota, 503 = overloaded -> wait and retry.
    if ((res.status === 429 || res.status === 503) && attempt < backoffs.length) {
      const err = new Error(lastErr);
      err.rateLimited = res.status === 429;
      if (/per day|quota metric.*per day|PerDay/i.test(errText)) {
        err.dailyQuota = true;
        throw err;
      }
      await sleep(backoffs[attempt]);
      continue;
    }
    const err = new Error(lastErr);
    err.rateLimited = res.status === 429;
    throw err;
  }
  throw new Error(lastErr || 'Gemini request failed');
}

// --- Fallback generator (no API key) ---
function titleCaseFromFilename(filename) {
  return filename
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function pick(arr, seed) {
  return arr[Math.abs(seed) % arr.length];
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function fallbackGenerate(filename, boards, ctx) {
  const base = titleCaseFromFilename(filename) || 'Healthy Inspiration';
  const seed = hashStr(filename);

  // guess board by keyword overlap with filename words
  const words = base.toLowerCase().split(' ');
  let best = boards[0];
  let bestScore = -1;
  for (const b of boards) {
    if (ctx.niche !== 'auto' && b.niche !== ctx.niche) continue;
    const score = b.keywords.reduce(
      (acc, kw) => acc + (words.some((w) => kw.includes(w) || w.includes(kw.split(' ')[0])) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (ctx.niche !== 'auto') {
    const inNiche = boards.filter((b) => b.niche === ctx.niche);
    if (inNiche.length && !inNiche.includes(best)) best = pick(inNiche, seed);
  }

  const isRecipe = best.niche === 'recipes';
  const power = pick(POWER_WORDS, seed);
  const num = 5 + (Math.abs(seed) % 6); // 5-10
  const cta = isRecipe ? pick(RECIPE_CTAS, seed) : pick(FITNESS_CTAS, seed);

  const titleTemplates = isRecipe
    ? [
        `${power} ${base} Recipe`,
        `${num} ${base} Ideas You'll Love`,
        `The Best ${base} (${power}!)`,
        `${power} ${base} in 30 Minutes`,
      ]
    : [
        `${power} ${base} Workout`,
        `${num} ${base} Moves That Work`,
        `The ${base} Routine You Need`,
        `${power} ${base} for Beginners`,
      ];
  let title = pick(titleTemplates, seed).replace(/\s+/g, ' ').trim();
  // collapse consecutive duplicate words (e.g. "Routine Routine" -> "Routine")
  title = title.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');

  const kw = best.keywords.slice(0, 5);
  const description =
    `${title}. ` +
    (isRecipe
      ? `A ${power.toLowerCase()} idea for ${kw[0]} lovers — simple ingredients, big flavor, and ready in no time. `
      : `A ${power.toLowerCase()} approach to ${kw[0]} you can start today — no fancy equipment needed. `) +
    `Perfect for ${kw.slice(1, 3).join(' and ')}. ${cta}! #${kw[0].replace(/\s/g, '')} #${(kw[1] || 'pinterest').replace(/\s/g, '')}`;

  return {
    title,
    description: description.slice(0, 340),
    board_id: best.id,
    keywords: kw,
    alt_text: `${base} image`,
    _fallback: true,
  };
}

/**
 * Generate metadata for one image.
 * @returns {Promise<{title, description, board_id, keywords, alt_text, _fallback?}>}
 */
export async function generateForImage({ imagePath, filename, mime }, boards, settings) {
  const ctx = {
    niche: settings.defaultNiche || 'auto',
    language: settings.language || 'English',
    tone: settings.tone || 'Friendly',
  };

  if (aiEnabled()) {
    try {
      const result = await callGemini(imagePath, mime, boards, ctx);
      // validate board_id, fallback to closest if missing
      if (!boards.some((b) => b.id === result.board_id)) {
        const fb = fallbackGenerate(filename, boards, ctx);
        result.board_id = fb.board_id;
      }
      return {
        title: String(result.title || '').slice(0, 100),
        description: String(result.description || '').slice(0, 480),
        board_id: result.board_id,
        keywords: Array.isArray(result.keywords) ? result.keywords.slice(0, 8) : [],
        alt_text: String(result.alt_text || '').slice(0, 200),
        _ai: true,
      };
    } catch (e) {
      console.warn(`AI generation failed for ${filename}, using fallback: ${e.message}`);
      return {
        ...fallbackGenerate(filename, boards, ctx),
        _error: e.message,
        _rateLimited: Boolean(e.rateLimited),
        _dailyQuota: Boolean(e.dailyQuota),
      };
    }
  }
  return fallbackGenerate(filename, boards, ctx);
}
