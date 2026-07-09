// Simple JSON-file persistence layer. No external DB needed.
import fs from 'fs';
import { config } from './config.js';

const DEFAULT_BOARDS = [
  // Health & Fitness
  { id: 'home-workouts-women', name: 'Home Workouts for Women', niche: 'fitness', keywords: ['home workout', 'no equipment', 'full body', 'weight loss', 'women fitness'] },
  { id: 'weight-loss-tips', name: 'Weight Loss Tips & Motivation', niche: 'fitness', keywords: ['weight loss', 'lose belly fat', 'fat loss', 'diet', 'motivation'] },
  { id: 'healthy-habits', name: 'Healthy Habits & Wellness', niche: 'fitness', keywords: ['healthy habits', 'wellness', 'self care', 'routine', 'morning routine'] },
  { id: 'glutes-legs', name: 'Glutes & Legs Workouts', niche: 'fitness', keywords: ['glute workout', 'booty', 'leg day', 'lower body', 'squats'] },
  { id: 'yoga-beginners', name: 'Yoga for Beginners', niche: 'fitness', keywords: ['yoga', 'beginner yoga', 'stretching', 'flexibility', 'stress relief'] },
  // Recipes
  { id: 'easy-healthy-dinners', name: 'Easy Healthy Dinner Recipes', niche: 'recipes', keywords: ['dinner', 'healthy dinner', 'easy meals', 'weeknight', 'family dinner'] },
  { id: 'high-protein-meal-prep', name: 'High Protein Meal Prep', niche: 'recipes', keywords: ['meal prep', 'high protein', 'lunch', 'make ahead', 'muscle'] },
  { id: 'healthy-breakfast', name: 'Healthy Breakfast Ideas', niche: 'recipes', keywords: ['breakfast', 'overnight oats', 'smoothie', 'eggs', 'morning'] },
  { id: 'easy-desserts', name: 'Easy Dessert Recipes', niche: 'recipes', keywords: ['dessert', 'no bake', 'chocolate', 'cake', 'sweet treats'] },
  { id: 'smoothies-juices', name: 'Healthy Smoothies & Juices', niche: 'recipes', keywords: ['smoothie', 'juice', 'detox', 'green smoothie', 'protein shake'] },
];

const DEFAULT_DB = {
  boards: DEFAULT_BOARDS,
  pins: [],
  settings: {
    destinationUrls: [],       // where pins link to (round-robin)
    pinsPerDay: 15,            // scheduling volume
    postingHours: [7, 10, 13, 16, 19, 21], // local hours to post at
    startDate: null,           // ISO date; null = start tomorrow
    defaultNiche: 'auto',      // auto | fitness | recipes
    hashtags: '',              // appended disclosure/hashtags
    language: 'English',
    tone: 'Friendly',
    geminiApiKey: '',          // set here from the UI (or via .env)
    geminiModel: '',           // e.g. gemini-2.5-flash (blank = default)
  },
  pinterest: {
    connected: false,
    account: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    boards: [], // fetched live boards from Pinterest (id + name)
  },
};

let db = null;

function ensureDirs() {
  for (const dir of [config.paths.data, config.paths.uploads]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadDb() {
  ensureDirs();
  if (fs.existsSync(config.paths.db)) {
    try {
      const raw = JSON.parse(fs.readFileSync(config.paths.db, 'utf8'));
      db = { ...structuredClone(DEFAULT_DB), ...raw };
      // deep-merge settings so new defaults appear
      db.settings = { ...DEFAULT_DB.settings, ...(raw.settings || {}) };
      db.pinterest = { ...DEFAULT_DB.pinterest, ...(raw.pinterest || {}) };
      if (!Array.isArray(db.boards) || db.boards.length === 0) db.boards = DEFAULT_BOARDS;
    } catch (e) {
      console.error('Failed to parse db.json, starting fresh:', e.message);
      db = structuredClone(DEFAULT_DB);
    }
  } else {
    db = structuredClone(DEFAULT_DB);
    save();
  }
  return db;
}

export function getDb() {
  if (!db) loadDb();
  return db;
}

let saveTimer = null;
export function save() {
  if (!db) return;
  clearTimeout(saveTimer);
  // debounce writes slightly to avoid hammering disk on batch ops
  saveTimer = setTimeout(() => {
    fs.writeFileSync(config.paths.db, JSON.stringify(db, null, 2));
  }, 50);
}

export function saveNow() {
  if (!db) return;
  clearTimeout(saveTimer);
  fs.writeFileSync(config.paths.db, JSON.stringify(db, null, 2));
}

// --- helpers ---
export function getBoards() {
  return getDb().boards;
}

export function getSettings() {
  return getDb().settings;
}

export function updateSettings(patch) {
  const d = getDb();
  d.settings = { ...d.settings, ...patch };
  saveNow();
  return d.settings;
}

export function addPin(pin) {
  const d = getDb();
  d.pins.push(pin);
  save();
  return pin;
}

export function updatePin(id, patch) {
  const d = getDb();
  const pin = d.pins.find((p) => p.id === id);
  if (!pin) return null;
  Object.assign(pin, patch);
  save();
  return pin;
}

export function deletePin(id) {
  const d = getDb();
  const idx = d.pins.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  d.pins.splice(idx, 1);
  save();
  return true;
}

export function getPins() {
  return getDb().pins;
}

export function setPinterest(patch) {
  const d = getDb();
  d.pinterest = { ...d.pinterest, ...patch };
  saveNow();
  return d.pinterest;
}

export function getPinterest() {
  return getDb().pinterest;
}
