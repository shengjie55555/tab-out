/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Mirrors Chrome's own tab groups (chrome.tabGroups) as cards, plus one
      card for everything that isn't in a group
   3. Renders group cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

// One card per Chrome tab group, plus a final card for ungrouped tabs.
// Populated by buildTabGroups(). Named "openGroups" rather than "tabGroups"
// so it can't be confused with the chrome.tabGroups API.
let openGroups = [];

// Mirrors chrome.tabGroups.TAB_GROUP_ID_NONE — "this tab isn't in a group".
// Hardcoded rather than read off chrome.tabGroups so it still works when the
// API is unavailable (see chromeGroupsAvailable below).
const UNGROUPED_ID = -1;

// False once chrome.tabGroups.query() has failed — a missing "tabGroups"
// permission (extension not reloaded after a manifest edit) or an older
// Chrome. Everything then falls into the single Ungrouped card.
let chromeGroupsAvailable = true;

// True when chrome.tabs.query() itself failed. The dashboard can't show
// anything in that case, so it says so rather than pretending you have
// no tabs open.
let tabsLoadFailed = false;

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 *
 * groupId / index / favIconUrl come back on the same Tab objects, so
 * mirroring Chrome's groups costs no extra API calls.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      groupId:  typeof t.groupId === 'number' ? t.groupId : UNGROUPED_ID,
      index:    typeof t.index   === 'number' ? t.index   : 0,
      favIconUrl: typeof t.favIconUrl === 'string' ? t.favIconUrl : '',
      pinned:   !!t.pinned,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
    tabsLoadFailed = false;
  } catch (err) {
    // chrome.tabs API unavailable — worth shouting about, because the
    // dashboard would otherwise render a cheerful "no tabs" empty state.
    console.error('[tab-out] chrome.tabs.query() failed:', err);
    openTabs = [];
    tabsLoadFailed = true;
  }
}

/**
 * fetchChromeGroups()
 *
 * Reads every tab group in every window. Returns [] (and flips
 * chromeGroupsAvailable to false) if the tabGroups permission is missing.
 */
async function fetchChromeGroups() {
  try {
    const groups = await chrome.tabGroups.query({});
    chromeGroupsAvailable = true;
    return groups;
  } catch (err) {
    chromeGroupsAvailable = false;
    console.warn(
      '[tab-out] chrome.tabGroups unavailable — every tab will show under ' +
      '"Ungrouped". Reload the extension at chrome://extensions so the ' +
      '"tabGroups" permission takes effect.', err
    );
    return [];
  }
}

/**
 * closeTabsByIds(ids)
 *
 * The single close path in the app. Closing by id means Chrome itself
 * validates every target, so a stale id is a harmless no-op instead of the
 * wrong-tab close that URL/hostname matching used to risk.
 *
 * Returns how many ids were asked to close.
 */
async function closeTabsByIds(ids) {
  const unique = [...new Set(ids)].filter(Number.isInteger);
  if (unique.length === 0) return 0;

  // We're about to fire the very events live sync listens for
  noteSelfMutation();

  try {
    await chrome.tabs.remove(unique);
  } catch {
    // A single stale id rejects the whole batch, so retry one by one and let
    // the tabs that still exist close.
    await Promise.allSettled(unique.map(id => chrome.tabs.remove(id)));
  }

  await fetchOpenTabs();
  return unique.length;
}

/**
 * focusTabById(tabId)
 *
 * Switches Chrome to a tab and brings its window to the front.
 * No URL or hostname guessing, so it can't activate another window's copy.
 */
async function focusTabById(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    showToast('That tab is already gone');
  }
}

/**
 * tabsInGroup(groupId)
 *
 * The live, real-web tabs belonging to one group — or to no group at all
 * when groupId is UNGROUPED_ID. Returns them in tab-strip order.
 *
 * Shared by the renderer and the close paths so a card's "N tabs" count can
 * never disagree with what its buttons actually close.
 *
 * Deliberately filtered client-side rather than with
 * chrome.tabs.query({ groupId }): the isRealTabUrl filter is mandatory
 * (chrome.tabs.remove rejects the entire batch if one target is a chrome://
 * URL), and it keeps a single definition of "a tab you can see".
 */
async function tabsInGroup(groupId) {
  const all  = await chrome.tabs.query({});
  const real = all.filter(t => isRealTabUrl(t.url));
  // Tab-strip order, grouped by window: a card can span windows (the
  // Ungrouped one usually does), and index alone would interleave them
  // depending on the order chrome.tabs.query happened to return.
  const byStripOrder = (a, b) => (a.windowId - b.windowId) || ((a.index || 0) - (b.index || 0));

  if (groupId !== UNGROUPED_ID) {
    return real.filter(t => normalizeGroupId(t.groupId) === groupId).sort(byStripOrder);
  }

  // "Ungrouped" means not in a group Chrome still reports — which is exactly
  // how buildTabGroups files them. That covers a tab whose group was closed
  // between the two queries, and (because fetchChromeGroups returns [] when
  // the permission is missing) every tab in that case too. Matching on
  // groupId === -1 alone would leave those tabs visible on the card but
  // missing from its "Close all".
  const live = new Set((await fetchChromeGroups()).map(g => g.id));
  return real
    .filter(t => {
      const gid = normalizeGroupId(t.groupId);
      return gid === UNGROUPED_ID || !live.has(gid);
    })
    .sort(byStripOrder);
}

/**
 * closeDuplicateTabs(tabs, keepOne)
 *
 * Closes duplicate tabs among the given list of real tab objects.
 * keepOne=true → keep one copy of each URL, close the rest.
 * keepOne=false → close every copy.
 *
 * The survivor is the tab you're looking at if there is one, otherwise the
 * leftmost in the tab strip — deterministic, unlike raw array order.
 * Scoped to the tabs it's given, so one card's dedup can't reach another's.
 */
async function closeDuplicateTabs(tabs, keepOne = true) {
  const byUrl = new Map();
  for (const tab of tabs) {
    if (!byUrl.has(tab.url)) byUrl.set(tab.url, []);
    byUrl.get(tab.url).push(tab);
  }

  const toClose = [];
  for (const copies of byUrl.values()) {
    if (copies.length < 2) continue;
    const keep = keepOne ? (copies.find(t => t.active) || copies[0]) : null;
    for (const tab of copies) {
      if (!keep || tab.id !== keep.id) toClose.push(tab.id);
    }
  }

  return closeTabsByIds(toClose);
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  noteSelfMutation();
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       favIconUrl: "https://…",      // optional; absent on items saved before
                                     // favicons came from Chrome (see below)
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string, favIconUrl?: string }} tab
 */
async function saveTabForLater(tab) {
  noteSelfMutation();
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    // Stored because the tab may be closed by the time this is rendered, so
    // there's nothing left to ask Chrome for an icon. Items saved by older
    // versions have no favIconUrl and fall back to a letter avatar.
    favIconUrl: tab.favIconUrl || '',
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  noteSelfMutation();
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  noteSelfMutation();
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * updateOpenTabsHeader()
 *
 * Repaints the "N groups · M tabs · Close all" line above the cards.
 * Called by the initial render and after every action that changes how many
 * cards or tabs exist, so those numbers can't drift out of date.
 */
function updateOpenTabsHeader() {
  const countEl = document.getElementById('openTabsSectionCount');
  if (!countEl) return;

  const cards = document.querySelectorAll('#openTabsMissions .mission-card:not(.closing)');
  const realCount = openTabs.filter(t => isRealTabUrl(t.url)).length;

  if (cards.length === 0) {
    setHTML(countEl, '0 groups');
    return;
  }

  setHTML(countEl,
    `${cards.length} group${cards.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; ` +
    `${realCount} tab${realCount !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; ` +
    `<button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realCount} tabs</button>`);
}

/**
 * updateFooterStats()
 *
 * Keeps the footer count in step with the cards and the toolbar badge.
 * Counts real web tabs, not every tab Chrome knows about.
 */
function updateFooterStats() {
  const el = document.getElementById('statTabs');
  if (el) el.textContent = openTabs.filter(t => isRealTabUrl(t.url)).length;
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all group cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  setHTML(missionsEl, `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `);

  updateOpenTabsHeader();
  updateFooterStats();
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  chevron: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>`,
};

// Chrome's TabGroupColor values. Used as a whitelist so a group color is
// never interpolated into markup unvalidated; anything unrecognized falls
// back to 'grey'. The matching colors live in style.css ([data-group-color]).
const GROUP_COLORS = {
  grey: true, blue: true, red: true, yellow: true, green: true,
  pink: true, purple: true, cyan: true, orange: true,
};


/* ----------------------------------------------------------------
   MARKUP SAFETY

   Tab titles and URLs come from any page you happen to have open, so they
   are untrusted input as far as this page is concerned. Everything
   interpolated into innerHTML goes through escapeHtml() first.
   ---------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/**
 * setHTML(el, html)
 *
 * Replaces an element's markup, but only when it actually differs.
 *
 * Live sync re-renders the whole dashboard on every change, and a single
 * action produces several of those renders — the one our own handler does
 * after its animation, plus the one the resulting Chrome events schedule.
 * Almost all of them generate byte-identical markup. Rewriting innerHTML
 * anyway discards the browser's layout and makes the card grid visibly
 * jump, so identical markup means we don't touch the DOM at all.
 *
 * Reading innerHTML back costs a re-serialization, but it can't go stale the
 * way caching the last written string would (other code does mutate these
 * containers directly). If the browser ever normalizes something we wrote and
 * the comparison misses, the cost is one redundant write — never a missed
 * update.
 */
function setHTML(el, html) {
  if (!el) return false;
  if (el.innerHTML === html) return false;
  el.innerHTML = html;
  return true;
}


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * normalizeGroupId(groupId)
 *
 * chrome.tabGroups.TAB_GROUP_ID_NONE (-1) means "not in a group"; older
 * Chrome builds and some internal pages can report undefined instead.
 */
function normalizeGroupId(groupId) {
  return typeof groupId === 'number' ? groupId : UNGROUPED_ID;
}

/**
 * isRealTabUrl(url)
 *
 * True for pages that belong on a "your open web tabs" dashboard.
 * The empty check matters: chrome.tabs.query() can return tabs with no URL
 * yet, and they'd otherwise render as a blank chip.
 */
function isRealTabUrl(url) {
  if (!url) return false;
  return (
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:') &&
    !url.startsWith('edge://') &&
    !url.startsWith('brave://')
  );
}

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => isRealTabUrl(t.url));
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   CHIP RENDERING — one tab inside a card

   A single builder serves both the visible chips and the hidden "+N more"
   ones; previously those were near-identical copies and only one of them
   cleaned titles properly.
   ---------------------------------------------------------------- */

/**
 * faviconHtml(tab, hostname)
 *
 * Uses the icon Chrome already has for the tab (tab.favIconUrl). That keeps
 * this page from fetching icons from a third-party service — which is what
 * the old google.com/s2/favicons lookup did, sending every open hostname
 * to Google on every new tab.
 *
 * The icon is frequently absent (tab still loading, sites without one, saved
 * items stored by older versions), so there are two layers of fallback:
 *   1. here — no usable URL means a letter avatar is emitted, never an <img>
 *   2. the delegated error listener at the bottom of this file — a URL that
 *      exists but fails to load is swapped for the same avatar
 *
 * The inline onerror this replaced never ran: MV3's default extension CSP
 * forbids inline event handlers.
 */
function faviconHtml(tab, hostname) {
  const src = usableFaviconUrl(tab.favIconUrl);
  if (!src) return letterAvatarHtml(hostname, 'chip-favicon');
  return `<img class="chip-favicon" src="${escapeHtml(src)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" draggable="false" data-host="${escapeHtml(hostname)}">`;
}

/**
 * usableFaviconUrl(raw)
 *
 * Returns the URL only if it's something an <img> on an extension page can
 * actually load. Chrome hands back moz-extension://, chrome:// and empty
 * strings for some tabs; those would render as a broken-image glyph.
 */
function usableFaviconUrl(raw) {
  const src = typeof raw === 'string' ? raw.trim() : '';
  return /^(https?:|data:image\/)/i.test(src) ? src : '';
}

function letterAvatarHtml(hostname, cssClass) {
  const letter = (hostname || '').replace(/^www\./, '').charAt(0).toUpperCase() || '?';
  return `<span class="${cssClass} favicon-fallback" aria-hidden="true">${escapeHtml(letter)}</span>`;
}

/**
 * deferredFaviconHtml(item, hostname)
 *
 * Saved tabs outlive their tabs, so by the time this renders there may be
 * nothing to ask Chrome. Prefer the icon captured at save time, fall back to
 * a live tab that still has the same URL, and otherwise show a letter.
 * (Items saved by earlier versions have no favIconUrl — hence the avatar.)
 */
function deferredFaviconHtml(item, hostname) {
  const live = openTabs.find(t => t.url === item.url && t.favIconUrl);
  const src  = usableFaviconUrl(item.favIconUrl) || usableFaviconUrl(live && live.favIconUrl);

  if (!src) return letterAvatarHtml(hostname, 'deferred-favicon');
  return `<img class="deferred-favicon" src="${escapeHtml(src)}" alt="" width="14" height="14" loading="lazy" referrerpolicy="no-referrer" data-host="${escapeHtml(hostname)}">`;
}

/**
 * chipLabel(tab)
 *
 * Display text for one tab, cleaned against that tab's OWN hostname. Cards
 * can now hold several domains, so the card's identity is no longer a valid
 * hostname to clean against.
 */
function chipLabel(tab) {
  let hostname = '';
  try { hostname = new URL(tab.url).hostname; } catch {}

  let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), hostname);

  // For localhost tabs, prepend the port so you can tell projects apart
  try {
    const parsed = new URL(tab.url);
    if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
  } catch {}

  return { label, hostname };
}

/**
 * renderChip(tab, urlCounts)
 *
 * One clickable tab row. Carries only the tab id: the URL and title are read
 * back from Chrome when you click, so a chip can never act on a stale URL
 * that now belongs to some other tab.
 */
function renderChip(tab, urlCounts) {
  const { label, hostname } = chipLabel(tab);
  const count     = (urlCounts && urlCounts[tab.url]) || 1;
  const dupeTag   = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
  const chipClass = count > 1 ? ' chip-has-dupes' : '';

  return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-id="${tab.id}" title="${escapeHtml(label)}">
      ${faviconHtml(tab, hostname)}
      <span class="chip-text">${escapeHtml(label)}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-id="${tab.id}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-id="${tab.id}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
}

/**
 * buildOverflowChips(hiddenTabs, urlCounts)
 *
 * The "+N more" expander and the chips it reveals. The expand handler relies
 * on .page-chips-overflow being the button's previous sibling, so keep the
 * order here.
 */
function renderChips(tabs, urlCounts) {
  return tabs.map(tab => renderChip(tab, urlCounts)).join('');
}

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  return `
    <div class="page-chips-overflow" style="display:none">${renderChips(hiddenTabs, urlCounts)}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   GROUP CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * groupLabel(group)
 *
 * Chrome group titles are authored by you, so they're shown verbatim —
 * running them through the title cleaners would mangle real names. An
 * unnamed group is just a coloured dot in Chrome's tab strip, so give it
 * something readable.
 */
function groupLabel(group) {
  if (group.isUngrouped) return 'Ungrouped';
  return (group.title || '').trim() || 'Untitled group';
}

/**
 * renderGroupCard(group)
 *
 * Builds one card for a Chrome tab group — or for the Ungrouped bucket.
 * group = { id, isUngrouped, title, color, collapsed, windowId, index, tabs }
 */
function renderGroupCard(group) {
  const tabs     = group.tabs || [];
  const tabCount = tabs.length;

  // Count duplicates (exact URL match) within this card
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;

  const dupeCounts  = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes    = dupeCounts.length > 0;
  const totalExtras = dupeCounts.reduce((sum, [, c]) => sum + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Show each URL once, with an (Nx) badge when it's open more than once
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  // A card you expanded with "+N more" stays expanded when the dashboard
  // re-renders underneath you (live sync re-renders often).
  const expanded = expandedGroups.has(group.id);
  const pageChips = renderChips(visibleTabs, urlCounts)
    + (extraCount > 0
        ? (expanded
            ? renderChips(uniqueTabs.slice(8), urlCounts)
            : buildOverflowChips(uniqueTabs.slice(8), urlCounts))
        : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-group-tabs" data-group-id="${group.id}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-group-id="${group.id}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  const label = groupLabel(group);
  const color = GROUP_COLORS[group.color] ? group.color : 'grey';

  // Only real Chrome groups can be collapsed — there's no Chrome-side state
  // to write for the Ungrouped bucket.
  const toggle = group.isUngrouped ? '' : `
          <button class="card-collapse-toggle" type="button" data-action="toggle-group-collapse" data-group-id="${group.id}" aria-expanded="${!group.collapsed}" title="${group.collapsed ? 'Expand' : 'Collapse'} in Chrome">
            ${ICONS.chevron}
          </button>`;

  const nameHint = group.isUngrouped
    ? 'Tabs that are not in a Chrome group'
    : `Chrome group${group.title ? ` “${group.title}”` : ''} · window ${group.windowId}`;

  return `
    <div class="mission-card group-card${group.collapsed ? ' is-collapsed' : ''}" data-group-id="${group.id}" data-group-color="${color}">
      <div class="mission-content">
        <div class="mission-top">${toggle}
          <span class="mission-name" title="${escapeHtml(nameHint)}">${escapeHtml(label)}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      setHTML(list, active.map(item => renderDeferredItem(item)).join(''));
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      // Re-applies whatever the search box currently holds: live sync
      // re-renders this list, and silently dropping the filter would look
      // like your search had been cleared.
      setHTML(archiveList, renderArchiveResults(archived));
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '', hostname = '';
  try { hostname = new URL(item.url).hostname; domain = hostname.replace(/^www\./, ''); } catch {}
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}" aria-label="Mark as read">
      <div class="deferred-info">
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="deferred-title" title="${escapeHtml(item.title || item.url)}">
          ${deferredFaviconHtml(item, hostname)}${escapeHtml(item.title || item.url)}
        </a>
        <div class="deferred-meta">
          <span>${escapeHtml(domain)}</span>
          <span>${escapeHtml(ago)}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveResults(archived)
 *
 * The archived list narrowed by whatever the search box holds. A query needs
 * two characters to count, matching the behaviour of the input handler.
 */
function renderArchiveResults(archived) {
  const q = (archiveQuery || '').trim().toLowerCase();

  const items = q.length < 2
    ? archived
    : archived.filter(item =>
        (item.title || '').toLowerCase().includes(q) ||
        (item.url   || '').toLowerCase().includes(q));

  if (items.length === 0 && q.length >= 2) {
    return '<div class="archive-empty">No results</div>';
  }
  return items.map(item => renderArchiveItem(item)).join('');
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="archive-item-title" title="${escapeHtml(item.title || item.url)}">
        ${escapeHtml(item.title || item.url)}
      </a>
      <span class="archive-item-date">${escapeHtml(ago)}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * buildTabGroups(realTabs, chromeGroups, currentWindowId)
 *
 * Turns Chrome's groups plus the open tabs into the card list: one card per
 * Chrome group, plus a final Ungrouped card holding every tab that isn't in
 * one. Tabs within a card keep their tab-strip order.
 *
 * A tab whose groupId points at a group chrome.tabGroups.query() didn't
 * return (the group was closed between the two calls) is treated as
 * ungrouped rather than dropped — a tab missing from the dashboard is worse
 * than one filed under the wrong card.
 *
 * Groups whose tabs are all browser-internal end up with no tabs and are
 * skipped, so we never render a card whose buttons would do nothing.
 */
function buildTabGroups(realTabs, chromeGroups, currentWindowId) {
  const byId  = new Map(chromeGroups.map(g => [g.id, g]));
  const found = new Map();

  for (const tab of realTabs) {
    let gid  = normalizeGroupId(tab.groupId);
    let meta = byId.get(gid);

    if (gid !== UNGROUPED_ID && !meta) {
      gid  = UNGROUPED_ID;
      meta = null;
    }

    let group = found.get(gid);
    if (!group) {
      group = {
        id:         gid,
        isUngrouped: gid === UNGROUPED_ID,
        title:      (meta && meta.title) || '',
        color:      (meta && meta.color) || 'grey',
        collapsed:  !!(meta && meta.collapsed),
        windowId:   meta ? meta.windowId : null,
        index:      tab.index || 0,
        tabs:       [],
      };
      found.set(gid, group);
    }

    group.index = Math.min(group.index, tab.index || 0);
    group.tabs.push(tab);
  }

  for (const group of found.values()) {
    // Same ordering as tabsInGroup(), so a card lists tabs in the order its
    // "Close all" would close them.
    group.tabs.sort((a, b) => (a.windowId - b.windowId) || ((a.index || 0) - (b.index || 0)));
  }

  return [...found.values()].sort((a, b) => compareGroups(a, b, currentWindowId));
}

/**
 * compareGroups(a, b, currentWindowId)
 *
 * Card order mirrors Chrome: current window first, then by window, then by
 * where the group sits in the tab strip. Ungrouped always sinks to the
 * bottom so the real groups get the attention.
 */
function compareGroups(a, b, currentWindowId) {
  if (a.isUngrouped !== b.isUngrouped) return a.isUngrouped ? 1 : -1;

  const aCurrent = a.windowId === currentWindowId;
  const bCurrent = b.windowId === currentWindowId;
  if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;

  if (a.windowId !== b.windowId) return (a.windowId || 0) - (b.windowId || 0);
  if (a.index !== b.index) return a.index - b.index;
  return a.id - b.id;
}

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs and, from Chrome, the tab groups they belong to
 * 3. Builds one card per group (plus one for ungrouped tabs)
 * 4. Renders those cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();

  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');
  const countEl              = document.getElementById('openTabsSectionCount');

  // If we couldn't read tabs at all, say so. Silently showing the cheerful
  // "Inbox zero" state would look like you have no tabs open.
  if (tabsLoadFailed) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    if (countEl) countEl.textContent = '';
    if (openTabsSection) openTabsSection.style.display = 'block';
    setHTML(openTabsMissionsEl, `
        <div class="missions-empty-state">
          <div class="empty-title">Couldn't read your tabs.</div>
          <div class="empty-subtitle">Reload the extension at chrome://extensions and try again.</div>
        </div>`);
    // Saved tabs live in chrome.storage, not chrome.tabs — they're still
    // worth showing even when the tab list can't be read.
    await renderDeferredColumn();
    return;
  }

  const realTabs = getRealTabs();

  // --- Build one card per Chrome tab group ---
  const chromeGroups = await fetchChromeGroups();

  let currentWindowId = null;
  try { currentWindowId = (await chrome.windows.getCurrent()).id; } catch {}

  openGroups = buildTabGroups(realTabs, chromeGroups, currentWindowId);

  // --- Render group cards ---
  if (openGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    setHTML(openTabsMissionsEl, openGroups.map(g => renderGroupCard(g)).join(''));
    openTabsSection.style.display = 'block';
    updateOpenTabsHeader();
  } else if (openTabsSection && openTabsMissionsEl) {
    // Nothing open — show the cheerful empty state, not an empty box
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSection.style.display = 'block';
    setHTML(openTabsMissionsEl, '');
    checkAndShowEmptyState();
  }

  // --- Footer stats ---
  updateFooterStats();

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   LIVE SYNC — keep an open dashboard in step with the browser

   Without this, the dashboard is a snapshot taken when the tab loaded, and
   Tab Out pages accumulate in the background (see the duplicate-Tab-Out
   banner), so a stale one is easy to come back to.

   Three things make this trickier than "re-render on every event":

   1. Our own actions fire the same events the user's do. Chrome doesn't tell
      us who caused them, and our handlers already update the DOM themselves,
      so events are ignored for a moment after we change something.
   2. A single navigation fires tabs.onUpdated several times (status, title,
      favicon). Everything is funnelled through one debounced render.
   3. Re-rendering throws away UI state — so the "+N more" cards you expanded
      and the archive search box are remembered and re-applied (below).
   ---------------------------------------------------------------- */

const SYNC_DEBOUNCE_MS  = 150;
// Long enough to cover our own close animations (300ms) and the event
// latency after them.
const SELF_MUTATION_MS  = 600;

let syncTimer     = null;
let syncQueued    = false;
let syncRunning   = false;
let selfMutatedAt = 0;

// Card ids the user expanded with "+N more", restored across re-renders
const expandedGroups = new Set();
// The archive search box's current text, re-applied after a re-render
let archiveQuery = '';

/**
 * noteSelfMutation()
 *
 * Call after changing tabs, groups or storage ourselves, so the events
 * Chrome sends back don't trigger a second, competing render.
 */
function noteSelfMutation() {
  selfMutatedAt = Date.now();
}

/**
 * scheduleSync()
 *
 * Queue a re-render. Safe to call as often as you like — a burst of events
 * collapses into one render.
 *
 * Nothing is scheduled while the page is hidden: a background Tab Out tab
 * does no work at all, and catches up the moment you switch back to it.
 */
function scheduleSync() {
  if (document.hidden) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, SYNC_DEBOUNCE_MS);
}

async function runSync() {
  syncTimer = null;

  // Our own change is still settling — come back once it has, rather than
  // re-rendering underneath it.
  const sinceSelf = Date.now() - selfMutatedAt;
  if (sinceSelf < SELF_MUTATION_MS) {
    syncTimer = setTimeout(runSync, SELF_MUTATION_MS - sinceSelf);
    return;
  }

  // Never let two renders overlap; queue exactly one more if asked again.
  if (syncRunning) { syncQueued = true; return; }

  syncRunning = true;
  try {
    await renderDashboard();
  } catch (err) {
    console.error('[tab-out] Live sync failed:', err);
  } finally {
    syncRunning = false;
    if (syncQueued) { syncQueued = false; scheduleSync(); }
  }
}

// Switching back to a background dashboard catches it up immediately
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleSync();
});


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    // Remember it, so a live-sync re-render doesn't immediately collapse it
    if (card) {
      const groupId = Number(card.dataset.groupId);
      if (Number.isInteger(groupId)) expandedGroups.add(groupId);
    }
    const overflowContainer = actionEl.parentElement &&
                              actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabId = Number(actionEl.dataset.tabId);
    if (Number.isInteger(tabId)) await focusTabById(tabId);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    const tabId = Number(actionEl.dataset.tabId);
    if (!Number.isInteger(tabId)) return;

    await closeTabsByIds([tabId]);
    playCloseSound();

    // Animate the chip row out, then resync every count from Chrome — the
    // card's "N tabs open" badge and the section header both just changed.
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
    }

    showToast('Tab closed');
    setTimeout(async () => {
      if (chip) chip.remove();
      // A card whose last tab just closed is gone from Chrome, so it simply
      // won't come back when we re-render.
      await renderDashboard();
    }, 200);
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    const tabId = Number(actionEl.dataset.tabId);
    if (!Number.isInteger(tabId)) return;

    // Read the tab back from Chrome rather than trusting what's in the DOM,
    // and bail if it's already gone — so we never store a half-empty record.
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      showToast('That tab is already gone');
      await renderDashboard();
      return;
    }

    // Store the label we actually displayed, not the raw page title: the
    // renderer has already stripped notification counts and email addresses
    // out of it.
    const shownTitle = actionEl.closest('.page-chip')?.querySelector('.chip-text')?.textContent;

    try {
      await saveTabForLater({
        url:        tab.url,
        title:      shownTitle || tab.title || tab.url,
        favIconUrl: tab.favIconUrl || '',
      });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    await closeTabsByIds([tabId]);

    // Animate chip out, then resync (which also repaints the sidebar)
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    setTimeout(async () => {
      if (chip) chip.remove();
      await renderDashboard();
    }, 200);
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close every tab in one group ----
  if (action === 'close-group-tabs') {
    const groupId = Number(actionEl.dataset.groupId);
    if (!Number.isInteger(groupId)) return;

    const group     = openGroups.find(g => g.id === groupId);
    const labelText = group ? groupLabel(group) : 'that group';

    // Re-query instead of trusting the tabs captured at render time: tabs
    // added to this group since then should close, and tabs that have since
    // left it should not.
    const tabs = await tabsInGroup(groupId);
    if (tabs.length === 0) {
      await renderDashboard();
      return;
    }

    const closed = await closeTabsByIds(tabs.map(t => t.id));
    playCloseSound();

    if (card) animateCardOut(card);
    openGroups = openGroups.filter(g => g.id !== groupId);
    expandedGroups.delete(groupId);

    showToast(`Closed ${closed} tab${closed !== 1 ? 's' : ''} from ${labelText}`);
    updateOpenTabsHeader();
    updateFooterStats();
    return;
  }

  // ---- Collapse / expand a group, in Chrome as well as here ----
  if (action === 'toggle-group-collapse') {
    const groupId = Number(actionEl.dataset.groupId);
    const group   = openGroups.find(g => g.id === groupId);
    if (!group || group.isUngrouped || !Number.isInteger(groupId) || groupId < 0) return;

    // Take the direction from the DOM rather than reading Chrome and
    // inverting: two clicks landing before the first write resolves would
    // both read the old value and write the same one, leaving the card and
    // Chrome disagreeing. This way the last click simply wins.
    const collapsed = !card.classList.contains('is-collapsed');

    card.classList.toggle('is-collapsed', collapsed);
    actionEl.setAttribute('aria-expanded', String(!collapsed));
    actionEl.title = collapsed ? 'Expand in Chrome' : 'Collapse in Chrome';
    group.collapsed = collapsed;

    try {
      noteSelfMutation();
      await chrome.tabGroups.update(groupId, { collapsed });
    } catch (err) {
      // Group's gone, or the tabGroups permission needs an extension reload —
      // put the card back the way it was.
      console.warn('[tab-out] Could not update group in Chrome:', err);
      card.classList.toggle('is-collapsed', !collapsed);
      actionEl.setAttribute('aria-expanded', String(collapsed));
      actionEl.title = collapsed ? 'Collapse in Chrome' : 'Expand in Chrome';
      group.collapsed = !collapsed;
      showToast('Couldn’t update that group in Chrome');
    }
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const groupId = Number(actionEl.dataset.groupId);
    if (!Number.isInteger(groupId)) return;

    // Recompute duplicates from Chrome rather than trusting a payload
    // rendered earlier, and scope it to this card's group so it can't reach
    // an identical URL shown on another card.
    const tabs   = await tabsInGroup(groupId);
    const closed = await closeDuplicateTabs(tabs, true);
    if (closed === 0) {
      await renderDashboard();
      return;
    }

    playCloseSound();
    showToast(`Closed ${closed} duplicate${closed !== 1 ? 's' : ''}, kept one copy each`);

    // The dupe badges, the card's counts and the dedup button itself all
    // change, so re-render rather than patching each one by hand.
    setTimeout(renderDashboard, 250);
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const all    = await chrome.tabs.query({});
    const closed = await closeTabsByIds(
      all.filter(t => isRealTabUrl(t.url)).map(t => t.id)
    );
    if (closed === 0) return;

    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    openGroups = [];
    showToast('All tabs closed. Fresh start.');
    updateOpenTabsHeader();
    updateFooterStats();
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  // Remembered so a live-sync re-render can re-apply it
  archiveQuery = e.target.value;

  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();
    setHTML(archiveList, renderArchiveResults(archived));
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


// ---- Favicon load failures — swap the broken image for a letter avatar ----
// Chrome's favIconUrl is empty for plenty of tabs, and a URL that exists can
// still fail to load. The `error` event doesn't bubble, so this has to be
// capture-phase. An inline onerror attribute can't do this job: MV3's default
// extension CSP blocks inline event handlers, so the ones this replaced never
// ran at all.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;

  const isChip = img.classList.contains('chip-favicon');
  if (!isChip && !img.classList.contains('deferred-favicon')) return;

  const host   = (img.getAttribute('data-host') || '').replace(/^www\./, '');
  const avatar = document.createElement('span');
  avatar.className = `${isChip ? 'chip-favicon' : 'deferred-favicon'} favicon-fallback`;
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = (host.charAt(0) || '?').toUpperCase();

  img.replaceWith(avatar);
}, true);


/* ----------------------------------------------------------------
   INITIALIZE — wire up live sync, then paint once

   Listeners are registered synchronously at load so they're in place before
   anything can change.
   ---------------------------------------------------------------- */

chrome.tabs.onCreated.addListener(scheduleSync);
chrome.tabs.onRemoved.addListener(scheduleSync);
chrome.tabs.onMoved.addListener(scheduleSync);
chrome.tabs.onAttached.addListener(scheduleSync);
chrome.tabs.onDetached.addListener(scheduleSync);
chrome.tabs.onReplaced.addListener(scheduleSync);

// onUpdated reports every little thing — status flips from "loading" to
// "complete" on each navigation, and none of those change what we draw.
const IGNORED_TAB_CHANGES = new Set([
  'status', 'audible', 'mutedInfo', 'attention', 'discarded', 'autoDiscardable',
]);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (Object.keys(changeInfo).some(key => !IGNORED_TAB_CHANGES.has(key))) scheduleSync();
});

// chrome.tabGroups is undefined when the "tabGroups" permission isn't in
// effect yet (the extension hasn't been reloaded since the manifest changed).
// Reading a property off it here would throw and take the whole file down with
// it, so this has to stay guarded.
if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(scheduleSync);
  chrome.tabGroups.onUpdated.addListener(scheduleSync);
  chrome.tabGroups.onRemoved.addListener(scheduleSync);
  chrome.tabGroups.onMoved.addListener(scheduleSync);
}

// Saved-for-later changes — including ones made by another Tab Out tab
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.deferred) scheduleSync();
});

renderDashboard().catch(err => {
  console.error('[tab-out] Dashboard failed to render:', err);
});
