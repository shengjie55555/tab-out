/* ================================================================
   Tab Out — theme, applied before the page paints

   The preference lives in localStorage rather than chrome.storage.local
   because reading it has to be SYNCHRONOUS. An async read means the first
   frame is drawn in the wrong theme, and a new tab page is created constantly,
   so that flash would be the first thing you saw every single time.

   A separate file rather than an inline <script>, because MV3's CSP allows
   'self' and nothing else — inline scripts are blocked outright.

   This only has to be right for the first paint. app.js owns changing the
   preference afterwards.
   ================================================================ */
(function () {
  var choice = 'system';

  try {
    choice = localStorage.getItem('tab-out-theme') || 'system';
  } catch (err) {
    // localStorage can be unavailable; following the system is the right
    // fallback, and it's what the preference defaults to anyway.
  }

  var prefersDark = false;
  try {
    prefersDark = !!(window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (err) {}

  var dark = choice === 'dark' || (choice !== 'light' && prefersDark);

  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
