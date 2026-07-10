// Uploads local images to a public host so Pinterest's bulk CSV can fetch them.
//
// Default: litterbox.catbox.moe (no API key, direct image URL, kept 72h — long
// enough for Pinterest to ingest the image). If an imgbb API key is set in
// settings, uses imgbb instead (permanent hosting).
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { getSettings } from './store.js';

async function hostImgbb(buffer, key) {
  const form = new URLSearchParams();
  form.append('image', buffer.toString('base64'));
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${key}`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`imgbb ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const d = await res.json();
  const url = d?.data?.url;
  if (!url) throw new Error('imgbb: no url returned');
  return url;
}

async function hostLitterbox(buffer, filename, mime) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '72h');
  form.append('fileToUpload', new Blob([buffer], { type: mime || 'image/png' }), filename || 'image.png');
  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) throw new Error(`litterbox: ${text.slice(0, 150)}`);
  return text;
}

// Host one pin's image; returns { url, host }.
export async function hostImage(pin) {
  const s = getSettings();
  const filePath = path.join(config.paths.uploads, pin.filename);
  const buffer = fs.readFileSync(filePath);
  if (s.imgbbApiKey) return { url: await hostImgbb(buffer, s.imgbbApiKey), host: 'imgbb' };
  return { url: await hostLitterbox(buffer, pin.filename, pin.mime), host: 'litterbox' };
}
