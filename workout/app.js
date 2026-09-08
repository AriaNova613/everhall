/* ===========================================================================
   Carr Athletics — the interface.

   Three files, three jobs. core.js is arithmetic that can be tested in Node,
   data.js is everything that touches the network, and this is the screen.

   The one rule that governs this file: there is no `innerHTML` in it, and
   there never should be. Not because the old escaping was wrong — it was very
   nearly right — but because correctness in a template literal lives at every
   single `${}`, and there is nowhere to put a check that catches the one you
   forgot. Building nodes makes the safe thing the only thing: `textContent`
   cannot produce markup. It is also what allows the strict Content-Security-
   Policy in index.html, because a style attribute assembled in a string needs
   'unsafe-inline' while `el.style.setProperty` does not.
   =========================================================================== */

import {
  todayISO, shiftISO, daysBetween, dayNum, fromISO, longDate, prettyDate, relativeDay,
  daysInMonth, weekDays, DOW_LONG, DOW_MIN, MONTHS, MONTHS_SHORT, pad,
  currentStreak, bestStreak, countMonth,
  TAG_GROUPS, tagLabel, MAX_TAGS,
  COLOR_SLOTS, colorVar,
  prepareSeries, latestEntry, weightSummary, sparklineGeometry, describeSeries,
  displayWeight, displayDelta, parseWeightInput, gramsFrom, WEIGHT_INPUT_RANGE,
} from './core.js';

import * as db from './data.js';

const CFG = window.CHECKMARK_CONFIG || {};
const PLATFORM = window.__CARR || { ios: false, iosSafari: false, standalone: false };

/* ===========================================================================
   DOM construction
   =========================================================================== */

const $ = sel => document.querySelector(sel);

/**
 * Build an element.
 *
 *   el('button', { class: 'btn', text: 'Save', onclick: fn }, icon('check'))
 *
 * `text` is the only way text enters, and it goes through textContent.
 * `style` takes an object and goes through setProperty, which CSP does not
 * restrict — that is the whole reason a person's colour can be applied here
 * without loosening style-src.
 */
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') for (const [p, v] of Object.entries(value)) node.style.setProperty(p, v);
    else if (key === 'data') for (const [p, v] of Object.entries(value)) node.dataset[p] = v;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  append(node, kids);
  return node;
}

function append(node, kids) {
  for (const kid of kids.flat(4)) {
    if (kid == null || kid === false) continue;
    // appendChild, not append: it lives on Node so it works for SVG elements
    // too, it takes exactly one child so nothing can be silently coerced, and
    // a stray string becomes a text node rather than markup.
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

/**
 * Append children to an existing node, skipping nulls.
 *
 * Node.append() converts null into the STRING "null" and puts it on the page,
 * which is exactly what happened the first time a conditional child was passed
 * to it directly. Everything in this file goes through here instead.
 */
const add = (node, ...kids) => { append(node, kids); return node; };

const SVGNS = 'http://www.w3.org/2000/svg';

/** A sprite icon. Always decorative — the control around it carries the name. */
function icon(id, cls) {
  const svg = document.createElementNS(SVGNS, 'svg');
  if (cls) svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVGNS, 'use');
  use.setAttribute('href', '#i-' + id);
  add(svg, use);
  return svg;
}

/** An SVG element with attributes, for the seal and the sparkline. */
function svgEl(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') { node.textContent = v; continue; }
    node.setAttribute(k, v);
  }
  append(node, kids);
  return node;
}

const mount = (host, ...kids) => { host.replaceChildren(); append(host, kids); };

/** Set a person's colour on a container. Everything inside inherits it. */
const paint = (node, slot) => { node.style.setProperty('--c', colorVar(slot)); return node; };

/* ===========================================================================
   State
   =========================================================================== */

const state = {
  session: null,
  me: null,               // my profile row
  people: [],             // everyone, me first; joined and not-yet-joined alike
  checkins: new Map(),    // "userId|YYYY-MM-DD" -> row
  weights: new Map(),     // userId -> [rows]
  cursor: null,           // { y, m } — the month on screen
  cursorPinned: false,    // true once the user has navigated deliberately
  board: null,            // whose plate is showing on a phone
  channel: null,
  live: false,
  syncError: false,
  renderedDay: null,
  installEvent: null,
  swRegistration: null,
};

const ckey = (uid, day) => `${uid}|${day}`;
const getCheckin = (uid, day) => state.checkins.get(ckey(uid, day));

/** The set of days one person has checked off. Rebuilt when check-ins load. */
const dayIndex = new Map();
function reindex() {
  dayIndex.clear();
  for (const key of state.checkins.keys()) {
    const cut = key.indexOf('|');
    const uid = key.slice(0, cut);
    let set = dayIndex.get(uid);
    if (!set) dayIndex.set(uid, (set = new Set()));
    set.add(key.slice(cut + 1));
  }
}
const daysOf = uid => dayIndex.get(uid) || new Set();

/* ===========================================================================
   Boot
   =========================================================================== */

main().catch(err => {
  console.error(err);
  window.__CARR?.fail?.('exception');
  showGate(
    el('h1', { text: 'Something went wrong', tabindex: '-1' }),
    el('p', { class: 'gate__lede', text: 'The board could not start. This is nearly always a connection problem.' }),
    el('button', { class: 'btn btn--ghost btn--wide', text: 'Try again', onclick: () => location.reload() }),
  );
});

async function main() {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return showSetup();

  if (!window.supabase) {
    return showGate(
      el('h1', { text: 'Cannot reach the network', tabindex: '-1' }),
      el('p', { class: 'gate__lede', text: 'The app could not load everything it needs. Check your connection and try again.' }),
      el('button', { class: 'btn btn--ghost btn--wide', text: 'Reload', onclick: () => location.reload() }),
    );
  }

  db.createClient(CFG);

  /* Register the worker here rather than after sign-in.
     It caches the shell and nothing else — no tokens, no board data — so it
     has no reason to wait for a session, and waiting was actively wrong: a
     first-time visitor sees only the sign-in gate, so the worker never
     installed for exactly the person being told to add the app to their home
     screen. */
  registerServiceWorker();

  /* A sign-in that came back from an email link or from Google arrives as a
     fragment on the URL. Surface a failure rather than silently showing the
     sign-in form again, which reads as "your password was wrong". */
  const url = new URL(location.href);
  const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
  const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error')
    || frag.get('error_description') || frag.get('error');
  // A real OAuth return always carries a value; a bare ?code is somebody
  // else's query string and must not put the app into a waiting state.
  const returning = !!url.searchParams.get('code') || !!frag.get('access_token');

  if (oauthError) {
    cleanUrl();
    return showSignIn({ error: oauthError });
  }

  if (returning) {
    // Hold the spinner until the exchange settles. Flashing the sign-in form
    // mid-exchange is how somebody ends up requesting a second email against
    // a two-per-hour limit for a sign-in that was about to succeed.
    const session = await db.waitForSession();
    cleanUrl();
    if (!session) return showSignIn({ error: 'That sign-in did not complete. Please try again.' });
  }

  const { session, offline } = await db.getSession();
  if (!session) return offline ? showOffline() : showSignIn({});

  await enterApp(session);

  db.state.supa.auth.onAuthStateChange((event) => {
    // Only a real sign-out reloads. A transient refresh failure must not.
    if (event === 'SIGNED_OUT') location.reload();
  });
}

const cleanUrl = () => history.replaceState({}, '', location.pathname + location.search.replace(/[?&](code|error|error_description)=[^&]*/g, '').replace(/^&/, '?'));

/* ===========================================================================
   Gate screens
   =========================================================================== */

function showGate(...content) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  const gate = $('#gate');
  gate.hidden = false;
  mount($('#gateBody'), content);
  // Moving focus to the new heading is what tells a screen reader the whole
  // screen changed; without it the swap is silent.
  requestAnimationFrame(() => $('#gateBody').querySelector('h1')?.focus());
}

function showSetup() {
  showGate(
    el('h1', { text: 'Almost there', tabindex: '-1' }),
    el('p', { class: 'gate__lede', text: 'The app is published but has not been pointed at its database yet.' }),
    el('p', { class: 'fineprint', text: 'Open the Supabase project, copy the Project URL and the publishable key from Settings, and paste both into workout/config.js.' }),
  );
}

function showOffline() {
  window.addEventListener('online', () => location.reload(), { once: true });
  showGate(
    el('h1', { text: 'You appear to be offline', tabindex: '-1' }),
    el('p', { class: 'gate__lede', text: 'You are still signed in. The board will open as soon as there is a connection.' }),
    el('button', { class: 'btn btn--ghost btn--wide', text: 'Try again', onclick: () => location.reload() }),
  );
}

/**
 * Sign in.
 *
 * The six-digit code is offered beside the link rather than behind it,
 * because on an installed iPhone app the link cannot work at all: a link
 * tapped in Mail opens Safari, and an iOS home-screen app has its own storage
 * that Safari's session never reaches. There is no way to route the link back.
 * So the code is the primary path there, and the app says so.
 */
function showSignIn({ error = '', prefill = '', sent = false, email = '' } = {}) {
  const installedOnIOS = PLATFORM.ios && PLATFORM.standalone;
  const hasCode = CFG.EMAIL_HAS_CODE === true;

  const emailField = el('input', {
    class: 'field', id: 'emailField', type: 'email', inputmode: 'email',
    autocomplete: 'email', placeholder: 'you@gmail.com', value: prefill || email,
    'aria-label': 'Your email address',
  });

  const sendBtn = el('button', {
    class: 'btn btn--primary btn--wide', type: 'button',
    text: sent ? 'Send again' : hasCode ? 'Email me a code' : 'Email me a sign-in link',
  });

  const send = async () => {
    const address = (emailField.value || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(address)) return toast('Enter a valid email address', { error: true });
    sendBtn.disabled = true;
    mount(sendBtn, el('span', { class: 'spin' }), el('span', { text: 'Sending' }));
    try {
      await db.requestSignIn(address);
      showCodeEntry(address);
    } catch (e) {
      showSignIn({ error: e.message, prefill: address });
    }
  };

  sendBtn.addEventListener('click', send);
  emailField.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

  const google = CFG.GOOGLE_ENABLED ? [
    el('button', {
      class: 'btn btn--google', type: 'button',
      onclick: async e => {
        const btn = e.currentTarget;
        btn.disabled = true;
        mount(btn, el('span', { class: 'spin' }), el('span', { text: 'Redirecting' }));
        try { await db.signInWithGoogle(); } catch (err) { showSignIn({ error: err.message }); }
      },
    }, googleMark(), el('span', { text: 'Continue with Google' })),
    el('div', { class: 'or', text: 'or' }),
  ] : [];

  showGate(
    el('h1', { text: 'Sign in', tabindex: '-1' }),
    el('p', {
      class: 'gate__lede',
      text: installedOnIOS && hasCode
        ? 'Enter the address you were invited with. We will email you a six-digit code to type in here.'
        : 'One check a day. Use the address you were invited with.',
    }),
    google,
    el('div', { class: 'stack' }, emailField, sendBtn),
    error ? el('div', { class: 'msg msg--err', text: error }) : null,
    /* The email contains a code only once the template has been given one, so
       the copy is driven by config rather than by hope. Promising a code that
       is not in the email would send somebody hunting for a number that does
       not exist — and on an installed iPhone, where the link genuinely cannot
       work, that dead end has to be named rather than papered over. */
    installedOnIOS && !hasCode
      ? el('div', { class: 'msg' },
        el('span', { text: 'On an iPhone the link in the email opens Safari, not this app, so it cannot sign you in here. Sign in from Safari instead — or send the email, then use “Trouble signing in?” to paste the link straight in.' }))
      : el('p', {
        class: 'fineprint',
        text: hasCode
          ? 'The email carries both a link and a six-digit code. Either one works.'
          : 'Tap the link in the email and you are in.',
      }),
    installedOnIOS && !hasCode
      ? el('button', { class: 'linkq', type: 'button', text: 'Trouble signing in?', onclick: () => showPasteLink((emailField.value || '').trim().toLowerCase()) })
      : null,
  );
}

/** Six separate boxes, because that is what a phone offers to autofill into. */
function showCodeEntry(email, message = '') {
  const boxes = Array.from({ length: 6 }, (_, i) => el('input', {
    class: 'field', type: 'text', inputmode: 'numeric', maxlength: i === 0 ? '6' : '1',
    autocomplete: i === 0 ? 'one-time-code' : 'off', 'aria-label': `Digit ${i + 1} of 6`,
  }));

  const read = () => boxes.map(b => b.value.replace(/\D/g, '')).join('').slice(0, 6);

  const submit = async () => {
    const code = read();
    if (code.length !== 6) return toast('Enter all six digits', { error: true });
    verifyBtn.disabled = true;
    mount(verifyBtn, el('span', { class: 'spin' }), el('span', { text: 'Checking' }));
    try {
      const session = await db.verifyCode(email, code);
      if (!session) throw new Error('That code did not work.');
      await enterApp(session);
    } catch (e) {
      showCodeEntry(email, e.message);
    }
  };

  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      // A pasted or autofilled code lands entirely in the first box; spread it.
      const digits = box.value.replace(/\D/g, '');
      if (digits.length > 1) {
        [...digits].slice(0, 6).forEach((d, k) => { if (boxes[i + k]) boxes[i + k].value = d; });
        boxes[Math.min(5, i + digits.length - 1)].focus();
      } else {
        box.value = digits;
        if (digits && boxes[i + 1]) boxes[i + 1].focus();
      }
      if (read().length === 6) submit();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && boxes[i - 1]) boxes[i - 1].focus();
      if (e.key === 'Enter') submit();
    });
  });

  const verifyBtn = el('button', { class: 'btn btn--primary btn--wide', type: 'button', text: 'Sign in', onclick: submit });

  const hasCode = CFG.EMAIL_HAS_CODE === true;

  /* Six empty boxes that can never be filled are worse than no boxes at all.
     While the email carries only a link, this screen says one thing and asks
     for nothing; the code entry comes back the moment EMAIL_HAS_CODE is true.
     The paste-the-link escape hatch stays reachable either way, because on an
     installed iPhone it is the only thing that works. */
  showGate(
    el('h1', { text: 'Check your email', tabindex: '-1' }),
    el('p', {
      class: 'gate__lede',
      text: hasCode ? `We sent a code to ${email}.` : `We sent a sign-in link to ${email}.`,
    }),
    hasCode ? null : el('div', { class: 'msg msg--ok', text: 'Tap the link in that email and you are in. You should not have to do this again on this device.' }),
    hasCode ? el('div', { class: 'fgroup' },
      el('span', { class: 'cap', text: 'Six-digit code' }),
      el('div', { class: 'otp' }, boxes),
    ) : null,
    hasCode ? verifyBtn : null,
    message ? el('div', { class: 'msg msg--err', text: message }) : null,
    hasCode
      ? el('div', { class: 'msg', text: 'The same email also has a link in it. On an Android phone, tapping the link signs you in straight away.' })
      : el('div', { class: 'msg', text: 'No email after a minute? Check spam. Sign-in emails are limited to a couple an hour for the whole board, so give it a moment before asking for another.' }),
    el('button', { class: 'linkq', type: 'button', text: 'Use a different address', onclick: () => showSignIn({ prefill: email }) }),
    el('button', { class: 'linkq', type: 'button', text: 'Trouble signing in?', onclick: () => showPasteLink(email) }),
  );

  if (hasCode) requestAnimationFrame(() => boxes[0].focus());
}

/**
 * The last resort, for an installed iPhone app whose owner cannot get a code
 * to arrive. Because the app uses the implicit flow, the sign-in link carries
 * its tokens in the fragment, so pasting the link in is enough.
 */
function showPasteLink(email) {
  const field = el('input', { class: 'field', type: 'url', placeholder: 'Paste the link from the email', 'aria-label': 'The sign-in link from your email' });
  const go = async () => {
    try {
      const session = await db.signInWithPastedLink(field.value);
      await enterApp(session);
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
  showGate(
    el('h1', { text: 'Paste the link instead', tabindex: '-1' }),
    el('p', { class: 'gate__lede', text: 'In the email, press and hold the sign-in link, choose Copy Link, then paste it here.' }),
    el('div', { class: 'stack' }, field, el('button', { class: 'btn btn--primary btn--wide', type: 'button', text: 'Sign in', onclick: go })),
    el('p', { class: 'fineprint', text: 'This works because the link carries your sign-in details in the part after the # — which is why it has to be the whole link.' }),
    el('button', { class: 'linkq', type: 'button', text: 'Back', onclick: () => showCodeEntry(email) }),
  );
}

function googleMark() {
  const svg = svgEl('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true', focusable: 'false' });
  const paths = [
    ['#EA4335', 'M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.8 2.6 13.5l7.8 6.1C12.3 13.7 17.6 9.5 24 9.5z'],
    ['#4285F4', 'M46.6 24.6c0-1.6-.1-3.2-.4-4.6H24v9.1h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.6c4.3-3.9 6.8-9.7 6.8-17.3z'],
    ['#FBBC05', 'M10.4 28.4a14.6 14.6 0 0 1 0-8.8l-7.8-6.1a24 24 0 0 0 0 21l7.8-6.1z'],
    ['#34A853', 'M24 47.5c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.6c-2 1.4-4.7 2.3-8.6 2.3-6.4 0-11.7-4.2-13.6-10.1l-7.8 6.1C6.5 42.2 14.6 47.5 24 47.5z'],
  ];
  for (const [fill, d] of paths) svg.append(svgEl('path', { fill, d }));
  return svg;
}

/* ===========================================================================
   Entering the app
   =========================================================================== */

async function enterApp(session) {
  state.session = session;

  let profiles;
  try {
    profiles = await db.loadProfiles();
  } catch (e) {
    return showGate(
      el('h1', { text: 'Could not load your board', tabindex: '-1' }),
      el('p', { class: 'gate__lede', text: e.message }),
      el('button', { class: 'btn btn--ghost btn--wide', text: 'Try again', onclick: () => location.reload() }),
    );
  }

  const mine = profiles.find(p => p.id === session.user.id);
  if (!mine) {
    // Row-level security returns nothing at all to somebody off the list, so an
    // empty result here genuinely means no access rather than an error.
    await db.signOutHere().catch(() => {});
    return showGate(
      el('h1', { text: 'No access', tabindex: '-1' }),
      el('p', { class: 'gate__lede', text: `${session.user.email || 'That address'} is not on the list for this board.` }),
      el('button', { class: 'btn btn--ghost btn--wide', text: 'Back to sign in', onclick: () => location.reload() }),
    );
  }

  state.me = mine;
  await Promise.all([reloadPeople(profiles), reloadCheckins(), reloadWeights()]);

  const now = new Date();
  state.cursor = { y: now.getFullYear(), m: now.getMonth() };
  state.board = state.me.id;

  $('#boot').hidden = true;
  $('#gate').hidden = true;
  $('#app').hidden = false;

  wireChrome();
  subscribeRealtime();
  scheduleMidnight();
  setupInstall();
  renderAll();
  handleShortcut();
}

/** Everyone on the board: profiles first, then people invited but not yet in. */
async function reloadPeople(profiles) {
  const rows = profiles || await db.loadProfiles();
  const members = await db.loadMembers().catch(() => []);
  const order = new Map(members.map(m => [m.email, m.sort_order ?? 99]));

  const joined = rows.map(p => ({
    id: p.id,
    email: p.email,
    name: p.display_name || p.email.split('@')[0],
    color: p.color,
    rule: p.rule || '',
    weeklyTarget: p.weekly_target || 4,
    weightUnit: p.weight_unit || 'lb',
    shareWeight: !!p.share_weight,
    joined: true,
  }));

  const known = new Set(joined.map(p => p.email));
  const pending = members.filter(m => !known.has(m.email)).map(m => ({
    id: null,
    email: m.email,
    name: m.display_name || m.email.split('@')[0],
    color: m.color,
    rule: '',
    weeklyTarget: 4,
    weightUnit: 'lb',
    shareWeight: false,
    joined: false,
  }));

  const rank = p => (p.id === state.me.id ? -1 : order.get(p.email) ?? 99);
  state.people = [...joined, ...pending].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const refreshed = rows.find(p => p.id === state.me.id);
  if (refreshed) state.me = refreshed;
}

async function reloadCheckins() {
  try {
    const { rows, truncated } = await db.loadCheckins({ since: db.historyFloor() });
    const map = new Map(rows.map(r => [ckey(r.user_id, r.day), r]));
    state.checkins = db.applyInflight(map);
    reindex();
    state.syncError = truncated;
    if (truncated) console.warn('check-in history was truncated by the server');
    return true;
  } catch (e) {
    console.error(e);
    state.syncError = true;
    return false;
  }
}

async function reloadWeights() {
  try {
    const rows = await db.loadWeights();
    const byUser = new Map();
    for (const r of rows) {
      let list = byUser.get(r.user_id);
      if (!list) byUser.set(r.user_id, (list = []));
      list.push(r);
    }
    state.weights = byUser;
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

/* ===========================================================================
   Chrome, sync, lifecycle
   =========================================================================== */

function wireChrome() {
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#prevM').addEventListener('click', () => stepMonth(-1));
  $('#nextM').addEventListener('click', () => stepMonth(1));

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('online', () => refresh());
  window.addEventListener('focus', () => refresh());
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60 * 1000);

  /* iOS ignores interactive-widget=resizes-content, so the sheet has to be
     told how much of the screen the keyboard has taken. Without this, Save
     sits underneath the keyboard and cannot be reached. */
  if (window.visualViewport) {
    const sync = () => {
      const inset = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
      document.documentElement.style.setProperty('--kb', `${Math.round(inset)}px`);
    };
    window.visualViewport.addEventListener('resize', sync);
    window.visualViewport.addEventListener('scroll', sync);
  }
}

let refreshTimer = null;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    // Everything that can change is reloaded, not just check-ins: a new member,
    // a renamed peer or an edited rule would otherwise never appear in an
    // installed app that goes days without a cold start.
    const ok = await reloadCheckins();
    await Promise.all([reloadPeople(), reloadWeights()]);
    if (state.renderedDay !== todayISO()) state.renderedDay = null;
    state.syncError = !ok;
    renderAll();
  }, 250);
}

function subscribeRealtime() {
  state.channel = db.subscribe({
    onCheckins: () => refresh(),
    onProfiles: () => refresh(),
    onStatus: status => {
      state.live = status === 'SUBSCRIBED';
      const live = $('#live');
      live.dataset.state = state.live ? 'on' : 'off';
      $('#liveText').textContent = state.live ? 'Live' : 'Offline';
      live.setAttribute('title', state.live
        ? 'Changes from the others appear here within a second or two'
        : 'Not connected — the board still works, it just will not update on its own');
    },
  });
}

/**
 * Re-render at midnight, and never with setInterval: a day is not always
 * 86,400,000 milliseconds long, so a fixed interval drifts by a whole hour
 * twice a year.
 */
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
  setTimeout(() => {
    if (!state.cursorPinned) {
      const n = new Date();
      state.cursor = { y: n.getFullYear(), m: n.getMonth() };
    }
    renderAll();
    scheduleMidnight();
  }, next - now);
}

function stepMonth(delta) {
  const d = new Date(state.cursor.y, state.cursor.m + delta, 1);
  const now = new Date();
  if (d > new Date(now.getFullYear(), now.getMonth(), 1)) return;
  state.cursor = { y: d.getFullYear(), m: d.getMonth() };
  state.cursorPinned = !(state.cursor.y === now.getFullYear() && state.cursor.m === now.getMonth());
  renderMonth();
}

/** Long-pressing the home-screen icon offers these. */
function handleShortcut() {
  const action = new URL(location.href).searchParams.get('a');
  if (!action) return;
  history.replaceState({}, '', location.pathname);
  if (action === 'check' && !getCheckin(state.me.id, todayISO())) checkOffToday();
  else if (action === 'check') openDayEditor(todayISO());
  else if (action === 'weight') openWeightSheet();
}

/* ===========================================================================
   Rendering
   =========================================================================== */

function renderAll() {
  const today = todayISO();
  state.renderedDay = today;
  renderBanner();
  renderToday(today);
  renderFamily(today);
  renderWeek(today);
  renderMonth();
  renderWeight();
  renderInstall();
}

function renderBanner() {
  const host = $('#bannerRoot');
  if (!state.syncError) return mount(host);
  mount(host, el('div', { class: 'banner' },
    icon('offline'),
    el('span', { text: 'Could not sync just now, so this may be out of date. It will catch up on its own.' }),
  ));
}

/* -------------------------------- today ---------------------------------- */

function renderToday(today) {
  const me = state.me;
  const mine = getCheckin(me.id, today);
  const d = fromISO(today);
  const days = daysOf(me.id);
  const week = weekDays(today);
  const doneThisWeek = week.filter(day => days.has(day)).length;
  const target = me.weekly_target || 4;

  const card = $('#todayCard');
  const parts = [
    el('span', { class: 'cap today__day', text: DOW_LONG[d.getDay()] }),
    el('div', { class: 'today__date' },
      el('span', { class: 'today__num', text: String(d.getDate()) }),
      el('span', { class: 'today__mon', text: MONTHS[d.getMonth()] }),
    ),
  ];

  if (mine) {
    parts.push(
      el('div', { class: 'stamp' },
        seal(doneThisWeek, target),
        el('div', { class: 'grow' },
          el('div', { class: 'stamp__t', text: 'Logged' }),
          el('div', { class: 'stamp__s', text: stampSubtitle(mine) }),
        ),
      ),
      statBand([
        { n: doneThisWeek, of: `of ${target}`, label: 'This week', met: doneThisWeek >= target },
        { n: currentStreak(days, today), label: 'Streak' },
        { n: countMonth(days, d.getFullYear(), d.getMonth()), label: 'This month' },
      ]),
    );
    if (mine.tags?.length) {
      parts.push(el('div', { class: 'detail' }, mine.tags.map(t => el('span', { class: 'chip', text: tagLabel(t) }))));
    }
    if (mine.note) parts.push(el('p', { class: 'quote', text: mine.note }));
    parts.push(el('button', {
      class: 'act', type: 'button', onclick: () => openDayEditor(today),
      'aria-label': 'Edit today: add tags or a note',
    }, el('span', { class: 'act__l', text: 'Edit today' }), icon('arrow')));
  } else {
    parts.push(
      el('button', {
        class: 'plate-btn', type: 'button', id: 'logToday',
        'aria-pressed': 'false',
        onclick: checkOffToday,
      }, icon('check'), el('span', { text: 'Log today' })),
      statBand([
        { n: doneThisWeek, of: `of ${target}`, label: 'This week', met: doneThisWeek >= target },
        { n: currentStreak(days, today), label: 'Streak' },
        { n: countMonth(days, d.getFullYear(), d.getMonth()), label: 'This month' },
      ]),
    );
  }

  const rule = (me.rule || '').trim();
  parts.push(el('div', { class: 'today__rule' },
    el('span', { class: 'cap', text: 'What counts for you' }),
    rule
      ? el('p', { text: rule })
      : el('p', { class: 'none', text: 'Not set yet. Write your own definition of what a workout is — nobody else can change it.' }),
  ));

  mount(card, parts);
}

function stampSubtitle(row) {
  if (row.tags?.length) return row.tags.map(tagLabel).join(' · ');
  return 'Checked off. Tags and a note are optional.';
}

/**
 * The seal: a brass arc showing the week's progress against this person's own
 * target, with a struck check inside. It is the dominant object once the day
 * is logged, which is what stops the logged state from feeling like a
 * consolation prize for having already acted.
 */
function seal(done, target) {
  const R = 54;
  const CIRC = 2 * Math.PI * R;
  const fraction = Math.max(0, Math.min(1, target > 0 ? done / target : 0));

  const wrap = el('div', { class: 'seal' });
  const svg = svgEl('svg', { viewBox: '0 0 112 112', role: 'img', 'aria-label': `${done} of ${target} days this week` });
  add(svg, 
    svgEl('circle', { class: 'seal__disc', cx: 56, cy: 56, r: 44 }),
    svgEl('circle', { class: 'seal__track', cx: 56, cy: 56, r: R }),
    svgEl('circle', {
      class: 'seal__arc', cx: 56, cy: 56, r: R,
      'stroke-dasharray': CIRC.toFixed(2),
      'stroke-dashoffset': (CIRC * (1 - fraction)).toFixed(2),
    }),
    svgEl('path', { class: 'seal__ck', d: 'M42 57.5 52.5 68 71 45' }),
  );
  svg.style.setProperty('--arc-len', CIRC.toFixed(2));
  svg.style.setProperty('--arc-off', (CIRC * (1 - fraction)).toFixed(2));
  add(wrap, svg);
  return wrap;
}

function statBand(items) {
  return el('div', { class: 'stats' }, items.map(item => {
    const value = el('div', { class: 'stat__n' + (item.n === 0 ? ' zero' : '') + (item.met ? ' met' : '') },
      el('span', { text: item.n === 0 ? '—' : String(item.n) }),
      item.of ? el('span', { class: 'stat__of', text: item.of }) : null,
    );
    return el('div', { class: 'stat' }, value, el('div', { class: 'stat__l', text: item.label }));
  }));
}

async function checkOffToday() {
  const btn = $('#logToday');
  const today = todayISO();               // read at the moment of the tap
  if (btn) btn.disabled = true;
  await writeCheckin(today, true, [], '');
}

/* -------------------------------- family --------------------------------- */

function renderFamily(today) {
  const others = state.people.filter(p => p.id !== state.me.id);
  const joined = others.filter(p => p.joined);
  const inCount = joined.filter(p => getCheckin(p.id, today)).length;

  $('#familyCount').textContent = joined.length ? `${inCount} of ${joined.length} in` : '';

  mount($('#familyCard'), others.map(person => {
    const row = paint(el('div', { class: 'rrow' + (person.joined ? '' : ' rrow--out') }), person.color);
    const checkin = person.joined ? getCheckin(person.id, today) : null;

    let stateNode;
    if (!person.joined) {
      stateNode = el('span', { class: 'rrow__s' },
        el('span', { text: 'Invited, not signed in yet' }),
      );
    } else if (checkin) {
      stateNode = el('span', { class: 'rrow__s' },
        el('span', { class: 'yes', text: checkin.tags?.length ? checkin.tags.map(tagLabel).join(' · ') : 'Logged' }),
        icon('check', 'tick'),
      );
    } else {
      stateNode = el('span', { class: 'rrow__s' },
        el('span', { text: 'Not yet' }),
        el('span', { class: 'dash', 'aria-hidden': 'true' }),
      );
    }

    add(row, 
      el('span', { class: 'dot' + (person.joined ? '' : ' dot--ring'), 'aria-hidden': 'true' }),
      el('span', { class: 'rrow__n', text: person.name }),
      stateNode,
    );
    return row;
  }));
}

/* --------------------------------- week ---------------------------------- */

function renderWeek(today) {
  const days = weekDays(today);
  $('#weekRange').textContent =
    `${fromISO(days[0]).getDate()} – ${fromISO(days[6]).getDate()} ${MONTHS_SHORT[fromISO(days[6]).getMonth()]}`;

  const header = el('div', { class: 'whd', 'aria-hidden': 'true' },
    days.map((day, i) => el('span', { text: DOW_MIN[i] })));

  const rows = state.people.map(person => {
    const set = person.joined ? daysOf(person.id) : new Set();
    const done = days.filter(d => set.has(d)).length;
    const target = person.weeklyTarget;
    const met = person.joined && done >= target;

    const isMe = person.id === state.me.id;

    const cells = days.map(day => {
      const logged = person.joined && set.has(day);
      const future = day > today;

      /* Your own past days are buttons here, not just on the month board.
         The week strip is where you look when you realise you forgot Monday,
         and a row of squares that shows the miss but will not let you fix it
         is the most annoying kind of read-only. Everyone else's stay inert —
         their detail lives on their board, and making thirty-five squares
         focusable would bury the rest of the page in tab stops. */
      const editable = isMe && person.joined && !future;
      const cell = el(editable ? 'button' : 'div', { class: 'wd' });
      if (editable) {
        cell.type = 'button';
        cell.setAttribute('aria-pressed', logged ? 'true' : 'false');
        cell.addEventListener('click', () => openDayEditor(day));
      }

      if (!person.joined) {
        cell.classList.add('is-void');
        cell.setAttribute('aria-label', `${person.name}: has not joined`);
      } else if (logged) {
        cell.classList.add('is-on');
        add(cell, icon('check'));
        cell.setAttribute('aria-label', isMe
          ? `${longDate(day)}: logged. Edit`
          : `${person.name}, ${longDate(day)}: logged`);
      } else if (future) {
        cell.classList.add('is-future');
        cell.setAttribute('aria-label', `${longDate(day)}: still to come`);
      } else {
        cell.setAttribute('aria-label', isMe
          ? `${longDate(day)}: not logged. Check it off`
          : `${person.name}, ${longDate(day)}: not logged`);
      }
      if (editable) cell.classList.add('is-edit');
      if (day === today) cell.classList.add('is-today');
      return cell;
    });

    const row = paint(el('div', { class: 'wrow' }), person.color);
    add(row, 
      el('div', { class: 'wrow__hd' },
        el('span', { class: 'dot' + (person.joined ? '' : ' dot--ring'), 'aria-hidden': 'true' }),
        el('span', { class: 'wrow__n', text: person.name }),
        el('span', { class: 'wrow__c' + (met ? ' met' : '') },
          el('b', { text: person.joined ? String(done) : '—' }),
          el('i', { text: `of ${target}` }),
        ),
      ),
      el('div', { class: 'wdays', role: 'group', 'aria-label': `${person.name}, this week` }, cells),
      person.joined ? targetRail(done, target) : null,
    );
    return row;
  });

  mount($('#weekCard'), header, rows);
}

/** A bar showing the week so far with a marker where this person's target is. */
function targetRail(done, target) {
  const rail = el('div', { class: 'wrail', 'aria-hidden': 'true' });
  add(rail, 
    el('span', { class: 'wrail__f', style: { width: `${Math.min(100, (done / 7) * 100)}%` } }),
    el('span', { class: 'wrail__t', style: { left: `${Math.min(100, (target / 7) * 100)}%` } }),
  );
  return rail;
}

/* --------------------------------- month --------------------------------- */

function renderMonth() {
  const { y, m } = state.cursor;
  const now = new Date();

  mount($('#monthLabel'), el('span', { text: MONTHS[m] + ' ' }), el('i', { text: String(y) }));
  $('#nextM').disabled = (y === now.getFullYear() && m === now.getMonth());

  /* A person who has been invited but has never signed in has no id, so their
     board is keyed by address. Comparing on id alone would silently bounce the
     selection back to your own board the moment you tapped their tab. */
  const keyOf = person => person.id || person.email;
  if (!state.people.some(p => keyOf(p) === state.board)) state.board = state.me.id;

  // Tabs: which board is shown on a phone.
  mount($('#railIn'), state.people.map(person => {
    const selected = keyOf(person) === state.board;
    const tab = paint(el('button', {
      class: 'tab', type: 'button', role: 'tab',
      'aria-selected': selected ? 'true' : 'false',
      onclick: () => { state.board = person.id || person.email; renderMonth(); },
    }), person.color);
    add(tab, 
      el('span', { class: 'dot' + (person.joined ? '' : ' dot--ring'), 'aria-hidden': 'true' }),
      el('span', { text: person.name }),
    );
    return tab;
  }));

  mount($('#plates'), state.people.map(person => monthPlate(person, y, m)));
  mount($('#indexList'), monthIndex(y, m));
  requestAnimationFrame(moveRailInk);
}

function moveRailInk() {
  const active = $('#railIn').querySelector('[aria-selected="true"]');
  const ink = $('#railInk');
  if (!active || !ink) return;
  ink.style.width = `${active.offsetWidth}px`;
  ink.style.transform = `translateX(${active.offsetLeft}px)`;
}

function monthPlate(person, y, m) {
  const key = person.id || person.email;
  const isMe = person.id === state.me.id;
  const today = todayISO();
  const set = person.joined ? daysOf(person.id) : new Set();

  const plate = paint(el('div', { class: 'panel plate' + (key === state.board ? ' is-on' : ''), data: { board: key } }), person.color);

  add(plate, el('div', { class: 'plate__hd' },
    el('span', { class: 'dot' + (person.joined ? '' : ' dot--ring'), 'aria-hidden': 'true' }),
    el('h3', { class: 'plate__n', text: person.name }),
    isMe ? el('span', { class: 'you', text: 'You' }) : null,
  ));

  add(plate, statBand([
    { n: person.joined ? countMonth(set, y, m) : 0, label: 'This month' },
    { n: person.joined ? currentStreak(set, today) : 0, label: 'Streak' },
    { n: person.joined ? bestStreak(set) : 0, label: 'Best' },
  ]));

  if (!person.joined) {
    add(plate, el('div', { class: 'empty-board' },
      el('strong', { text: 'Not signed in yet' }),
      el('p', { text: `${person.name} has been invited. Their board opens the moment they sign in for the first time.` }),
    ));
    return plate;
  }

  add(plate, 
    el('div', { class: 'dow', 'aria-hidden': 'true' }, DOW_MIN.map(d => el('span', { text: d }))),
    calendar(person, y, m, set, today, isMe),
  );

  if (set.size === 0) {
    add(plate, el('div', { class: 'empty-board' },
      el('strong', { text: isMe ? 'No days checked off yet' : 'Nothing logged yet' }),
      el('p', { text: isMe ? 'The first one is the only hard one.' : `${person.name} has not checked off a day yet.` }),
    ));
  }

  const rule = (person.rule || '').trim();
  add(plate, el('div', { class: 'plate__rule' },
    el('span', { class: 'cap', text: `What counts for ${person.name}` }),
    rule ? el('p', { text: rule }) : el('p', { class: 'none', text: 'Not set yet.' }),
    isMe ? el('button', { class: 'linkb', type: 'button', text: 'Edit my rule', onclick: openSettings }) : null,
  ));

  return plate;
}

/**
 * One person's month.
 *
 * Roving tabindex: exactly one cell in the grid is reachable by Tab, and the
 * arrow keys move within it. With five people that is the difference between
 * five tab stops and a hundred and fifty.
 */
function calendar(person, y, m, set, today, isMe) {
  const grid = el('div', {
    class: 'cal', role: 'grid',
    'aria-label': `${person.name}, ${MONTHS[m]} ${y}`,
  });

  const lead = new Date(y, m, 1).getDay();
  for (let i = 0; i < lead; i++) grid.append(el('div', { class: 'cell cell--blank', 'aria-hidden': 'true' }));

  const total = daysInMonth(y, m);
  let firstStop = null;

  for (let d = 1; d <= total; d++) {
    const iso = `${y}-${pad(m + 1)}-${pad(d)}`;
    const on = set.has(iso);
    const future = iso > today;
    const row = state.checkins.get(ckey(person.id, iso));

    const classes = ['cell'];
    if (on) classes.push('is-on');
    if (future) classes.push('is-future');
    else if (isMe) classes.push('is-edit');
    if (iso === today) classes.push('is-today');

    const label = [
      longDate(iso),
      future ? 'still to come' : on ? 'logged' : 'not logged',
      on && row?.tags?.length ? row.tags.map(tagLabel).join(', ') : '',
    ].filter(Boolean).join(', ');

    const cell = el(future ? 'div' : 'button', {
      class: classes.join(' '),
      role: 'gridcell',
      tabindex: '-1',
      'aria-label': label,
      'aria-disabled': future ? 'true' : null,
    });
    if (!future) {
      cell.type = 'button';
      if (isMe) cell.setAttribute('aria-pressed', on ? 'true' : 'false');
      cell.addEventListener('click', () => (isMe ? openDayEditor(iso) : openPeerDay(person, iso)));
      if (!firstStop) firstStop = cell;
    }

    if (on) {
      add(cell, el('span', { class: 'cell__n', text: String(d) }), icon('check', 'cell__ck'));
      if (row?.tags?.length) cell.append(el('span', { class: 'cell__tag', 'aria-hidden': 'true' }));
    } else {
      add(cell, el('span', { class: 'cell__n', text: String(d) }));
    }

    add(grid, cell);
  }

  if (firstStop) firstStop.tabIndex = 0;
  grid.addEventListener('keydown', e => {
    const cells = [...grid.querySelectorAll('[role="gridcell"]:not([aria-hidden])')].filter(c => c.tabIndex !== undefined && !c.classList.contains('cell--blank'));
    const at = cells.indexOf(document.activeElement);
    if (at < 0) return;
    const jump = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[e.key];
    let next = null;
    if (jump !== undefined) next = cells[at + jump];
    else if (e.key === 'Home') next = cells[at - (at % 7)];
    else if (e.key === 'End') next = cells[Math.min(cells.length - 1, at - (at % 7) + 6)];
    else return;
    e.preventDefault();
    if (!next) return;
    cells.forEach(c => { c.tabIndex = -1; });
    next.tabIndex = 0;
    next.focus();
  });

  return grid;
}

/** Everyone else's month as a barcode, so nobody is hidden behind a tap. */
function monthIndex(y, m) {
  const others = state.people.filter(p => (p.id || p.email) !== state.board);
  if (!others.length) return null;

  const total = daysInMonth(y, m);
  const nodes = [el('span', { class: 'cap index__cap', text: `The rest of the family · ${MONTHS[m]}` })];

  for (const person of others) {
    const set = person.joined ? daysOf(person.id) : new Set();
    const ticks = [];
    for (let d = 1; d <= total; d++) {
      const iso = `${y}-${pad(m + 1)}-${pad(d)}`;
      ticks.push(el('i', { class: set.has(iso) ? 'on' : '' }));
    }
    const count = person.joined ? countMonth(set, y, m) : null;
    const row = paint(el('button', {
      class: 'irow', type: 'button',
      'aria-label': `Show ${person.name}'s board. ${count === null ? 'Not signed in yet' : `${count} days in ${MONTHS[m]}`}`,
      onclick: () => { state.board = person.id || person.email; renderMonth(); document.getElementById('plates').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); },
    }), person.color);
    add(row, 
      el('span', { class: 'irow__n', text: person.name }),
      el('span', { class: 'mini', 'aria-hidden': 'true' }, ticks),
      el('span', { class: 'irow__c' }, el('span', { text: count === null ? '—' : String(count) }), el('span', { text: 'days' })),
      icon('right'),
    );
    nodes.push(row);
  }
  return nodes;
}

/* --------------------------------- weight -------------------------------- */

function renderWeight() {
  const me = state.me;
  const unit = me.weight_unit || 'lb';
  const today = todayISO();
  const series = prepareSeries(state.weights.get(me.id) || [], today);
  const summary = weightSummary(series, today);

  const card = $('#weightCard');
  const own = paint(el('div'), me.color);

  add(own, el('div', { class: 'weight__hd' },
    el('h3', { class: 'plate__n', text: 'You' }),
    unitToggle(unit),
  ));

  if (summary.latest) {
    add(own, el('div', { class: 'wnow' },
      el('span', { class: 'wnow__n', text: displayWeight(summary.latest.grams, unit) }),
      el('span', { class: 'wnow__u', text: unit }),
      el('span', { class: 'wnow__d' },
        el('span', { text: 'Last entry' }), el('br'),
        el('span', { text: `${prettyDate(summary.latest.day)}` }),
      ),
    ));
    add(own, deltaBand(summary.deltas, unit));
  } else {
    add(own, el('div', { class: 'wnow' },
      el('span', { class: 'wnow__n', text: '—' }),
      el('span', { class: 'wnow__u', text: unit }),
    ));
  }

  add(own, sparkline(series, unit, today));

  if (series.length) own.append(weightTable(series, unit, today));

  add(own, el('div', { class: 'wfoot' },
    el('button', {
      class: 'ghost ghost--brass', type: 'button',
      onclick: () => openWeightSheet(),
    }, icon('plus'), el('span', { text: series.length ? "Add today's weight" : 'Add your first' })),
  ));

  add(own, shareSwitch(me));

  const shared = state.people.filter(p =>
    p.joined && p.id !== me.id && (state.weights.get(p.id) || []).length);

  const nodes = [own];
  if (shared.length) {
    const fam = el('div', { class: 'wfam' },
      el('span', { class: 'cap', text: 'Family · sharing on' }),
    );
    for (const person of shared) {
      const theirs = prepareSeries(state.weights.get(person.id), today);
      const theirSummary = weightSummary(theirs, today);
      const d30 = theirSummary.deltas.find(x => x.key === 'd30');
      const row = paint(el('div', { class: 'wfrow' }), person.color);
      add(row, 
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { class: 'wfrow__n', text: person.name }),
        el('span', { class: 'wfrow__d', text: d30?.grams != null ? `${displayDelta(d30.grams, unit)} in ${d30.spanDays} days` : 'No 30-day comparison' }),
        el('span', { class: 'wfrow__v' },
          el('span', { text: displayWeight(theirSummary.latest.grams, unit) }),
          el('span', { text: unit }),
        ),
      );
      add(fam, row);
    }
    add(fam, el('p', {
      class: 'note-hair',
      text: 'Only people who have turned sharing on appear here. Everyone else is simply absent — you cannot tell whether they track their weight or not.',
    }));
    nodes.push(fam);
  }

  mount(card, nodes);
}

function unitToggle(unit) {
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Show weight in' });
  for (const u of ['lb', 'kg']) {
    add(seg, el('button', {
      type: 'button', text: u, 'aria-pressed': u === unit ? 'true' : 'false',
      onclick: async () => {
        if (u === unit) return;
        // Only the display preference moves. Every stored row is untouched,
        // which is why switching units cannot round anybody's history away.
        try {
          const updated = await db.saveProfile(state.me.id, { weight_unit: u });
          state.me = updated;
          await reloadPeople();
          renderWeight();
        } catch (e) { toast(e.message, { error: true }); }
      },
    }));
  }
  return seg;
}

function deltaBand(deltas, unit) {
  return el('div', { class: 'deltas' }, deltas.map(delta => {
    const value = el('div', { class: 'delta__v' });
    if (delta.grams == null) {
      add(value, el('b', { text: '—' }));
    } else {
      const dir = delta.grams === 0 ? 'flat' : delta.grams < 0 ? 'down' : 'up';
      add(value, 
        icon(dir),
        el('b', { text: displayDelta(delta.grams, unit) }),
        el('i', { text: unit }),
      );
    }
    return el('div', { class: 'delta' },
      el('div', { class: 'delta__l', text: delta.label }),
      value,
      el('div', {
        class: 'delta__ref',
        text: delta.ref ? `since ${prettyDate(delta.ref.day)} (${delta.spanDays} days)` : 'no reading close enough',
      }),
    );
  }));
}

/**
 * The sparkline.
 *
 * The x axis is time, not the index of the entry. Three readings on
 * consecutive days followed by one in June must look like a cluster, a
 * silence, and a single point — spaced evenly they would describe a steady
 * drift that never happened. The vertical range has a floor for the same
 * reason: a one-pound spread stretched to fill the plot looks like a crisis.
 */
function sparkline(series, unit, today) {
  const W = 320, H = 96;
  const geo = sparklineGeometry(series, { today, rangeDays: 90, width: W, height: H });

  const svg = svgEl('svg', {
    class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': describeSeries(series, unit, today),
  });

  // Month boundaries inside the window, so the silence has a scale.
  for (let i = 0; i < 4; i++) {
    const probe = new Date(geo.x0 * 86400000);
    const monthStart = new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + i + 1, 1));
    const x = Math.floor(monthStart.getTime() / 86400000);
    if (x <= geo.x0 || x >= geo.x1) continue;
    const px = geo.px(x);
    add(svg, svgEl('line', { class: 'spark-grid', x1: px, y1: 6, x2: px, y2: H - 20 }));
    add(svg, svgEl('text', { class: 'spark-ax', x: px + 5, y: H - 6, text: MONTHS_SHORT[monthStart.getUTCMonth()].toUpperCase() }));
  }

  add(svg, svgEl('line', { class: 'spark-base', x1: 0, y1: H - 20, x2: W, y2: H - 20 }));

  if (geo.empty) {
    add(svg, svgEl('text', { class: 'spark-empty', x: W / 2, y: H / 2 - 4, 'text-anchor': 'middle', text: 'No entries yet' }));
  } else {
    if (geo.points.length > 1) svg.append(svgEl('path', { class: 'spark-line', d: geo.path }));
    geo.points.forEach((point, i) => {
      const last = i === geo.points.length - 1;
      if (last) {
        add(svg, svgEl('circle', { class: 'spark-halo', cx: point.cx, cy: point.cy, r: 4.8 }));
        add(svg, svgEl('circle', { class: 'spark-last', cx: point.cx, cy: point.cy, r: 3.2 }));
      } else {
        add(svg, svgEl('circle', { class: 'spark-pt', cx: point.cx, cy: point.cy, r: 2 }));
      }
    });
  }

  const wrap = el('div', { class: 'sparkwrap', tabindex: '0', role: 'group', 'aria-label': 'Weight trend, last 90 days' });
  add(wrap, svg);
  if (series.length === 1) {
    add(wrap, el('p', { class: 'hint hint--left', text: 'One entry so far. Add another to see a trend.' }));
  }
  return wrap;
}

/** The numbers, in a table, visible to everybody — not hidden for screen readers. */
function weightTable(series, unit, today) {
  const rows = [...series].reverse().slice(0, 20);
  const table = el('table');
  add(table, el('caption', { text: describeSeries(series, unit, today) }));
  const head = el('tr');
  add(head, 
    el('th', { scope: 'col', text: 'Date' }),
    el('th', { scope: 'col', text: `Weight (${unit})` }),
    el('th', { scope: 'col', text: 'Change' }),
  );
  add(table, el('thead', {}, head));

  const body = el('tbody');
  rows.forEach((entry, i) => {
    const older = rows[i + 1];
    const tr = el('tr');
    add(tr, 
      el('td', { text: prettyDate(entry.day) }),
      el('td', { text: displayWeight(entry.grams, unit) }),
      el('td', { text: older ? displayDelta(entry.grams - older.grams, unit) : '—' }),
    );
    add(body, tr);
  });
  add(table, body);

  const details = el('details', { class: 'wtable' });
  add(details, el('summary', { text: 'View as a table' }), table);
  return details;
}

function shareSwitch(me) {
  const on = !!me.share_weight;
  const wrap = el('div', { class: 'share' });
  const label = el('div', { class: 'share__t' },
    el('span', { text: 'Share my weight with the family' }),
    el('em', {
      text: on
        ? 'On: they see your latest weight, your 7- and 30-day change, and your trend. They never see individual entries.'
        : 'Off: nobody sees your weight, your trend, or that you track it at all — you simply do not appear in the weight section of their board.',
    }),
  );

  const status = el('span', { class: 'share__s' + (on ? ' on' : '') },
    icon(on ? 'eye' : 'lock'),
    el('span', { text: on ? 'Shared' : 'Private' }),
  );

  const toggle = el('button', {
    class: 'switch', type: 'button', role: 'switch',
    'aria-checked': on ? 'true' : 'false',
    'aria-label': 'Share my weight with the family',
    onclick: async () => {
      try {
        const updated = await db.saveProfile(state.me.id, { share_weight: !on });
        state.me = updated;
        await reloadPeople();
        renderWeight();
        announce(updated.share_weight ? 'Weight sharing is on' : 'Weight sharing is off');
      } catch (e) { toast(e.message, { error: true }); }
    },
  });

  add(wrap, label, status, toggle);
  return wrap;
}

/* ===========================================================================
   Writing
   =========================================================================== */

async function writeCheckin(iso, checked, tags, note) {
  const uid = state.me.id;
  const key = ckey(uid, iso);
  const previous = state.checkins.get(key);

  // Optimistic: the board moves before the round trip, and data.js keeps the
  // pending row on top of any refresh that lands mid-flight.
  if (checked) state.checkins.set(key, { user_id: uid, day: iso, tags, note });
  else state.checkins.delete(key);
  reindex();
  renderAll();

  try {
    if (checked) await db.saveCheckin({ userId: uid, day: iso, tags, note });
    else await db.removeCheckin({ userId: uid, day: iso });
    toast(checked ? (previous ? 'Updated' : 'Checked off') : 'Removed');
    announce(checked ? `${longDate(iso)} logged` : `${longDate(iso)} removed`);
  } catch (e) {
    /* Do not blindly put the old value back. A request that committed and then
       lost its response would leave the screen claiming the opposite of the
       truth; asking the server is the only way to know. */
    toast(e.message, { error: true, persist: e.offline });
    announce(`Could not save: ${e.message}`, true);
    refresh();
  }
}

/* ===========================================================================
   Sheets
   =========================================================================== */

let sheetReturnFocus = null;
let sheetKeyHandler = null;

/**
 * Where focus goes when a sheet closes.
 *
 * Usually back to whatever opened it. But saving a day re-renders the board,
 * which detaches that element, and focus would otherwise fall to the body —
 * leaving a keyboard user at the top of the document after every save. So the
 * anchor is remembered by id where there is one, looked up again afterwards,
 * and the main region catches whatever is left.
 */
function restoreFocus() {
  const remembered = sheetReturnFocus;
  sheetReturnFocus = null;
  if (remembered && document.contains(remembered)) return remembered.focus();
  const byId = remembered?.id ? document.getElementById(remembered.id) : null;
  if (byId) return byId.focus();
  const main = $('#main');
  main.tabIndex = -1;
  main.focus();
}

function openSheet({ title, subtitle, body, actions }) {
  closeSheet();
  sheetReturnFocus = document.activeElement;

  const heading = el('h2', { class: 'sheet__t', id: 'sheetTitle', tabindex: '-1', text: title });
  const sheet = el('div', { class: 'sheet' },
    el('div', { class: 'grip', 'aria-hidden': 'true' }),
    el('div', { class: 'sheet__hd' },
      el('div', { class: 'grow' }, heading, subtitle ? el('div', { class: 'sheet__s', text: subtitle }) : null),
      el('button', { class: 'closeb', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, icon('x')),
    ),
    body,
    actions ? el('div', { class: 'acts' }, actions) : null,
  );

  const wrap = el('div', { class: 'sheetwrap', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheetTitle' }, sheet);
  const scrim = el('div', {
    class: 'scrim',
    onclick: e => { if (e.target === scrim) closeSheet(); },
  }, wrap);

  mount($('#sheetRoot'), scrim);
  // `inert` on the rest of the page is what actually traps focus: Tab cannot
  // reach anything behind the sheet, so no key-by-key trap is needed.
  $('#app').setAttribute('inert', '');
  // A sheet is bottom-anchored and can be almost full height, so there is no
  // offset that reliably keeps a bottom toast clear of it. Move them up top.
  document.body.dataset.sheet = 'open';

  sheetKeyHandler = e => { if (e.key === 'Escape') { e.preventDefault(); closeSheet(); } };
  document.addEventListener('keydown', sheetKeyHandler);

  requestAnimationFrame(() => heading.focus());
  return sheet;
}

function closeSheet() {
  const root = $('#sheetRoot');
  if (!root.firstChild) return;
  mount(root);
  $('#app').removeAttribute('inert');
  delete document.body.dataset.sheet;
  if (sheetKeyHandler) document.removeEventListener('keydown', sheetKeyHandler);
  sheetKeyHandler = null;
  restoreFocus();
}

/* ------------------------------- day editor ------------------------------ */

function openDayEditor(iso) {
  const existing = getCheckin(state.me.id, iso);
  const tags = new Set(existing?.tags || []);
  const today = todayISO();

  const groups = TAG_GROUPS.map(group => {
    const buttons = group.tags.map(([slug, label]) => el('button', {
      class: 'tagb', type: 'button', text: label,
      'aria-pressed': tags.has(slug) ? 'true' : 'false',
      data: { tag: slug },
    }));
    return el('div', { class: 'fgroup' },
      el('span', { class: 'cap', text: group.name }),
      el('div', { class: 'taggrid' }, buttons),
    );
  });

  const note = el('input', {
    class: 'field', maxlength: '280', placeholder: 'Bench 3 × 8 at 185. Felt strong.',
    value: existing?.note || '', 'aria-label': 'A note about this day',
  });

  const body = el('div', {}, groups, el('div', { class: 'fgroup' },
    el('span', { class: 'cap', text: 'Note (optional)' }), note));

  const repaint = () => {
    body.querySelectorAll('[data-tag]').forEach(button => {
      const on = tags.has(button.dataset.tag);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.disabled = !on && tags.size >= MAX_TAGS;
    });
  };

  body.addEventListener('click', e => {
    const button = e.target.closest('[data-tag]');
    if (!button) return;
    const slug = button.dataset.tag;
    if (tags.has(slug)) tags.delete(slug); else tags.add(slug);
    repaint();
  });

  const save = el('button', {
    class: 'btn btn--primary', type: 'button',
    text: existing ? 'Save' : 'Check off this day',
    onclick: () => { closeSheet(); writeCheckin(iso, true, [...tags], note.value.trim()); },
  });

  const remove = existing ? el('button', {
    class: 'btn btn--danger', type: 'button', text: 'Remove',
    onclick: () => { closeSheet(); writeCheckin(iso, false, [], ''); },
  }) : null;

  openSheet({
    title: longDate(iso),
    subtitle: [existing ? 'Checked off' : 'Not logged yet', relativeDay(iso, today)].filter(Boolean).join(' · '),
    body,
    actions: [remove, save].filter(Boolean),
  });
  repaint();
}

function openPeerDay(person, iso) {
  const row = getCheckin(person.id, iso);
  const body = el('div', {});
  if (row) {
    add(body, el('span', { class: 'cap', text: 'Logged' }));
    if (row.tags?.length) {
      add(body, el('div', { class: 'detail' }, row.tags.map(t => el('span', { class: 'chip', text: tagLabel(t) }))));
    } else {
      add(body, el('div', { class: 'detail' }, el('span', { class: 'chip', text: 'Checked in' })));
    }
    if (row.note) body.append(el('p', { class: 'quote', text: row.note }));
  } else {
    add(body, el('p', { class: 'muted', text: `${person.name} did not log this day.` }));
  }
  openSheet({ title: longDate(iso), subtitle: person.name, body });
}

/* ------------------------------ weight sheet ----------------------------- */

function openWeightSheet(day) {
  const me = state.me;
  const unit = me.weight_unit || 'lb';
  const today = todayISO();
  const iso = day || today;
  const existing = (state.weights.get(me.id) || []).find(r => r.day === iso);
  const range = WEIGHT_INPUT_RANGE[unit];

  const seeded = existing ? displayWeight(existing.grams, unit) : '';
  const input = el('input', {
    type: 'number', inputmode: 'decimal', step: String(range.step),
    min: String(range.min), max: String(range.max), enterkeyhint: 'done',
    value: seeded, placeholder: unit === 'kg' ? '82.3' : '181.4',
    'aria-label': `Your weight in ${unit === 'kg' ? 'kilograms' : 'pounds'}`,
  });

  const nudge = delta => {
    const current = Number(input.value) || (unit === 'kg' ? 80 : 175);
    const next = Math.round((current + delta) * 10) / 10;
    input.value = Math.min(range.max, Math.max(range.min, next)).toFixed(1);
  };

  const dateField = el('input', {
    class: 'field', type: 'date', value: iso, max: today, 'aria-label': 'The day this weight is for',
  });

  const body = el('div', {},
    el('div', { class: 'stepper' },
      el('button', { class: 'stepb', type: 'button', 'aria-label': `Down ${range.step} ${unit}`, onclick: () => nudge(-range.step) }, icon('minus')),
      el('div', { class: 'stepv' }, input, el('span', { text: unit })),
      el('button', { class: 'stepb', type: 'button', 'aria-label': `Up ${range.step} ${unit}`, onclick: () => nudge(range.step) }, icon('plus')),
    ),
    el('p', { class: 'hint', text: 'Weigh at the same time of day — first thing in the morning is easiest.' }),
    el('div', { class: 'fgroup fgroup--spaced' },
      el('span', { class: 'cap', text: 'Day' }), dateField),
  );

  const save = el('button', {
    class: 'btn btn--primary', type: 'button', text: 'Save',
    onclick: async () => {
      const text = input.value.trim();
      /* Nothing was typed and nothing was changed: write nothing at all. This
         is what makes opening and closing the sheet a strict no-op, so a
         stored weight cannot drift a tenth every time somebody looks at it. */
      if (text === seeded && dateField.value === iso) return closeSheet();
      const grams = parseWeightInput(text, unit);
      if (grams == null) return toast(`Enter a weight between ${range.min} and ${range.max} ${unit}`, { error: true });
      const when = dateField.value || iso;
      if (when > today) return toast('That day has not happened yet.', { error: true });

      save.disabled = true;
      mount(save, el('span', { class: 'spin' }));
      try {
        await db.saveWeight({ userId: me.id, day: when, grams });
        await reloadWeights();
        closeSheet();
        renderWeight();
        toast('Weight saved');
      } catch (e) {
        save.disabled = false;
        save.textContent = 'Save';
        toast(e.message, { error: true });
      }
    },
  });

  const remove = existing ? el('button', {
    class: 'btn btn--danger', type: 'button', text: 'Remove',
    onclick: async () => {
      try {
        await db.removeWeight({ userId: me.id, day: iso });
        await reloadWeights();
        closeSheet();
        renderWeight();
        toast('Entry removed');
      } catch (e) { toast(e.message, { error: true }); }
    },
  }) : null;

  openSheet({
    title: existing ? 'Edit weigh-in' : 'Add a weigh-in',
    subtitle: longDate(iso),
    body,
    actions: [remove, save].filter(Boolean),
  });
  requestAnimationFrame(() => input.focus());
}

/* -------------------------------- settings ------------------------------- */

function openSettings() {
  const me = state.me;

  const nameField = el('input', { class: 'field', maxlength: '40', value: me.display_name || '', 'aria-label': 'Your display name' });
  const ruleField = el('textarea', {
    class: 'field', maxlength: '400', rows: '4',
    placeholder: 'e.g. Two exercises, three working sets each. A walk does not count.',
    'aria-label': 'What counts as a workout for you',
  });
  ruleField.value = me.rule || '';

  const targetButtons = [];
  let target = me.weekly_target || 4;
  const targetRow = el('div', { class: 'taggrid' });
  for (let n = 1; n <= 7; n++) {
    const button = el('button', {
      class: 'tagb', type: 'button', text: String(n),
      'aria-pressed': n === target ? 'true' : 'false',
      'aria-label': `${n} ${n === 1 ? 'day' : 'days'} a week`,
      onclick: () => {
        target = n;
        targetButtons.forEach((b, i) => b.setAttribute('aria-pressed', i + 1 === n ? 'true' : 'false'));
      },
    });
    targetButtons.push(button);
    add(targetRow, button);
  }

  const body = el('div', {},
    el('div', { class: 'fgroup' }, el('span', { class: 'cap', text: 'Display name' }), nameField),
    el('div', { class: 'fgroup' }, el('span', { class: 'cap', text: 'What counts as a workout for me' }), ruleField),
    el('div', { class: 'fgroup' },
      el('span', { class: 'cap', text: 'Days a week I am aiming for' }), targetRow,
      el('p', { class: 'hint hint--left', text: 'Everyone sets their own. Yours is what the week strip and the seal measure you against.' })),
    el('div', { class: 'fgroup' },
      el('span', { class: 'cap', text: 'This device' }),
      el('div', { class: 'wfoot wfoot--plain' },
        PLATFORM.standalone ? null : el('button', {
          class: 'ghost', type: 'button', onclick: () => { closeSheet(); showInstallHelp(); },
        }, icon('install'), el('span', { text: 'Add to home screen' })),
        el('button', { class: 'ghost', type: 'button', onclick: () => { closeSheet(); showAbout(); } },
          icon('info'), el('span', { text: 'How this works' })),
        el('button', {
          class: 'ghost', type: 'button',
          onclick: async () => {
            try { await db.signOutHere(); location.reload(); }
            catch (e) { toast(e.message, { error: true }); }
          },
        }, icon('out'), el('span', { text: 'Sign out' })),
      )),
  );

  const save = el('button', {
    class: 'btn btn--primary', type: 'button', text: 'Save',
    onclick: async () => {
      save.disabled = true;
      mount(save, el('span', { class: 'spin' }));
      try {
        const updated = await db.saveProfile(me.id, {
          display_name: nameField.value.trim().slice(0, 40) || me.email.split('@')[0],
          rule: ruleField.value.trim().slice(0, 400),
          weekly_target: target,
        });
        state.me = updated;
        await reloadPeople();
        closeSheet();
        renderAll();
        toast('Saved');
      } catch (e) {
        save.disabled = false;
        save.textContent = 'Save';
        toast(e.message, { error: true });
      }
    },
  });

  openSheet({
    title: 'Your settings',
    subtitle: 'Only you can change these. Everyone can see them.',
    body,
    actions: [save],
  });
}

function showAbout() {
  const body = el('div', {},
    el('p', { class: 'quote', text: 'It is the calendar on the fridge, except the rest of the family can see it.' }),
    el('p', { class: 'hint hint--left hint--gap', text: 'One check a day, on your own honour, by your own written definition of what counts. Tags and a note are optional — the check is the point.' }),
    el('p', { class: 'hint hint--left', text: 'You can check off past days, never future ones. Only you can edit your own days; everyone can see everything.' }),
    el('p', { class: 'hint hint--left', text: 'Weight is different. It is off by default, and while it is off nobody can see your entries, your trend, or that you track it at all.' }),
    el('p', { class: 'hint hint--left', text: 'Changes appear on everyone else’s board within a second or two.' }),
  );
  openSheet({ title: 'How this works', body });
}

/* ===========================================================================
   Install
   =========================================================================== */

const INSTALL_DISMISSED = 'carr.install.dismissed';
const DISMISS_DAYS = 60;

function setupInstall() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    state.installEvent = e;
    renderInstall();
  });
  window.addEventListener('appinstalled', () => {
    state.installEvent = null;
    try { localStorage.setItem(INSTALL_DISMISSED, String(Date.now())); } catch { /* private mode */ }
    renderInstall();
    toast('Added to your home screen');
  });
}

function installDismissedRecently() {
  try {
    const at = Number(localStorage.getItem(INSTALL_DISMISSED) || 0);
    return at > 0 && (Date.now() - at) < DISMISS_DAYS * 86400000;
  } catch { return false; }
}

function renderInstall() {
  const section = $('#installSec');
  const canPrompt = !!state.installEvent;
  const iosCanInstall = PLATFORM.ios && PLATFORM.iosSafari && !PLATFORM.standalone;

  if (PLATFORM.standalone || installDismissedRecently() || (!canPrompt && !iosCanInstall)) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  mount($('#installCard'), installCardContent(canPrompt));
}

function installCardContent(canPrompt) {
  const head = el('div', { class: 'install__hd' },
    el('div', { class: 'grow' },
      el('div', { class: 'install__t', text: 'Put this on your home screen' }),
      el('p', {
        class: 'install__p',
        text: canPrompt
          ? 'It gets its own icon and opens without the browser around it. Nothing is downloaded from a store.'
          : 'It gets its own icon and opens without Safari around it. Nothing is downloaded from a store, and it keeps you signed in.',
      }),
    ),
    el('button', { class: 'closeb', type: 'button', 'aria-label': 'Not now', onclick: dismissInstall }, icon('x')),
  );

  if (canPrompt) {
    return [head, el('div', { class: 'install__foot' },
      el('button', {
        class: 'btn btn--brass', type: 'button', text: 'Install',
        onclick: async () => {
          const event = state.installEvent;
          if (!event) return;
          state.installEvent = null;
          event.prompt();
          const choice = await event.userChoice.catch(() => null);
          if (choice?.outcome !== 'accepted') dismissInstall();
          renderInstall();
        },
      }),
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Not now', onclick: dismissInstall }),
    )];
  }

  // iPhone: there is no API, so the instructions have to be real instructions.
  const steps = el('ol', { class: 'steps' },
    el('li', {},
      el('span', { class: 'glyph' }, icon('ios-share')),
      el('p', {}, el('span', { text: 'Tap ' }), el('b', { text: 'Share' }), el('span', { text: ' in the Safari toolbar — the square with an arrow leaving the top.' })),
    ),
    el('li', {},
      el('span', { class: 'glyph' }, icon('ios-add')),
      el('p', {}, el('span', { text: 'Scroll down, choose ' }), el('b', { text: 'Add to Home Screen' }), el('span', { text: ', then tap Add.' })),
    ),
  );

  return [head, steps, el('p', {
    class: 'install__note',
    text: 'Then open it from the new icon and sign in there with a six-digit code. An iPhone keeps the app and Safari separate, so signing in once in each is normal.',
  }), el('div', { class: 'install__foot' },
    el('button', { class: 'btn btn--ghost', type: 'button', text: 'Not now', onclick: dismissInstall }),
  )];
}

function dismissInstall() {
  try { localStorage.setItem(INSTALL_DISMISSED, String(Date.now())); } catch { /* private mode */ }
  renderInstall();
}

/** Reachable from settings, so declining the card is never a dead end. */
function showInstallHelp() {
  openSheet({
    title: 'Add to home screen',
    body: el('div', {}, installCardContent(!!state.installEvent).filter(node => !node.classList?.contains('install__hd'))),
  });
}

/* ===========================================================================
   Service worker
   =========================================================================== */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  /* Not on the dev server unless asked for. A worker that serves the shell
     from cache is exactly what you want on a phone and exactly what you do not
     want while editing: the first broken save gets cached and then served back
     over every subsequent fix, and the bug appears to be immortal.
     Use http://localhost:4321/?sw to exercise it deliberately. */
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (local && !new URL(location.href).searchParams.has('sw')) {
    navigator.serviceWorker.getRegistrations()
      .then(list => list.forEach(r => r.unregister()))
      .catch(() => {});
    return;
  }

  navigator.serviceWorker.register('./sw.js', { scope: './' }).then(registration => {
    state.swRegistration = registration;
    if (registration.waiting) offerUpdate(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        // controller present means this is an update, not a first install.
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(incoming);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) registration.update().catch(() => {});
    });
  }).catch(err => console.warn('service worker did not register', err));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

/* The swap is offered, never forced: replacing the running app's script while
   somebody is halfway through logging a day is how a check-in gets lost. */
function offerUpdate(worker) {
  toast('A new version is ready', {
    persist: true,
    action: { label: 'Reload', run: () => worker.postMessage('SKIP_WAITING') },
  });
}

/* ===========================================================================
   Toasts and announcements
   =========================================================================== */

let toastTimer = null;

function toast(text, { error = false, persist = false, action = null } = {}) {
  const host = error ? $('#alertRoot') : $('#toastRoot');
  clearTimeout(toastTimer);

  const node = el('div', { class: 'toast' + (error ? ' toast--err' : '') },
    icon(error ? 'alert' : 'check'),
    el('span', { text }),
  );

  if (action) {
    add(node, el('button', {
      class: 'toast__act', type: 'button', 'aria-label': action.label,
      text: action.label, onclick: () => { mount(host); action.run(); },
    }));
  }
  if (persist || action) {
    add(node, el('button', { class: 'toast__x', type: 'button', 'aria-label': 'Dismiss', onclick: () => mount(host) }, icon('x')));
  }

  mount(host, node);
  if (!persist && !action) toastTimer = setTimeout(() => mount(host), error ? 5200 : 2600);
}

/** For state changes that are painted but not otherwise spoken. */
function announce(text, assertive = false) {
  const host = assertive ? $('#alertRoot') : $('#toastRoot');
  if (host.firstChild) return;             // a toast is already saying something
  const node = el('span', { class: 'sr', text });
  mount(host, node);
  setTimeout(() => { if (host.firstChild === node) mount(host); }, 1200);
}

/* Exposed for the console during development, and for nothing else. */
window.__carr = { state, refresh };
