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

/*
  COLLECTIONS — the `collections` story tree.

  Modelled on the shape the user actually wants, plus one branch per thing the
  tests have to prove:

    '1'  d2d_mem                 group
      '2'  v1                      group
        '3'  mid                     group
          '4'  wsj-d2dmid-…-1-n32      link (full https URL)
          '5'  wsj/d2d_mem/mid-0901-1  link whose URL has NO scheme
        '6'  sft                     group
          '7'  wsj-d2dmems-…-1-n32     link
          '8'  wsj/d2d_mem/sft-0919-1  link (URL duplicates '11' — no dedupe)
        '9'  rl                      group, collapsed
          '10' wsj-d2dmemr-…-n16       link
          '11' wsj/d2d_mem/rl-0919-1   link, same URL as '8'
    '12' Empty group             group with no children at all
    '13' prose-named link        top-level link, name is a whole sentence
    '14' Deep                    group
      '15' L2                      group
        '16' L3                      group
          '17' L4                      group
            '18' very deep link          link
    '19' Hostile                 group
      '20' <img src=x …>           link whose name is markup and url is javascript:

  Ids are numeric strings and run 1..20, so nextCollectionId(COLLECTIONS) === '21'.
  Counts: 11 groups, 9 links.
*/
const COLLECTIONS = {
  version: 1,
  nodes: [
    { id: '1', type: 'group', name: 'd2d_mem', collapsed: false, children: [
      { id: '2', type: 'group', name: 'v1', collapsed: false, children: [
        { id: '3', type: 'group', name: 'mid', collapsed: false, children: [
          { id: '4', type: 'link', name: 'wsj-d2dmid-0901-1-n32-09012201',
            url: 'https://tracker.example/runs/wsj-d2dmid-0901-1-n32-09012201',
            favIconUrl: '', addedAt: '2026-09-23T10:00:00.000Z' },
          { id: '5', type: 'link', name: 'wsj/d2d_mem/mid-0901-1',
            url: 'wsj/d2d_mem/mid-0901-1',
            favIconUrl: '', addedAt: '2026-09-23T10:01:00.000Z' },
        ]},
        { id: '6', type: 'group', name: 'sft', collapsed: false, children: [
          { id: '7', type: 'link', name: 'wsj-d2dmems-0919-1-n32-09191750',
            url: 'https://tracker.example/runs/wsj-d2dmems-0919-1-n32-09191750',
            favIconUrl: '', addedAt: '2026-09-23T10:02:00.000Z' },
          { id: '8', type: 'link', name: 'wsj/d2d_mem/sft-0919-1',
            url: 'https://tracker.example/runs/shared-report',
            favIconUrl: '', addedAt: '2026-09-23T10:03:00.000Z' },
        ]},
        { id: '9', type: 'group', name: 'rl', collapsed: true, children: [
          { id: '10', type: 'link', name: 'wsj-d2dmemr-0919-1-n16-09212312',
            url: 'https://tracker.example/runs/wsj-d2dmemr-0919-1-n16-09212312',
            favIconUrl: '', addedAt: '2026-09-23T10:04:00.000Z' },
          // Same URL as '8' — a link legitimately living under two groups
          { id: '11', type: 'link', name: 'wsj/d2d_mem/rl-0919-1',
            url: 'https://tracker.example/runs/shared-report',
            favIconUrl: '', addedAt: '2026-09-23T10:05:00.000Z' },
        ]},
      ]},
    ]},

    { id: '12', type: 'group', name: 'Empty group', collapsed: false, children: [] },

    // The user's trailing line: a link whose display text is a whole sentence
    { id: '13', type: 'link',
      name: '重新copy一个encoder_old来提取当前帧（encoder_old生成的）和mem 4帧，进行多帧融合，encoder_old整个都fix，',
      url: 'https://tracker.example/notes/encoder-old-multiframe-fusion',
      favIconUrl: '', addedAt: '2026-09-23T10:06:00.000Z' },

    { id: '14', type: 'group', name: 'Deep', collapsed: false, children: [
      { id: '15', type: 'group', name: 'L2', collapsed: false, children: [
        { id: '16', type: 'group', name: 'L3', collapsed: false, children: [
          { id: '17', type: 'group', name: 'L4', collapsed: false, children: [
            { id: '18', type: 'link', name: 'very deep link',
              url: 'https://example.com/deep',
              favIconUrl: '', addedAt: '2026-09-23T10:07:00.000Z' },
          ]},
        ]},
      ]},
    ]},

    { id: '19', type: 'group', name: 'Hostile', collapsed: false, children: [
      { id: '20', type: 'link', name: '<img src=x onerror="alert(1)">',
        url: 'javascript:alert(1)',
        favIconUrl: '', addedAt: '2026-09-23T10:08:00.000Z' },
    ]},

    // One of each newer leaf kind. The '&' in the group name is deliberate:
    // group names need escaping in the same places item names do.
    { id: '21', type: 'group', name: 'Notes & code', collapsed: false, children: [
      { id: '22', type: 'note', name: '', status: '',
        text: '重新copy一个encoder_old来提取当前帧（encoder_old生成的）和mem 4帧，进行多帧融合，encoder_old整个都fix，',
        addedAt: '2026-09-23T10:09:00.000Z' },
      { id: '23', type: 'snippet', name: 'launch', status: 'doing',
        code: 'torchrun --nproc_per_node 8 train.py --mem 4 --freeze-encoder',
        language: 'bash', addedAt: '2026-09-23T10:10:00.000Z' },
      // Same url as node '4' — a duplicate, on purpose
      { id: '24', type: 'link', name: 'mid run', status: 'todo',
        url: 'https://tracker.example/runs/wsj-d2dmid-0901-1-n32-09012201',
        favIconUrl: '', addedAt: '2026-09-23T10:11:00.000Z' },
    ]},
  ],
};

module.exports = { GROUPS, TABS, SAVED, REAL_TAB_IDS, COLLECTIONS };
