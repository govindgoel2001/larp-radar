// Live check against OpenRouter with made-up posts. Needs OPENROUTER_API_KEY in the environment.
import { readFileSync } from 'node:fs';
import { jevScore, takeaways, describeMedia, deepDive } from '../lib/api.js';

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('set OPENROUTER_API_KEY');

// [id, text, larp range, labels that count as right]
const cases = [
  ['build', "@nateherk: Jev is tagging X posts in real time for me. Breaking, golden nugget, or slop.\nIt's not looking at videos or images though, just the text. I'll admit the prompting needs some work.", [0, 35], ['gem', 'news']],
  ['guru', "@growthguru: I made $47,000 in 30 days with ONE ChatGPT prompt. No code. No team. Comment 'PROMPT' and I'll DM it. Most people will scroll past this and stay broke.", [70, 100], ['larp']],
  ['data', '@devnotes: Postgres 18 shipped async I/O. On our 2TB table, seq scans went from 41s to 17s. Index scans unchanged. Config: io_method=worker, 3 workers.', [0, 35], ['gem']],
  ['empty', "@aiwizard: AI is changing everything. The ones who adapt will win. The ones who don't will be left behind. Let that sink in.", [20, 100], ['slop']],
  ['news', '@reuters: The Reserve Bank of India held its repo rate at 5.5% on Wednesday, in line with a Reuters poll of economists.', [0, 35], ['news']],
  ['fear', "@doomwatch: BREAKING: banks will freeze ALL savings accounts next month. They don't want you to know. Withdraw everything NOW before it's too late. Share before this gets deleted!", [0, 100], ['fearmongering']],
];
const posts = cases.map(([id, text]) => ({ id, text }));

let fails = 0;
let t = Date.now();
const [scores, tks] = await Promise.all([jevScore(key, posts), takeaways(key, posts)]);
console.log(`text: scored ${posts.length} posts in ${Date.now() - t} ms\n`);
for (const [id, , [lo, hi], labels] of cases) {
  const s = scores[id];
  const ok = s.larp >= lo && s.larp <= hi && labels.includes(s.label);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id.padEnd(6)} ${String(s.larp).padStart(3)}% ${s.label.padEnd(13)} | ${tks[id]}`);
}

// Vision path, same steps as background.js visual(): describe the frame, then score what was seen.
t = Date.now();
const frame = `data:image/jpeg;base64,${readFileSync(new URL('./fixture-reel.jpg', import.meta.url)).toString('base64')}`;
const seen = await describeMedia(key, [frame], '@ai.hustler: link in bio 🔥', 'video');
const full = ['@ai.hustler: link in bio 🔥', `[on screen] ${seen.onscreen}`, `[shows] ${seen.shows}`].join('\n');
const vs = (await jevScore(key, [{ id: 'reel', text: full }])).reel;
const vok = /30K/i.test(seen.onscreen) && vs.larp >= 70 && vs.label === 'larp';
if (!vok) fails++;
console.log(`\n${vok ? 'PASS' : 'FAIL'} reel   ${vs.larp}% ${vs.label} in ${Date.now() - t} ms\n  read: ${seen.onscreen}\n  takeaway: ${seen.takeaway}`);

t = Date.now();
const d = await deepDive(key, cases[5][1], scores.fear);
const dok = !!d.verdict && Array.isArray(d.claims);
if (!dok) fails++;
console.log(`\n${dok ? 'PASS' : 'FAIL'} deep dive in ${Date.now() - t} ms: ${d.verdict}`);

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exitCode = fails ? 1 : 0;
