// Larp Radar content script. Finds posts on X, Instagram and LinkedIn, gets them scored,
// tints each post in its label's colour and adds a badge, a takeaway and a deep-dive panel.
// X and text-heavy LinkedIn posts are scored from text. Instagram, and LinkedIn posts that are
// mostly an image or video, are scored from screen frames read by a vision model.
(() => {
  const HOST = location.hostname;
  const SITES = { 'www.instagram.com': 'ig', 'www.linkedin.com': 'li' };
  const SITE = SITES[HOST] || 'x';
  const BATCH = 8;
  const FLUSH_MS = 700;
  const MAX_CHARS = 1500;
  const PRIVATE = {
    x: /^\/(messages|i\/chat|settings)/,
    ig: /^\/(direct|accounts)/,
    li: /^\/(messaging|mypreferences|psettings)/,
  }[SITE];

  const LABEL_COLOURS = {
    news: '#1d9bf0',
    gem: '#f2b705',
    larp: '#f4212e',
    fearmongering: '#a855f7',
    slop: '#8b98a5',
  };
  const DARK_TEXT = new Set(['gem', 'slop']);

  let settings = {
    enabled: true,
    threshold: 70,
    mode: 'badge',
    takeaways: true,
    junk: ['larp', 'fearmongering', 'slop'],
  };
  const results = new Map(); // key -> score
  const info = new WeakMap(); // post element -> { key, text, media, visual }
  const pending = new Map(); // key -> text, waiting for a text batch
  const inflight = new Set();
  let flushTimer = null;
  let lastError = null;

  // ---------- helpers ----------

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return SITE + (h >>> 0).toString(36);
  }

  function textLines(root) {
    const out = [];
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      const t = n.data.trim();
      if (t.length > 1) out.push(t);
    }
    return out;
  }

  function bigMedia(el) {
    const all = [...el.querySelectorAll('video, img')].filter((m) => m.clientWidth >= 250 && m.clientHeight >= 200);
    return all.find((m) => m.tagName === 'VIDEO') || all[0] || null;
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // ---------- site adapters ----------

  const IG_NOISE =
    /^(verified|like|likes|comment|comments|repost|share|save|follow|following|more|more options|reply|see translation|view all .*|view replies.*|add a comment.*|liked by.*|original audio.*|audio.*|sponsored|suggested for you|suggested posts|paid partnership.*|and|others|\d+[smhdw]|\d[\d,.]*[km]?|•|·|…|\.\.\.)$/i;

  const adapters = {
    x: {
      posts: () => [...document.querySelectorAll('article[data-testid="tweet"]')],
      read(el) {
        const bodies = [...el.querySelectorAll('[data-testid="tweetText"]')].map((t) => t.innerText.trim());
        if (!bodies.join('').trim()) return null;
        const handle = (el.querySelector('[data-testid="User-Name"]')?.innerText.match(/@\w+/) || [''])[0];
        const [main, ...quoted] = bodies;
        let text = `${handle}: ${main}`;
        if (quoted.length) text += `\n[quoting] ${quoted.join('\n')}`;
        return { text, key: hash(text), visual: false };
      },
      place(el, host) {
        const anchor = el.querySelector('[data-testid="tweetText"]');
        anchor ? anchor.after(host) : el.appendChild(host);
      },
    },

    li: {
      posts: () =>
        [...document.querySelectorAll('[role="listitem"][componentkey]')].filter(
          (el) => el.querySelector('[data-testid="expandable-text-box"]') || bigMedia(el),
        ),
      read(el) {
        const body = el.querySelector('[data-testid="expandable-text-box"]')?.innerText.trim() || '';
        const lines = textLines(el);
        const i = lines.findIndex((l) => /^•\s*(1st|2nd|3rd\+?|following)/i.test(l));
        const author = i > 0 ? lines[i - 1] : '';
        const media = bigMedia(el);
        const text = `${author}: ${body}`.slice(0, MAX_CHARS);
        if (!body && !media) return null;
        const visual = !!media && body.length < 120;
        const key = visual ? `li-${el.getAttribute('componentkey')}` : hash(text);
        return { text, key, media, visual };
      },
      place(el, host) {
        const tb = el.querySelector('[data-testid="expandable-text-box"]');
        tb ? tb.before(host) : el.prepend(host);
      },
    },

    ig: {
      posts() {
        const articles = [...document.querySelectorAll('article')];
        // The Reels tab has no <article>: a post there is the box around each video.
        const reels = [...document.querySelectorAll('video')].filter((v) => !v.closest('article')).map(reelBox);
        return [...articles, ...new Set(reels)];
      },
      read(el) {
        const reel = el.tagName !== 'ARTICLE';
        const media = bigMedia(el);
        const link = [...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).find((h) => /\/(p|reel)\/[\w-]+/.test(h));
        const lines = textLines(el).filter((l) => !IG_NOISE.test(l));
        const caption = [...new Set(lines)].join('\n').slice(0, MAX_CHARS);
        if (!media && caption.length < 15) return null;
        const handle = lines[0] || '';
        const text = `@${handle}: ${caption.replace(handle, '').trim()}`;
        const key = link ? `ig${link.match(/\/(p|reel)\/([\w-]+)/)[2]}` : hash(text);
        return { text, key, media, visual: !!media, overlay: reel };
      },
      place(el, host) {
        const header = el.querySelector('header');
        header ? header.after(host) : el.prepend(host);
      },
    },
  };

  function reelBox(v) {
    let c = v;
    while (
      c.parentElement &&
      c.parentElement !== document.body &&
      c.parentElement.querySelectorAll('video').length === 1 &&
      c.parentElement.getBoundingClientRect().width < 900
    )
      c = c.parentElement;
    return c;
  }

  const site = adapters[SITE];

  // ---------- styles ----------

  const style = document.createElement('style');
  style.textContent = `
    .lr-card { outline: 2px solid var(--lr-c) !important; outline-offset: -2px;
               background-image: linear-gradient(color-mix(in srgb, var(--lr-c) 8%, transparent), color-mix(in srgb, var(--lr-c) 8%, transparent)) !important; }
    .lr-flash { animation: lr-flash 1.6s ease-out 1; }
    @keyframes lr-flash {
      0%   { box-shadow: inset 0 0 0 2000px color-mix(in srgb, var(--lr-c) 45%, transparent); }
      30%  { box-shadow: inset 0 0 80px 10px color-mix(in srgb, var(--lr-c) 70%, transparent); }
      100% { box-shadow: inset 0 0 0 0 transparent; }
    }
    .lr-ring { outline: 4px solid var(--lr-c) !important; outline-offset: -4px; }
    .lr-ring.lr-flash { animation: lr-ring-flash 1.6s ease-out 1; }
    @keyframes lr-ring-flash {
      0%   { box-shadow: 0 0 0 6px var(--lr-c), 0 0 60px 20px var(--lr-c); }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    [data-larp-chip] { position: absolute !important; z-index: 5; }
    .lr-dim { opacity: .28; transition: opacity .2s; }
    .lr-dim:hover { opacity: 1; }
    .lr-hidden { display: none !important; }
  `;
  document.documentElement.appendChild(style);

  const BADGE_CSS = `
    :host { all: initial; display: block; }
    .wrap { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 10px 0 6px; color: var(--fg); }
    .card { background: rgba(15,20,25,.94); color: #e7e9ea; border-radius: 12px; padding: 10px 12px; width: 250px;
            box-shadow: 0 6px 24px rgba(0,0,0,.45); border: 2px solid var(--c); }
    .pill { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 999px; cursor: pointer;
            background: var(--c); color: var(--on); font-weight: 800; font-size: 13px; letter-spacing: .03em;
            box-shadow: 0 1px 6px color-mix(in srgb, var(--c) 45%, transparent); }
    .pill:hover { filter: brightness(1.08); }
    .pct { font-weight: 600; opacity: .85; }
    .tk { margin-top: 8px; padding: 7px 10px; border-left: 4px solid var(--c); border-radius: 4px;
          background: color-mix(in srgb, var(--c) 12%, transparent); font-size: 14px; font-weight: 500; }
    .tk b { font-weight: 800; color: var(--c); margin-right: 4px; }
    .wait { opacity: .6; font-size: 13px; }
    .err { color: #f5a524; font-size: 13px; cursor: pointer; }
  `;

  const CHIP_CSS = `
    :host { all: initial; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
            font: 800 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .05em;
            color: var(--c); background: color-mix(in srgb, var(--c) 16%, rgba(0,0,0,.55)); border: 1px solid var(--c);
            backdrop-filter: blur(4px); white-space: nowrap; }
    .chip:hover { background: var(--c); color: var(--on); }
    .pct { font-weight: 600; opacity: .8; letter-spacing: 0; }
  `;
  const CHIP_TEXT = { news: '⚡ NEWS', gem: '★ GEM', larp: '🎭 LARP', fearmongering: '⚠ FEAR', slop: '✕ SLOP' };
  const CHIP_POS = { x: 'top:10px;right:64px', li: 'top:12px;right:92px', ig: 'top:14px;right:52px' }[SITE];

  function pageFg() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    const light = m && (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 > 140;
    return light ? '#0f1419' : '#e7e9ea';
  }

  // ---------- badge ----------

  const overlays = new Map(); // reel box -> floating host

  function hostFor(el, inf) {
    if (inf.overlay) {
      let host = overlays.get(el);
      if (!host || !host.isConnected) {
        host = makeHost();
        host.style.cssText = 'position:fixed;z-index:2147483640;display:none';
        document.body.appendChild(host);
        overlays.set(el, host);
      }
      return host;
    }
    let host = el.querySelector(':scope [data-larp-radar]:not([data-larp-chip])');
    if (!host) {
      host = makeHost();
      site.place(el, host);
    }
    return host;
  }

  function makeHost() {
    const host = document.createElement('div');
    host.setAttribute('data-larp-radar', '');
    host.attachShadow({ mode: 'open' });
    for (const ev of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'])
      host.addEventListener(ev, (e) => e.stopPropagation());
    return host;
  }

  function isJunk(r) {
    return !!r && ((typeof r.larp === 'number' && r.larp >= settings.threshold) || settings.junk.includes(r.label));
  }

  function render(el) {
    const inf = info.get(el);
    if (!inf) return;
    const r = results.get(inf.key);
    const host = hostFor(el, inf);
    const c = LABEL_COLOURS[r?.label] || '#8b98a5';
    const on = DARK_TEXT.has(r?.label) ? '#0f1419' : '#fff';
    const root = host.shadowRoot;
    root.innerHTML = `<style>${BADGE_CSS}</style><div class="wrap ${inf.overlay ? 'card' : ''}" style="--fg:${inf.overlay ? '#e7e9ea' : pageFg()};--c:${c};--on:${on}"></div>`;
    const wrap = root.querySelector('.wrap');

    if (!r) {
      if (lastError && !inflight.has(inf.key)) {
        wrap.innerHTML = `<span class="err">Larp Radar: ${esc(errorText(lastError))}</span>`;
        wrap.querySelector('.err').onclick = () => send({ type: 'options' });
      } else {
        let wait = 'Larp Radar is reading this...';
        if (inf.visual) wait = inflight.has(inf.key) ? 'Larp Radar is watching this...' : 'Larp Radar reads this when it is on screen';
        wrap.innerHTML = `<span class="wait">${wait}</span>`;
      }
      host.style.display = '';
      (inf.tintEl ?? el).querySelector(':scope > [data-larp-chip]')?.remove();
      tint(el, inf, null);
      applyMode(el, inf, null);
      return;
    }

    const takeaway = settings.takeaways && r.takeaway ? `<div class="tk"><b>Takeaway</b>${esc(r.takeaway)}</div>` : '';
    if (inf.overlay) {
      wrap.innerHTML = `
        <span class="pill" title="Open the deep dive">${esc(CHIP_TEXT[r.label] ?? '?')}<span class="pct">${esc(r.larp ?? '?')}% larp</span></span>
        ${takeaway}`;
      wrap.querySelector('.pill').onclick = () => openPanel(el);
    } else {
      wrap.innerHTML = takeaway;
      host.style.display = takeaway ? '' : 'none';
      chip(el, inf, r, c, on);
    }
    tint(el, inf, c, r);
    applyMode(el, inf, r);
  }

  // Label chip in the card's top right, like Nate's.
  function chip(el, inf, r, c, on) {
    const target = (inf.tintEl ??= tintTarget(el));
    let host = target.querySelector(':scope > [data-larp-chip]');
    if (!host) {
      host = makeHost();
      host.setAttribute('data-larp-chip', '');
      if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
      target.appendChild(host);
    }
    host.style.cssText = CHIP_POS;
    host.shadowRoot.innerHTML = `<style>${CHIP_CSS}</style>
      <span class="chip" style="--c:${c};--on:${on}" title="Larp Radar: open the deep dive">${esc(CHIP_TEXT[r.label] ?? '?')}<span class="pct">${esc(r.larp ?? '?')}%</span></span>`;
    host.shadowRoot.querySelector('.chip').onclick = () => openPanel(el);
  }

  // LinkedIn cards paint a white layer inside the list item, which would cover a tint on the item itself.
  function tintTarget(el) {
    let t = el;
    for (let i = 0; i < 4; i++) {
      const k = [...t.children].find((n) => !n.hasAttribute('data-larp-radar'));
      if (!k) break;
      if (getComputedStyle(k).backgroundColor !== 'rgba(0, 0, 0, 0)') return k;
      t = k;
    }
    return el;
  }

  const flashed = new WeakMap(); // element -> key it last flashed for

  function tint(el, inf, c, r) {
    const target = inf.overlay ? inf.media : (inf.tintEl ??= tintTarget(el));
    if (!target) return;
    target.classList.toggle(inf.overlay ? 'lr-ring' : 'lr-card', !!c && !!r);
    if (!c || !r) return;
    target.style.setProperty('--lr-c', c);
    if (flashed.get(target) === inf.key) return;
    flashed.set(target, inf.key);
    target.classList.remove('lr-flash');
    void target.offsetWidth; // restart the animation on a recycled element
    target.classList.add('lr-flash');
    target.addEventListener('animationend', () => target.classList.remove('lr-flash'), { once: true });
  }

  function applyMode(el, inf, r) {
    const junk = isJunk(r);
    el.classList.toggle('lr-dim', junk && settings.mode === 'dim');
    if (inf.overlay) return; // a reel fills the screen; hiding it would break scrolling
    const hide = junk && settings.mode === 'hide' && !el.dataset.lrShown;
    let stub = el.previousElementSibling?.matches?.('[data-larp-stub]') ? el.previousElementSibling : null;
    if (hide) {
      el.classList.add('lr-hidden');
      if (!stub) {
        stub = document.createElement('div');
        stub.setAttribute('data-larp-stub', '');
        stub.onclick = (e) => {
          e.stopPropagation();
          el.dataset.lrShown = '1';
          render(el);
        };
        el.before(stub);
      }
      const c = LABEL_COLOURS[r.label] || '#8b98a5';
      stub.style.cssText = `font:600 13px system-ui,sans-serif;padding:10px 16px;margin:4px 0;color:${c};border-left:5px solid ${c};background:color-mix(in srgb, ${c} 10%, transparent);cursor:pointer`;
      stub.textContent = `Hidden by Larp Radar: ${(r.label ?? '').toUpperCase()}, ${r.larp}% larp. Click to show.`;
    } else {
      el.classList.remove('lr-hidden');
      stub?.remove();
    }
  }

  function errorText(e) {
    if (e === 'no-key') return 'add your OpenRouter key (click)';
    if (/Extension context invalidated/i.test(e)) return 'extension was reloaded, refresh the page';
    return `error, click for settings (${String(e).slice(0, 80)})`;
  }

  // Keep the floating reel cards next to their video.
  function placeOverlays() {
    for (const [el, host] of overlays) {
      if (!el.isConnected) {
        host.remove();
        overlays.delete(el);
        continue;
      }
      const media = info.get(el)?.media;
      const r = (media || el).getBoundingClientRect();
      const visible = r.bottom > 80 && r.top < innerHeight - 80;
      host.style.display = visible && settings.enabled ? 'block' : 'none';
      if (!visible) continue;
      const roomRight = innerWidth - r.right > 280;
      host.style.left = `${roomRight ? r.right + 16 : r.left + 10}px`;
      host.style.top = `${Math.max(10, r.top + (roomRight ? 0 : 10))}px`;
    }
  }
  let rafPending = false;
  const schedulePlace = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      placeOverlays();
    });
  };
  addEventListener('scroll', schedulePlace, { passive: true, capture: true });
  addEventListener('resize', schedulePlace);

  // ---------- text scoring ----------

  function enqueueText(key, text) {
    if (results.has(key) || inflight.has(key)) return;
    pending.set(key, text);
    if (pending.size >= BATCH) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  async function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending.size) return;
    const batch = [...pending].slice(0, BATCH);
    for (const [k] of batch) {
      pending.delete(k);
      inflight.add(k);
    }
    if (pending.size) flushTimer = setTimeout(flush, 50);
    const resp = await send({ type: 'score', posts: batch.map(([id, text]) => ({ id, text })) });
    for (const [k] of batch) inflight.delete(k);
    if (resp?.ok) {
      lastError = null;
      for (const [k, v] of Object.entries(resp.results)) results.set(k, v);
    } else {
      lastError = resp?.error ?? 'unknown';
    }
    renderKeys(new Set(batch.map(([k]) => k)));
  }

  function renderKeys(keys) {
    for (const el of site.posts()) if (keys.has(info.get(el)?.key)) render(el);
    updateHud();
    schedulePlace();
  }

  // ---------- visual scoring ----------

  const visualQueue = [];
  const queued = new Set();
  let visualBusy = false;

  function onScreenRect(m) {
    const r = m.getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const w = Math.min(innerWidth, r.right) - x;
    const h = Math.min(innerHeight, r.bottom) - y;
    return { x, y, w, h, share: w > 0 && h > 0 ? (w * h) / (r.width * r.height) : 0 };
  }

  function enqueueVisual(el) {
    const inf = info.get(el);
    if (!inf || results.has(inf.key) || inflight.has(inf.key) || queued.has(inf.key)) return;
    queued.add(inf.key);
    visualQueue.push(el);
    pumpVisual();
  }

  async function pumpVisual() {
    if (visualBusy || !visualQueue.length) return;
    visualBusy = true;
    const el = visualQueue.shift();
    const inf = info.get(el);
    if (inf) queued.delete(inf.key);
    try {
      if (inf) await runVisual(el, inf);
    } finally {
      visualBusy = false;
      pumpVisual();
    }
  }

  function hideOwnUi(on) {
    for (const host of overlays.values()) host.style.visibility = on ? 'hidden' : '';
    if (hud) hud.style.visibility = on ? 'hidden' : '';
  }

  async function runVisual(el, inf) {
    if (results.has(inf.key) || document.visibilityState !== 'visible') return;
    const media = inf.media?.isConnected ? inf.media : bigMedia(el);
    if (!media || onScreenRect(media).share < 0.5) return; // scrolled past; picked up again if it comes back
    inflight.add(inf.key);
    render(el);
    const isVideo = media.tagName === 'VIDEO';
    const frames = [];
    for (let i = 0; i < (isVideo ? 3 : 1); i++) {
      if (i) await sleep(1600);
      const r = onScreenRect(media);
      if (r.share < 0.5 || document.visibilityState !== 'visible') break;
      hideOwnUi(true);
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const resp = await send({ type: 'capture', rect: r, dpr: devicePixelRatio });
      hideOwnUi(false);
      if (!resp?.ok) {
        lastError = resp?.error;
        break;
      }
      frames.push(resp.frame);
    }
    if (frames.length) {
      const resp = await send({ type: 'visual', id: inf.key, text: inf.text, frames, kind: isVideo ? 'video' : 'image' });
      if (resp?.ok) {
        lastError = null;
        results.set(inf.key, resp.result);
      } else {
        lastError = resp?.error ?? 'unknown';
      }
    }
    inflight.delete(inf.key);
    renderKeys(new Set([inf.key]));
  }

  // ---------- scanning ----------

  // Visual posts are only read once their media has sat at least 60% on screen for a second.
  const nearby = new Set();
  const settled = new WeakSet();
  const watcher = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const el = en.target;
        const inf = info.get(el);
        if (!inf) continue;
        if (!inf.visual) {
          if (en.isIntersecting) enqueueText(inf.key, inf.text);
          continue;
        }
        en.isIntersecting ? nearby.add(el) : nearby.delete(el);
      }
    },
    { threshold: 0 },
  );

  setInterval(() => {
    if (!settings.enabled || document.visibilityState !== 'visible') return;
    for (const el of nearby) {
      const inf = info.get(el);
      if (!el.isConnected || !inf) {
        nearby.delete(el);
        continue;
      }
      if (results.has(inf.key)) continue;
      const media = inf.media?.isConnected ? inf.media : bigMedia(el);
      if (!media) continue;
      inf.media = media;
      if (onScreenRect(media).share < 0.6) {
        settled.delete(el);
        continue;
      }
      if (settled.has(el)) enqueueVisual(el);
      else settled.add(el);
    }
  }, 1000);

  function scan() {
    if (!settings.enabled || PRIVATE.test(location.pathname)) return;
    for (const el of site.posts()) {
      const read = site.read(el);
      if (!read) continue;
      const old = info.get(el);
      if (old && old.key === read.key) {
        if (!old.media?.isConnected && read.media) old.media = read.media;
        continue;
      }
      if (old) {
        // Recycled element: clear the previous post's styling.
        el.classList.remove('lr-card', 'lr-flash', 'lr-dim', 'lr-hidden');
        old.tintEl?.classList.remove('lr-card', 'lr-flash');
        old.tintEl?.querySelector(':scope > [data-larp-chip]')?.remove();
        old.media?.classList.remove('lr-ring');
        delete el.dataset.lrShown;
      }
      info.set(el, read);
      render(el);
      watcher.unobserve(el);
      watcher.observe(el);
    }
    schedulePlace();
  }

  // ---------- feed counter ----------

  let hud;
  function updateHud() {
    if (!settings.enabled || PRIVATE.test(location.pathname)) return hud?.remove();
    const scored = [...results.values()].filter((r) => typeof r.larp === 'number');
    if (!scored.length) return;
    if (!hud || !hud.isConnected) {
      hud = document.createElement('div');
      hud.attachShadow({ mode: 'open' });
      document.body.appendChild(hud);
    }
    const avg = Math.round(scored.reduce((a, r) => a + r.larp, 0) / scored.length);
    const junk = scored.filter(isJunk).length;
    const byLabel = {};
    for (const r of scored) byLabel[r.label] = (byLabel[r.label] || 0) + 1;
    const bar = Object.keys(LABEL_COLOURS)
      .filter((l) => byLabel[l])
      .map((l) => `<span style="flex:${byLabel[l]};background:${LABEL_COLOURS[l]}" title="${l} ${byLabel[l]}"></span>`)
      .join('');
    const legend = Object.keys(LABEL_COLOURS)
      .filter((l) => byLabel[l])
      .map((l) => `<span><i style="background:${LABEL_COLOURS[l]}"></i>${l} ${Math.round((100 * byLabel[l]) / scored.length)}%</span>`)
      .join('');
    hud.shadowRoot.innerHTML = `
      <style>
        .h { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; font: 12px/1.45 system-ui, sans-serif;
             background: rgba(15,20,25,.94); color: #e7e9ea; border: 1px solid #333; border-radius: 12px;
             padding: 10px 12px; width: 240px; cursor: pointer; box-shadow: 0 4px 18px rgba(0,0,0,.4); }
        .t { font-size: 13px; }
        .t b { font-size: 16px; }
        .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 7px 0 6px; gap: 1px; }
        .lg { display: flex; flex-wrap: wrap; gap: 4px 10px; color: #c4cfd6; }
        .lg i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
        .m { color: #8b98a5; margin-top: 4px; }
      </style>
      <div class="h" title="Larp Radar settings">
        <div class="t">Feed larp <b>${avg}%</b> avg · ${scored.length} posts</div>
        <div class="bar">${bar}</div>
        <div class="lg">${legend}</div>
        <div class="m">${junk} flagged as junk</div>
      </div>`;
    hud.shadowRoot.querySelector('.h').onclick = () => send({ type: 'options' });
  }

  // ---------- deep-dive panel ----------

  let panel;
  function openPanel(el) {
    const inf = info.get(el);
    const score = results.get(inf.key);
    const text = score?.seen || inf.text;
    const c = LABEL_COLOURS[score?.label] || '#8b98a5';
    panel?.remove();
    panel = document.createElement('div');
    const root = panel.attachShadow({ mode: 'open' });
    document.body.appendChild(panel);
    const history = [];
    root.innerHTML = `
      <style>
        .p { position: fixed; top: 0; right: 0; width: min(420px, 100vw); height: 100vh; z-index: 2147483647;
             background: #0f1419; color: #e7e9ea; border-left: 4px solid ${c}; box-shadow: -8px 0 30px rgba(0,0,0,.4);
             font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; flex-direction: column; }
        .top { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #2f3336; }
        .top h2 { font-size: 15px; margin: 0; }
        .x { background: none; border: 0; color: #8b98a5; font-size: 22px; cursor: pointer; line-height: 1; }
        .body { overflow-y: auto; padding: 16px 18px; flex: 1; }
        .score { display: inline-block; font-size: 18px; font-weight: 800; background: ${c}; color: ${DARK_TEXT.has(score?.label) ? '#0f1419' : '#fff'}; padding: 4px 12px; border-radius: 999px; }
        .post { white-space: pre-wrap; color: #8b98a5; font-size: 13px; border-left: 2px solid #2f3336; padding-left: 10px; margin: 12px 0 16px; max-height: 160px; overflow: auto; }
        h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #8b98a5; margin: 18px 0 6px; }
        .tk { border-left: 4px solid ${c}; background: color-mix(in srgb, ${c} 14%, transparent); padding: 8px 10px; border-radius: 4px; font-weight: 500; }
        ul { margin: 0; padding-left: 18px; }
        li { margin: 3px 0; }
        .yes { color: #00ba7c; } .partly { color: #f5a524; } .no { color: #f4212e; }
        .muted { color: #8b98a5; }
        .q { font-weight: 600; margin-top: 12px; }
        .a { white-space: pre-wrap; }
        form { display: flex; gap: 8px; padding: 12px 18px; border-top: 1px solid #2f3336; }
        input { flex: 1; padding: 9px 11px; border-radius: 8px; border: 1px solid #2f3336; background: #000; color: inherit; font: inherit; }
        button.s { padding: 0 14px; border-radius: 8px; border: 0; background: #e7e9ea; color: #0f1419; font-weight: 700; cursor: pointer; }
      </style>
      <div class="p">
        <div class="top"><h2>Larp Radar deep dive</h2><button class="x" title="Close">×</button></div>
        <div class="body">
          <span class="score">${esc((score?.label ?? '?').toUpperCase())} · ${esc(score?.larp ?? '?')}% larp</span>
          <div class="post">${esc(text)}</div>
          <div class="deep muted">Reading it properly...</div>
          <div class="qa"></div>
        </div>
        <form><input placeholder="Ask anything about this post" /><button class="s">Ask</button></form>
      </div>`;
    root.querySelector('.x').onclick = () => panel.remove();
    for (const ev of ['keydown', 'keyup', 'keypress'])
      root.querySelector('input').addEventListener(ev, (e) => e.stopPropagation()); // keep site hotkeys out

    send({ type: 'deep', text, score }).then((r) => {
      const box = root.querySelector('.deep');
      if (!r?.ok) return (box.textContent = `Deep dive failed: ${errorText(r?.error ?? 'unknown')}`);
      const d = r.deep;
      history.push({ role: 'assistant', content: `My analysis: ${JSON.stringify(d)}` });
      const list = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="muted">None</div>');
      box.className = 'deep';
      box.innerHTML = `
        <div>${esc(d.verdict)}</div>
        <h3>Real takeaway</h3><div class="tk">${esc(d.takeaway)}</div>
        <h3>Claims</h3>${d.claims?.length ? `<ul>${d.claims.map((x) => `<li><span class="${esc(x.backed)}">[${esc(x.backed)}]</span> ${esc(x.claim)} <span class="muted">${esc(x.why)}</span></li>`).join('')}</ul>` : '<div class="muted">No real claims made</div>'}
        <h3>Red flags</h3>${list(d.red_flags)}
        <h3>Green flags</h3>${list(d.green_flags)}
        <h3>Check before trusting</h3>${list(d.verify)}`;
    });

    root.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const input = root.querySelector('input');
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      const item = document.createElement('div');
      item.innerHTML = `<div class="q">${esc(q)}</div><div class="a muted">Thinking...</div>`;
      root.querySelector('.qa').appendChild(item);
      history.push({ role: 'user', content: q });
      const r = await send({ type: 'ask', text, history });
      const a = item.querySelector('.a');
      a.className = 'a';
      a.textContent = r?.ok ? r.answer : `Failed: ${errorText(r?.error ?? 'unknown')}`;
      if (r?.ok) history.push({ role: 'assistant', content: r.answer });
      root.querySelector('.body').scrollTop = 1e9;
    };
  }

  // ---------- wiring ----------

  function rerenderAll() {
    for (const el of site.posts()) if (info.has(el)) render(el);
    updateHud();
    schedulePlace();
  }

  function teardown() {
    document.querySelectorAll('[data-larp-radar],[data-larp-stub]').forEach((n) => n.remove());
    nearby.clear();
    document.querySelectorAll('.lr-card,.lr-flash,.lr-ring,.lr-dim,.lr-hidden').forEach((n) => n.classList.remove('lr-card', 'lr-flash', 'lr-ring', 'lr-dim', 'lr-hidden'));
    overlays.clear();
    hud?.remove();
  }

  chrome.storage.local.get(Object.keys(settings)).then((s) => {
    settings = { ...settings, ...s };
    scan();
  });

  chrome.storage.onChanged.addListener((changes) => {
    let touched = false;
    for (const k of Object.keys(settings)) {
      if (changes[k]) {
        settings[k] = changes[k].newValue;
        touched = true;
      }
    }
    if (changes.apiKey) {
      lastError = null;
      for (const el of site.posts()) {
        const inf = info.get(el);
        if (inf && !inf.visual && !results.has(inf.key)) enqueueText(inf.key, inf.text);
      }
    }
    if (!touched) return;
    if (!settings.enabled) return teardown();
    scan();
    rerenderAll();
  });

  let scanTimer;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }).observe(document.body, { childList: true, subtree: true });
})();
