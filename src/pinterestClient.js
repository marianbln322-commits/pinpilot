// Pinterest API v5 client: OAuth flow + create pins + list boards.
// This is the "Stage 2" module. It only activates when PINTEREST_APP_ID /
// PINTEREST_APP_SECRET are configured and the user has connected an account.
//
// NOTE: Publishing to a real account requires STANDARD API access from
// Pinterest. With Trial access, created pins are sandbox-only (visible to you).
import fs from 'fs';
import path from 'path';
import { config, pinterestConfigured } from './config.js';
import { getPinterest, setPinterest } from './store.js';

const OAUTH_AUTHORIZE = 'https://www.pinterest.com/oauth/';
const SCOPES = ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'];

export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.pinterest.appId,
    redirect_uri: config.pinterest.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(','),
    state: state || 'pinpilot',
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

function basicAuthHeader() {
  const token = Buffer.from(`${config.pinterest.appId}:${config.pinterest.appSecret}`).toString('base64');
  return `Basic ${token}`;
}

export async function exchangeCodeForToken(code) {
  const res = await fetch(`${config.pinterest.apiBase}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.pinterest.redirectUri,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  persistToken(data);
  return data;
}

export async function refreshAccessToken() {
  const pinterest = getPinterest();
  if (!pinterest.refreshToken) throw new Error('No refresh token available');
  const res = await fetch(`${config.pinterest.apiBase}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: pinterest.refreshToken,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed ${res.status}`);
  const data = await res.json();
  persistToken(data);
  return data;
}

function persistToken(data) {
  setPinterest({
    connected: true,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || getPinterest().refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  });
}

async function authedFetch(url, options = {}) {
  let pinterest = getPinterest();
  if (pinterest.expiresAt && Date.now() > pinterest.expiresAt - 60_000) {
    try {
      await refreshAccessToken();
      pinterest = getPinterest();
    } catch {
      /* fall through; request will fail and surface the error */
    }
  }
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${pinterest.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Pinterest API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function fetchUserAccount() {
  const data = await authedFetch(`${config.pinterest.apiBase}/user_account`);
  setPinterest({ account: { username: data.username, type: data.account_type } });
  return data;
}

export async function fetchBoards() {
  const data = await authedFetch(`${config.pinterest.apiBase}/boards?page_size=100`);
  const boards = (data.items || []).map((b) => ({ id: b.id, name: b.name }));
  setPinterest({ boards });
  return boards;
}

/**
 * Create a pin on Pinterest. `board.pinterestBoardId` (real Pinterest board id)
 * is preferred; falls back to the mapped id.
 */
export async function createPinOnPinterest(pin, board) {
  if (!pinterestConfigured()) throw new Error('Pinterest app not configured');
  const pinterest = getPinterest();
  if (!pinterest.connected) throw new Error('Pinterest account not connected');

  // Resolve the real Pinterest board id (matched by name against live boards).
  let boardId = pin.pinterestBoardId;
  if (!boardId && board) {
    const live = (pinterest.boards || []).find(
      (b) => b.name.toLowerCase() === board.name.toLowerCase()
    );
    boardId = live?.id;
  }
  if (!boardId) throw new Error(`No matching Pinterest board for "${board?.name || pin.boardId}"`);

  const imgPath = path.join(config.paths.uploads, pin.filename);
  const base64 = fs.readFileSync(imgPath).toString('base64');
  const contentType = pin.mime || 'image/jpeg';

  const body = {
    board_id: boardId,
    title: pin.title,
    description: pin.description,
    link: pin.link || undefined,
    alt_text: pin.altText || undefined,
    media_source: {
      source_type: 'image_base64',
      content_type: contentType,
      data: base64,
    },
  };

  return authedFetch(`${config.pinterest.apiBase}/pins`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
