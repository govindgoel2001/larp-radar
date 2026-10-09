// OpenRouter calls shared by the service worker and the Node tests.
// Jev scores (it only returns probabilities and choices); a chat model writes the words.

export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
export const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const DEFAULTS = {
  apiKey: '',
  enabled: true,
  threshold: 70,
  mode: 'badge', // badge | dim | hide
  junk: ['larp', 'fearmongering', 'slop'], // labels treated like an over-threshold post
  takeaways: true,
  jevModel: 'typesafe/jev-1.13',
  textModel: 'google/gemini-2.5-flash',
};

export const LABELS = {
  news: 'breaking news, an announcement or a factual update',
  gem: 'a golden nugget: genuinely useful, specific, actionable insight, or real work shown with evidence',
  larp: 'faked or overstated expertise, results, money or access; guru posturing; engagement bait',
  fearmongering: 'alarmist or scary claims that are false, exaggerated or unsupported, meant to scare people into watching or buying',
  slop: 'generic, empty, AI-sounding filler with no real information',
};

const LARP_QUESTION = (id) => ({
  type: 'noul',
  instructions:
    `Is post ${id} larp: is the author faking or overstating expertise, results, money, ` +
    `access or insider knowledge, or making claims the post gives no evidence for?`,
  criteria: {
    true: 'fake or unbacked claims, flexing, engagement bait ("comment X and I will DM you"), guru posturing, recycled hype',
    false: 'honest, specific, verifiable, modest, or plainly sharing work, news or opinion',
  },
});

async function post(url, key, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} from OpenRouter: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// posts: [{ id, text }] -> { [id]: { larp: 0-100, label, confidence } }
export async function jevScore(key, posts, model = DEFAULTS.jevModel) {
  const short = posts.map((p, i) => ({ ...p, sid: `p${i}` }));
  const questions = {};
  for (const p of short) {
    questions[`${p.sid}_larp`] = LARP_QUESTION(p.sid);
    questions[`${p.sid}_label`] = {
      type: 'choice',
      instructions: `Classify post ${p.sid}.`,
      criteria: LABELS,
    };
  }
  const res = await post(JEV_URL, key, {
    model,
    state: {
      context: 'Posts from a social feed (X, Instagram or LinkedIn), keyed by id. Lines starting [on screen] or [shows] describe what the image or video contains.',
      posts: Object.fromEntries(short.map((p) => [p.sid, p.text])),
    },
    questions,
  });
  const out = {};
  for (const p of short) {
    const l = res.answers?.[`${p.sid}_larp`];
    const c = res.answers?.[`${p.sid}_label`];
    out[p.id] = {
      larp: typeof l?.noul === 'number' ? Math.round(l.noul * 100) : null,
      label: c?.choice ?? null,
      confidence: c?.confidence ?? null,
    };
  }
  return out;
}

function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('model did not return JSON');
  return JSON.parse(m[0]);
}

async function chat(key, model, system, user, maxTokens) {
  const res = await post(CHAT_URL, key, {
    model,
    max_tokens: maxTokens,
    reasoning: { enabled: false },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return res.choices?.[0]?.message?.content ?? '';
}

// posts: [{ id, text }] -> { [id]: "takeaway" }
export async function takeaways(key, posts, model = DEFAULTS.textModel) {
  const short = posts.map((p, i) => ({ ...p, sid: `p${i}` }));
  const system =
    'For each social media post, write the one real takeaway in under 20 words, plain words, no hype. ' +
    'If the post is a flex or bait, say what (if anything) is actually true or useful underneath. ' +
    'If there is nothing, write exactly "nothing here". ' +
    'Reply with only a JSON object mapping each id to its takeaway.';
  const user = JSON.stringify(Object.fromEntries(short.map((p) => [p.sid, p.text])));
  const obj = parseJson(await chat(key, model, system, user, 60 + 50 * posts.length));
  return Object.fromEntries(short.map((p) => [p.id, obj[p.sid] ?? null]));
}

const DEEP_SYSTEM = `You audit social media posts for larp (faked or overstated expertise, results, money or access), fearmongering (scary claims that are false or unsupported) and slop.
Be blunt and specific to this post. Do not invent facts about the author; judge only what the post shows.
Keep it short: at most 4 claims, each "why" under 15 words, at most 3 items per list.
Reply with only JSON in this shape:
{"verdict": "one sentence",
 "claims": [{"claim": "...", "backed": "yes|partly|no", "why": "..."}],
 "red_flags": ["..."],
 "green_flags": ["..."],
 "takeaway": "the real, usable point in 1-2 sentences, or 'nothing here'",
 "verify": ["what to check before trusting or acting on it"]}`;

// frames: jpeg data URLs captured from the screen. Returns { onscreen, shows, takeaway }.
export async function describeMedia(key, frames, caption, kind, model = DEFAULTS.textModel) {
  const res = await post(CHAT_URL, key, {
    model,
    max_tokens: 500,
    reasoning: { enabled: false },
    messages: [
      {
        role: 'system',
        content:
          `You get ${kind === 'video' ? 'frames taken a second or two apart from a short video' : 'a screenshot of an image post'} and its caption. ` +
          'Reply with only JSON: {"onscreen": "all readable text on screen, verbatim, in order, deduplicated across frames", ' +
          '"shows": "one sentence on what is shown", ' +
          '"takeaway": "the one real takeaway in under 20 words, plain words, or \'nothing here\'"}. ' +
          'Never repeat a money, result or fear claim as if it were true; if the post is a flex, bait or scare, ' +
          'the takeaway is what is actually shown or useful underneath, or \'nothing here\'. ' +
          'You cannot hear audio; do not guess what is said.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Caption:\n${caption || '(none)'}` },
          ...frames.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ],
  });
  return parseJson(res.choices?.[0]?.message?.content ?? '');
}

export async function deepDive(key, text, score, model = DEFAULTS.textModel) {
  const user = `Post:\n${text}\n\nJev scored it ${score?.larp ?? '?'}% larp, label "${score?.label ?? '?'}".`;
  return parseJson(await chat(key, model, DEEP_SYSTEM, user, 900));
}

// history: [{ role: 'user'|'assistant', content }]
export async function ask(key, text, history, model = DEFAULTS.textModel) {
  const res = await post(CHAT_URL, key, {
    model,
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content:
          'You help the user judge a social media post for larp and slop and pull out what is useful. ' +
          'Answer briefly and directly in plain text. Say when the post alone cannot answer something.\n\nPost:\n' + text,
      },
      ...history,
    ],
  });
  return res.choices?.[0]?.message?.content ?? '';
}
