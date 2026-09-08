/* ===========================================================================
   Runs before anything else, and is deliberately tiny.

   It exists as a file rather than an inline <script> so that the page can ship
   a Content-Security-Policy of `script-src 'self'` with no hash exception. A
   hash would work too, right up until somebody edits a comment in it, or git
   rewrites the line endings on the way to the deploy repository — at which
   point the script is silently blocked in production and nowhere else.

   Three jobs:

     1. Tell the stylesheet what kind of thing it is running inside, before the
        first paint, so an iPhone opened from the home screen never flashes an
        "install me" card at somebody who already installed it.
     2. Make a failure visible. Any error thrown while the app is starting used
        to leave a spinner turning forever with no message and — in a standalone
        window, where there is no address bar — no way out.
     3. Note when we started, so the watchdog knows how long it has been.
   =========================================================================== */
(function () {
  var html = document.documentElement;

  /* --------------------------------------------------------------- platform */
  var ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac; the touch-point count is what gives it away.
  var isIOS = /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);

  var standalone = false;
  try {
    standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || navigator.standalone === true;
  } catch (e) { /* matchMedia missing is not worth failing over */ }

  html.setAttribute('data-platform', isIOS ? 'ios' : 'other');
  if (standalone) html.setAttribute('data-standalone', 'yes');

  // Safari on iOS only reports the real Safari UA; anything else on iOS is a
  // different browser wrapping WebKit, and none of those can Add to Home Screen.
  var isRealSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Firefox/.test(ua);
  if (isIOS && !isRealSafari) html.setAttribute('data-ios-browser', 'other');

  window.__CARR = {
    ios: isIOS,
    iosSafari: isRealSafari,
    standalone: standalone,
    startedAt: Date.now(),
    failed: null,
  };

  /* --------------------------------------------------------------- watchdog */
  function fail(reason) {
    if (window.__CARR.failed) return;
    window.__CARR.failed = reason || 'unknown';

    var boot = document.getElementById('boot');
    if (!boot || boot.hidden) return;          // the app got far enough to take over

    var app = document.getElementById('app');
    var gate = document.getElementById('gate');
    if ((app && !app.hidden) || (gate && !gate.hidden)) return;

    boot.textContent = '';
    var box = document.createElement('div');
    box.className = 'bootfail';

    var h = document.createElement('h1');
    h.textContent = 'The board did not load';
    var p = document.createElement('p');
    p.textContent = 'Something went wrong while starting up. This is almost '
      + 'always a connection problem, and trying again usually fixes it.';
    var btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = 'Try again';
    btn.addEventListener('click', function () { location.reload(); });

    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(btn);
    boot.appendChild(box);
  }

  window.__CARR.fail = fail;

  // Twelve seconds is long enough for a cold Supabase project on a slow phone
  // and short enough that nobody is left staring at a spinner wondering.
  setTimeout(function () { fail('timeout'); }, 12000);

  window.addEventListener('error', function (e) {
    // Ignore failures of individual subresources; only a real script error
    // means the app cannot start.
    if (e && e.target && e.target !== window) return;
    fail('error');
  });
  window.addEventListener('unhandledrejection', function () { fail('rejection'); });
})();
