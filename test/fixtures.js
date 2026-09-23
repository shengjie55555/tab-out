'use strict';

/*
  Fixtures for the app tests.

  A deliberately awkward tab set, covering the cases the grouping code has to
  get right:

    window 1
      group 10 "Work" (blue)          github + youtube — two different domains
      group 11 unnamed (red, collapsed)  two tabs on the SAME url
      group 13 "Internal" (grey)      only browser-internal tabs → no card
      group 14 "Reading" (purple)     10 tabs, so the card overflows with
                                      "+2 more"
      ungrouped                       a pinned tab, a file:// tab, a url-less
                                      tab, a chrome:// tab, and a tab whose
                                      title tries to inject markup
      tab 8                           points at group 99, which tabGroups.query
                                      does not report (the group-closed-in-
                                      between race)
    window 2
      group 12 "Other" (green)        one tab, to prove windows stay separate
*/

const GROUPS = [
  { id: 10, title: 'Work', color: 'blue',  collapsed: false, windowId: 1 },
  { id: 11, title: '',     color: 'red',   collapsed: true,  windowId: 1 },
  { id: 12, title: 'Other', color: 'green', collapsed: false, windowId: 2 },
  { id: 13, title: 'Internal', color: 'grey', collapsed: false, windowId: 1 },
  { id: 14, title: 'Reading', color: 'purple', collapsed: false, windowId: 1 },
];

// 10 tabs in group 14 — one more than a card shows before "+N more"
const READING_TABS = Array.from({ length: 10 }, (_, i) => ({
  id: 20 + i,
  url: `https://reading.example/${i}`,
  title: `Reading ${i}`,
  groupId: 14,
  index: 11 + i,
  windowId: 1,
  active: false,
}));

const TABS = [
  // --- group 10 "Work" ---
  { id: 1, url: 'https://github.com/a', title: 'a/b — GitHub', groupId: 10, index: 0, windowId: 1, active: true,
    favIconUrl: 'https://github.githubassets.com/favicon.ico' },
  { id: 2, url: 'https://www.youtube.com/watch?v=1', title: 'Some Video - YouTube', groupId: 10, index: 1, windowId: 1, active: false },

  // --- group 11: two copies of one URL ---
  { id: 3, url: 'https://example.com/dup', title: 'Dup', groupId: 11, index: 2, windowId: 1, active: false },
  { id: 4, url: 'https://example.com/dup', title: 'Dup', groupId: 11, index: 3, windowId: 1, active: false },

  // --- ungrouped in window 1 ---
  { id: 5, url: 'https://news.com', title: 'News', groupId: -1, index: 4, windowId: 1, active: false, pinned: true },
  { id: 9, url: 'file:///tmp/x.html', title: 'Local', groupId: -1, index: 7, windowId: 1, active: false },
  { id: 12, url: 'https://evil.com', title: 'Evil <img src=x onerror="alert(1)">', groupId: -1, index: 10, windowId: 1, active: false },

  // --- must never appear: browser-internal, extension page, no url at all ---
  { id: 6, url: 'chrome://settings', title: 'Settings', groupId: -1, index: 5, windowId: 1, active: false },
  { id: 11, url: 'chrome-extension://abc/index.html', title: 'Tab Out', groupId: 13, index: 9, windowId: 1, active: false },
  { id: 10, url: undefined, title: 'No URL', groupId: -1, index: 8, windowId: 1, active: false },

  // --- race: groupId 99 is not in GROUPS ---
  { id: 8, url: 'https://orphan.com', title: 'Orphan', groupId: 99, index: 6, windowId: 1, active: false },

  // --- another window ---
  { id: 7, url: 'https://blog.com', title: 'Blog', groupId: 12, index: 0, windowId: 2, active: false },

  ...READING_TABS,
];

const SAVED = [
  { id: '1', url: 'https://saved-with-icon.com', title: 'Has icon',
    favIconUrl: 'https://saved-with-icon.com/f.ico', savedAt: '2026-04-04T10:00:00.000Z',
    completed: false, dismissed: false },
  // Saved by a version that didn't store icons — must degrade, not break
  { id: '2', url: 'https://saved-legacy.com', title: 'Legacy item',
    savedAt: '2026-04-04T10:00:00.000Z', completed: false, dismissed: false },
  { id: '3', url: 'https://archived.com', title: 'Archived',
    savedAt: '2026-04-04T10:00:00.000Z', completed: true, dismissed: false },
];

// Real web tabs = TABS minus chrome://, chrome-extension:// and the url-less
// one, in the order the dashboard displays them (window, then tab-strip index)
const REAL_TAB_IDS = [
  1, 2, 3, 4, 5, 8, 9, 12,
  20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  7,
];

module.exports = { GROUPS, TABS, SAVED, REAL_TAB_IDS };
