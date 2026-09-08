/* ===========================================================================
   Carr Athletics — core logic.

   Everything in this file is a pure function of its arguments. No DOM, no
   network, no globals. That is not tidiness for its own sake: it is what lets
   tools/test-logic.mjs import this module directly in Node and check the date
   arithmetic against DST transitions, and the weight conversions against two
   hundred rounds of open-and-save, without a browser anywhere.

   If you are adding something here and it needs `document`, it belongs in
   app.js instead.
   =========================================================================== */

/* ---------------------------------------------------------------------------
   Dates

   Every day in this app is a local calendar day written 'YYYY-MM-DD'. That is
   what the database stores and what a person means when they say "Tuesday".

   The one rule that matters: never subtract two Date objects to count days.
   Toronto has a 23-hour day every March and a 25-hour one every November, so
   a difference in milliseconds divided by 86,400,000 is not an integer on
   those days, and whether you get the right answer depends entirely on
   whether the rounding happens to go your way. Instead, convert to a day
   NUMBER — a count of days since the epoch computed in UTC, where every day
   is exactly 24 hours — and do the arithmetic there.

   `new Date(y, m - 1, d)` is still allowed, but only for asking the calendar
   questions it is good at: what weekday is this, how many days in this month.
   Never for a subtraction.
   --------------------------------------------------------------------------- */

export const pad = n => String(n).padStart(2, '0');

/** A local Date -> 'YYYY-MM-DD'. The one place the device's clock enters. */
export const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Today, as the person holding the phone would name it. */
export const todayISO = () => toISO(new Date());

/** 'YYYY-MM-DD' -> a local Date at midnight. For rendering only, never maths. */
export const fromISO = s => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** 'YYYY-MM-DD' -> integer days since 1970-01-01. DST-proof by construction. */
export const dayNum = s => {
  const [y, m, d] = s.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};

/** The inverse. */
export const isoFromDayNum = n => {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** Whole days from b to a. Exact, allocation-free, correct across DST. */
export const daysBetween = (a, b) => dayNum(a) - dayNum(b);

/** Move a day by n days. */
export const shiftISO = (iso, n) => isoFromDayNum(dayNum(iso) + n);

/** The Sunday on or before iso. */
export const startOfWeekISO = iso => shiftISO(iso, -fromISO(iso).getDay());

export const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

export const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_MIN = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const prettyDate = iso => {
  const d = fromISO(iso);
  return `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
};

export const longDate = iso => {
  const d = fromISO(iso);
  return `${DOW_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** 'Today' / 'Yesterday' / '4 days ago' / '' — relative to a today you pass in,
    so a render pass cannot straddle midnight halfway through. */
export const relativeDay = (iso, today) => {
  const diff = daysBetween(today, iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return `${diff} days ago`;
  if (diff === -1) return 'Tomorrow';
  return '';
};

/* ---------------------------------------------------------------------------
   Check-in statistics

   All of these take a Set of 'YYYY-MM-DD' strings for one person. Building the
   Set once per load and reusing it is what keeps five boards cheap to render:
   the previous version rescanned a Map of every check-in by every person, per
   board, per render.
   --------------------------------------------------------------------------- */

/**
 * The run of consecutive days ending today, or ending yesterday if today has
 * not been logged yet. A streak is not broken by a day that is still in
 * progress — you have until midnight.
 */
export function currentStreak(days, today) {
  let cursor = days.has(today) ? dayNum(today) : dayNum(today) - 1;
  if (!days.has(isoFromDayNum(cursor))) return 0;
  let n = 0;
  while (days.has(isoFromDayNum(cursor))) { n++; cursor--; }
  return n;
}

/** The longest run ever recorded. */
export function bestStreak(days) {
  const nums = [...days].map(dayNum).sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  for (const n of nums) {
    run = prev !== null && n === prev + 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = n;
  }
  return best;
}

/** How many days in a given calendar month were logged. */
export function countMonth(days, y, m) {
  const prefix = `${y}-${pad(m + 1)}-`;
  let n = 0;
  for (const d of days) if (d.startsWith(prefix)) n++;
  return n;
}

/** The seven ISO days of the week containing `today`, Sunday first. */
export const weekDays = today => {
  const start = startOfWeekISO(today);
  return Array.from({ length: 7 }, (_, i) => shiftISO(start, i));
};

/* ---------------------------------------------------------------------------
   Weight

   Stored as an integer number of grams, always. Pounds and kilograms are both
   display units, and choosing either as storage makes the other lossy: a
   value round-tripped lb -> stored -> kg -> stored drifts by a tenth every
   few edits, so a row nobody touched slowly changes. Integer grams round-trip
   exactly, and one gram is finer than any bathroom scale reports.
   --------------------------------------------------------------------------- */

export const LB_IN_GRAMS = 453.59237;          // exact, by international definition

export const gramsFromLb = lb => Math.round(lb * LB_IN_GRAMS);
export const gramsFromKg = kg => Math.round(kg * 1000);
export const lbFromGrams = g => g / LB_IN_GRAMS;
export const kgFromGrams = g => g / 1000;

export const gramsFrom = (value, unit) =>
  unit === 'kg' ? gramsFromKg(value) : gramsFromLb(value);

/** The number a person sees, as a string with one decimal. */
export const displayWeight = (grams, unit) =>
  (unit === 'kg' ? kgFromGrams(grams) : lbFromGrams(grams)).toFixed(1);

/** A signed difference in the display unit, e.g. '-2.1' / '+0.4' / '0.0'. */
export const displayDelta = (deltaGrams, unit) => {
  const v = unit === 'kg' ? kgFromGrams(deltaGrams) : lbFromGrams(deltaGrams);
  const s = Math.abs(v).toFixed(1);
  if (Number(s) === 0) return `0.0`;
  return `${v < 0 ? '−' : '+'}${s}`;      // a real minus sign, not a hyphen
};

/**
 * Parse what somebody typed. Accepts a comma as a decimal separator, because
 * a phone set to a European locale offers one on the numeric keypad.
 * Returns null for anything that is not a plausible weight.
 */
export function parseWeightInput(raw, unit) {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const grams = gramsFrom(value, unit);
  if (grams < 20000 || grams > 400000) return null;   // matches the DB constraint
  return grams;
}

export const WEIGHT_INPUT_RANGE = {
  lb: { min: 45, max: 880, step: 0.1 },
  kg: { min: 20, max: 400, step: 0.1 },
};

/**
 * Prepare a weight series for reading. Takes rows of { day, grams }, returns
 * them sorted oldest-first with their day numbers precomputed, dropping
 * anything dated after `today` (the database allows a day of slack for
 * timezones, and a stray future row must not become "latest").
 */
export function prepareSeries(rows, today) {
  const cap = dayNum(today);
  const entries = (rows || [])
    .map(r => ({ day: r.day, grams: r.grams, note: r.note || '', x: dayNum(r.day) }))
    .filter(e => Number.isFinite(e.grams) && e.x <= cap)
    .sort((a, b) => a.x - b.x);
  return entries;
}

/** The most recent entry, or null. */
export const latestEntry = series => (series.length ? series[series.length - 1] : null);

/**
 * The entry to compare against, `back` days before `anchor`.
 *
 * Nearest-PRECEDING within a tolerance, never nearest-either-side and never
 * interpolated. Interpolating between sporadic weigh-ins invents a
 * measurement nobody took and then presents it with the same confidence as a
 * real one. If there is no reading close enough to the target, the honest
 * answer is that there is no comparison to make.
 */
export function entryAsOf(series, anchorX, back, tolerance) {
  const target = anchorX - back;
  let found = null;
  for (const e of series) {
    if (e.x <= target) found = e;
    else break;
  }
  if (!found) return null;
  if (target - found.x > tolerance) return null;
  return found;
}

/**
 * The headline numbers for one person's weight card.
 *
 * The comparison is anchored on the latest ENTRY, not on today. If Kaden last
 * weighed himself five days ago, a "vs 7 days" anchored on today would
 * silently span twelve days and report a change over a period he never
 * measured.
 */
export function weightSummary(series, today) {
  const latest = latestEntry(series);
  if (!latest) return { latest: null, deltas: [] };

  /* The tolerance is how far past the target the search may reach BACKWARDS to
     find a reading. Somebody who weighs themselves once a week will rarely have
     an entry exactly seven days before their latest one, and refusing to
     compare at all would leave the card permanently showing two dashes. Five
     days of slack catches a weekly habit; twelve catches a monthly one.

     Reaching back further is honest only because the span is always printed
     with the number — "-2.1 lb since 27 August (12 days)" makes no claim the
     data does not support. Reaching FORWARD past the target never happens, and
     nothing is ever interpolated. */
  const spec = [
    { key: 'd7', back: 7, tolerance: 5, label: '7 days' },
    { key: 'd30', back: 30, tolerance: 12, label: '30 days' },
  ];

  const deltas = spec.map(s => {
    const ref = entryAsOf(series, latest.x, s.back, s.tolerance);
    return {
      key: s.key,
      label: s.label,
      ref,
      grams: ref ? latest.grams - ref.grams : null,
      spanDays: ref ? latest.x - ref.x : null,
    };
  });

  return { latest, deltas };
}

/**
 * A trailing average over a window of DAYS, not of entries.
 *
 * "The last seven readings" is the wrong window for sporadic data: seven
 * readings can span six weeks, so it would be a six-week average wearing a
 * one-week label. Two pointers, one pass.
 */
export function movingAverage(series, windowDays) {
  const out = [];
  let lo = 0, sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i].grams;
    while (series[lo].x < series[i].x - (windowDays - 1)) { sum -= series[lo].grams; lo++; }
    out.push({ x: series[i].x, day: series[i].day, grams: sum / (i - lo + 1), n: i - lo + 1 });
  }
  return out;
}

/**
 * Geometry for the sparkline.
 *
 * Two decisions are load-bearing:
 *
 *   The x axis is TIME. Entries on the 1st, 2nd, 3rd of January and then one
 *   in June must read as a cluster, a long silence, and a single point. Spaced
 *   by index they would read as a slow steady drift that never happened.
 *
 *   The domain is a fixed trailing window, not first-entry-to-last-entry. A
 *   domain that rescales itself every time a point is added tells a different
 *   story about the same body each week.
 *
 * The vertical range has a floor, because a one-pound spread stretched to fill
 * the plot looks like a crisis.
 */
export function sparklineGeometry(series, {
  today, rangeDays = 90, width = 320, height = 96,
  padX = 6, padTop = 10, padBottom = 10, minSpanGrams = 2000, gapDays = 21,
} = {}) {
  const x1 = dayNum(today);
  const x0 = x1 - (rangeDays - 1);
  const visible = series.filter(e => e.x >= x0);

  const span = Math.max(1, x1 - x0);
  const px = x => padX + ((x - x0) / span) * (width - padX * 2);

  const values = visible.map(e => e.grams);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 0;
  const spread = Math.max(hi - lo, minSpanGrams);
  const mid = (lo + hi) / 2;
  const yLo = mid - spread / 2;
  const yHi = mid + spread / 2;
  const py = g => height - padBottom - ((g - yLo) / (yHi - yLo)) * (height - padTop - padBottom);

  // Break the line across long silences. A straight segment drawn over a
  // three-month gap asserts a trajectory that was never measured.
  const path = [];
  let prevX = null;
  for (const e of visible) {
    const cmd = prevX === null || e.x - prevX > gapDays ? 'M' : 'L';
    path.push(`${cmd}${px(e.x).toFixed(1)} ${py(e.grams).toFixed(1)}`);
    prevX = e.x;
  }

  return {
    x0, x1, width, height, yLo, yHi,
    visible,
    points: visible.map(e => ({ ...e, cx: px(e.x), cy: py(e.grams) })),
    path: path.join(' '),
    px, py,
    empty: visible.length === 0,
  };
}

/**
 * A sentence describing the whole series, for a screen reader and for the
 * table caption. Computed, never hand-written, so it cannot drift from the
 * data it claims to describe.
 */
export function describeSeries(series, unit, today) {
  if (!series.length) return 'No weight entries yet.';
  const first = series[0];
  const last = series[series.length - 1];
  const u = unit === 'kg' ? 'kilograms' : 'pounds';
  if (series.length === 1) {
    return `One weight entry: ${displayWeight(last.grams, unit)} ${u} on ${longDate(last.day)}.`;
  }
  const change = last.grams - first.grams;
  const dir = change === 0 ? 'unchanged' : change < 0 ? 'down' : 'up';
  const lo = series.reduce((a, b) => (b.grams < a.grams ? b : a));
  const hi = series.reduce((a, b) => (b.grams > a.grams ? b : a));
  return [
    `${series.length} weight entries between ${longDate(first.day)} and ${longDate(last.day)}.`,
    `Started ${displayWeight(first.grams, unit)}, ended ${displayWeight(last.grams, unit)} ${u},`,
    `${dir}${change === 0 ? '' : ` ${displayWeight(Math.abs(change), unit)}`}.`,
    `Lowest ${displayWeight(lo.grams, unit)} on ${longDate(lo.day)},`,
    `highest ${displayWeight(hi.grams, unit)} on ${longDate(hi.day)}.`,
  ].join(' ');
}

/* ---------------------------------------------------------------------------
   Tags
   --------------------------------------------------------------------------- */

export const TAG_GROUPS = [
  { name: 'Cardio', tags: [
    ['run', 'Run'], ['walk', 'Walk / Hike'], ['bike', 'Bike'], ['swim', 'Swim'],
    ['row', 'Row'], ['machine', 'Machine'], ['sport', 'Sport'], ['hiit', 'HIIT'],
  ] },
  { name: 'Resistance', tags: [
    ['chest', 'Chest'], ['back', 'Back'], ['shoulders', 'Shoulders'],
    ['biceps', 'Biceps'], ['triceps', 'Triceps'], ['legs', 'Legs'],
    ['glutes', 'Glutes'], ['core', 'Core'], ['fullbody', 'Full body'],
  ] },
  { name: 'Other', tags: [
    ['yoga', 'Yoga'], ['mobility', 'Mobility / Stretch'], ['climb', 'Climbing'],
    ['martial', 'Martial arts'], ['other', 'Other'],
  ] },
];

export const TAG_LABEL = Object.fromEntries(TAG_GROUPS.flatMap(g => g.tags));
export const MAX_TAGS = 12;

/** Display-only. An unknown slug from the database still renders as itself. */
export const tagLabel = slug => TAG_LABEL[slug] || slug;

/* ---------------------------------------------------------------------------
   Person colours

   The database stores a slot NAME and the stylesheet decides what it looks
   like, so re-colouring the whole app never touches a single row. The list
   here must stay in step with the CHECK constraint in
   supabase/migrations/20260908000001_mom_weights_colors.sql — the constraint
   is the enforcement, this is the client's copy of the same truth.
   --------------------------------------------------------------------------- */

export const COLOR_SLOTS = ['indigo', 'amber', 'teal', 'rose', 'violet', 'emerald', 'sky', 'coral'];

/**
 * A CSS value for a person's colour.
 *
 * The whitelist is a security control, not a nicety: the value comes from the
 * database and lands in a CSS property, so it must never be interpolated
 * unchecked. The inner `var(--indigo)` fallback covers the other half of the
 * problem — an undefined custom property makes the whole declaration invalid,
 * which paints an avatar transparent and its initials invisible rather than
 * merely wrong.
 */
export function colorVar(slot) {
  if (COLOR_SLOTS.includes(slot)) return `var(--c-${slot}, var(--c-indigo))`;
  if (typeof console !== 'undefined') console.warn('unknown colour slot:', slot);
  return 'var(--c-indigo)';
}

/**
 * The first character of a name, counting by code point so an emoji or an
 * accented letter outside the basic plane is not sliced into half a surrogate
 * pair and rendered as a replacement glyph.
 */
export const initials = person => {
  const source = (person?.display_name || person?.email || '?').trim();
  return ([...source][0] || '?').toUpperCase();
};
