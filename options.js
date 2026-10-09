import { DEFAULTS } from './lib/api.js';

const $ = (id) => document.getElementById(id);
const status = (t) => ($('status').textContent = t);

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('apiKey').value = s.apiKey;
  $('enabled').checked = s.enabled;
  $('mode').value = s.mode;
  $('threshold').value = s.threshold;
  $('thresholdVal').textContent = s.threshold;
  $('takeaways').checked = s.takeaways;
  for (const box of document.querySelectorAll('input[name=junk]')) box.checked = s.junk.includes(box.value);
  $('textModel').value = s.textModel;
  $('jevModel').value = s.jevModel;
}

async function save() {
  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    enabled: $('enabled').checked,
    mode: $('mode').value,
    threshold: Number($('threshold').value),
    takeaways: $('takeaways').checked,
    junk: [...document.querySelectorAll('input[name=junk]:checked')].map((b) => b.value),
    textModel: $('textModel').value.trim() || DEFAULTS.textModel,
    jevModel: $('jevModel').value.trim() || DEFAULTS.jevModel,
  });
  status('Saved. Open tabs pick it up straight away.');
}

async function test() {
  await save();
  status('Asking Jev...');
  const text = `@growthguru: I made $47,000 in 30 days with ONE ChatGPT prompt. No code. No team. Comment "PROMPT" and I'll DM it to you. ${Date.now()}`;
  const r = await chrome.runtime.sendMessage({ type: 'score', posts: [{ id: 'test', text }] });
  if (!r?.ok) return status(r?.error === 'no-key' ? 'Add your OpenRouter key first.' : `Failed: ${r?.error ?? 'no reply from the extension'}`);
  const x = r.results.test;
  await chrome.storage.local.remove('c:test');
  status(`Sample "$47k with one prompt" post\n${x.label} · ${x.larp}% larp\ntakeaway: ${x.takeaway ?? '(none)'}`);
}

$('threshold').addEventListener('input', () => ($('thresholdVal').textContent = $('threshold').value));
$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
load();
