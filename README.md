# 📌 PinPilot

Upload your images → AI writes **SEO titles & descriptions**, picks the **right board**, **schedules** the pins, and lets you **export a Pinterest CSV** or **auto-publish** via the Pinterest API.

Built as a lightweight, self-hosted alternative to paid pin schedulers. Works with **zero paid subscriptions**.

---

## 🖱️ Easiest way to run (no coding)

1. Install **Node.js** (LTS) from <https://nodejs.org>.
2. **Windows:** double-click **`START-WINDOWS.bat`**
   **Mac:** double-click **`START-MAC.command`** (first time: right-click → Open).
3. The app opens automatically at <http://localhost:3004>.

The launcher installs everything on first run and starts the app. To stop it, close the window.

---

## 💻 Manual way (terminal)

```bash
npm install
npm start
# open http://localhost:3004
```

It runs immediately in **template mode** (no keys needed).

### Turn on real AI (free)

1. Get a free key at <https://aistudio.google.com/app/apikey>
2. Copy `.env.example` to `.env` and set `GEMINI_API_KEY=your_key_here`
3. Restart. The badge shows **AI: Gemini ✓** and content is based on the actual image.

---

## 📤 Stage 1 — Export CSV (no API approval needed)

1. Fill in **destination URLs**, upload images, click **Generate**, then **Build schedule**.
2. Click **Export Pinterest CSV**.
3. Go to Pinterest → **Create → Bulk create Pins**, upload the CSV.

> ⚠️ Pinterest bulk upload needs **public image URLs**. Locally the CSV points at `localhost` (Pinterest can't reach that). For a real upload, host the `/uploads` folder publicly and set `PUBLIC_BASE_URL` in `.env`.

---

## 🔗 Stage 2 — Auto-publish via Pinterest API

1. Create an app at <https://developers.pinterest.com/apps/>.
2. Set `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, `PINTEREST_REDIRECT_URI` in `.env`.
3. Restart, click **Connect Pinterest**, approve access, then **Sync boards**.

> Publishing to a live account requires **Standard** API access from Pinterest (app review). With **Trial** access, created pins are sandbox-only. The API has no native "publish later" for organic pins — PinPilot queues and releases them itself.

---

## 🗂️ Project structure

```
pinpilot/
├── server.js              # Express app + all routes
├── START-WINDOWS.bat      # double-click launcher (Windows)
├── START-MAC.command      # double-click launcher (Mac)
├── src/
│   ├── config.js          # env loader + config
│   ├── store.js           # JSON persistence
│   ├── aiEngine.js        # Gemini vision + template fallback
│   ├── scheduler.js       # schedule builder + background publisher
│   ├── csvExport.js       # Pinterest Bulk Create CSV
│   └── pinterestClient.js # OAuth + API v5 (Stage 2)
├── public/                # web UI
├── uploads/               # your uploaded images
└── data/db.json           # local database
```

Default boards cover **Health & Fitness** and **Recipes** — edit them in the UI to match your account.
