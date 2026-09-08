/* ===========================================================================
   Carr Athletics — everything that talks to Supabase.

   app.js owns the screen; this file owns the network. The split exists because
   almost every bug worth having in an app like this lives in one of them and
   not the other, and mixing them makes both harder to reason about: an
   optimistic update that gets clobbered by a background refresh is a data
   problem wearing a rendering costume.

   Three rules this module keeps:

     1. Never fetch without a bound. PostgREST silently truncates a response at
        the project's max-rows setting and returns HTTP 200 while doing it, so
        an unpaginated `select()` does not fail — it quietly returns some of
        the rows and lets every streak and total downstream be wrong. Every
        read here pages until it sees a short page.

     2. Writes to the same day are serialised, and a write in flight is never
        overwritten by a read that started before it. Two people checking in at
        the same moment must not make either of their checkmarks flicker back
        off.

     3. Errors come back as something a person can read. A red toast saying
        `TypeError: Failed to fetch` is not an error message, it is a shrug.
   =========================================================================== */

import { todayISO, shiftISO } from './core.js';

const PAGE = 1000;          // PostgREST's default cap; asking for more is pointless
const MAX_PAGES = 40;       // a backstop, not a limit anyone should reach

export const state = {
  supa: null,
  session: null,
  meId: null,
};

/* ---------------------------------------------------------------------------
   Client
   --------------------------------------------------------------------------- */
export function createClient(cfg) {
  state.supa = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      /* Implicit, not PKCE — and this is not an oversight to tidy up later.
         PKCE stores a code_verifier in the localStorage of the browser that
         REQUESTED the link. Tapping that link inside the Gmail app opens a
         different browser context, which has no verifier and cannot complete
         the exchange. Implicit puts the tokens in the URL fragment, so
         whichever browser opens the link can finish the job. On iOS this is
         the difference between a sign-in that works and one that cannot. */
      flowType: 'implicit',
    },
  });
  return state.supa;
}

/* ---------------------------------------------------------------------------
   Reading

   `select` takes an explicit column list everywhere. `select('*')` would mean
   that the day somebody adds a column to profiles, it starts being broadcast
   to every family member's browser without anyone deciding that it should be.
   --------------------------------------------------------------------------- */

/**
 * Read a table completely, a page at a time.
 * Returns { rows, truncated } — truncated is true only if the backstop was hit,
 * which would mean something has gone very wrong upstream.
 */
async function fetchAll(table, columns, tune = q => q) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await tune(
      state.supa.from(table).select(columns),
    ).range(from, from + PAGE - 1);

    if (error) throw asAppError(error, table);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export const PROFILE_COLUMNS =
  'id, email, display_name, rule, weekly_target, color, weight_unit, share_weight';

export async function loadProfiles() {
  const { rows } = await fetchAll('profiles', PROFILE_COLUMNS,
    q => q.order('email', { ascending: true }));
  return rows;
}

export async function loadMembers() {
  const { rows } = await fetchAll('members', 'email, display_name, color, sort_order',
    q => q.order('sort_order', { ascending: true }));
  return rows;
}

/**
 * Check-ins, oldest first, ordered so that a truncated page would at least be
 * a contiguous run rather than an arbitrary sample. `since` bounds the read;
 * the caller passes far enough back to cover the longest streak anyone could
 * plausibly have.
 */
export async function loadCheckins({ since } = {}) {
  const floor = since || '2026-01-01';
  const { rows, truncated } = await fetchAll('checkins', 'user_id, day, tags, note',
    q => q.gte('day', floor).order('day', { ascending: true }));
  return { rows, truncated };
}

/**
 * Weights. Row-level security decides what comes back: your own always, other
 * people's only while they are sharing. The client never filters on
 * share_weight itself — a flag the browser consults is decoration, and the
 * point of this feature is that the fence is in the database.
 */
export async function loadWeights({ since } = {}) {
  const floor = since || '2024-01-01';
  const { rows } = await fetchAll('weights', 'user_id, day, grams, note',
    q => q.gte('day', floor).order('day', { ascending: true }));
  return rows;
}

/* ---------------------------------------------------------------------------
   Writing

   Every mutation goes through a queue keyed by the row it touches, so two
   operations on the same day can never race each other. Without this, a fast
   check-then-remove can commit in the wrong order: PostgREST runs each request
   on its own connection and nothing orders them, so the DELETE can land first,
   match nothing, and be followed by the INSERT — leaving the day checked while
   the app says it was removed.
   --------------------------------------------------------------------------- */

const queues = new Map();
/** Rows currently being written, so a concurrent read cannot roll them back. */
export const inflight = new Map();

function enqueue(key, task) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

/**
 * Overlay any in-flight writes onto a freshly fetched map, so a refresh that
 * started before a write finished cannot make the checkmark flicker back off
 * under the user's finger.
 */
export function applyInflight(map) {
  for (const [k, row] of inflight) {
    if (row === null) map.delete(k);
    else map.set(k, row);
  }
  return map;
}

export function saveCheckin({ userId, day, tags, note }) {
  const key = `checkin|${userId}|${day}`;
  const row = { user_id: userId, day, tags, note };
  inflight.set(`${userId}|${day}`, row);
  return enqueue(key, async () => {
    try {
      const { error } = await state.supa.from('checkins')
        .upsert(row, { onConflict: 'user_id,day' });
      if (error) throw asAppError(error, 'checkins');
    } finally {
      inflight.delete(`${userId}|${day}`);
    }
  });
}

export function removeCheckin({ userId, day }) {
  const key = `checkin|${userId}|${day}`;
  inflight.set(`${userId}|${day}`, null);
  return enqueue(key, async () => {
    try {
      const { error } = await state.supa.from('checkins')
        .delete().eq('user_id', userId).eq('day', day);
      if (error) throw asAppError(error, 'checkins');
    } finally {
      inflight.delete(`${userId}|${day}`);
    }
  });
}

export function saveWeight({ userId, day, grams, note = '' }) {
  const key = `weight|${userId}|${day}`;
  return enqueue(key, async () => {
    const { error } = await state.supa.from('weights')
      .upsert({ user_id: userId, day, grams, note }, { onConflict: 'user_id,day' });
    if (error) throw asAppError(error, 'weights');
  });
}

export function removeWeight({ userId, day }) {
  const key = `weight|${userId}|${day}`;
  return enqueue(key, async () => {
    const { error } = await state.supa.from('weights')
      .delete().eq('user_id', userId).eq('day', day);
    if (error) throw asAppError(error, 'weights');
  });
}

/**
 * Update your own profile. Only the five columns the database grants are ever
 * sent; anything else would be refused, and sending it anyway would produce a
 * baffling permission error instead of a clear one.
 */
const PROFILE_WRITABLE = ['display_name', 'rule', 'weekly_target', 'weight_unit', 'share_weight'];

export function saveProfile(userId, patch) {
  const clean = {};
  for (const k of PROFILE_WRITABLE) if (k in patch) clean[k] = patch[k];
  return enqueue(`profile|${userId}`, async () => {
    const { data, error } = await state.supa.from('profiles')
      .update(clean).eq('id', userId).select(PROFILE_COLUMNS).single();
    if (error) throw asAppError(error, 'profiles');
    return data;
  });
}

/* ---------------------------------------------------------------------------
   Errors

   Postgres and PostgREST both speak in codes. Turning them into sentences here
   means every call site gets the same wording, and nobody ever sees a raw
   constraint name in a toast.
   --------------------------------------------------------------------------- */
export class AppError extends Error {
  constructor(message, { code = '', offline = false, cause = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.offline = offline;
    this.cause = cause;
  }
}

export function asAppError(error, table = '') {
  const raw = String(error?.message || '');
  const code = error?.code || '';

  /* Server codes are checked first, and deliberately so. A Postgres error code
     is proof that the request reached the database and was answered, which
     means it is not a connectivity problem no matter what navigator.onLine
     currently claims — and navigator.onLine lies often enough (captive
     portals, a radio that has come back but not told anyone) that letting it
     win would relabel a genuine permission error as "you are offline". */
  if (code === '42501') {
    return new AppError(
      table === 'weights'
        ? 'You can only change your own weight entries.'
        : 'You can only change your own days.',
      { code, cause: error });
  }
  if (code === '23514') {
    if (/not_future/.test(raw)) return new AppError('That day has not happened yet.', { code, cause: error });
    if (/not_ancient/.test(raw)) return new AppError('That date is too far in the past.', { code, cause: error });
    if (/weights_range/.test(raw)) return new AppError('That weight is outside the range the app accepts.', { code, cause: error });
    if (/note_len/.test(raw)) return new AppError('That note is too long.', { code, cause: error });
    if (/tag_shape|tag_count/.test(raw)) return new AppError('One of those tags is not valid.', { code, cause: error });
    return new AppError('The database refused that value.', { code, cause: error });
  }
  if (code === '23505') return new AppError('That entry already exists.', { code, cause: error });
  if (code === 'PGRST116') return new AppError('That record could not be found.', { code, cause: error });
  if (/jwt|token/i.test(raw)) return new AppError('Your session expired. Reload to sign in again.', { code, cause: error });

  // Nothing came back from the server, so this is the connection failing.
  const looksOffline = /failed to fetch|networkerror|load failed|network request failed/i.test(raw)
    || (!code && typeof navigator !== 'undefined' && navigator.onLine === false);
  if (looksOffline) {
    return new AppError('You are offline. Nothing was saved.', { code, offline: true, cause: error });
  }

  return new AppError(raw || 'Something went wrong.', { code, cause: error });
}

/* ---------------------------------------------------------------------------
   Realtime

   Check-ins and profiles stream; weights deliberately do not. A realtime
   DELETE payload carries only the row's primary key and is not filtered by the
   read policy, so publishing weights would broadcast "somebody deleted a
   weight for user X on day Y" to every connected client — exactly the fact the
   privacy switch exists to withhold. Weight is refreshed on focus instead,
   which is more than fast enough for a number that changes once a day.
   --------------------------------------------------------------------------- */
export function subscribe({ onCheckins, onProfiles, onStatus }) {
  let everConnected = false;

  const channel = state.supa
    .channel('carr-athletics')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'checkins' }, onCheckins)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, onProfiles)
    .subscribe(status => {
      const live = status === 'SUBSCRIBED';
      /* Realtime is a stream, not a journal: anything committed while the
         socket was down is never delivered. So a reconnection is a signal to
         go and read the world again, not just to turn the indicator green. */
      if (live && everConnected) onCheckins({ resync: true });
      if (live) everConnected = true;
      onStatus?.(status);
    });

  return channel;
}

/* ---------------------------------------------------------------------------
   Auth
   --------------------------------------------------------------------------- */

/**
 * Ask for a sign-in email. The same request produces both the link and the
 * six-digit code — they are the same token, and which one the person uses
 * depends only on what the email template shows them.
 */
export async function requestSignIn(email) {
  const { error } = await state.supa.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: location.origin + location.pathname,
    },
  });
  if (error) throw signInError(error);
}

export async function verifyCode(email, token) {
  const { data, error } = await state.supa.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw signInError(error);
  return data.session;
}

export async function signInWithGoogle() {
  const { error } = await state.supa.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: location.origin + location.pathname,
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error) throw signInError(error);
}

/**
 * The escape hatch for an installed iPhone app, where a link tapped in Mail
 * opens Safari and the session lands in storage the app cannot see. Because
 * the implicit flow carries the tokens in the URL fragment, pasting the link
 * into the app is enough to finish the job.
 */
export async function signInWithPastedLink(pasted) {
  let hash = '';
  try {
    hash = new URL(String(pasted).trim()).hash.replace(/^#/, '');
  } catch {
    throw new AppError('That does not look like a sign-in link.');
  }
  const params = new URLSearchParams(hash);
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  if (!access_token || !refresh_token) {
    throw new AppError('That link has no sign-in details in it. Copy the whole link from the email.');
  }
  const { data, error } = await state.supa.auth.setSession({ access_token, refresh_token });
  if (error) throw signInError(error);
  return data.session;
}

/**
 * Sign out of THIS device only.
 *
 * supabase-js defaults to a global sign-out, which revokes every refresh token
 * the account holds. Signing out on the family laptop would therefore knock
 * every phone in the house back to the sign-in screen within the hour, and
 * getting them all back in would cost more sign-in emails than the project is
 * allowed to send.
 */
export async function signOutHere() {
  const { error } = await state.supa.auth.signOut({ scope: 'local' });
  if (error) throw asAppError(error);
}

function signInError(error) {
  const raw = String(error?.message || '').toLowerCase();
  if (!navigator.onLine || /failed to fetch/.test(raw)) {
    return new AppError('You are offline. Reconnect and try again.', { offline: true, cause: error });
  }
  if (raw.includes('checkmark_not_invited')) {
    return new AppError('That address is not on the list. This board is invite-only.', { cause: error });
  }
  /* A signup blocked by the allow-list trigger surfaces as a generic database
     error, so it has to be mapped here. But mapping EVERY database error to
     "not invited" — which the old version did — turns a genuine outage into an
     accusation, so the two are kept apart as far as the message allows. */
  if (raw.includes('database error') || raw.includes('unexpected_failure')) {
    return new AppError(
      'That address could not be signed in. If you were invited, check the spelling; otherwise the board may be having a problem.',
      { cause: error });
  }
  if (raw.includes('rate limit') || raw.includes('too many') || raw.includes('over_email_send_rate')) {
    return new AppError('Too many sign-in emails just now. Wait a few minutes and try again.', { cause: error });
  }
  if (raw.includes('expired') || raw.includes('invalid')) {
    return new AppError('That code or link has expired or was already used. Ask for a new one.', { cause: error });
  }
  return new AppError(error?.message || 'Sign-in failed. Try again.', { cause: error });
}

/* ---------------------------------------------------------------------------
   Session
   --------------------------------------------------------------------------- */

/**
 * Get the current session, distinguishing "signed out" from "could not reach
 * the server to find out". The difference matters: showing a sign-in form to
 * somebody who is merely on a bad connection invites them to burn one of the
 * project's two sign-in emails per hour on a session they already have.
 */
export async function getSession() {
  const { data, error } = await state.supa.auth.getSession();
  if (data?.session) return { session: data.session, offline: false };
  const offline = !navigator.onLine
    || error?.name === 'AuthRetryableFetchError'
    || /failed to fetch/i.test(String(error?.message || ''));
  return { session: null, offline };
}

/** Wait for the SDK to finish consuming a sign-in fragment from the URL. */
export function waitForSession(ms = 25000) {
  return new Promise(resolve => {
    let settled = false;
    let sub = null;
    const done = value => {
      if (settled) return;
      settled = true;
      try { sub?.data?.subscription?.unsubscribe(); } catch { /* already gone */ }
      resolve(value);
    };
    sub = state.supa.auth.onAuthStateChange((_event, session) => { if (session) done(session); });
    state.supa.auth.getSession().then(({ data }) => { if (data?.session) done(data.session); });
    setTimeout(async () => {
      // One last look before giving up: on a slow connection the SDK may have
      // finished a moment after the timer, and telling somebody their sign-in
      // failed when it did not is how a second email gets requested.
      const { data } = await state.supa.auth.getSession();
      done(data?.session || null);
    }, ms);
  });
}

/** A sensible floor for how far back to read check-ins. */
export const historyFloor = () => shiftISO(todayISO(), -800);
