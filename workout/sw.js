/* ===========================================================================
   Service worker for Carr Athletics.

   It exists for one reason: when someone taps the icon on their home screen,
   something should appear. Without this, an installed app with no signal shows
   the browser's offline page inside a chromeless window, which is a worse
   experience than the website it replaced.

   The rules, in order of how much they matter:

     1. Never touch Supabase. Auth tokens and board data go straight to the
        network, always. A cached 401, or a stale board presented as current,
        would be worse than an error.
     2. The document is network-first with a short timeout. A deploy must reach
        everybody quickly; GitHub Pages already serves the HTML with only ten
        minutes of freshness, and a family app that pins itself to a stale shell
        is a support call nobody can answer.
     3. Everything else the shell needs — the script, the fonts, the icons — is
        served from cache and refreshed in the background.

   Versioning: CACHE carries a version string. Activating a new worker deletes
   every cache that is not the current one, so there is no way to end up serving
   half of one release and half of another. Bump VERSION whenever the shell
   changes; tools/deploy.mjs refuses to publish if you forgot.
   =========================================================================== */

const VERSION = '2026-09-08e';
const CACHE = `carr-athletics-${VERSION}`;

/* The shell. Paths are relative so the worker keeps working if the app is ever
   moved out of /workout/ into its own subdomain. */
const SHELL = [
  './',
  './index.html',
  './app.css',
  './boot.js',
  './app.js',
  './core.js',
  './data.js',
  './config.js',
  './vendor/supabase.js',
  './manifest.webmanifest',
  './fonts/fonts.css',
  './icon.svg',
  './icon-32.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './icon-mono-512.png',
  './apple-touch-icon-180.png',
];

/* Fonts are content-addressed by family and weight and never change under a
   name, so they are safe to serve from cache indefinitely. They are discovered
   at runtime rather than listed, because the list changes whenever the type
   choice does and a stale entry here would fail the whole install step. */
const isFont = url => url.pathname.includes('/fonts/') && url.pathname.endsWith('.woff2');

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    /* One at a time, not Promise.all.
       Firing nineteen cold requests at once, while the page that triggered the
       install is fetching the same origin for itself, reliably lost about half
       of them on the real host — the failures were silent, and the app was
       left with a cache good enough to boot but missing every icon. In series
       the whole shell is a few hundred kilobytes and takes a moment longer,
       which nobody experiences because it happens after the page has painted.

       addAll is avoided for a different reason: it is atomic, so one bad entry
       would leave nothing cached at all. Each file gets its own try, and one
       retry, so a single hiccup costs one icon rather than the whole shell. */
    for (const path of SHELL) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await cache.add(new Request(path, { cache: 'reload' }));
          break;
        } catch (e) {
          if (attempt) console.warn('[sw] could not precache', path, e);
        }
      }
    }
  })());
  // Deliberately NOT skipWaiting(). Swapping the script out from under a page
  // that is mid-write is how you lose somebody's check-in. The page asks for
  // the swap when it is ready; see the SKIP_WAITING message below.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key.startsWith('carr-athletics-')) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

const timeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Rule 1: anything that is not our own origin is none of our business.
  // Supabase REST, Supabase realtime and any future third party all fall here.
  if (url.origin !== self.location.origin) return;

  // Rule 2: navigations are network-first, so a deploy lands immediately and a
  // dead connection still opens yesterday's shell.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await timeout(fetch(req), 3500);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html'))
          || (await cache.match('./'))
          || new Response('Offline, and nothing cached yet.', {
            status: 503, headers: { 'content-type': 'text/plain' },
          });
      }
    })());
    return;
  }

  // Fonts: cache-first and never revalidated. They are immutable by name.
  if (isFont(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const fresh = await fetch(req);
      if (fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    })());
    return;
  }

  // Rule 3: everything else is stale-while-revalidate. The page paints from
  // cache immediately, and the next load has the new file.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const spawn = fetch(req)
      .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => null);
    return hit || (await spawn) || new Response('', { status: 504 });
  })());
});
