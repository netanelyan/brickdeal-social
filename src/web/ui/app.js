// The panel, in one module.
//
// No framework, no build step, no dependency. That is the same decision the rest
// of the project makes for the same reason: this file is served by the process
// that publishes to Instagram, and a toolchain between the source and the running
// panel is a toolchain that can be out of date on the box at the moment somebody
// needs to fix a caption.
//
// TWO RULES IT KEEPS THROUGHOUT
//
//  1. Nothing is built from a string of HTML. Every node goes through el() and
//     every piece of text through textContent, because the things being rendered
//     are product names off a third-party feed. `innerHTML` with a set name in it
//     is a stored-XSS hole in a page that can publish.
//  2. The page never computes what the server can tell it. There is no local copy
//     of "is this deck approvable" — it asks, it renders the answer, and after any
//     action it asks again. Two admins acting at once is the normal case here, so
//     optimistic local state would be wrong more often than it was right.

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    // Deliberately no `style` and no `html`. Both are blocked by the page's CSP
    // anyway; leaving them unimplemented means a future edit cannot quietly
    // reintroduce them.
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(9)) {
    if (kid == null || kid === false || kid === '') continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const $ = (sel) => document.querySelector(sel);
const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${Math.round(Number(n)).toLocaleString('en-US')}₪`);

/** Hebrew relative time, short enough for a table cell. */
function ago(ts) {
  if (!ts) return 'מעולם';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'עכשיו';
  const m = Math.round(s / 60);
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.round(m / 60);
  if (h < 24) return `לפני ${h} ש׳`;
  const d = Math.round(h / 24);
  return `לפני ${d} ימים`;
}

const clock = (ts) =>
  ts
    ? new Date(ts).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

const TARGET_HE = { telegram: 'טלגרם', instagram: 'אינסטגרם', tiktok: 'טיקטוק' };
const targetsHe = (list) => (list || []).map((t) => TARGET_HE[t] || t).join(' + ');

/**
 * A rendered slide, or an honest placeholder.
 *
 * `onDisk` is checked rather than hoped for. A deck whose renders were swept is a
 * deck that cannot publish, and a broken-image icon would read as a slow network
 * — which is the one wrong thing to conclude while deciding whether to approve it.
 */
const img = (slide, cls, onclick) =>
  slide?.filename && slide.onDisk
    ? el('img', { class: cls, src: `/api/image/${encodeURIComponent(slide.filename)}`, alt: '', loading: 'lazy', onclick })
    : el('div', { class: `missing ${cls || ''}`.trim(), text: slide ? 'הקובץ נמחק' : 'אין תמונה' });

// ---------------------------------------------------------------------------
// Toasts and the lightbox
// ---------------------------------------------------------------------------

function toast(message, kind = 'ok') {
  const node = el('div', { class: `toast ${kind}`, text: String(message || '') });
  $('#toasts').append(node);
  // Failures stay long enough to read twice; a success is a confirmation and can
  // go. An error message here is often the only place a publisher's own sentence
  // is shown ("Instagram: API access blocked").
  setTimeout(() => node.remove(), kind === 'bad' ? 12000 : 5000);
}

function lightbox(src) {
  const box = el('div', { class: 'lightbox', onclick: () => box.remove() }, el('img', { src, alt: '' }));
  document.body.append(box);
  const esc = (e) => {
    if (e.key === 'Escape') {
      box.remove();
      window.removeEventListener('keydown', esc);
    }
  };
  window.addEventListener('keydown', esc);
}

const zoom = (slide) => () => {
  if (slide?.filename && slide.onDisk) lightbox(`/api/image/${encodeURIComponent(slide.filename)}`);
};

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

const state = {
  user: null,
  csrf: null,
  accounts: 0,
  tab: 'board',
  data: {},
  jobs: [],
  liveness: 'off',
  events: null,
  lastEventId: 0,
  busy: new Set(),
};

async function api(path, { method = 'GET', body = null } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  // The CSRF token the session was minted with. SameSite=Strict already blocks a
  // cross-site post; this is the second lock, and a header is the right shape for
  // it because a cross-origin form cannot set one.
  if (method !== 'GET' && state.csrf) headers['x-csrf'] = state.csrf;

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    // Same origin only. There is nowhere else to send this.
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    // The session went away — expired, or somebody signed everybody out. Drop
    // straight to the login screen rather than showing an error on a page whose
    // every button is now going to fail.
    state.user = null;
    render();
    throw new Error('צריך להתחבר מחדש');
  }

  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error(payload?.error || `שגיאה ${res.status}`);
  return payload;
}

/**
 * Run an action, with the button disabled while it is in flight.
 *
 * The lock is by key rather than on the element, because a re-render can replace
 * the button mid-action — which is exactly what happens here, since every action
 * ends by reloading the tab it was fired from.
 */
async function act(key, fn, { quiet = false } = {}) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  render();
  try {
    const result = await fn();
    if (!quiet && result?.said) toast(result.said, result.ok === false ? 'bad' : 'ok');
    return result;
  } catch (e) {
    toast(String(e.message || e), 'bad');
  } finally {
    state.busy.delete(key);
    await reload();
  }
}

const confirmed = (question) => window.confirm(question);

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/**
 * Subscribe to what is happening, on any surface.
 *
 * The events carry what changed; the page re-reads rather than patching itself
 * from the payload. That keeps one definition of every list on the server side —
 * and it means an event type the page has never heard of still causes it to show
 * the truth.
 */
function listen() {
  if (state.events) state.events.close();
  const source = new EventSource(`/api/events?since=${state.lastEventId}`);
  state.events = source;

  source.onopen = () => {
    state.liveness = 'on';
    paintLiveness();
  };
  source.onerror = () => {
    // EventSource reconnects on its own (the server sends `retry:`), so this is
    // a status change and not a failure to handle.
    state.liveness = 'off';
    paintLiveness();
  };

  source.onmessage = (e) => handleEvent(e);
  // Named events do not reach onmessage, and every event this server sends is
  // named. One listener per type would mean editing this file whenever an action
  // is added, so the types are enumerated from what the bus can emit and anything
  // unknown still lands in the generic reload below.
  for (const type of [
    'staged',
    'approved',
    'rejected',
    'privacy',
    'cover',
    'photo',
    'proposed',
    'revised',
    'built',
    'proposal:rejected',
    'published',
    'requeued',
    'held',
    'target:degraded',
    'cleared:pending',
    'cleared:queue',
    'cleared:held',
    'retry',
    'resent',
    'publish:next',
    'publish:at',
    'draft:at',
    'settings:dial',
    'settings:copy',
    'job:started',
    'job:progress',
    'job:done',
    'job:failed',
  ]) {
    source.addEventListener(type, handleEvent);
  }
}

let reloadTimer = null;

function handleEvent(e) {
  let event = null;
  try {
    event = JSON.parse(e.data);
  } catch {
    return;
  }
  if (event?.id) state.lastEventId = event.id;

  if (event.type?.startsWith('job:')) {
    const job = event.job;
    if (job) {
      state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)].slice(0, 12);
      paintJobs();
    }
    if (event.type === 'job:failed' && job?.error) toast(`${job.label}: ${job.error}`, 'bad');
    if (event.type === 'job:done' && job?.result?.message) toast(job.result.message, 'info');
    // A finished job usually changed something — a card was staged, a cover was
    // re-drawn — so fall through to the reload below.
    if (event.type === 'job:progress' || event.type === 'job:started') return;
  } else if (event.actor) {
    // Somebody else did something. Worth saying out loud: two admins on one queue
    // is the case this panel exists for, and a list that silently rearranges
    // itself is how the same deck gets approved twice.
    const words = {
      approved: 'אישר פוסט',
      rejected: 'דחה פוסט',
      built: 'בנה מצגת',
      proposed: 'הציע מצגת',
      'proposal:rejected': 'דחה הצעה',
      published: 'פרסם',
      'publish:at': 'פרסם מהתור',
      'cleared:queue': 'רוקן את התור',
      'cleared:held': 'ויתר על מוחזקים',
      retry: 'החזיר מוחזקים לתור',
      'settings:dial': 'שינה הגדרה',
      'settings:copy': 'עדכן את הקופי',
    };
    const what = words[event.type];
    if (what) toast(`${event.actor} ${what}${event.headline ? `: ${event.headline}` : ''}`, 'info');
  }

  // Coalesced. A publish emits several events in a row and each one must not cost
  // its own round trip to every open browser.
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reload(), 250);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const loaders = {
  board: async () => ({ overview: await api('/api/overview') }),
  pending: async () => ({ pending: await api('/api/pending'), overview: await api('/api/overview') }),
  queue: async () => ({ queue: await api('/api/queue'), held: await api('/api/held') }),
  held: async () => ({ held: await api('/api/held') }),
  published: async () => ({ published: await api('/api/published') }),
  feed: async () => ({ feed: await api('/api/feed') }),
  settings: async () => ({ config: await api('/api/config') }),
  admins: async () => ({ admins: await api('/api/admins') }),
  audit: async () => ({ audit: await api('/api/audit') }),
};

let reloading = false;

async function reload() {
  if (!state.user || reloading) return;
  reloading = true;
  try {
    // The counts in the sidebar come from the overview, so every tab needs it —
    // except the ones that fetch it themselves above.
    const [own, counts] = await Promise.all([
      loaders[state.tab]?.() ?? Promise.resolve({}),
      state.tab === 'board' || state.tab === 'pending' ? Promise.resolve(null) : api('/api/overview').catch(() => null),
    ]);
    state.data = { ...state.data, ...own, ...(counts ? { overview: counts } : {}) };
    render();
  } catch (e) {
    if (state.user) toast(String(e.message || e), 'bad');
  } finally {
    reloading = false;
  }
}

async function go(tab) {
  // A hash nobody recognises falls back to the board rather than rendering a
  // shell with no view in it — which is what a stale bookmark or a typo does,
  // and it should look like arriving rather than like a broken page.
  state.tab = loaders[tab] ? tab : 'board';
  tab = state.tab;
  // The hash is kept in step so a reload lands on the same tab and so a link to
  // "the queue" is a thing that can be sent to somebody.
  if (location.hash.slice(1) !== tab) location.hash = tab;
  render();
  await reload();
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const TABS = [
  { id: 'board', label: 'לוח', icon: '📊' },
  { id: 'pending', label: 'ממתינים', icon: '⏳', count: (o) => o.counts.staged + o.counts.proposals, hot: true },
  { id: 'queue', label: 'תור', icon: '📦', count: (o) => o.counts.queue },
  { id: 'held', label: 'מוחזקים', icon: '⏸️', count: (o) => o.counts.held, bad: true },
  { id: 'published', label: 'פורסם', icon: '📤' },
  { id: 'feed', label: 'פיד', icon: '🧱' },
  { id: 'settings', label: 'הגדרות', icon: '⚙️', needs: 'configure' },
  { id: 'admins', label: 'מנהלים', icon: '👥', needs: 'accounts' },
  { id: 'audit', label: 'יומן', icon: '📜' },
];

const may = (capability) => Boolean(state.user?.capabilities?.includes(capability));

function render() {
  const app = clear($('#app'));
  app.className = '';

  if (!state.user) return app.append(loginView());

  const o = state.data.overview;
  const side = el(
    'aside',
    { class: 'side' },
    el('div', { class: 'brand' }, el('b', { text: 'BrickDeal' }), el('span', { text: 'ניהול שיווק' })),
    ...TABS.filter((t) => !t.needs || may(t.needs)).map((t) => {
      const n = o && t.count ? t.count(o) : 0;
      return el(
        'button',
        { class: `nav${state.tab === t.id ? ' on' : ''}`, onclick: () => go(t.id) },
        el('span', { text: t.icon }),
        el('span', { text: t.label }),
        n ? el('span', { class: `count${(t.hot || t.bad) && n ? ' hot' : ''}`, text: String(n) }) : null
      );
    }),
    el(
      'div',
      { class: 'side-foot' },
      el(
        'div',
        { class: 'who' },
        el('span', { class: `dot ${state.liveness === 'on' ? 'live' : 'dead'}`, id: 'liveness' }),
        el('span', { text: state.user.name })
      ),
      el('div', { class: 'row' }, el('button', { class: 'btn small ghost', text: 'יציאה', onclick: signOut })),
      el('div', { class: 'who', text: state.user.role === 'owner' ? 'בעלים' : state.user.role === 'admin' ? 'מנהל' : 'צפייה' })
    )
  );

  const main = el('main', { class: 'main' });
  main.append(el('div', { class: 'jobs', id: 'jobs' }));
  const view =
    {
      board: boardView,
      pending: pendingView,
      queue: queueView,
      held: heldView,
      published: publishedView,
      feed: feedView,
      settings: settingsView,
      admins: adminsView,
      audit: auditView,
    }[state.tab] || boardView;
  main.append(view());

  app.append(el('div', { class: 'shell' }, side, main));
  paintJobs();
}

function paintLiveness() {
  const dot = $('#liveness');
  if (dot) dot.className = `dot ${state.liveness === 'on' ? 'live' : 'dead'}`;
}

function paintJobs() {
  const box = $('#jobs');
  if (!box) return;
  clear(box);
  const shown = state.jobs.filter((j) => j.status === 'running' || Date.now() - (j.endedAt || 0) < 20000);
  for (const job of shown) {
    box.append(
      el(
        'div',
        { class: `job ${job.status}` },
        job.status === 'running' ? el('span', { class: 'spin' }) : el('span', { text: job.status === 'done' ? '✅' : '❌' }),
        el('b', { text: job.label }),
        el('span', { class: 'prog', text: job.error || job.progress || (job.status === 'done' ? 'הסתיים' : '') }),
        job.actor ? el('span', { class: 'tag', text: job.actor }) : null
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function loginView() {
  const user = el('input', { type: 'text', name: 'username', autocomplete: 'username', required: true });
  const pass = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const err = el('div', { class: 'err' });
  const submit = el('button', { class: 'btn primary', type: 'submit', text: 'התחברות' });

  const form = el(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        try {
          const out = await api('/api/login', {
            method: 'POST',
            body: { username: user.value.trim(), password: pass.value },
          });
          state.user = out.user;
          state.csrf = out.csrf;
          listen();
          await go(location.hash.slice(1) || 'board');
        } catch (e2) {
          err.textContent = String(e2.message || e2);
          pass.value = '';
        } finally {
          submit.disabled = false;
        }
      },
    },
    el('h1', { text: 'BrickDeal · ניהול שיווק' }),
    el('div', {
      class: 'sub',
      text: state.accounts
        ? 'אותן פעולות שיש בטלגרם, מהדפדפן.'
        : 'עוד אין חשבונות. צור אחד מהשרת: npm run admin -- add <שם>',
    }),
    el('label', { class: 'field' }, el('span', { text: 'שם משתמש' }), user),
    el('label', { class: 'field' }, el('span', { text: 'סיסמה' }), pass),
    err,
    el('div', { class: 'row' }, submit)
  );

  return el('div', { class: 'login' }, form);
}

async function signOut() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {}
  state.user = null;
  state.csrf = null;
  state.events?.close();
  state.events = null;
  render();
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

function boardView() {
  const o = state.data.overview;
  if (!o) return el('div', { class: 'empty', text: 'טוען…' });

  const box = el('div', {});
  box.append(
    el(
      'div',
      { class: 'head' },
      el('h1', { text: 'לוח' }),
      el('span', {
        class: 'sub',
        text: `פרסום אחרון ${ago(o.lastPublishedAt)} · כרטיס אחרון ${ago(o.lastStagedAt)}`,
      }),
      el('span', { class: 'spacer' }),
      may('act')
        ? el('button', {
            class: 'btn primary',
            text: '💡 הצע מצגת',
            disabled: state.busy.has('deck'),
            onclick: () => act('deck', () => api('/api/deck', { method: 'POST', body: {} })),
          })
        : null,
      may('act')
        ? el('button', {
            class: 'btn',
            text: '📤 פרסם את הבא',
            disabled: state.busy.has('next') || !o.counts.queue,
            onclick: () => act('next', () => api('/api/queue/next', { method: 'POST' })),
          })
        : null
    )
  );

  const tiles = [
    { k: 'ממתינים לאישור', n: o.counts.staged, hot: o.counts.staged > 0, go: 'pending' },
    { k: 'הצעות', n: o.counts.proposals, hot: o.counts.proposals > 0, go: 'pending' },
    { k: 'בתור לפרסום', n: o.counts.queue, go: 'queue' },
    { k: 'מוחזקים', n: o.counts.held, bad: o.counts.held > 0, go: 'held' },
    { k: 'פורסם היום', n: o.counts.publishedToday },
    { k: `מצגות היום (מתוך ${o.schedule.decksPerDay})`, n: o.counts.stagedToday },
  ];
  box.append(
    el(
      'div',
      { class: 'grid' },
      ...tiles.map((t) =>
        el(
          'div',
          { class: `tile${t.hot ? ' hot' : ''}${t.bad ? ' bad' : ''}` },
          el('div', { class: 'n', text: String(t.n) }),
          el('div', { class: 'k', text: t.k }),
          t.go && t.n
            ? el('button', { class: 'btn small ghost', text: 'פתח', onclick: () => go(t.go) })
            : null
        )
      )
    )
  );

  // Destinations, which is the panel's answer to /health.
  const health = el('div', { class: 'card' }, el('h2', { text: 'יעדים' }));
  const table = el(
    'table',
    { class: 'list' },
    el(
      'tr',
      {},
      el('th', { text: 'יעד' }),
      el('th', { text: 'מצב' }),
      el('th', { text: 'הצלחה אחרונה' }),
      el('th', { text: 'שגיאה אחרונה' })
    )
  );
  for (const h of o.health) {
    table.append(
      el(
        'tr',
        {},
        el('td', {}, el('b', { text: h.label }), h.configured ? null : el('span', { class: 'tag', text: 'לא מוגדר' })),
        el(
          'td',
          {},
          h.blocking
            ? el('span', { class: 'tag bad', text: `מושבת · חוזר ${ago(h.recoveryDueAt)}` })
            : h.degraded
              ? el('span', { class: 'tag warn', text: 'ממתין לבדיקה' })
              : el('span', { class: 'tag ok', text: 'תקין' }),
          h.failures ? el('span', { class: 'tag warn', text: `${h.failures} כשלונות` }) : null
        ),
        el('td', { text: h.lastOkAt ? ago(h.lastOkAt) : 'מעולם' }),
        el('td', { class: 'meta', text: h.lastError || '—' })
      )
    );
  }
  health.append(el('div', { class: 'wrap' }, table));
  box.append(health);

  // Connections: tokens, scopes, caps — everything knowable without a call, plus
  // a button for each thing that needs one.
  const c = o.connections;
  const conn = el('div', { class: 'card' }, el('h2', { text: 'חיבורים' }));
  const probe = el('div', { class: 'meta', id: 'probe' });
  conn.append(
    el(
      'div',
      { class: 'row' },
      el('span', { class: `tag ${c.instagram.configured ? 'ok' : 'bad'}`, text: `אינסטגרם: ${c.instagram.configured ? 'מחובר' : 'לא מוגדר'}` }),
      c.instagram.tokenDaysLeft != null
        ? el('span', {
            class: `tag ${c.instagram.tokenDaysLeft > 7 ? '' : 'warn'}`,
            text: `טוקן: ${c.instagram.tokenDaysLeft} ימים`,
          })
        : null,
      el('span', { class: `tag ${c.tiktok.configured ? 'ok' : 'bad'}`, text: `טיקטוק: ${c.tiktok.configured ? 'מחובר' : 'לא מוגדר'}` }),
      c.tiktok.configured
        ? el('span', { class: 'tag', text: `${c.tiktok.usedInLast24h}/${c.tiktok.dailyCap} ב-24ש׳` })
        : null,
      c.tiktok.tokenHoursLeft != null ? el('span', { class: 'tag', text: `טוקן: ${c.tiktok.tokenHoursLeft} ש׳` }) : null,
      el('span', { class: `tag ${c.images ? 'ok' : 'warn'}`, text: c.images ? 'תמונות: בינה מלאכותית' : 'תמונות: קטלוג בלבד' })
    )
  );
  if (c.tiktok.configured && c.tiktok.missingScopes?.length) {
    conn.append(
      el('p', { class: 'note bad', text: `חסרות הרשאות בטיקטוק: ${c.tiktok.missingScopes.join(', ')} — פרסום ייכשל עד חיבור מחדש` })
    );
  }
  conn.append(
    el(
      'div',
      { class: 'row' },
      el('button', {
        class: 'btn small',
        text: 'בדוק אינסטגרם (עולה קריאה)',
        onclick: async () => {
          const r = await api('/api/probe/instagram');
          probe.textContent = r.error
            ? `אינסטגרם: ${r.error}`
            : r.configured
              ? `אינסטגרם: נותרו ${r.remaining ?? '?'} פרסומים ב-24 השעות הקרובות`
              : 'אינסטגרם לא מוגדר';
        },
      }),
      el('button', {
        class: 'btn small',
        text: 'בדוק טיקטוק (עולה קריאה)',
        onclick: async () => {
          const r = await api('/api/probe/tiktok');
          probe.textContent = r.error
            ? `טיקטוק: ${r.error}`
            : r.configured
              ? `טיקטוק: @${r.username || '?'} · ${(r.options || []).map((o2) => o2.label).join(', ')}${r.preAudit ? ' (לפני audit — רק פרטי)' : ''}`
              : 'טיקטוק לא מוגדר';
        },
      }),
      probe
    )
  );
  box.append(conn);

  box.append(
    el(
      'div',
      { class: 'card' },
      el('h2', { text: 'עלות ושימוש' }),
      el('pre', { class: 'text', text: o.usageReport || '—' })
    )
  );

  return box;
}

// ---------------------------------------------------------------------------
// Pending: proposals, then built decks
// ---------------------------------------------------------------------------

function pendingView() {
  const data = state.data.pending;
  const box = el('div', {});

  const ask = el('input', { type: 'text', placeholder: 'נושא, מחיר או שם של סט — או ריק' });
  box.append(
    el(
      'div',
      { class: 'head' },
      el('h1', { text: 'ממתינים' }),
      el('span', { class: 'spacer' }),
      may('act') ? ask : null,
      may('act')
        ? el('button', {
            class: 'btn primary',
            text: '💡 הצע מצגת',
            disabled: state.busy.has('deck'),
            onclick: () =>
              act('deck', () => api('/api/deck', { method: 'POST', body: { request: ask.value.trim() || null } })),
          })
        : null,
      may('act') && data?.staged?.length
        ? el('button', {
            class: 'btn small',
            text: '📨 שלח כרטיסים לטלגרם',
            onclick: () => act('resend', () => api('/api/staged/resend', { method: 'POST' })),
          })
        : null
    )
  );

  if (!data) return box.append(el('div', { class: 'empty', text: 'טוען…' })), box;
  if (!data.proposals.length && !data.staged.length) {
    box.append(el('div', { class: 'empty', text: 'אין ממתינים. הצע מצגת כדי להתחיל.' }));
    return box;
  }

  for (const p of data.proposals) box.append(proposalCard(p));
  for (const s of data.staged) box.append(stagedCard(s));
  return box;
}

/** A proposal: named sets and real prices, before a shekel has been spent. */
function proposalCard(p) {
  const card = el('div', { class: 'card' });
  card.append(
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'tag accent', text: '💡 הצעה' }),
      el('h2', { text: p.subject || '—' }),
      el('span', { class: 'tag', text: p.recipe || '' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'meta', text: ago(p.proposedAt) }),
      p.inTelegram ? el('span', { class: 'tag', text: 'גם בטלגרם' }) : null
    )
  );

  if (p.warning) card.append(el('p', { class: 'note', text: `⚠️ ${p.warning}` }));

  const table = el(
    'table',
    { class: 'slides' },
    el('tr', {}, el('th', { text: 'סט' }), el('th', { text: 'מחיר' }), el('th', { text: 'מחירון' }), el('th', { text: 'חיסכון' }))
  );
  for (const d of p.deals) {
    const c = d.comparison;
    table.append(
      el(
        'tr',
        { class: c?.ok ? '' : 'nocomp' },
        el(
          'td',
          {},
          el('div', { text: d.product }),
          d.setId ? el('span', { class: 'src mono', text: `set ${d.setId}` }) : null
        ),
        el('td', { text: money(d.price) }),
        el('td', { text: c?.ok ? money(c.listIls) : '—' }),
        el('td', { text: c?.ok ? money(c.saving) : c?.why || 'ללא השוואה' })
      )
    );
  }
  card.append(el('div', { class: 'wrap' }, table));

  if (Object.keys(p.rates || {}).length) {
    card.append(
      el('div', {
        class: 'meta',
        text: `💱 ${Object.entries(p.rates)
          .map(([cur, r]) => `${cur}/ILS ${r.rate} (${r.date})`)
          .join(' · ')}`,
      })
    );
  }

  if (may('act')) {
    const build = (targets) => () =>
      act(`build:${p.key}`, () => api(`/api/proposals/${p.key}/build`, { method: 'POST', body: { targets } }));

    card.append(
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn primary', text: '📸 אינסטגרם', onclick: build(['instagram']) }),
        el('button', { class: 'btn', text: '🎵 טיקטוק (טיוטה)', onclick: build(['tiktok']) }),
        el('button', { class: 'btn', text: '📸🎵 שניהם', onclick: build(['instagram', 'tiktok']) }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn small',
          text: '🤖 שנה בהוראה',
          onclick: () => {
            const instruction = window.prompt('מה לבנות במקום? נושא, מחיר או שם של סט');
            if (instruction && instruction.trim()) {
              act(`revise:${p.key}`, () =>
                api(`/api/proposals/${p.key}/revise`, { method: 'POST', body: { instruction: instruction.trim() } })
              );
            }
          },
        }),
        el('button', {
          class: 'btn small danger',
          text: '❌ דחה',
          onclick: () => act(`nx:${p.key}`, () => api(`/api/proposals/${p.key}/reject`, { method: 'POST' })),
        })
      )
    );
    card.append(
      el('div', {
        class: 'meta',
        text: 'הבנייה עולה: קריאה אחת לשער ותמונה אחת לכל שקופית. אחרי זה תגיע לכאן מצגת לאישור.',
      })
    );
  }

  return card;
}

/** A built deck awaiting the tap that publishes it. */
function stagedCard(s) {
  const card = el('div', { class: 'card' });

  card.append(
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'tag accent', text: s.kind === 'deck' ? '🎞️ מצגת' : '📰 כרטיס' }),
      el('h2', { text: s.headline || s.subject || '—' }),
      el('span', { class: 'spacer' }),
      ...(s.targets || []).map((t) => el('span', { class: 'tag ok', text: TARGET_HE[t] || t })),
      s.tiktokDraft ? el('span', { class: 'tag warn', text: 'טיוטה' }) : null,
      s.inTelegram ? el('span', { class: 'tag', text: 'גם בטלגרם' }) : el('span', { class: 'tag warn', text: 'לא בטלגרם' })
    )
  );

  card.append(
    el(
      'div',
      { class: 'deck-head' },
      img(s.preview[0], 'cover', zoom(s.preview[0])),
      el(
        'div',
        { class: 'body' },
        el('div', { class: 'hook' }, hookWithEmphasis(s.hook, s.emphasis)),
        el(
          'div',
          { class: 'row' },
          s.hookFrom ? el('span', { class: 'tag', text: `שער: ${s.hookFrom}` }) : null,
          ...Object.entries(s.photos || {}).map(([kind, n]) =>
            el('span', {
              class: `tag ${kind === 'generated' ? 'accent' : kind === 'stock' ? 'warn' : ''}`,
              text: `${n} ${{ generated: 'תמונות AI', stock: 'תמונות קטלוג', none: 'ללא תמונה' }[kind] || kind}`,
            })
          ),
          s.tiktok?.privacyHe ? el('span', { class: 'tag', text: `🔒 ${s.tiktok.privacyHe}` }) : null
        ),
        s.photos?.generated
          ? el('p', { class: 'note', text: '⚠️ יש לסמן את הפוסט כתוכן שנוצר בבינה מלאכותית באפליקציה' })
          : null,
        ...(s.notes || []).map((n) => el('p', { class: 'note', text: `🔁 ${n}` })),
        ...(s.overrides || []).map((n) => el('p', { class: 'note', text: `⚠️ ${n}` })),
        s.tiktok?.error ? el('p', { class: 'note bad', text: `טיקטוק: ${s.tiktok.error}` }) : null
      )
    )
  );

  // The slides, as they will publish. This is the half a chat cannot do well: an
  // album in Telegram shows ten at a time and cannot be looked at next to the
  // prices it states.
  const strip = el('div', { class: 'strip' });
  s.preview.forEach((slide, i) => {
    strip.append(
      el(
        'figure',
        {},
        img(slide, '', zoom(slide)),
        el('figcaption', { text: i === 0 ? 'שער' : `${i}` })
      )
    );
  });
  card.append(strip);

  // Every price claim with its source, which is the thing being approved.
  const table = el(
    'table',
    { class: 'slides' },
    el(
      'tr',
      {},
      el('th', { text: '#' }),
      el('th', { text: 'סט' }),
      el('th', { text: 'מחיר' }),
      el('th', { text: 'מחירון' }),
      el('th', { text: 'חיסכון' }),
      may('act') ? el('th', { text: '' }) : null
    )
  );
  for (const sl of s.slides || []) {
    const c = sl.comparison;
    table.append(
      el(
        'tr',
        { class: c?.ok ? '' : 'nocomp' },
        el('td', { class: 'num', text: String(sl.n + 1) }),
        el(
          'td',
          {},
          el('div', {}, sl.rank ? `#${sl.rank} ` : '', sl.emoji ? `${sl.emoji} ` : '', sl.name),
          c?.ok && c.source
            ? el('div', {
                class: 'src mono',
                text: `${c.source.region} ${c.source.amount} ${c.source.currency} @ ${c.source.rate} (${c.source.rateDate})`,
              })
            : null,
          sl.image?.provenance
            ? el('span', {
                class: `tag ${sl.image.provenance === 'generated' ? 'accent' : 'warn'}`,
                text: sl.image.provenance === 'generated' ? 'AI' : sl.image.provenance,
                // Where the picture came from and what was wrong with it, on
                // hover. It says whether a shot came back on the second
                // attempt and whether it had room above the model, which is
                // the answer to "why is that one smaller in the frame" — a
                // question the slide itself cannot answer.
                title: sl.image.note || null,
              })
            : null
        ),
        el('td', { text: money(sl.price) }),
        el('td', { text: c?.ok ? money(c.listIls) : '—' }),
        el('td', { text: c?.ok ? money(c.saving) : c?.why || 'ללא השוואה' }),
        may('act')
          ? el(
              'td',
              {},
              el('button', {
                class: 'btn small ghost',
                text: '🖼️ תמונה חדשה',
                title: 'עולה קריאה אחת למודל',
                disabled: state.busy.has(`photo:${s.key}:${sl.n}`),
                onclick: () =>
                  confirmed(`תמונה חדשה לשקופית ${sl.n} ("${sl.name}")? זה עולה קריאה אחת למודל.`) &&
                  act(`photo:${s.key}:${sl.n}`, () =>
                    api(`/api/staged/${s.key}/photo`, { method: 'POST', body: { slide: sl.n } })
                  ),
              })
            )
          : null
      )
    );
  }
  card.append(el('div', { class: 'wrap' }, table));

  if (s.dropped?.length) {
    card.append(
      el(
        'details',
        {},
        el('summary', { text: `🚫 ${s.dropped.length} ירדו מהמצגת` }),
        el('pre', { class: 'text', text: s.dropped.map((d) => `${d.id} — ${d.why}`).join('\n') })
      )
    );
  }

  card.append(
    el('details', {}, el('summary', { text: '📝 התיאור והטקסט המלא' }), el('pre', { class: 'text', text: s.approvalText }))
  );

  if (s.renders && Object.keys(s.renders).length > 1) {
    const sizes = el('details', {}, el('summary', { text: '🖼️ כל הגזירות' }));
    for (const [size, slides] of Object.entries(s.renders)) {
      const row = el('div', { class: 'strip' });
      slides.forEach((slide, i) => row.append(el('figure', {}, img(slide, '', zoom(slide)), el('figcaption', { text: i === 0 ? 'שער' : String(i) }))));
      sizes.append(el('div', { class: 'meta', text: size === 'tiktok' ? 'טיקטוק · 1080×1920' : 'אינסטגרם · 1080×1350' }), row);
    }
    card.append(sizes);
  }

  if (may('act')) {
    card.append(
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'btn primary',
          text: '✅ אשר ופרסם',
          disabled: state.busy.has(`ok:${s.key}`),
          onclick: () => act(`ok:${s.key}`, () => api(`/api/staged/${s.key}/approve`, { method: 'POST' })),
        }),
        el('button', {
          class: 'btn danger',
          text: '❌ דחה',
          disabled: state.busy.has(`no:${s.key}`),
          onclick: () => act(`no:${s.key}`, () => api(`/api/staged/${s.key}/reject`, { method: 'POST' })),
        }),
        s.kind === 'deck'
          ? el('button', {
              class: 'btn',
              text: '🔁 שער חדש',
              title: 'משנה רק את שקופית 1 — התמונות לא נוצרות מחדש',
              disabled: state.busy.has(`cover:${s.key}`),
              onclick: () => act(`cover:${s.key}`, () => api(`/api/staged/${s.key}/cover`, { method: 'POST' })),
            })
          : null,
        (s.tiktok?.options || []).length > 1
          ? el('button', {
              class: 'btn',
              text: `🔒 פרטיות: ${s.tiktok.privacyHe || '—'}`,
              onclick: () => act(`tp:${s.key}`, () => api(`/api/staged/${s.key}/privacy`, { method: 'POST' })),
            })
          : null
      )
    );
  }

  return card;
}

/** The cover line, with the phrase that is set in cream actually set in cream. */
function hookWithEmphasis(hook, emphasis) {
  if (!hook) return el('span', { class: 'meta', text: 'אין שער' });
  if (!emphasis || !hook.includes(emphasis)) return el('span', { text: hook });
  const [before, ...rest] = hook.split(emphasis);
  return el('span', {}, before, el('em', { text: emphasis }), rest.join(emphasis));
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function queueView() {
  const data = state.data.queue;
  const box = el('div', {});
  box.append(
    el(
      'div',
      { class: 'head' },
      el('h1', { text: 'תור לפרסום' }),
      el('span', { class: 'sub', text: data?.queue?.length ? 'בסדר שבו הם יֵצאו — הטפטוף מחליף בין מצגת לכרטיס' : '' }),
      el('span', { class: 'spacer' }),
      may('act') && data?.queue?.length
        ? el('button', {
            class: 'btn primary',
            text: '📤 פרסם את הבא',
            disabled: state.busy.has('next'),
            onclick: () => act('next', () => api('/api/queue/next', { method: 'POST' })),
          })
        : null,
      may('act') && data?.queue?.length
        ? el('button', {
            class: 'btn small danger',
            text: '🧹 רוקן את התור',
            onclick: () =>
              confirmed('לרוקן את התור? פוסטים שכבר אושרו לא יפורסמו.') &&
              act('clearq', () => api('/api/queue/clear', { method: 'POST' })),
          })
        : null
    )
  );

  if (!data) return box.append(el('div', { class: 'empty', text: 'טוען…' })), box;
  if (!data.queue.length) return box.append(el('div', { class: 'empty', text: '📦 התור ריק' })), box;

  const table = el(
    'table',
    { class: 'list' },
    el(
      'tr',
      {},
      el('th', { text: '#' }),
      el('th', { text: '' }),
      el('th', { text: 'פוסט' }),
      el('th', { text: 'יעד' }),
      el('th', { text: '' })
    )
  );
  for (const q of data.queue) {
    table.append(
      el(
        'tr',
        {},
        el('td', { class: 'num', text: String(q.n) }),
        el('td', {}, q.cover?.onDisk ? img(q.cover, 'thumb', zoom(q.cover)) : null),
        el(
          'td',
          {},
          el('div', {}, q.kind === 'deck' ? '🎞️ ' : '📰 ', q.headline || '—'),
          q.attempts ? el('span', { class: 'tag warn', text: `${q.attempts} נסיונות` }) : null
        ),
        el(
          'td',
          {},
          el('span', { class: 'tag', text: targetsHe(q.targets) || 'אין יעד' }),
          q.draft ? el('span', { class: 'tag warn', text: 'טיוטה' }) : null
        ),
        may('act')
          ? el(
              'td',
              {},
              el(
                'div',
                { class: 'row' },
                el('button', {
                  class: 'btn small',
                  text: '📤 פרסם',
                  disabled: state.busy.has(`pub:${q.n}`),
                  onclick: () => act(`pub:${q.n}`, () => api(`/api/queue/${q.n}/publish`, { method: 'POST' })),
                }),
                q.targets.includes('tiktok')
                  ? el('button', {
                      class: 'btn small ghost',
                      text: '🎵 לטיוטות',
                      disabled: state.busy.has(`dr:${q.n}`),
                      onclick: () => act(`dr:${q.n}`, () => api(`/api/queue/${q.n}/draft`, { method: 'POST' })),
                    })
                  : null
              )
            )
          : null
      )
    );
  }
  box.append(el('div', { class: 'card flush' }, el('div', { class: 'wrap' }, table)));
  box.append(
    el('div', {
      class: 'meta',
      text: 'פרסום מתוך הרשימה מדלג על המרווח שנקבע — זה נרשם ביומן ונשלח לטלגרם.',
    })
  );
  return box;
}

// ---------------------------------------------------------------------------
// Held
// ---------------------------------------------------------------------------

function heldView() {
  const data = state.data.held;
  const box = el('div', {});
  box.append(
    el(
      'div',
      { class: 'head' },
      el('h1', { text: 'מוחזקים' }),
      el('span', { class: 'sub', text: 'פוסטים מאושרים שהיעד שלהם נפל' }),
      el('span', { class: 'spacer' }),
      may('act') && data?.held?.length
        ? el('button', {
            class: 'btn primary',
            text: '🔁 תיקנתי — נסה שוב',
            disabled: state.busy.has('retry'),
            onclick: () => act('retry', () => api('/api/held/retry', { method: 'POST' })),
          })
        : null,
      may('act') && data?.held?.length
        ? el('button', {
            class: 'btn small danger',
            text: '🗑️ ותר עליהם',
            onclick: () =>
              confirmed('לוותר על כל המוחזקים? מה שכבר פורסם נשאר, והיעדים יסומנו כתקינים.') &&
              act('clearheld', () => api('/api/held/clear', { method: 'POST' })),
          })
        : null
    )
  );

  if (!data) return box.append(el('div', { class: 'empty', text: 'טוען…' })), box;
  if (!data.held.length) return box.append(el('div', { class: 'empty', text: '✅ אין פוסטים מוחזקים' })), box;

  for (const h of data.held) {
    box.append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'row' },
          h.cover?.onDisk ? img(h.cover, 'thumb', zoom(h.cover)) : null,
          el('h2', { text: h.headline || '—' }),
          el('span', { class: 'tag bad', text: `חסר: ${targetsHe(h.targets)}` }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'meta', text: ago(h.ts) })
        ),
        h.error ? el('p', { class: 'note bad', text: h.error }) : null
      )
    );
  }
  return box;
}

// ---------------------------------------------------------------------------
// Published
// ---------------------------------------------------------------------------

function publishedView() {
  const data = state.data.published;
  const box = el('div', {}, el('div', { class: 'head' }, el('h1', { text: 'פורסם' })));
  if (!data) return box.append(el('div', { class: 'empty', text: 'טוען…' })), box;
  if (!data.published.length) return box.append(el('div', { class: 'empty', text: 'עוד לא פורסם כלום בחלון הנוכחי' })), box;

  const table = el(
    'table',
    { class: 'list' },
    el('tr', {}, el('th', { text: 'מתי' }), el('th', { text: 'פוסט' }), el('th', { text: 'איפה' }), el('th', { text: 'נושא' }))
  );
  for (const p of data.published) {
    table.append(
      el(
        'tr',
        {},
        el('td', { class: 'meta', text: clock(p.ts) }),
        el('td', { text: p.headline || p.id || '—' }),
        el(
          'td',
          {},
          p.instagram ? el('span', { class: 'tag ok', text: 'אינסטגרם' }) : null,
          p.tiktok
            ? el('span', {
                class: `tag ${p.tiktokDraft ? 'warn' : 'ok'}`,
                // A draft reached the inbox and published nothing. Saying
                // "posted" here is the one wrong thing to say: you would read it
                // and not open the app, which is the only place the last step can
                // happen.
                text: p.tiktokDraft ? 'טיקטוק · טיוטה' : 'טיקטוק',
              })
            : null,
          p.telegram ? el('span', { class: 'tag ok', text: 'טלגרם' }) : null
        ),
        el('td', { class: 'meta', text: [p.topic, p.place].filter(Boolean).join(' · ') || '—' })
      )
    );
  }
  box.append(el('div', { class: 'card flush' }, el('div', { class: 'wrap' }, table)));
  return box;
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

function feedView() {
  const data = state.data.feed;
  const box = el('div', {});
  box.append(
    el(
      'div',
      { class: 'head' },
      el('h1', { text: 'הפיד' }),
      el('span', { class: 'sub', text: 'מה שכל הצעה נבנית ממנו' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn small',
        text: '🔄 קרא מחדש',
        onclick: async () => {
          state.data.feed = await api('/api/feed?fresh=1');
          render();
        },
      })
    )
  );
  if (!data) return box.append(el('div', { class: 'empty', text: 'טוען…' })), box;
  if (data.error) return box.append(el('p', { class: 'note bad', text: data.error })), box;

  box.append(
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'tag ok', text: `${data.count} דילים ראויים` }),
      data.dropped.length ? el('span', { class: 'tag warn', text: `${data.dropped.length} נפלו` }) : null
    )
  );

  const table = el(
    'table',
    { class: 'list' },
    el('tr', {}, el('th', { text: 'סט' }), el('th', { text: 'מחיר' }), el('th', { text: 'מק״ט' }), el('th', { text: 'פורסם' }))
  );
  for (const d of data.deals) {
    table.append(
      el(
        'tr',
        {},
        el('td', {}, d.url ? el('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer', text: d.product || '—' }) : d.product || '—'),
        el('td', { text: money(d.price) }),
        el('td', { class: 'mono', text: d.setId || d.productId || '—' }),
        el('td', { class: 'meta', text: d.postedAt ? clock(Date.parse(d.postedAt)) : '—' })
      )
    );
  }
  box.append(el('div', { class: 'card flush' }, el('div', { class: 'wrap' }, table)));

  if (data.dropped.length) {
    box.append(
      el(
        'details',
        {},
        el('summary', { text: `🚫 ${data.dropped.length} דילים שלא ראויים לפרסום` }),
        el('pre', { class: 'text', text: data.dropped.map((d) => `${d.id} — ${d.why}`).join('\n') })
      )
    );
  }
  return box;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsView() {
  const data = state.data.config;
  const box = el('div', {}, el('div', { class: 'head' }, el('h1', { text: 'הגדרות' })));
  if (!data) return box.append(el('div', { class: 'empty', text: 'טוען…' })), box;

  // The schedule.
  const dials = el('div', { class: 'dials' });
  const LABELS = {
    POST_INTERVAL_MINUTES: 'מרווח בין פרסומים (דקות)',
    DECKS_PER_DAY: 'הצעות מצגת ביום',
    DECK_BACKLOG_MAX: 'מקסימום הצעות שממתינות',
    RUN_HOUR: 'שעת התחלה',
    GATHER_UNTIL_HOUR: 'שעת סיום',
    GATHER_EVERY_HOURS: 'כל כמה שעות להציע',
    QUIET_ALERT_HOURS: 'התראת שקט (שעות)',
  };
  for (const d of data.dials) {
    const input = el('input', { type: 'number', value: String(d.value), min: String(d.min), max: String(d.max), step: 'any' });
    dials.append(
      el(
        'div',
        { class: 'dial' },
        el('div', { class: 'k', text: LABELS[d.key] || d.key }),
        input,
        el(
          'div',
          { class: 'row' },
          el('button', {
            class: 'btn small',
            text: 'שמור',
            disabled: !may('configure'),
            onclick: () =>
              act(`dial:${d.key}`, () => api('/api/config/dial', { method: 'POST', body: { key: d.key, value: input.value } }), {
                quiet: true,
              }).then(() => toast(`${LABELS[d.key] || d.key}: ${input.value}`)),
          }),
          d.source === 'stored'
            ? el('button', {
                class: 'btn small ghost',
                text: 'חזור ל-.env',
                disabled: !may('configure'),
                onclick: () =>
                  act(`dial:${d.key}`, () => api('/api/config/dial', { method: 'POST', body: { key: d.key, value: null } })),
              })
            : null
        ),
        el('div', {
          class: 'src',
          text:
            d.source === 'stored'
              ? `נשמר כאן · ב-.env: ${d.envValue ?? 'לא מוגדר'}`
              : d.source === 'env'
                ? 'מ-.env'
                : 'ברירת מחדל',
        }),
        el('div', { class: 'src', text: `טווח ${d.min}–${d.max}` })
      )
    );
  }
  box.append(el('div', { class: 'card' }, el('h2', { text: 'לוח זמנים' }), el('p', { class: 'meta', text: 'משפיע מהטיק הבא — אין צורך להפעיל מחדש.' }), dials));

  // The copy rules.
  const copy = el('div', { class: 'card' });
  copy.append(
    el('h2', { text: 'הקופי — brick-config.json' }),
    el('p', {
      class: 'meta',
      text: 'התיאורים, ההאשטגים, שורות השער, התוויות על כל מחיר והפריים המסכם. נשמר רק אם הוא עובר אימות; אם לא — הקובץ הקודם מוחזר ותקבל את השגיאה.',
    })
  );
  if (!data.ok) copy.append(el('p', { class: 'note bad', text: `הקובץ הנוכחי לא נטען: ${data.error}` }));

  const area = el('textarea', { class: 'code', spellcheck: 'false' });
  area.value = data.raw || '';
  copy.append(area);
  copy.append(
    el(
      'div',
      { class: 'row' },
      el('button', {
        class: 'btn primary',
        text: 'שמור קופי',
        disabled: !may('configure') || state.busy.has('copy'),
        onclick: () => act('copy', () => api('/api/config/copy', { method: 'POST', body: { text: area.value } }), { quiet: true }).then((r) => r && toast('נשמר ואומת ✅')),
      }),
      data.hasBackup
        ? el('button', {
            class: 'btn small',
            text: 'שחזר גרסה קודמת',
            disabled: !may('configure'),
            onclick: () => confirmed('לשחזר את הגרסה הקודמת של הקופי?') && act('restore', () => api('/api/config/restore', { method: 'POST' })),
          })
        : null
    )
  );
  box.append(copy);
  return box;
}

// ---------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------

function adminsView() {
  const data = state.data.admins;
  const box = el('div', {}, el('div', { class: 'head' }, el('h1', { text: 'מנהלים' })));
  if (!data) return box.append(el('div', { class: 'empty', text: 'טוען…' })), box;

  const ROLE_HE = { owner: 'בעלים', admin: 'מנהל', viewer: 'צפייה' };
  const table = el(
    'table',
    { class: 'list' },
    el('tr', {}, el('th', { text: 'שם' }), el('th', { text: 'משתמש' }), el('th', { text: 'תפקיד' }), el('th', { text: 'כניסה אחרונה' }), el('th', { text: '' }))
  );
  for (const a of data.admins) {
    const roleSelect = el(
      'select',
      {
        onchange: (e) =>
          act(`role:${a.username}`, () =>
            api(`/api/admins/${encodeURIComponent(a.username)}/role`, { method: 'POST', body: { role: e.target.value } })
          ),
      },
      ...data.roles.map((r) => el('option', { value: r, selected: r === a.role, text: ROLE_HE[r] || r }))
    );
    table.append(
      el(
        'tr',
        {},
        el('td', { text: a.name || a.username }),
        el('td', { class: 'mono', text: a.username }),
        el('td', {}, roleSelect),
        el('td', { class: 'meta', text: a.lastLoginAt ? ago(a.lastLoginAt) : 'מעולם' }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'row' },
            el('button', {
              class: 'btn small',
              text: 'סיסמה חדשה',
              onclick: () => {
                const password = window.prompt(`סיסמה חדשה ל-${a.username} (12 תווים לפחות)`);
                if (password)
                  act(`pw:${a.username}`, () =>
                    api(`/api/admins/${encodeURIComponent(a.username)}/password`, { method: 'POST', body: { password } })
                  ).then((r) => r && toast('הסיסמה הוחלפה — כל החיבורים הפתוחים שלו נותקו'));
              },
            }),
            el('button', {
              class: 'btn small danger',
              text: 'הסר',
              onclick: () =>
                confirmed(`להסיר את ${a.username}?`) &&
                act(`rm:${a.username}`, () => api(`/api/admins/${encodeURIComponent(a.username)}`, { method: 'DELETE' })),
            })
          )
        )
      )
    );
  }
  box.append(el('div', { class: 'card flush' }, el('div', { class: 'wrap' }, table)));

  // Add one.
  const username = el('input', { type: 'text', autocomplete: 'off' });
  const name = el('input', { type: 'text', autocomplete: 'off' });
  const password = el('input', { type: 'password', autocomplete: 'new-password' });
  const role = el('select', {}, ...data.roles.map((r) => el('option', { value: r, selected: r === 'admin', text: ROLE_HE[r] || r })));
  box.append(
    el(
      'div',
      { class: 'card' },
      el('h2', { text: 'הוסף מנהל' }),
      el('label', { class: 'field' }, el('span', { text: 'שם משתמש (לטיני)' }), username),
      el('label', { class: 'field' }, el('span', { text: 'שם לתצוגה' }), name),
      el('label', { class: 'field' }, el('span', { text: 'סיסמה (12 תווים לפחות)' }), password),
      el('label', { class: 'field' }, el('span', { text: 'תפקיד' }), role),
      el(
        'div',
        { class: 'row' },
        el('button', {
          class: 'btn primary',
          text: 'צור',
          onclick: () =>
            act('addadmin', () =>
              api('/api/admins', {
                method: 'POST',
                body: {
                  username: username.value.trim(),
                  name: name.value.trim() || null,
                  password: password.value,
                  role: role.value,
                },
              })
            ).then((r) => {
              if (r?.admin) {
                toast(`נוצר: ${r.admin.username}`);
                username.value = '';
                name.value = '';
                password.value = '';
              }
            }),
        })
      ),
      el('p', { class: 'meta', text: 'תפקיד "צפייה" רואה הכל ולא יכול לאשר, לפרסם או לשנות הגדרות.' })
    )
  );

  box.append(
    el(
      'div',
      { class: 'card' },
      el('h2', { text: 'נתק את כולם' }),
      el('p', {
        class: 'meta',
        text: 'מחליף את המפתח שכל החיבורים חתומים בו. כולם — כולל אותך — יצטרכו להתחבר מחדש. זה מה שעושים אם חוששים שחיבור נגנב.',
      }),
      el('button', {
        class: 'btn danger',
        text: 'נתק את כל החיבורים',
        onclick: () =>
          confirmed('לנתק את כל החיבורים? תצטרך להתחבר מחדש גם אתה.') &&
          api('/api/admins/signout-all', { method: 'POST' }).then(() => {
            state.user = null;
            render();
          }),
      })
    )
  );
  return box;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function auditView() {
  const data = state.data.audit;
  const box = el(
    'div',
    {},
    el(
      'div',
      { class: 'head' },
      el('h1', { text: 'יומן' }),
      el('span', { class: 'sub', text: 'מי עשה מה, ומאיפה' })
    )
  );
  if (!data) return box.append(el('div', { class: 'empty', text: 'טוען…' })), box;
  if (!data.audit.length) return box.append(el('div', { class: 'empty', text: 'עוד אין רשומות' })), box;

  const WORDS = {
    staged: 'כרטיס נוצר',
    approved: 'אישר',
    rejected: 'דחה',
    proposed: 'הציע מצגת',
    revised: 'שינה הצעה',
    built: 'בנה מצגת',
    'proposal:rejected': 'דחה הצעה',
    cover: 'שער חדש',
    photo: 'תמונה חדשה',
    privacy: 'שינה פרטיות',
    resent: 'שלח כרטיסים מחדש',
    'publish:next': 'פרסם את הבא',
    'publish:at': 'פרסם מהתור',
    'draft:at': 'שלח לטיוטות',
    retry: 'החזיר מוחזקים',
    'cleared:pending': 'ניקה ממתינים',
    'cleared:queue': 'רוקן את התור',
    'cleared:held': 'ויתר על מוחזקים',
    'settings:dial': 'שינה לוח זמנים',
    'settings:copy': 'עדכן קופי',
    'signed-in': 'התחבר',
    'account:created': 'יצר חשבון',
    'account:password': 'החליף סיסמה',
    'account:role': 'שינה תפקיד',
    'account:removed': 'הסיר חשבון',
    'account:signout-all': 'ניתק את כולם',
  };
  const WHERE = { web: 'אתר', telegram: 'טלגרם', timer: 'טיימר', cli: 'טרמינל' };

  const table = el(
    'table',
    { class: 'list' },
    el('tr', {}, el('th', { text: 'מתי' }), el('th', { text: 'מי' }), el('th', { text: 'מה' }), el('th', { text: 'פרטים' }))
  );
  for (const row of data.audit) {
    const { ts, action, actor, ...rest } = row;
    const detail = Object.entries(rest)
      .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' · ');
    table.append(
      el(
        'tr',
        {},
        el('td', { class: 'meta', text: clock(ts) }),
        el(
          'td',
          {},
          el('span', { text: actor?.name || (actor?.kind === 'timer' ? 'המערכת' : '—') }),
          actor?.kind ? el('span', { class: 'tag', text: WHERE[actor.kind] || actor.kind }) : null
        ),
        el('td', { text: WORDS[action] || action }),
        el('td', { class: 'meta', text: detail })
      )
    );
  }
  box.append(el('div', { class: 'card flush' }, el('div', { class: 'wrap' }, table)));
  return box;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if (tab && tab !== state.tab && loaders[tab]) go(tab);
});

async function boot() {
  try {
    const s = await api('/api/session');
    state.user = s.user;
    state.csrf = s.csrf;
    state.accounts = s.accounts;
    if (state.user) {
      listen();
      const jobsNow = await api('/api/jobs').catch(() => null);
      if (jobsNow) {
        state.jobs = jobsNow.jobs;
        state.lastEventId = jobsNow.lastEventId || 0;
      }
      await go(location.hash.slice(1) || 'board');
    } else {
      render();
    }
  } catch (e) {
    clear($('#app')).append(el('p', { class: 'boot', text: `לא הצלחתי להתחבר לשרת: ${e.message}` }));
  }
}

boot();
