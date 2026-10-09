import { DEFAULTS, jevScore, takeaways, describeMedia, deepDive, ask } from './lib/api.js';

const CACHE_MAX = 3000;
const FRAME_MAX_W = 720;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

async function cacheGet(keys) {
  const got = await chrome.storage.local.get(keys.map((k) => `c:${k}`));
  return Object.fromEntries(keys.filter((k) => got[`c:${k}`]).map((k) => [k, got[`c:${k}`]]));
}

async function cachePut(entries) {
  const now = Date.now();
  await chrome.storage.local.set(
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [`c:${k}`, { ...v, t: now }])),
  );
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('c:'));
  if (keys.length <= CACHE_MAX) return;
  keys.sort((a, b) => (all[a].t ?? 0) - (all[b].t ?? 0));
  await chrome.storage.local.remove(keys.slice(0, keys.length - CACHE_MAX));
}

// Text posts: [{ id, text }]
async function score(s, posts) {
  const cached = await cacheGet(posts.map((p) => p.id));
  const todo = posts.filter((p) => !cached[p.id]);
  if (!todo.length) return cached;

  const [jev, tk] = await Promise.allSettled([
    jevScore(s.apiKey, todo, s.jevModel),
    s.takeaways ? takeaways(s.apiKey, todo, s.textModel) : Promise.resolve({}),
  ]);
  if (jev.status === 'rejected') throw jev.reason;
  const fresh = {};
  for (const p of todo) {
    fresh[p.id] = { ...jev.value[p.id], takeaway: tk.status === 'fulfilled' ? tk.value[p.id] ?? null : null };
  }
  await cachePut(fresh);
  return { ...cached, ...fresh };
}

// Reels, carousels, image posts: Gemini reads the frames, then Jev scores what it saw.
async function visual(s, { id, text, frames, kind }) {
  const cached = await cacheGet([id]);
  if (cached[id]) return cached[id];
  const seen = await describeMedia(s.apiKey, frames, text, kind, s.textModel);
  const full = [
    text,
    seen.onscreen && `[on screen] ${seen.onscreen}`,
    seen.shows && `[shows] ${seen.shows}`,
  ].filter(Boolean).join('\n');
  const sc = (await jevScore(s.apiKey, [{ id, text: full }], s.jevModel))[id];
  const result = { ...sc, takeaway: seen.takeaway ?? null, seen: full };
  await cachePut({ [id]: result });
  return result;
}

// Chrome allows about two captures a second per window.
let lastCapture = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function capture(windowId, rect, dpr) {
  const wait = lastCapture + 600 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCapture = Date.now();
  const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(bmp.width - sx, Math.round(rect.w * dpr));
  const sh = Math.min(bmp.height - sy, Math.round(rect.h * dpr));
  if (sw < 50 || sh < 50) throw new Error('media not on screen');
  const scale = Math.min(1, FRAME_MAX_W / sw);
  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
  return `data:image/jpeg;base64,${toBase64(await blob.arrayBuffer())}`;
}

async function handle(msg, sender) {
  if (msg.type === 'options') {
    await chrome.runtime.openOptionsPage();
    return {};
  }
  const s = await settings();
  if (!s.apiKey) throw new Error('no-key');
  switch (msg.type) {
    case 'score':
      return { results: await score(s, msg.posts) };
    case 'capture':
      return { frame: await capture(sender.tab.windowId, msg.rect, msg.dpr) };
    case 'visual':
      return { result: await visual(s, msg) };
    case 'deep':
      return { deep: await deepDive(s.apiKey, msg.text, msg.score, s.textModel) };
    case 'ask':
      return { answer: await ask(s.apiKey, msg.text, msg.history, s.textModel) };
    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  handle(msg, sender).then(
    (r) => send({ ok: true, ...r }),
    (e) => send({ ok: false, error: String(e?.message ?? e) }),
  );
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onStartup.addListener(pruneCache);
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await pruneCache();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
