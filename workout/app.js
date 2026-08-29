/* ===========================================================================
   Checkmark — shared workout accountability board
   Vanilla JS, no build step. Talks to Supabase for auth + data.
   =========================================================================== */

const CFG = window.CHECKMARK_CONFIG || {};

/* ---------------------------------------------------------------------------
   Tag catalogue. Slugs are what land in the database; labels are display-only,
   so renaming a label here never breaks existing rows.
   --------------------------------------------------------------------------- */
const TAG_GROUPS = [
  { name: 'Cardio', tags: [
    ['run','Run'], ['walk','Walk / Hike'], ['bike','Bike'], ['swim','Swim'],
    ['row','Row'], ['machine','Machine'], ['sport','Sport'], ['hiit','HIIT'],
  ]},
  { name: 'Resistance', tags: [
    ['chest','Chest'], ['back','Back'], ['shoulders','Shoulders'],
    ['biceps','Biceps'], ['triceps','Triceps'], ['legs','Legs'],
    ['glutes','Glutes'], ['core','Core'], ['fullbody','Full body'],
  ]},
  { name: 'Other', tags: [
    ['yoga','Yoga'], ['mobility','Mobility / Stretch'], ['climb','Climbing'],
    ['martial','Martial arts'], ['other','Other'],
  ]},
];
const TAG_LABEL = Object.fromEntries(TAG_GROUPS.flatMap(g => g.tags));
const MAX_TAGS = 12;

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOW1 = ['S','M','T','W','T','F','S'];
const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

/* ---------------------------------------------------------------------------
   Date helpers — all LOCAL time. Never `new Date('2026-08-29')`, that is UTC
   and silently shifts the day for anyone west of Greenwich.
   --------------------------------------------------------------------------- */
const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayISO = () => toISO(new Date());
const shiftISO = (iso, n) => { const d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
const startOfWeekISO = iso => { const d = fromISO(iso); d.setDate(d.getDate() - d.getDay()); return toISO(d); };

function prettyDate(iso) {
  const d = fromISO(iso);
  return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
function relativeDay(iso) {
  const t = todayISO();
  if (iso === t) return 'Today';
  if (iso === shiftISO(t, -1)) return 'Yesterday';
  const diff = Math.round((fromISO(t) - fromISO(iso)) / 86400000);
  if (diff > 0 && diff < 7) return `${diff} days ago`;
  return '';
}

/* ---------------------------------------------------------------------------
   Tiny DOM helpers
   --------------------------------------------------------------------------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (id, cls = '') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;

function toast(text, isErr = false) {
  const root = $('#toastRoot');
  root.innerHTML = `<div class="toast${isErr ? ' err' : ''}">${esc(text)}</div>`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { root.innerHTML = ''; }, isErr ? 5200 : 2600);
}

/* ---------------------------------------------------------------------------
   State
   --------------------------------------------------------------------------- */
const state = {
  supa: null,
  session: null,
  me: null,            // my profile row
  profiles: [],        // every member profile, me first
  checkins: new Map(), // "userId|YYYY-MM-DD" -> row
  pending: [],         // allow-listed people who haven't signed in yet
  cursor: null,        // {y, m} month being displayed
  channel: null,
};

const key = (uid, day) => `${uid}|${day}`;
const getCheckin = (uid, day) => state.checkins.get(key(uid, day));
const colorVar = c => `var(--${['indigo', 'amber', 'teal', 'rose'].includes(c) ? c : 'indigo'})`;
const initials = p => (p.display_name || p.email || '?').trim().slice(0, 2).toUpperCase();

/* ===========================================================================
   BOOT
   =========================================================================== */
main();

async function main() {
  // 1. Config present?
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return showSetup();

  // 2. Library loaded?
  if (window.__sbFailed || !window.supabase) {
    return showGate(`
      <h1>Can't reach the network</h1>
      <p class="sub">The Supabase library didn't load. Check your connection and reload.</p>
      <button class="btn" onclick="location.reload()">Reload</button>`);
  }

  state.supa = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // Implicit, not PKCE. PKCE stashes a code_verifier in the localStorage of
      // the browser that REQUESTED the link; tapping the link inside the Gmail
      // app opens a different browser context, which then cannot complete the
      // exchange. Implicit returns the tokens in the URL fragment, so whichever
      // browser opens the link can finish signing in.
      flowType: 'implicit',
    },
  });

  // 3. Surface an OAuth error rather than silently bouncing to a sign-in form.
  const url = new URL(location.href);
  const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
  const oauthErr = url.searchParams.get('error_description') || url.searchParams.get('error')
                || frag.get('error_description') || frag.get('error');
  const returning = url.searchParams.has('code') || frag.has('access_token');
  if (oauthErr) {
    cleanUrl();
    return showSignIn(decodeURIComponent(oauthErr).replace(/\+/g, ' '));
  }

  // If we're mid-OAuth-return, hold the spinner until the exchange settles
  // instead of flashing the sign-in form (that reads as a failed login).
  if (returning) {
    const ok = await waitForSession(7000);
    cleanUrl();
    if (!ok) return showSignIn('That sign-in did not complete. Please try again.');
  }

  const { data: { session } } = await state.supa.auth.getSession();
  if (!session) return showSignIn();

  await enterApp(session);

  state.supa.auth.onAuthStateChange((event, s) => {
    if (event === 'SIGNED_OUT' || !s) { location.reload(); }
  });
}

function waitForSession(ms) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    const sub = state.supa.auth.onAuthStateChange((_e, s) => { if (s) done(true); });
    state.supa.auth.getSession().then(({ data }) => { if (data.session) done(true); });
    setTimeout(() => { try { sub.data.subscription.unsubscribe(); } catch {} done(false); }, ms);
  });
}

function cleanUrl() {
  history.replaceState({}, '', location.pathname);
}

/* ===========================================================================
   GATE SCREENS
   =========================================================================== */
function showGate(html) {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#gateBody').innerHTML = html;
}

function showSetup() {
  showGate(`
    <h1>Almost there</h1>
    <p class="sub">Checkmark is deployed, but it hasn't been pointed at its database yet.</p>
    <ol>
      <li>Open your Supabase project → <b>Settings → API</b>.</li>
      <li>Copy the <b>Project URL</b> and the <b>anon / public</b> key.</li>
      <li>Paste both into <code>workout/config.js</code> in the
          <code>everhall</code> repo and commit.</li>
    </ol>
    <div class="msg">The anon key is safe to publish — every table is protected by
    row-level security and an email allow-list.</div>`);
}

function showSignIn(message = '', prefill = '') {
  const googleBtn = CFG.GOOGLE_ENABLED ? `
    <button class="btn btn--google" id="gBtn">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.8 2.6 13.5l7.8 6.1C12.3 13.7 17.6 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.6 24.6c0-1.6-.1-3.2-.4-4.6H24v9.1h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.6c4.3-3.9 6.8-9.7 6.8-17.3z"/>
        <path fill="#FBBC05" d="M10.4 28.4a14.6 14.6 0 0 1 0-8.8l-7.8-6.1a24 24 0 0 0 0 21l7.8-6.1z"/>
        <path fill="#34A853" d="M24 47.5c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.6c-2 1.4-4.7 2.3-8.6 2.3-6.4 0-11.7-4.2-13.6-10.1l-7.8 6.1C6.5 42.2 14.6 47.5 24 47.5z"/>
      </svg>
      Continue with Google
    </button>
    <div class="or">or</div>` : '';

  showGate(`
    <h1>Checkmark</h1>
    <p class="sub">A shared workout board. Sign in with the email you were invited with.</p>
    ${googleBtn}
    <div class="stack">
      <input class="field" id="email" type="email" inputmode="email" autocomplete="email"
             placeholder="you@gmail.com" value="${esc(prefill)}">
      <button class="btn" id="sendBtn">Email me a sign-in link</button>
    </div>
    ${message ? `<div class="msg msg--err">${esc(message)}</div>` : ''}`);

  const emailEl = $('#email');
  const send = async () => {
    const email = (emailEl.value || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Enter a valid email address', true);

    const btn = $('#sendBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Sending';

    const { error } = await state.supa.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: location.origin + location.pathname,
      },
    });

    if (error) {
      btn.disabled = false;
      btn.textContent = 'Email me a sign-in link';
      return showSignIn(authErrorText(error), email);
    }
    showLinkSent(email);
  };

  $('#sendBtn').onclick = send;
  emailEl.onkeydown = e => { if (e.key === 'Enter') send(); };

  const g = $('#gBtn');
  if (g) g.onclick = async () => {
    g.disabled = true;
    g.innerHTML = '<span class="spin"></span> Redirecting';
    const { error } = await state.supa.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: location.origin + location.pathname,
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error) showSignIn(error.message);
  };
}

function showLinkSent(email) {
  showGate(`
    <h1>Check your email</h1>
    <p class="sub">We sent a sign-in link to <b>${esc(email)}</b>. Tap it and you're in —
    on this device or any other.</p>
    <div class="msg msg--ok">The link signs you in for good. You shouldn't have to do
    this again on this device unless you sign out.</div>
    <div class="stack" style="margin-top:18px">
      <button class="btn btn--ghost" id="backBtn">Use a different email</button>
    </div>
    <div class="msg">No email after a minute? Check spam. Sign-in emails are limited to
    a couple per hour, so give it a moment before retrying.</div>`);

  $('#backBtn').onclick = () => showSignIn('', email);
}

function authErrorText(error) {
  const raw = (error?.message || '').toLowerCase();
  if (raw.includes('checkmark_not_invited') ||
      raw.includes('database error') ||
      raw.includes('unexpected_failure')) {
    return 'That email is not on the list. Checkmark is invite-only.';
  }
  if (raw.includes('rate limit') || raw.includes('too many') || raw.includes('60 seconds')) {
    return 'Too many sign-in emails just now. Wait a few minutes and try again.';
  }
  if (raw.includes('invalid') || raw.includes('expired')) {
    return 'That sign-in link is expired or already used. Request a new one.';
  }
  return error?.message || 'Something went wrong. Try again.';
}

/* ===========================================================================
   ENTER APP
   =========================================================================== */
async function enterApp(session) {
  state.session = session;

  const email = (session.user.email || '').toLowerCase();
  const { data: profiles, error } = await state.supa
    .from('profiles').select('*');

  if (error) {
    return showGate(`
      <h1>Couldn't load your board</h1>
      <p class="sub">${esc(error.message)}</p>
      <button class="btn" onclick="location.reload()">Try again</button>`);
  }

  // RLS returns zero rows to anyone off the allow-list.
  const mine = (profiles || []).find(p => p.id === session.user.id);
  if (!profiles?.length || !mine) {
    await state.supa.auth.signOut();
    return showGate(`
      <h1>No access</h1>
      <p class="sub"><b>${esc(email)}</b> isn't on the allow-list for this board.</p>
      <button class="btn" onclick="location.reload()">Back to sign in</button>`);
  }

  setProfiles(mine, profiles);

  await loadMembers();
  await loadCheckins();

  const now = new Date();
  state.cursor = { y: now.getFullYear(), m: now.getMonth() };

  $('#boot').hidden = true;
  $('#gate').hidden = true;
  $('#app').hidden = false;

  wireChrome();
  subscribeRealtime();
  renderAll();
}

// Me first, then everyone else alphabetically.
function setProfiles(mine, profiles) {
  state.me = mine;
  state.profiles = [mine, ...profiles.filter(p => p.id !== mine.id)
    .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''))];
}

// Allow-listed people who have not signed in yet have no profile row, so they
// would otherwise be invisible. Show them as an empty board instead — on day
// one that is the difference between "we built this together" and a lone card.
async function loadMembers() {
  const { data } = await state.supa.from('members').select('email, display_name, color');
  const known = new Set(state.profiles.map(p => p.email));
  state.pending = (data || []).filter(m => !known.has(m.email));
}

async function loadCheckins() {
  const { data, error } = await state.supa
    .from('checkins').select('user_id, day, tags, note');
  if (error) { console.error(error); return; }
  state.checkins = new Map((data || []).map(r => [key(r.user_id, r.day), r]));
}

function wireChrome() {
  $('#signOut').onclick = async () => {
    await state.supa.auth.signOut();
    location.reload();
  };
  $('#prevM').onclick = () => stepMonth(-1);
  $('#nextM').onclick = () => stepMonth(1);
  $('#aboutBtn').onclick = showAbout;

  // Re-sync whenever the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60 * 1000);
}

let refreshTimer = null;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadCheckins();
    renderAll();
  }, 250);
}

function subscribeRealtime() {
  state.channel = state.supa
    .channel('checkmark')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'checkins' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async () => {
      const { data } = await state.supa.from('profiles').select('*');
      if (data?.length) {
        const mine = data.find(p => p.id === state.me.id) || state.me;
        setProfiles(mine, data);
        await loadMembers();
        renderAll();
      }
    })
    .subscribe(status => {
      $('#live').classList.toggle('on', status === 'SUBSCRIBED');
    });
}

function stepMonth(delta) {
  const d = new Date(state.cursor.y, state.cursor.m + delta, 1);
  const now = new Date();
  if (d > new Date(now.getFullYear(), now.getMonth(), 1)) return;
  state.cursor = { y: d.getFullYear(), m: d.getMonth() };
  renderMonth();
}

/* ===========================================================================
   RENDER
   =========================================================================== */
function renderAll() { renderToday(); renderWeek(); renderMonth(); }

/* -------------------------------- today ---------------------------------- */
function renderToday() {
  const t = todayISO();
  const mine = getCheckin(state.me.id, t);
  const others = state.profiles.filter(p => p.id !== state.me.id);

  const tagLine = mine?.tags?.length
    ? mine.tags.map(x => TAG_LABEL[x] || x).join(' · ')
    : '';

  const peers = others.map(p => {
    const c = getCheckin(p.id, t);
    const detail = c
      ? (c.tags?.length ? c.tags.map(x => TAG_LABEL[x] || x).join(' · ') : 'Checked in')
      : 'No checkmark yet';
    return `
      <div class="peer">
        <div class="peer__av" style="background:${colorVar(p.color)}">${esc(initials(p))}</div>
        <div class="peer__txt">
          <div class="peer__name">${esc(p.display_name)}</div>
          <div class="peer__state ${c ? 'yes' : ''}">${c ? '✓ ' : ''}${esc(detail)}</div>
        </div>
      </div>`;
  }).join('');

  $('#todayCard').innerHTML = `
    <div class="today__head">
      <div class="today__date">${esc(prettyDate(t))}</div>
      <div class="today__rel">Today</div>
    </div>
    <button class="bigcheck ${mine ? 'done' : ''}" id="bigCheck">
      ${mine ? ic('check') : ic('plus')}
      <span class="bigcheck__lbl">${mine ? 'Workout logged' : 'Log today’s workout'}</span>
      <span class="bigcheck__hint">${mine ? (tagLine || 'Tap to add what you did') : 'One tap to check off today'}</span>
    </button>
    ${peers}`;

  // One tap is the whole point: an unchecked day checks off immediately.
  // Once it's checked, the same button opens the optional detail sheet.
  $('#bigCheck').onclick = mine
    ? () => openEditor(state.me, t)
    : () => saveDay(t, true, [], '');
}

/* -------------------------------- week ----------------------------------- */
function renderWeek() {
  const t = todayISO();
  const start = startOfWeekISO(t);
  const days = Array.from({ length: 7 }, (_, i) => shiftISO(start, i));

  const rows = state.profiles.map(p => {
    const done = days.filter(d => getCheckin(p.id, d)).length;
    const cells = days.map(d => {
      const on = !!getCheckin(p.id, d);
      const future = d > t;
      const cls = ['wd', on ? 'on' : '', future ? 'future' : '', d === t ? 'today' : ''].filter(Boolean).join(' ');
      const style = on ? `style="background:${colorVar(p.color)};color:#fff"` : '';
      return `<div class="${cls}" ${style} title="${esc(prettyDate(d))}">${on ? ic('check') : ''}</div>`;
    }).join('');
    return `
      <div class="weekrow">
        <div class="weekrow__name">
          <span class="swatch" style="background:${colorVar(p.color)}"></span>
          <span>${esc(p.display_name)}</span>
        </div>
        <div class="weekdays">${cells}</div>
        <div class="weekrow__count" title="Weekly target">${done}<span>/${p.weekly_target}</span></div>
      </div>`;
  }).join('');

  $('#weekCard').innerHTML = `
    <div class="weekgrid">
      <div class="weekhdr">
        <div></div>
        <div class="weekhdr__labels">${DOW1.map(d => `<span>${d}</span>`).join('')}</div>
        <div></div>
      </div>
      ${rows}
    </div>`;
}

/* -------------------------------- month ---------------------------------- */
function renderMonth() {
  const { y, m } = state.cursor;
  $('#monthLabel').textContent = `${MONTHS[m]} ${y}`;

  const now = new Date();
  $('#nextM').disabled = (y === now.getFullYear() && m === now.getMonth());

  $('#boards').innerHTML =
    state.profiles.map(p => board(p, y, m)).join('') +
    state.pending.map(pendingBoard).join('');

  // wire every editable / viewable cell
  $('#boards').querySelectorAll('[data-uid][data-day]').forEach(el => {
    el.onclick = () => {
      const p = state.profiles.find(x => x.id === el.dataset.uid);
      openEditor(p, el.dataset.day);
    };
  });
  $('#boards').querySelectorAll('[data-editrule]').forEach(el => {
    el.onclick = openProfileEditor;
  });
}

function pendingBoard(m) {
  return `
    <div class="board card board--pending">
      <div class="board__head">
        <div class="board__av" style="background:${colorVar(m.color)};opacity:.45">${esc((m.display_name || '?').slice(0, 2).toUpperCase())}</div>
        <div class="board__id">
          <div class="board__name">${esc(m.display_name)}</div>
          <div class="board__sub">${esc(m.email)}</div>
        </div>
      </div>
      <div class="pending__note">
        Hasn't signed in yet. Their board appears here the moment they do.
      </div>
    </div>`;
}

function board(p, y, m) {
  const isMe = p.id === state.me.id;
  const t = todayISO();
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const lead = first.getDay();

  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div class="cell blank"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${pad(m + 1)}-${pad(d)}`;
    const c = getCheckin(p.id, iso);
    const future = iso > t;
    const cls = [
      'cell',
      c ? 'on' : '',
      future ? 'future' : (isMe ? 'editable' : 'readonly'),
      iso === t ? 'today' : '',
    ].filter(Boolean).join(' ');
    const style = c ? `style="background:${colorVar(p.color)}"` : '';
    const clickable = future ? '' : `data-uid="${p.id}" data-day="${iso}"`;
    const inner = c
      ? `<span class="cell__num">${d}</span>${ic('check', 'cell__check')}${c.tags?.length ? '<span class="cell__tagdot"></span>' : ''}`
      : `${d}`;
    cells += `<button class="${cls}" ${style} ${clickable}
                title="${esc(prettyDate(iso))}">${inner}</button>`;
  }

  const monthCount = countMonth(p.id, y, m);
  const cur = currentStreak(p.id);
  const best = bestStreak(p.id);

  const rule = (p.rule || '').trim();
  const ruleHtml = rule
    ? `<p>${esc(rule)}</p>`
    : `<p class="empty">${isMe ? 'Not set yet.' : 'Not set yet.'}</p>`;

  return `
    <div class="board card">
      <div class="board__head">
        <div class="board__av" style="background:${colorVar(p.color)}">${esc(initials(p))}</div>
        <div class="board__id">
          <div class="board__name">${esc(p.display_name)}</div>
          <div class="board__sub">${esc(p.email)}</div>
        </div>
        ${isMe ? '<div class="board__you">You</div>' : ''}
      </div>

      <div class="stats">
        <div class="stat"><div class="stat__n">${monthCount}</div><div class="stat__l">This month</div></div>
        <div class="stat"><div class="stat__n">${cur}</div><div class="stat__l">Streak</div></div>
        <div class="stat"><div class="stat__n">${best}</div><div class="stat__l">Best</div></div>
      </div>

      <div class="dow">${DOW1.map(d => `<span>${d}</span>`).join('')}</div>
      <div class="grid">${cells}</div>

      <div class="board__rule">
        <p class="eyebrow">What counts for ${esc(p.display_name)}</p>
        ${ruleHtml}
        ${isMe ? '<button class="linkbtn" data-editrule="1">Edit my rule</button>' : ''}
      </div>
    </div>`;
}

/* -------------------------------- stats ---------------------------------- */
function countMonth(uid, y, m) {
  const prefix = `${y}-${pad(m + 1)}-`;
  let n = 0;
  for (const [k] of state.checkins) {
    if (k.startsWith(`${uid}|${prefix}`)) n++;
  }
  return n;
}

function currentStreak(uid) {
  const t = todayISO();
  // A streak stays alive until today is actually missed, so start from today
  // if it's checked, otherwise from yesterday.
  let cur = getCheckin(uid, t) ? t : shiftISO(t, -1);
  if (!getCheckin(uid, cur)) return 0;
  let n = 0;
  while (getCheckin(uid, cur)) { n++; cur = shiftISO(cur, -1); }
  return n;
}

function bestStreak(uid) {
  const days = [...state.checkins.keys()]
    .filter(k => k.startsWith(`${uid}|`))
    .map(k => k.split('|')[1])
    .sort();
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    run = (prev && shiftISO(prev, 1) === d) ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

/* ===========================================================================
   EDITOR
   =========================================================================== */
function closeSheet() { $('#modalRoot').innerHTML = ''; }

function mountSheet(inner) {
  $('#modalRoot').innerHTML = `<div class="scrim" id="scrim">
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__grip"></div>
      ${inner}
    </div>
  </div>`;
  $('#scrim').onclick = e => { if (e.target.id === 'scrim') closeSheet(); };
  document.onkeydown = e => { if (e.key === 'Escape') closeSheet(); };
}

function openEditor(person, iso) {
  if (!person) return;
  return person.id === state.me.id ? openOwnEditor(iso) : openPeerView(person, iso);
}

function openPeerView(p, iso) {
  const c = getCheckin(p.id, iso);
  const body = c
    ? `<div class="roview">
         <p class="eyebrow">Logged</p>
         ${c.tags?.length
            ? `<div class="chiplist">${c.tags.map(t => `<span class="chip">${esc(TAG_LABEL[t] || t)}</span>`).join('')}</div>`
            : '<div class="chiplist"><span class="chip">Checked in</span></div>'}
         ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}
       </div>`
    : `<div class="roview"><p class="eyebrow">No checkmark</p>
         <div style="color:var(--ink-3)">${esc(p.display_name)} hasn't logged this day.</div></div>`;

  mountSheet(`
    <div class="sheet__head">
      <div style="flex:1">
        <div class="sheet__title">${esc(p.display_name)}</div>
        <div class="sheet__sub">${esc(prettyDate(iso))}${relativeDay(iso) ? ' · ' + relativeDay(iso) : ''}</div>
      </div>
      <button class="closebtn" onclick="this.closest('.scrim').remove()">${ic('x')}</button>
    </div>
    ${body}`);
}

function openOwnEditor(iso) {
  const existing = getCheckin(state.me.id, iso);
  const tags = new Set(existing?.tags || []);

  const groupsHtml = TAG_GROUPS.map(g => `
    <div class="taggroup">
      <p class="eyebrow">${esc(g.name)}</p>
      <div class="tags">
        ${g.tags.map(([slug, label]) =>
          `<button class="tag" data-tag="${slug}">${esc(label)}</button>`).join('')}
      </div>
    </div>`).join('');

  const rel = relativeDay(iso);

  mountSheet(`
    <div class="sheet__head">
      <div style="flex:1">
        <div class="sheet__title">${esc(prettyDate(iso))}</div>
        <div class="sheet__sub">${existing ? 'Checked off' : 'Not logged yet'}${rel ? ' · ' + esc(rel) : ''}</div>
      </div>
      <button class="closebtn" id="closeX">${ic('x')}</button>
    </div>

    ${groupsHtml}

    <div class="taggroup">
      <p class="eyebrow">Note (optional)</p>
      <input class="field" id="note" maxlength="280" placeholder="Felt strong. 5k in 27:40."
             value="${esc(existing?.note || '')}">
    </div>

    <div class="sheet__actions">
      ${existing ? '<button class="btn btn--danger" id="removeBtn">Remove</button>' : ''}
      <button class="btn" id="saveBtn">${existing ? 'Save' : 'Check off this day'}</button>
    </div>`);

  const paintTags = () => {
    $('#modalRoot').querySelectorAll('[data-tag]').forEach(b => {
      const on = tags.has(b.dataset.tag);
      b.classList.toggle('on', on);
      b.disabled = !on && tags.size >= MAX_TAGS;
    });
  };
  paintTags();

  $('#closeX').onclick = closeSheet;
  $('#modalRoot').querySelectorAll('[data-tag]').forEach(b => {
    b.onclick = () => {
      const t = b.dataset.tag;
      if (tags.has(t)) tags.delete(t); else tags.add(t);
      paintTags();
    };
  });

  const rm = $('#removeBtn');
  if (rm) rm.onclick = () => saveDay(iso, false, [], '');

  // Saving always means "this day counts" — Remove is how you undo it.
  $('#saveBtn').onclick = () =>
    saveDay(iso, true, [...tags], ($('#note')?.value || '').trim());
}

async function saveDay(iso, checked, tags, note) {
  const btn = $('#saveBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }

  const uid = state.me.id;
  const k = key(uid, iso);
  const prev = state.checkins.get(k);

  // Optimistic — the board updates before the round-trip.
  if (checked) state.checkins.set(k, { user_id: uid, day: iso, tags, note });
  else state.checkins.delete(k);
  closeSheet();
  renderAll();
  if (checked && !prev && iso === todayISO()) celebrate();

  let error;
  if (checked) {
    ({ error } = await state.supa.from('checkins')
      .upsert({ user_id: uid, day: iso, tags, note }, { onConflict: 'user_id,day' }));
  } else {
    ({ error } = await state.supa.from('checkins')
      .delete().eq('user_id', uid).eq('day', iso));
  }

  if (error) {
    // Roll back to the truth.
    if (prev) state.checkins.set(k, prev); else state.checkins.delete(k);
    renderAll();
    toast(error.message || 'Could not save', true);
  } else {
    toast(checked ? (prev ? 'Updated' : 'Checked off') : 'Removed');
  }
}

function celebrate() {
  const el = $('#bigCheck');
  if (el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  if (navigator.vibrate) { try { navigator.vibrate(18); } catch {} }
}

/* ===========================================================================
   PROFILE EDITOR
   =========================================================================== */
function openProfileEditor() {
  const p = state.me;
  mountSheet(`
    <div class="sheet__head">
      <div style="flex:1">
        <div class="sheet__title">Your settings</div>
        <div class="sheet__sub">Only you can change these. Both of you can see them.</div>
      </div>
      <button class="closebtn" id="closeX">${ic('x')}</button>
    </div>

    <div class="taggroup">
      <p class="eyebrow">Display name</p>
      <input class="field" id="pName" maxlength="40" value="${esc(p.display_name)}">
    </div>

    <div class="taggroup">
      <p class="eyebrow">What counts as a workout for me</p>
      <textarea class="field" id="pRule" rows="4" maxlength="400"
        placeholder="e.g. 30 minutes of real effort, or a full lifting session. Walking the dog doesn't count.">${esc(p.rule)}</textarea>
    </div>

    <div class="taggroup">
      <p class="eyebrow">Weekly target</p>
      <div class="tags" id="targetRow">
        ${[1,2,3,4,5,6,7].map(n =>
          `<button class="tag ${n === p.weekly_target ? 'on' : ''}" data-target="${n}">${n}×</button>`).join('')}
      </div>
    </div>

    <div class="sheet__actions">
      <button class="btn" id="pSave">Save</button>
    </div>`);

  let target = p.weekly_target;
  $('#closeX').onclick = closeSheet;
  $('#targetRow').querySelectorAll('[data-target]').forEach(b => {
    b.onclick = () => {
      target = Number(b.dataset.target);
      $('#targetRow').querySelectorAll('[data-target]').forEach(x =>
        x.classList.toggle('on', Number(x.dataset.target) === target));
    };
  });

  $('#pSave').onclick = async () => {
    const btn = $('#pSave');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    const patch = {
      display_name: ($('#pName').value || '').trim().slice(0, 40) || p.email.split('@')[0],
      rule: ($('#pRule').value || '').trim().slice(0, 400),
      weekly_target: target,
    };
    const { data, error } = await state.supa.from('profiles')
      .update(patch).eq('id', p.id).select().single();

    if (error) { btn.disabled = false; btn.textContent = 'Save'; return toast(error.message, true); }

    state.me = data;
    state.profiles = state.profiles.map(x => x.id === data.id ? data : x);
    closeSheet();
    renderAll();
    toast('Saved');
  };
}

/* ===========================================================================
   ABOUT
   =========================================================================== */
function showAbout() {
  mountSheet(`
    <div class="sheet__head">
      <div style="flex:1">
        <div class="sheet__title">How this works</div>
      </div>
      <button class="closebtn" id="closeX">${ic('x')}</button>
    </div>
    <div class="roview" style="line-height:1.6;font-size:14.5px">
      <p style="margin:0 0 12px">It's the calendar on the fridge, except your brother can see it.</p>
      <p style="margin:0 0 12px">One check per day, on your own honour, by your own definition of
      what a workout is. Tags and notes are optional — the check is the point.</p>
      <p style="margin:0 0 12px">You can check off past days, but not future ones. Only you can
      edit your own days; you can both see everything.</p>
      <p style="margin:0">Changes show up on the other person's board within a second or two.</p>
    </div>`);
  $('#closeX').onclick = closeSheet;
}
