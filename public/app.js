// PinPilot frontend
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let state = { boards: [], pins: [], settings: {}, pinterest: {}, aiEnabled: false, pinterestConfigured: false };

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function boardName(id) {
  return state.boards.find((b) => b.id === id)?.name || '—';
}

// ---------- render ----------
function renderBadges() {
  const ai = $('#badge-ai');
  ai.textContent = `AI: ${state.aiEnabled ? 'Gemini ✓' : 'template mode'}`;
  ai.className = `badge ${state.aiEnabled ? 'ok' : 'off'}`;

  const p = $('#badge-pinterest');
  const accts = state.accounts || [];
  if (accts.length) {
    p.textContent = `Pinterest: ${accts.length} account${accts.length > 1 ? 's' : ''} ✓`;
    p.className = 'badge ok';
  } else {
    p.textContent = `Pinterest: ${state.pinterestConfigured ? 'not connected' : 'CSV mode'}`;
    p.className = 'badge off';
  }
}

function renderAccounts() {
  const list = $('#accounts-list');
  const status = $('#pinterest-status');
  if (!list) return;
  const accts = state.accounts || [];
  if (!accts.length) {
    list.innerHTML = '';
    status.textContent = state.pinterestConfigured
      ? 'No accounts connected yet — click "Connect a Pinterest account".'
      : 'Add your Pinterest App ID & Secret in Settings to enable connecting.';
    return;
  }
  status.textContent = `${accts.length} connected · boards are pulled from Pinterest`;
  list.innerHTML = accts.map((a) => `
    <div class="chip" style="margin:4px 6px 4px 0">
      <span>@${a.username}</span>
      <span class="niche">${a.boardCount} boards</span>
      <button data-sync="${a.id}" title="Refresh this account's boards">🔄</button>
      <button data-del-acc="${a.id}" title="Disconnect">✕</button>
    </div>`).join('');
  list.querySelectorAll('[data-sync]').forEach((b) => (b.onclick = () => syncAccount(b.dataset.sync)));
  list.querySelectorAll('[data-del-acc]').forEach((b) => (b.onclick = () => disconnectAccount(b.dataset.delAcc)));
}

function renderSettings() {
  const s = state.settings;
  $('#destinationUrls').value = (s.destinationUrls || []).join('\n');
  $('#defaultNiche').value = s.defaultNiche || 'auto';
  $('#tone').value = s.tone || 'Friendly';
  $('#language').value = s.language || 'English';
  $('#pinsPerDay').value = s.pinsPerDay || 15;
  $('#postingHours').value = (s.postingHours || []).join(',');
  $('#startDate').value = s.startDate ? s.startDate.slice(0, 10) : '';
  $('#hashtags').value = s.hashtags || '';
  $('#geminiModel').value = s.geminiModel || '';
  $('#aiDelaySeconds').value = s.aiDelaySeconds ?? 4.5;
  // key is masked: show a saved indicator, leave field empty so it isn't overwritten
  const keyField = $('#geminiApiKey');
  keyField.value = '';
  keyField.placeholder = s.geminiKeySet ? '•••••••••• (saved — type to replace)' : 'Paste your Gemini API key here';
  // Pinterest app credentials
  $('#pinterestAppId').value = s.pinterestAppId || '';
  const secField = $('#pinterestAppSecret');
  secField.value = '';
  secField.placeholder = s.pinterestSecretSet ? '•••••••••• (saved — type to replace)' : 'Paste your app secret';
  const imgbb = $('#imgbbApiKey');
  imgbb.value = '';
  imgbb.placeholder = s.imgbbKeySet ? '•••••••••• (saved — type to replace)' : 'Leave blank to use the free image host';
}

function renderBoards() {
  const fromPinterest = state.boardsSource === 'pinterest';
  $('#board-count').textContent = `(${state.boards.length}${fromPinterest ? ' · from your Pinterest' : ''})`;
  const list = $('#boards-list');
  list.innerHTML = '';
  state.boards.forEach((b) => {
    const el = document.createElement('div');
    el.className = 'chip';
    const label = b.displayName || b.name;
    el.innerHTML = fromPinterest
      ? `<span>${label}</span><span class="niche">pinterest</span>`
      : `<span>${label}</span><span class="niche">${b.niche}</span><button title="Remove" data-id="${b.id}">✕</button>`;
    const btn = el.querySelector('button');
    if (btn) btn.onclick = async () => {
      await api(`/api/boards/${b.id}`, { method: 'DELETE' });
      await refresh();
      toast('Board removed');
    };
    list.appendChild(el);
  });
}

function renderPins() {
  const grid = $('#pins-grid');
  grid.innerHTML = '';
  const pins = state.pins;
  $('#empty-state').classList.toggle('hidden', pins.length > 0);

  pins.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'pin';
    el.innerHTML = `
      <img class="thumb" src="/uploads/${p.filename}" alt="${p.altText || ''}" loading="lazy" />
      <div class="pin-body">
        <span class="st ${p.status}">${p.status}</span>
        <div class="pin-title">${p.title || '<em style="color:#aaa">no title yet</em>'}</div>
        <div class="pin-desc">${p.description || ''}</div>
        <div class="pin-meta">
          ${p.boardId ? `<span class="tag board">${boardName(p.boardId)}</span>` : ''}
          ${p.generatedBy ? `<span class="tag">${p.generatedBy === 'gemini' ? '🤖 AI' : '📄 template'}</span>` : ''}
          ${p.hostedUrl ? '<span class="tag board">☁️ hosted</span>' : ''}
          ${p.scheduledAt ? `<span class="tag">🗓 ${new Date(p.scheduledAt).toLocaleString()}</span>` : ''}
        </div>
      </div>
      <div class="pin-actions">
        <button data-edit="${p.id}">✏️ Edit</button>
        <button data-regen="${p.id}">🔁 Regen</button>
        <button data-del="${p.id}">🗑</button>
      </div>`;
    grid.appendChild(el);
  });

  grid.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openEdit(b.dataset.edit)));
  grid.querySelectorAll('[data-regen]').forEach((b) => (b.onclick = () => regen(b.dataset.regen)));
  grid.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => delPin(b.dataset.del)));

  const c = state.counts || {};
  $('#counts').textContent = Object.entries(c).map(([k, v]) => `${v} ${k}`).join(' · ') || `${pins.length} pins`;
}

function renderAll() {
  renderBadges();
  renderSettings();
  renderBoards();
  renderAccounts();
  renderPins();
}

// ---------- actions ----------
async function refresh() {
  state = await api('/api/state');
  renderAll();
}

async function saveSettings() {
  const patch = {
    destinationUrls: $('#destinationUrls').value.split('\n').map((s) => s.trim()).filter(Boolean),
    defaultNiche: $('#defaultNiche').value,
    tone: $('#tone').value,
    language: $('#language').value,
    pinsPerDay: Number($('#pinsPerDay').value) || 15,
    postingHours: $('#postingHours').value.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n)),
    startDate: $('#startDate').value ? new Date($('#startDate').value).toISOString() : null,
    hashtags: $('#hashtags').value,
    geminiApiKey: $('#geminiApiKey').value.trim(), // empty = keep existing (masked)
    geminiModel: $('#geminiModel').value.trim(),
    aiDelaySeconds: Number($('#aiDelaySeconds').value) || 0,
    pinterestAppId: $('#pinterestAppId').value.trim(),
    pinterestAppSecret: $('#pinterestAppSecret').value.trim(), // empty = keep existing (masked)
    imgbbApiKey: $('#imgbbApiKey').value.trim(), // empty = keep existing (masked)
  };
  await api('/api/settings', { method: 'POST', body: patch });
  await refresh();
  toast(patch.geminiApiKey ? 'Settings saved — AI key updated' : 'Settings saved', 'ok');
}

async function testAi() {
  const out = $('#ai-test-result');
  const typed = $('#geminiApiKey').value.trim();
  // If the field is empty and nothing was saved before, guide the user.
  if (!typed && !(state.settings && state.settings.geminiKeySet)) {
    out.textContent = '✗ The Gemini key field is empty. Paste your key in the "🔑 Gemini API key" field (the FIRST password field, near the top), then click here again.';
    out.style.color = '#d94b4b';
    toast('Paste the key in the 🔑 Gemini API key field — not the Pinterest/imgbb fields.', 'err');
    $('#geminiApiKey').focus();
    return;
  }
  out.textContent = 'Testing…';
  const btn = $('#test-ai');
  btn.disabled = true;
  try {
    if (typed) await saveSettingsSilent(); // save the just-typed key
    const r = await api('/api/ai-test');
    if (r.ok) {
      out.textContent = `✓ Key + generation work — model: ${r.chosen} (${r.models.length} models available)`;
      out.style.color = '#1ea672';
      if (r.chosen) $('#geminiModel').value = r.chosen;
      toast(`AI works! Real generation succeeded with ${r.chosen}. Click Save settings.`, 'ok');
    } else if (r.stage === 'generate') {
      out.textContent = `✗ Key is valid, but GENERATION is blocked: ${r.error}`;
      out.style.color = '#d94b4b';
      toast('Generation blocked — likely quota/billing.', 'err');
    } else if (/No API key/i.test(r.error || '')) {
      out.textContent = '✗ Key didn\'t save. Make sure you pasted it in the "🔑 Gemini API key" field (near the top), then click Save settings.';
      out.style.color = '#d94b4b';
      toast('Key not saved — check you pasted in the 🔑 Gemini field, then Save settings.', 'err');
    } else {
      out.textContent = `✗ ${r.error}`;
      out.style.color = '#d94b4b';
      toast('AI test failed: ' + r.error, 'err');
    }
  } catch (e) {
    out.textContent = '✗ ' + e.message;
    toast('Test error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// Save settings without a success toast (used before AI test).
async function saveSettingsSilent() {
  const patch = {
    geminiApiKey: $('#geminiApiKey').value.trim(),
    geminiModel: $('#geminiModel').value.trim(),
  };
  await api('/api/settings', { method: 'POST', body: patch });
}

async function addBoard() {
  const name = $('#new-board-name').value.trim();
  if (!name) return toast('Enter a board name', 'err');
  await api('/api/boards', {
    method: 'POST',
    body: {
      name,
      niche: $('#new-board-niche').value,
      keywords: $('#new-board-keywords').value.split(',').map((s) => s.trim()).filter(Boolean),
    },
  });
  $('#new-board-name').value = '';
  $('#new-board-keywords').value = '';
  await refresh();
  toast('Board added', 'ok');
}

async function importBoards(replace) {
  const names = $('#import-boards').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return toast('Paste at least one board name', 'err');
  await api('/api/boards/import', { method: 'POST', body: { names, replace } });
  $('#import-boards').value = '';
  await refresh();
  toast(replace ? `Boards replaced with your ${names.length}` : `Added ${names.length} boards`, 'ok');
}

async function clearBoards() {
  if (!confirm('Remove ALL boards? You can paste your own afterwards.')) return;
  await api('/api/boards/import', { method: 'POST', body: { names: [], replace: true } });
  await refresh();
  toast('All boards cleared');
}

// --- Pinterest accounts ---
async function connectPinterest(e) {
  if (e) e.preventDefault();
  // save any just-typed credentials first, then check config
  await api('/api/settings', {
    method: 'POST',
    body: {
      pinterestAppId: $('#pinterestAppId').value.trim(),
      pinterestAppSecret: $('#pinterestAppSecret').value.trim(),
    },
  });
  const st = await api('/api/state');
  if (!st.pinterestConfigured) {
    toast('Add your Pinterest App ID & Secret in Settings, then Save, before connecting.', 'err');
    return;
  }
  location.href = '/auth/pinterest';
}

async function syncAccount(id) {
  toast('Refreshing boards…');
  try {
    const r = await api(`/api/accounts/${id}/sync`, { method: 'POST', body: {} });
    await refresh();
    toast(`Refreshed ${r.boards.length} boards`, 'ok');
  } catch (e) { toast('Refresh failed: ' + e.message, 'err'); }
}

async function disconnectAccount(id) {
  if (!confirm('Disconnect this Pinterest account?')) return;
  await api(`/api/accounts/${id}`, { method: 'DELETE' });
  await refresh();
  toast('Account disconnected');
}

async function syncAllBoardsUI() {
  toast('Refreshing all boards…');
  try {
    await api('/api/accounts/sync-all', { method: 'POST', body: {} });
    await refresh();
    toast('Boards refreshed from Pinterest', 'ok');
  } catch (e) { toast('Refresh failed: ' + e.message, 'err'); }
}

async function uploadFiles(files) {
  if (!files.length) return;
  const prog = $('#upload-progress');
  const bar = prog.querySelector('.bar');
  prog.classList.remove('hidden');
  bar.style.width = '10%';

  const form = new FormData();
  [...files].forEach((f) => form.append('images', f));

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 90) + 5}%`;
  };
  xhr.onload = async () => {
    bar.style.width = '100%';
    setTimeout(() => prog.classList.add('hidden'), 600);
    if (xhr.status === 200) {
      const r = JSON.parse(xhr.responseText);
      await refresh();
      toast(`Uploaded ${r.created} image(s). Now click "Generate AI content".`, 'ok');
    } else {
      toast('Upload failed', 'err');
    }
  };
  xhr.onerror = () => toast('Upload failed', 'err');
  xhr.send(form);
}

// Runs generation in small batches (respects Gemini rate limits) with progress.
async function runBatched(selector, buttons) {
  buttons.forEach((b) => (b.disabled = true));
  let totalAi = 0, totalFallback = 0, lastError = null;
  try {
    for (let i = 0; i < 2000; i++) { // safety cap on batches
      const r = await api('/api/generate', { method: 'POST', body: { ...selector, limit: 3 } });
      totalAi += r.aiUsed;
      totalFallback += r.fallback;
      if (r.lastError) lastError = r.lastError;
      await refresh();

      if (r.dailyQuota) {
        toast(`Stopped: quota limit hit (done ${totalAi} with AI). Reason: ${lastError || 'daily quota'}`, 'err');
        return;
      }
      if (r.generated === 0) break;                 // nothing left to process
      // If AI produced nothing this batch (and we asked for AI), stop to avoid looping.
      if (selector.onlyMissing && r.aiUsed === 0) {
        toast(`AI not producing content. ${lastError ? 'Reason: ' + lastError : 'Check your Gemini key / model.'}`, 'err');
        return;
      }
      toast(`Working… ${totalAi} done with AI · ${r.remaining} left`);
      if (r.remaining === 0) break;
    }
    if (totalAi > 0 && totalFallback === 0) toast(`✓ AI wrote ${totalAi} pin(s) with Gemini`, 'ok');
    else if (totalAi > 0) toast(`Done: ${totalAi} with AI, ${totalFallback} with templates.`, 'ok');
    else toast(`Used templates (no AI). ${lastError ? 'Reason: ' + lastError : 'Add/save your Gemini key.'}`, 'err');
  } catch (e) {
    toast('Error: ' + e.message, 'err');
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    $('#generate-all').textContent = '✨ Generate AI content for new pins';
    $('#regenerate-all').textContent = '🔁 Regenerate ALL (with AI)';
  }
}

async function generateAll() {
  $('#generate-all').textContent = '✨ Generating…';
  await runBatched({}, [$('#generate-all'), $('#regenerate-all')]);
}

async function regenerateAll() {
  if (!confirm('Rewrite title, description & board for ALL pins using AI?\n\nThis runs in batches and respects Gemini free-tier limits, so it can take a few minutes. Already-AI pins are skipped.')) return;
  $('#regenerate-all').textContent = '🔁 Regenerating…';
  await runBatched({ onlyMissing: true }, [$('#generate-all'), $('#regenerate-all')]);
}

async function buildSchedule() {
  const r = await api('/api/schedule', { method: 'POST', body: {} });
  await refresh();
  toast(`Scheduled ${r.scheduled} pins`, 'ok');
}

// Upload images to a public host (batched) so the Pinterest CSV works.
async function hostImages() {
  const btn = $('#host-images');
  btn.disabled = true;
  btn.textContent = '☁️ Hosting…';
  let total = 0, lastError = null;
  try {
    for (let i = 0; i < 3000; i++) {
      const r = await api('/api/host-images', { method: 'POST', body: { limit: 5 } });
      total += r.hosted;
      if (r.lastError) lastError = r.lastError;
      await refresh();
      if (r.hosted === 0) break;
      toast(`Hosting images… ${total} done · ${r.remaining} left`);
      if (r.remaining === 0) break;
    }
    if (total > 0 && !lastError) toast(`✓ Hosted ${total} image(s). Now Export the CSV.`, 'ok');
    else if (total > 0) toast(`Hosted ${total}, some failed: ${lastError}`, 'err');
    else toast(`Nothing to host — generate pins first. ${lastError || ''}`, lastError ? 'err' : '');
  } catch (e) {
    toast('Hosting error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '☁️ Host images for Pinterest';
  }
}

async function regen(id) {
  toast('Regenerating…');
  try {
    await api(`/api/pins/${id}/regenerate`, { method: 'POST', body: {} });
    await refresh();
    toast('Regenerated', 'ok');
  } catch (e) {
    toast('Error: ' + e.message, 'err');
  }
}

async function delPin(id) {
  if (!confirm('Delete this pin?')) return;
  await api(`/api/pins/${id}`, { method: 'DELETE' });
  await refresh();
}

// ---------- edit modal ----------
function openEdit(id) {
  const p = state.pins.find((x) => x.id === id);
  if (!p) return;
  const boardOptions = state.boards
    .map((b) => `<option value="${b.id}" ${b.id === p.boardId ? 'selected' : ''}>${b.name}</option>`)
    .join('');
  $('#modal-content').innerHTML = `
    <h3>Edit pin</h3>
    <div class="modal-grid">
      <img src="/uploads/${p.filename}" alt="" />
      <div style="display:flex;flex-direction:column;gap:12px">
        <label class="field"><span>Title</span><input id="e-title" value="${escapeHtml(p.title)}" maxlength="100" /></label>
        <label class="field"><span>Description</span><textarea id="e-desc" rows="4" maxlength="500">${escapeHtml(p.description)}</textarea></label>
        <label class="field"><span>Board</span><select id="e-board">${boardOptions}</select></label>
        <label class="field"><span>Destination link</span><input id="e-link" value="${escapeHtml(p.link || '')}" /></label>
        <label class="field"><span>Keywords (comma separated)</span><input id="e-kw" value="${escapeHtml((p.keywords||[]).join(', '))}" /></label>
      </div>
    </div>
    <div class="toolbar">
      <button class="primary" id="e-save">Save</button>
      ${state.pinterest?.connected ? '<button class="secondary" id="e-publish">🚀 Publish now</button>' : ''}
    </div>`;
  $('#modal').classList.remove('hidden');

  $('#e-save').onclick = async () => {
    await api(`/api/pins/${id}`, {
      method: 'PUT',
      body: {
        title: $('#e-title').value,
        description: $('#e-desc').value,
        boardId: $('#e-board').value,
        link: $('#e-link').value,
        keywords: $('#e-kw').value.split(',').map((s) => s.trim()).filter(Boolean),
      },
    });
    closeModal();
    await refresh();
    toast('Saved', 'ok');
  };
  const pubBtn = $('#e-publish');
  if (pubBtn) pubBtn.onclick = async () => {
    try {
      await api(`/api/pins/${id}/publish`, { method: 'POST', body: {} });
      closeModal();
      await refresh();
      toast('Published to Pinterest', 'ok');
    } catch (e) { toast('Publish failed: ' + e.message, 'err'); }
  };
}
function closeModal() { $('#modal').classList.add('hidden'); }
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- wire up ----------
function initEvents() {
  $('#save-settings').onclick = saveSettings;
  $('#test-ai').onclick = testAi;
  $('#add-board').onclick = addBoard;
  $('#import-replace').onclick = () => importBoards(true);
  $('#import-add').onclick = () => importBoards(false);
  $('#clear-boards').onclick = clearBoards;
  $('#generate-all').onclick = generateAll;
  $('#regenerate-all').onclick = regenerateAll;
  $('#build-schedule').onclick = buildSchedule;
  $('#clear-schedule').onclick = async () => {
    const r = await api('/api/schedule/clear', { method: 'POST', body: {} });
    await refresh();
    toast(`Cleared dates on ${r.cleared} pins — they'll publish immediately`, 'ok');
  };
  $('#host-images').onclick = hostImages;
  $('#export-csv').onclick = (e) => {
    const ready = (state.pins || []).filter(
      (p) => ['ready', 'scheduled'].includes(p.status) && p.title && p.hostedUrl && p.link
    ).length;
    if (ready === 0) {
      e.preventDefault();
      const noLinks = !((state.settings || {}).destinationUrls || []).length;
      toast(noLinks
        ? 'Pinterest needs a link per pin: add a Destination URL in Settings, Generate, then Host images.'
        : 'Click "☁️ Host images for Pinterest" first — then export.', 'err');
    }
  };
  $('#modal-close').onclick = closeModal;
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

  // collapsible cards
  $$('[data-toggle]').forEach((btn) => {
    btn.onclick = () => $('#' + btn.dataset.toggle).classList.toggle('collapsed');
  });

  // upload
  const dz = $('#dropzone');
  const input = $('#file-input');
  $('#browse-btn').onclick = () => input.click();
  dz.onclick = (e) => { if (e.target === dz || e.target.closest('.dz-inner') && e.target.tagName !== 'BUTTON') input.click(); };
  input.onchange = () => uploadFiles(input.files);
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

  // pinterest accounts
  $('#connect-pinterest').onclick = connectPinterest;
  $('#sync-all').onclick = syncAllBoardsUI;

  // pinterest connect result banner
  const params = new URLSearchParams(location.search);
  if (params.get('pinterest') === 'connected') toast(`Connected @${params.get('user') || ''}! Boards imported.`, 'ok');
  if (params.get('pinterest') === 'error') toast('Pinterest connection failed: ' + (params.get('msg') || ''), 'err');
}

initEvents();
refresh().catch((e) => toast('Failed to load: ' + e.message, 'err'));
