// Pinterest API v5 client — multi-account: OAuth + list boards + create pins.
//
// Credentials (App ID / Secret) come from .env OR the in-app settings.
// Reading boards works with Trial access; publishing pins to a live account
// requires STANDARD access approval from Pinterest.
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import {
  getSettings, getAccounts, upsertAccount, updateAccount, setAccountBoards,
} from './store.js';

const OAUTH_AUTHORIZE = 'https://www.pinterest.com/oauth/';
const SCOPES = ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'];

// Resolve app credentials from env first, then UI settings.
export function creds() {
  const s = getSettings();
  return {
    appId: config.pinterest.appId || s.pinterestAppId || '',
    appSecret: config.pinterest.appSecret || s.pinterestAppSecret || '',
    redirectUri: config.pinterest.redirectUri,
    apiBase: config.pinterest.apiBase,
  };
}

export function isConfigured() {
  const c = creds();
  return Boolean(c.appId && c.appSecret);
}

export function getAuthUrl(state) {
  const c = creds();
  const params = new URLSearchParams({
    client_id: c.appId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(','),
    state: state || 'pinpilot',
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

function basicAuthHeader() {
  const c = creds();
  return `Basic ${Buffer.from(`${c.appId}:${c.appSecret}`).toString('base64')}`;
}

// Exchange an OAuth code for tokens (does not persist — caller builds account).
export async function exchangeCodeForToken(code) {
  const c = creds();
  const res = await fetch(`${c.apiBase}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri }).toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function refreshAccount(account) {
  if (!account.refreshToken) throw new Error('No refresh token');
  const c = creds();
  const res = await fetch(`${c.apiBase}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refreshToken }).toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed ${res.status}`);
  const data = await res.json();
  updateAccount(account.id, {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  });
  return data.access_token;
}

// Authenticated fetch using a specific account's token (auto-refreshes).
async function accountFetch(account, url, options = {}) {
  let token = account.accessToken;
  if (account.expiresAt && Date.now() > account.expiresAt - 60_000) {
    try { token = await refreshAccount(account); } catch { /* surface below */ }
  }
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Pinterest API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Fetch profile info given a raw token (used right after OAuth).
async function fetchProfile(token) {
  const c = creds();
  const res = await fetch(`${c.apiBase}/user_account`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`user_account ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchBoardsRaw(token) {
  const c = creds();
  const res = await fetch(`${c.apiBase}/boards?page_size=250`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`boards ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.items || []).map((b) => ({ id: b.id, name: b.name }));
}

// Complete OAuth: turn a code into a stored account with its boards.
export async function connectAccountFromCode(code) {
  const tokenData = await exchangeCodeForToken(code);
  const token = tokenData.access_token;
  const profile = await fetchProfile(token).catch(() => ({ username: `account-${Date.now()}` }));
  const boards = await fetchBoardsRaw(token).catch(() => []);
  const account = {
    id: String(profile.id || profile.username || `account-${Date.now()}`),
    username: profile.username || 'account',
    accountType: profile.account_type || null,
    accessToken: token,
    refreshToken: tokenData.refresh_token || null,
    expiresAt: Date.now() + (Number(tokenData.expires_in) || 3600) * 1000,
    boards,
    connectedAt: new Date().toISOString(),
  };
  upsertAccount(account);
  return account;
}

// Re-sync boards for one account (call after you add/rename boards on Pinterest).
export async function syncAccountBoards(accountId) {
  const account = getAccounts().find((a) => a.id === accountId);
  if (!account) throw new Error('Account not found');
  let token = account.accessToken;
  if (account.expiresAt && Date.now() > account.expiresAt - 60_000) {
    try { token = await refreshAccount(account); } catch { /* try with existing token */ }
  }
  const boards = await fetchBoardsRaw(token);
  setAccountBoards(accountId, boards);
  return boards;
}

export async function syncAllBoards() {
  const results = [];
  for (const a of getAccounts()) {
    try { results.push({ id: a.id, username: a.username, boards: (await syncAccountBoards(a.id)).length }); }
    catch (e) { results.push({ id: a.id, username: a.username, error: e.message }); }
  }
  return results;
}

// Publish a pin to the account + board it was assigned to.
export async function createPinOnPinterest(pin, board) {
  const accountId = pin.accountId || board?.accountId;
  const account = getAccounts().find((a) => a.id === accountId);
  if (!account) throw new Error('No connected account for this pin');
  const boardId = pin.pinterestBoardId || board?.pinterestBoardId;
  if (!boardId) throw new Error(`No Pinterest board id for "${board?.name || pin.boardName}"`);

  const imgPath = path.join(config.paths.uploads, pin.filename);
  const base64 = fs.readFileSync(imgPath).toString('base64');

  const body = {
    board_id: boardId,
    title: pin.title,
    description: pin.description,
    link: pin.link || undefined,
    alt_text: pin.altText || undefined,
    media_source: { source_type: 'image_base64', content_type: pin.mime || 'image/jpeg', data: base64 },
  };
  return accountFetch(account, `${creds().apiBase}/pins`, { method: 'POST', body: JSON.stringify(body) });
}
