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
// API is unavailable.
const UNGROUPED_ID = -1;

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
 * Reads every tab group in every window. Returns [] if the "tabGroups"
 * permission isn't in effect, which makes every tab fall into the single
 * Ungrouped card.
 */
async function fetchChromeGroups() {
  try {
    return await chrome.tabGroups.query({});
  } catch (err) {
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
   COLLECTED TABS — a curated, nestable library of links

   Deliberately separate from "Saved for later": that one is a transient
   checklist you tick off, this one is a library you organise and keep. They
   live under different storage keys and never touch each other.

   Stored under the chrome.storage.local key "collections" as a tree:

     { version: 1, nodes: [
         { id, type: 'group', name, collapsed, children: [ … ] },
         { id, type: 'link',  name, url, favIconUrl, addedAt },
     ]}

   Every function from sanitizeCollectionTree() down to moveCollectionNode()
   is PURE — it returns a new tree and never mutates its input. That's what
   makes them unit-testable straight out of the vm sandbox, and it means a
   caller can't half-apply a change.
   ---------------------------------------------------------------- */

const COLLECTIONS_KEY     = 'collections';
const COLLECTIONS_VERSION = 1;

// A tree deeper than this is treated as malformed rather than walked, so a
// hand-edited storage value can't blow the stack inside the renderer.
const MAX_COLLECTION_DEPTH = 50;

// How many grid columns a top-level card may span. Widening past this would
// leave nothing beside it, which defeats the point of a board.
const MAX_COLLECTION_SPAN = 4;

function normalizeCollectionSpan(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(MAX_COLLECTION_SPAN, n));
}

// A group, or one of the three kinds of leaf:
//   link    — something with an address; opens, or copies when it has no
//             address we can follow (a bare path is a link, not a fourth type)
//   note    — prose, no address at all
//   snippet — code, copied rather than visited
const COLLECTION_TYPES = new Set(['group', 'link', 'note', 'snippet']);

// Optional marker on any leaf. '' means none.
const COLLECTION_STATUSES = new Set(['todo', 'doing', 'done', 'dropped']);

function normalizeCollectionStatus(value) {
  return COLLECTION_STATUSES.has(value) ? value : '';
}

/** The stored payload of a leaf, whatever kind it is. */
function collectionNodeValue(node) {
  if (!node) return '';
  if (node.type === 'link')    return node.url  || '';
  if (node.type === 'note')    return node.text || '';
  if (node.type === 'snippet') return node.code || '';
  return '';
}

/** First line, trimmed and capped — used when an item has no name of its own. */
function collectionFirstLine(text) {
  const line = String(text || '').trim().split('\n')[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * collectionColumnCount()
 *
 * How many columns the board has at the current window width. Computed in JS
 * rather than left to CSS media queries, because a card's stored span has to
 * be clamped to the columns actually available — a `span 4` in a 2-column
 * grid would overflow into an implicit column and break the layout.
 */
function collectionColumnCount() {
  const width = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1300;
  if (width < 700) return 1;
  if (width < 980) return 2;
  if (width < 1260) return 3;
  return 4;
}

// Serialises read-modify-write cycles — see queueCollectionWrite().
let collectionsWriteChain = Promise.resolve();

// Which node's name is being edited inline, and what's in the field. Held in
// module scope rather than read from the DOM, because live sync re-renders the
// tree out from under you — see the rename state machine in the handlers.
let editingCollectionNodeId = null;   // string id, or null
let editingCollectionMode   = 'rename'; // 'rename' (a text field) or 'move' (a select)
let renameDraft             = '';     // what the field currently shows
let renameCaret             = null;   // selectionStart as of the last input
let renameSession           = 0;      // bumped on every open/commit/cancel

// The tree the current render was built from. Only the "move to" select needs
// it, and threading it through three recursive renderers for that would be
// worse than reading it here. Held UNFILTERED, so the destinations a node can
// move to don't change just because a filter is on.
let collectionTreeForRender = createEmptyCollectionTree();

// What the filter box and the status dropdown currently hold, kept in module
// scope for the same reason as archiveQuery: a live-sync re-render has to be
// able to re-apply them.
let collectionQuery        = '';
let collectionStatusFilter = '';

// Where new links go — the "Add to" select, and the destination for the
// bookmark button on any Open tabs chip.
let collectTargetId = '';

// Drag state. The dragged id lives here rather than in dataTransfer because
// getData() returns '' during dragover (a browser security rule).
let collectionDragId     = null;
let collectionDragActive = false;

// Deleting a group destroys everything under it, so it takes a second click
// on the same bin. This remembers which row is armed.
let pendingDeleteId = null;

// Which batch close is armed for a second click. Closing one tab stays a
// single click — it's the most repeated action in the app, and doubling its
// clicks would tax the main loop — but a close that takes several tabs with it
// asks first, the same way deleting from the collected library does.
let pendingCloseKey = null;

/**
 * closeNeedsConfirmation(key, message, actionEl)
 *
 * → true on the arming click, meaning the caller must stop. Marking the button
 * directly rather than re-rendering the grid keeps arming cheap; the mark is
 * transient by design and a later render washes it away.
 */
function closeNeedsConfirmation(key, message, actionEl) {
  if (pendingCloseKey === key) {
    pendingCloseKey = null;
    return false;                      // confirmed: carry on
  }

  pendingCloseKey = key;
  if (actionEl && actionEl.classList) actionEl.classList.add('is-confirming');
  showToast(message);
  return true;
}

// The grid gap, which the resize maths needs and CSS also uses
const COLLECTION_BOARD_GAP = 12;

// The board's row height. Small, so a card's row span can follow its content
// closely; the vertical gap is the card's own margin-bottom, which the span
// arithmetic includes.
const COLLECTION_ROW_UNIT = 8;

// Live state for an in-progress edge drag; null when none is happening
let collectionResize = null;


/* ---- reading and repairing ---------------------------------------- */

function createEmptyCollectionTree() {
  return { version: COLLECTIONS_VERSION, nodes: [] };
}

/**
 * sanitizeCollectionTree(raw)
 *
 * Returns a tree the renderer can trust. storage.local is user-editable from
 * devtools, and a malformed node would otherwise crash the recursive renderer
 * midway through painting. Same defensive posture as normalizeGroupId() and
 * usableFaviconUrl().
 *
 * Drops anything it can't understand rather than guessing: non-objects, unknown
 * node types, links with no url, and — importantly — nodes whose id duplicates
 * one already seen, because two nodes sharing an id makes rename and drag act
 * on the wrong one.
 */
function sanitizeCollectionTree(raw) {
  const tree = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const seenIds = new Set();

  function cleanNode(node, depth) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    if (!COLLECTION_TYPES.has(node.type)) return null;
    if (depth > MAX_COLLECTION_DEPTH) return null;

    const id = (typeof node.id === 'string' || typeof node.id === 'number') ? String(node.id) : '';
    if (!id || seenIds.has(id)) return null;
    seenIds.add(id);

    const name   = typeof node.name === 'string' ? node.name : '';
    const status = normalizeCollectionStatus(node.status);
    const addedAt = typeof node.addedAt === 'string' ? node.addedAt : '';

    if (node.type === 'link') {
      if (typeof node.url !== 'string') return null;
      return {
        id, type: 'link', name, status,
        url: node.url,
        favIconUrl: typeof node.favIconUrl === 'string' ? node.favIconUrl : '',
        addedAt,
      };
    }

    if (node.type === 'note') {
      return { id, type: 'note', name, status, text: typeof node.text === 'string' ? node.text : '', addedAt };
    }

    if (node.type === 'snippet') {
      return {
        id, type: 'snippet', name, status,
        code:     typeof node.code     === 'string' ? node.code     : '',
        language: typeof node.language === 'string' ? node.language : '',
        addedAt,
      };
    }

    return {
      id, type: 'group', name,
      collapsed: !!node.collapsed,
      // Grid columns this card spans. Only top-level cards use it; nested ones
      // stack inside their parent. Kept on every group so the data round-trips.
      span: normalizeCollectionSpan(node.span),
      children: Array.isArray(node.children)
        ? node.children.map(child => cleanNode(child, depth + 1)).filter(Boolean)
        : [],
    };
  }

  return {
    version: typeof tree.version === 'number' ? tree.version : COLLECTIONS_VERSION,
    nodes: Array.isArray(tree.nodes)
      ? tree.nodes.map(node => cleanNode(node, 0)).filter(Boolean)
      : [],
  };
}

/**
 * migrateCollectionTree(raw)
 *
 * Upgrades an older tree to the current shape. There's only one version so
 * far, so this is sanitising plus the version bookkeeping the upgrade steps
 * will hang off later.
 *
 * A tree written by a NEWER build is sanitised for display but must never be
 * written back — see getCollections(), which never persists what it reads. If
 * it did, this build would quietly strip fields a newer one depends on.
 */
function migrateCollectionTree(raw) {
  const tree = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const version = typeof tree.version === 'number' ? tree.version : COLLECTIONS_VERSION;

  if (version > COLLECTIONS_VERSION) {
    console.warn(
      `[tab-out] Collections are version ${version}, this build understands ` +
      `${COLLECTIONS_VERSION}. Showing what it can read, and not rewriting it.`
    );
  }

  return sanitizeCollectionTree(tree);
}

async function getCollections() {
  const stored = await chrome.storage.local.get(COLLECTIONS_KEY);
  // Reads never write back: a read-triggered write would race a genuine one
  // from another window for no benefit at all.
  return migrateCollectionTree(stored && stored[COLLECTIONS_KEY]);
}

/**
 * queueCollectionWrite(mutate)
 *
 * Every collection write goes through here so read-modify-write cycles can't
 * interleave — the same shape as saveTabForLater() would lose updates if two
 * writes overlapped.
 *
 * `mutate` gets the freshly-read tree and returns a new one, or the same
 * reference / null to mean "nothing to do" (no write, no storage event).
 *
 * Callers must call noteSelfMutation() synchronously BEFORE this, so the
 * suppression window is already open when the onChanged echo arrives — the
 * echo can beat the promise chain.
 *
 * Chrome offers no compare-and-swap on storage.local, so two windows writing
 * at the same instant is still last-writer-wins. That window is now
 * sub-millisecond rather than spanning an await, and there is no way to close
 * it completely — pretending otherwise would be worse than saying so.
 */
function queueCollectionWrite(mutate) {
  const run = collectionsWriteChain.then(async () => {
    const tree = await getCollections();
    const next = mutate(tree);
    if (!next || next === tree) return tree;
    await chrome.storage.local.set({ [COLLECTIONS_KEY]: next });
    return next;
  });

  // One failed write must not wedge every later write in the chain
  collectionsWriteChain = run.catch(() => {});
  return run;
}


/* ---- walking the tree --------------------------------------------- */

/** The name to show for a node, with the fallbacks the tree relies on. */
function displayCollectionName(node) {
  const name = (node.name || '').trim();
  if (name) return name;

  if (node.type === 'link')    return node.url || '(unnamed link)';
  if (node.type === 'note')    return collectionFirstLine(node.text) || '(empty note)';
  if (node.type === 'snippet') return collectionFirstLine(node.code) || '(empty snippet)';
  return 'Untitled group';
}

/**
 * findCollectionNode(tree, id)
 *
 * → { node, parentId, index } or null. `index` is the position among its
 * siblings, which is what drop-position maths needs.
 */
function findCollectionNode(tree, id) {
  let result = null;

  (function walk(nodes, parentId) {
    if (result) return;
    const list = nodes || [];
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (String(node.id) === String(id)) {
        result = { node, parentId, index: i };
        return;
      }
      if (node.type === 'group') walk(node.children, node.id);
      if (result) return;
    }
  })(tree && tree.nodes, null);

  return result;
}

/** Every id in a subtree, the node itself first. */
function collectCollectionIds(node) {
  if (!node) return [];
  const ids = [String(node.id)];
  if (node.type === 'group') {
    for (const child of node.children || []) ids.push(...collectCollectionIds(child));
  }
  return ids;
}

/** True only for a STRICT descendant — a node is not its own descendant. */
function isCollectionDescendant(tree, ancestorId, candidateId) {
  if (String(ancestorId) === String(candidateId)) return false;
  const found = findCollectionNode(tree, ancestorId);
  if (!found || found.node.type !== 'group') return false;
  return collectCollectionIds(found.node).slice(1).includes(String(candidateId));
}

/**
 * flattenCollectionTree(tree)
 *
 * Depth-first pre-order, with each group's path pre-joined for the "Add to"
 * select. Uses " / " because that's how the paths people paste around here
 * are written (`wsj/d2d_mem/mid-0901-1`).
 */
function flattenCollectionTree(tree) {
  const out = [];

  (function walk(nodes, depth, parentId, prefix) {
    const list = nodes || [];
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const name = displayCollectionName(node);
      const path = prefix ? `${prefix} / ${name}` : name;

      out.push({
        id: node.id, type: node.type, name: node.name,
        depth, parentId, index: i, path,
        hasChildren: node.type === 'group' && (node.children || []).length > 0,
        collapsed: !!node.collapsed,
      });

      if (node.type === 'group') walk(node.children, depth + 1, node.id, path);
    }
  })(tree && tree.nodes, 0, null, '');

  return out;
}

/** The full "a / b / c" path to a node, inclusive. '' when it isn't found. */
function collectionPathOf(tree, id) {
  const trail = [];

  (function walk(nodes, prefix) {
    for (const node of nodes || []) {
      const name = displayCollectionName(node);
      const path = prefix ? `${prefix} / ${name}` : name;
      if (String(node.id) === String(id)) { trail.push(path); return true; }
      if (node.type === 'group' && walk(node.children, path)) return true;
    }
    return false;
  })(tree && tree.nodes, '');

  return trail[0] || '';
}

function countCollectionNodes(tree) {
  let groups = 0;
  let items  = 0;

  (function walk(nodes) {
    for (const node of nodes || []) {
      if (node.type === 'group') { groups++; walk(node.children); } else { items++; }
    }
  })(tree && tree.nodes);

  return { groups, items };
}

/**
 * nextCollectionId(tree)
 *
 * Derived from the tree's own contents every time, never stored. A persisted
 * counter is state that can drift out of step with the tree, and when it does
 * you get two nodes sharing an id — which silently makes rename and drag act
 * on the wrong node. (Date.now() is no good here either: two adds in the same
 * millisecond collide.)
 */
function nextCollectionId(tree) {
  let max = 0;

  (function walk(nodes) {
    for (const node of nodes || []) {
      const n = Number(node.id);
      if (Number.isFinite(n) && n > max) max = n;
      if (node.type === 'group') walk(node.children);
    }
  })(tree && tree.nodes);

  return String(max + 1);
}


/* ---- structural edits (all pure) ---------------------------------- */

function clampCollectionIndex(index, length) {
  const n = Number.isFinite(index) ? Math.trunc(index) : length;
  return Math.max(0, Math.min(n, length));
}

/**
 * updateCollectionNodes(nodes, id, updater)
 *
 * New node array with the matching node replaced by updater(node), or null if
 * no such node exists. Untouched siblings keep their identity (structural
 * sharing), so this is cheap and nothing is copied that didn't change.
 */
function updateCollectionNodes(nodes, id, updater) {
  let found = false;
  const next = [];

  for (const node of nodes || []) {
    if (String(node.id) === String(id)) {
      found = true;
      const replaced = updater(node);
      if (replaced) next.push(replaced);
      continue;
    }
    if (node.type === 'group' && (node.children || []).length) {
      const kids = updateCollectionNodes(node.children, id, updater);
      if (kids) {
        next.push(Object.assign({}, node, { children: kids }));
        found = true;
        continue;
      }
    }
    next.push(node);
  }

  return found ? next : null;
}

/** New node array without the matching node (and its subtree), or null. */
function removeCollectionNodes(nodes, id) {
  let found = false;
  const next = [];

  for (const node of nodes || []) {
    if (String(node.id) === String(id)) { found = true; continue; }
    if (node.type === 'group' && (node.children || []).length) {
      const kids = removeCollectionNodes(node.children, id);
      if (kids) {
        next.push(Object.assign({}, node, { children: kids }));
        found = true;
        continue;
      }
    }
    next.push(node);
  }

  return found ? next : null;
}

// parentId === null means the root level
function insertCollectionNodes(nodes, parentId, index, inserted) {
  if (parentId === null || parentId === undefined) {
    const next = (nodes || []).slice();
    next.splice(clampCollectionIndex(index, next.length), 0, inserted);
    return next;
  }

  let done = false;
  const next = [];

  for (const node of nodes || []) {
    if (!done && node.type === 'group' && String(node.id) === String(parentId)) {
      const kids = (node.children || []).slice();
      kids.splice(clampCollectionIndex(index, kids.length), 0, inserted);
      next.push(Object.assign({}, node, { children: kids }));
      done = true;
      continue;
    }
    if (!done && node.type === 'group' && (node.children || []).length) {
      const kids = insertCollectionNodes(node.children, parentId, index, inserted);
      if (kids) {
        next.push(Object.assign({}, node, { children: kids }));
        done = true;
        continue;
      }
    }
    next.push(node);
  }

  return done ? next : null;
}


/* ---- the operations the UI performs ------------------------------- */

/**
 * addCollectionLink(tree, { url, name, groupId, favIconUrl, addedAt })
 *
 * → { tree, id }, or null when the target group no longer exists (the caller
 * falls back to the root and re-resolves, rather than filing it somewhere
 * surprising).
 *
 * An empty name is stored as '' and resolved by displayCollectionName() at
 * render time, so "no name yet" stays distinguishable from a real one.
 */
/** Shared by every add* helper: assign an id, insert at the end, report it. */
function insertCollectionItem(tree, parentId, fields) {
  const id     = nextCollectionId(tree);
  const parent = (parentId === null || parentId === undefined || parentId === '')
    ? null : String(parentId);

  const nodes = insertCollectionNodes(
    tree.nodes, parent, Number.MAX_SAFE_INTEGER, Object.assign({ id }, fields));
  if (!nodes) return null;

  return { tree: Object.assign({}, tree, { nodes }), id };
}

/** The four shapes a new leaf can take, so the add helpers stay one-liners. */
function collectionItemFields(opts) {
  const options = opts || {};
  return {
    name:    typeof options.name === 'string' ? options.name : '',
    status:  normalizeCollectionStatus(options.status),
    addedAt: typeof options.addedAt === 'string' ? options.addedAt : '',
  };
}

function addCollectionLink(tree, options) {
  const opts = options || {};
  if (typeof opts.url !== 'string' || !opts.url) return null;

  return insertCollectionItem(tree, opts.groupId, Object.assign(collectionItemFields(opts), {
    type: 'link',
    url:  opts.url,
    favIconUrl: typeof opts.favIconUrl === 'string' ? opts.favIconUrl : '',
  }));
}

function addCollectionNote(tree, options) {
  const opts = options || {};
  const text = typeof opts.text === 'string' ? opts.text : '';
  if (!text.trim()) return null;

  return insertCollectionItem(tree, opts.groupId, Object.assign(collectionItemFields(opts), {
    type: 'note',
    text,
  }));
}

function addCollectionSnippet(tree, options) {
  const opts = options || {};
  const code = typeof opts.code === 'string' ? opts.code : '';
  if (!code.trim()) return null;

  return insertCollectionItem(tree, opts.groupId, Object.assign(collectionItemFields(opts), {
    type: 'snippet',
    code,
    language: typeof opts.language === 'string' ? opts.language : '',
  }));
}

function addCollectionGroup(tree, options) {
  const opts = options || {};
  const id     = nextCollectionId(tree);
  const parent = (opts.parentId === null || opts.parentId === undefined || opts.parentId === '')
    ? null : String(opts.parentId);

  const node = {
    id, type: 'group',
    name: typeof opts.name === 'string' ? opts.name : '',
    collapsed: false,
    span: normalizeCollectionSpan(opts.span),
    children: [],
  };

  const nodes = insertCollectionNodes(tree.nodes, parent, Number.MAX_SAFE_INTEGER, node);
  if (!nodes) return null;

  return { tree: Object.assign({}, tree, { nodes }), id };
}

function renameCollectionNode(tree, id, name) {
  const nodes = updateCollectionNodes(tree.nodes, id, node =>
    Object.assign({}, node, { name: String(name) }));
  return nodes ? Object.assign({}, tree, { nodes }) : null;
}

function deleteCollectionNode(tree, id) {
  const nodes = removeCollectionNodes(tree.nodes, id);
  return nodes ? Object.assign({}, tree, { nodes }) : null;
}

function setCollectionNodeCollapsed(tree, id, collapsed) {
  const nodes = updateCollectionNodes(tree.nodes, id, node =>
    node.type === 'group' ? Object.assign({}, node, { collapsed: !!collapsed }) : node);
  return nodes ? Object.assign({}, tree, { nodes }) : null;
}

// What an auto-created group is named, per kind of entry going into it
const COLLECTION_AUTO_GROUP_PREFIX = { link: 'Link', note: 'Note', snippet: 'Code' };

/**
 * nextCollectionAutoGroupName(tree, kind)
 *
 * The next free `Link3` / `Note1` / `Code2`. Skips names already in use, so an
 * auto group never collides with one you named yourself.
 */
function nextCollectionAutoGroupName(tree, kind) {
  const prefix = COLLECTION_AUTO_GROUP_PREFIX[kind] || 'Item';
  const taken  = new Set(flattenCollectionTree(tree).map(entry => String(entry.name || '').trim()));

  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * collectionWrapTopLevel(tree, parentId, kind)
 *
 * An entry headed for the top level gets a group of its own instead of sitting
 * loose on the board. The board is made of cards, and a bare chip among them
 * both looked wrong and — before tiles all got a measured row span — overlapped
 * its neighbours.
 *
 * One group per add, not per entry: pasting twenty lines makes one group with
 * twenty entries, not twenty groups.
 *
 * → { tree, parentId }
 */
function collectionWrapTopLevel(tree, parentId, kind) {
  const explicit = (parentId && findCollectionNode(tree, parentId)) ? String(parentId) : null;
  if (explicit !== null) return { tree, parentId: explicit };

  const made = addCollectionGroup(tree, {
    name: nextCollectionAutoGroupName(tree, kind),
    parentId: null,
  });
  if (!made) return { tree, parentId: null };

  return { tree: made.tree, parentId: made.id };
}

function setCollectionNodeStatus(tree, id, status) {
  const nodes = updateCollectionNodes(tree.nodes, id, node =>
    // Groups have no status of their own; a status filter reaches their
    // children, not them.
    node.type === 'group' ? node : Object.assign({}, node, { status: normalizeCollectionStatus(status) }));
  return nodes ? Object.assign({}, tree, { nodes }) : null;
}

/**
 * findCollectionDuplicates(tree, value)
 *
 * Every leaf already holding this exact value, with its path — so the caller
 * can say *where* the thing already lives rather than just refusing.
 */
function findCollectionDuplicates(tree, value) {
  const wanted = String(value || '').trim();
  if (!wanted) return [];

  const found = [];
  (function walk(nodes, prefix) {
    for (const node of nodes || []) {
      const name = displayCollectionName(node);
      const path = prefix ? `${prefix} / ${name}` : name;
      if (node.type === 'group') { walk(node.children, path); continue; }
      if (collectionNodeValue(node) === wanted) found.push({ id: node.id, path });
    }
  })(tree && tree.nodes, '');

  return found;
}

/**
 * filterCollectionTree(tree, query, status)
 *
 * → a pruned copy holding only what matches, plus the ancestors needed to show
 * where it lives. A group whose own name matches keeps its whole subtree —
 * narrowing to "this group" and then hiding its contents would be perverse.
 *
 * Kept groups come back expanded, so a match can never be hidden inside a
 * collapsed parent. Pure, so the matching rules are testable without a DOM.
 */
function filterCollectionTree(tree, query, status) {
  const q              = String(query || '').trim().toLowerCase();
  const wantedStatus   = normalizeCollectionStatus(status);
  if (!q && !wantedStatus) return tree;

  const matches = (node) => {
    if (wantedStatus && node.status !== wantedStatus) return false;
    if (!q) return true;
    return [node.name, node.url, node.text, node.code, node.language]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(q));
  };

  function prune(nodes) {
    const kept = [];
    for (const node of nodes || []) {
      if (node.type === 'group') {
        if (matches(node)) { kept.push(node); continue; }
        const children = prune(node.children);
        if (children.length) kept.push(Object.assign({}, node, { children, collapsed: false }));
        continue;
      }
      if (matches(node)) kept.push(node);
    }
    return kept;
  }

  return Object.assign({}, tree, { nodes: prune(tree.nodes) });
}

function setCollectionNodeSpan(tree, id, span) {
  const nodes = updateCollectionNodes(tree.nodes, id, node =>
    node.type === 'group' ? Object.assign({}, node, { span: normalizeCollectionSpan(span) }) : node);
  return nodes ? Object.assign({}, tree, { nodes }) : null;
}

/**
 * collectionMoveTargets(tree, id)
 *
 * Everywhere a node could move to: the top level, plus every group that is
 * neither the node itself nor inside it. Offering an invalid destination would
 * let the UI present a move the model then silently refuses.
 */
function collectionMoveTargets(tree, id) {
  const found = findCollectionNode(tree, id);
  if (!found) return [];

  const excluded = new Set(collectCollectionIds(found.node));

  const targets = [{ id: '', label: 'Top level' }];
  for (const entry of flattenCollectionTree(tree)) {
    if (entry.type !== 'group' || excluded.has(String(entry.id))) continue;
    targets.push({ id: entry.id, label: entry.path });
  }
  return targets;
}

/**
 * reparentCollectionNode(tree, id, parentId)
 *
 * Moves a node to the END of another group (or to the top level, for an empty
 * parentId). Distinct from moveCollectionNode(), which places a node relative
 * to a sibling for drag-and-drop; this one answers "put it in there".
 *
 * → a new tree; null if the move is impossible (unknown node, unknown parent,
 * or a group being dropped inside itself); the SAME reference when the node is
 * already the last child of that parent, so callers can skip the write.
 */
function isValidCollectionReparent(tree, id, parentId) {
  const found = findCollectionNode(tree, id);
  if (!found) return false;

  const dest = (parentId === null || parentId === undefined || parentId === '')
    ? null : String(parentId);

  if (dest === null) return true;
  if (dest === String(id)) return false;
  if (isCollectionDescendant(tree, id, dest)) return false;

  const parent = findCollectionNode(tree, dest);
  return !!(parent && parent.node.type === 'group');
}

function reparentCollectionNode(tree, id, parentId) {
  // Split per the validator because the cycle check is otherwise invisible: a
  // cyclic move fails later anyway, when the destination turns out to have been
  // inside the subtree that was just removed. The outcome alone can't tell you
  // the guard is doing anything — and without it, correctness would rest on
  // insertCollectionNodes failing for a missing parent, which is a much thinner
  // thread than it looks.
  if (!isValidCollectionReparent(tree, id, parentId)) return null;

  const found = findCollectionNode(tree, id);
  const dest = (parentId === null || parentId === undefined || parentId === '')
    ? null : String(parentId);

  let siblings = null;
  if (dest === null) {
    siblings = tree.nodes;
  } else {
    const parent = findCollectionNode(tree, dest);
    if (parent && parent.node.type === 'group') siblings = parent.node.children;
  }
  if (!Array.isArray(siblings)) return null;

  const alreadyLast = String(found.parentId === null || found.parentId === undefined ? '' : found.parentId)
                   === String(dest === null ? '' : dest)
                   && siblings.length > 0
                   && String(siblings[siblings.length - 1].id) === String(id);
  if (alreadyLast) return tree;

  const without = removeCollectionNodes(tree.nodes, id);
  if (!without) return null;

  const nodes = insertCollectionNodes(without, dest, Number.MAX_SAFE_INTEGER, found.node);
  if (!nodes) return null;

  return Object.assign({}, tree, { nodes });
}


/* ---- drag and drop ------------------------------------------------- */

/**
 * collectionDropZoneX(rect, clientX)
 *
 * Which half of a card the pointer is over, for reordering the board. Pure,
 * and it takes a rect rather than an event so it can be unit-tested — the
 * harness has no layout engine, so an event-driven version would test nothing.
 */
function collectionDropZoneX(rect, clientX) {
  if (!rect || typeof rect.left !== 'number' || !rect.width) return 'after';
  return (clientX - rect.left) / rect.width < 0.5 ? 'before' : 'after';
}

/**
 * collectionRowSpan(height, rowUnit, gap)
 *
 * How many grid rows a card of this height needs, including the margin that
 * provides the vertical gap — the span has to cover both or the next card
 * would sit on top of it.
 *
 * Pure, like the other layout maths: the test harness has no layout engine, so
 * an inline version would test nothing.
 */
function collectionRowSpan(height, rowUnit, gap) {
  if (!Number.isFinite(height) || height <= 0) return 1;
  if (!Number.isFinite(rowUnit) || rowUnit <= 0) return 1;

  const spacing = Number.isFinite(gap) && gap > 0 ? gap : 0;
  return Math.max(1, Math.ceil((height + spacing) / rowUnit));
}

/**
 * collectionSpanFromDrag(startWidth, dx, colUnit, gap, maxColumns)
 *
 * The number of columns a card snaps to while its right edge is dragged.
 * Widths land on whole columns so card edges always line up with the grid —
 * a freely-dragged width would leave the board ragged.
 *
 * Pure for the same reason as collectionDropZoneX.
 */
function collectionSpanFromDrag(startWidth, dx, colUnit, gap, maxColumns) {
  // Guard the column width itself: a zero unit would divide into a huge span
  // and clamp to the maximum, silently blowing the card up instead of leaving
  // it alone.
  if (!Number.isFinite(colUnit) || colUnit <= 0) return 1;

  const unit = colUnit + (Number.isFinite(gap) ? gap : 0);
  const span = Math.round((startWidth + dx + gap) / unit);
  return Math.max(1, Math.min(maxColumns, span));
}

/**
 * isValidCollectionMove(tree, dragId, targetId, position)
 *
 * Split out from resolveCollectionDrop() so a caller (and a test) can tell
 * *why* a move was refused rather than just that it was.
 */
function isValidCollectionMove(tree, dragId, targetId, position) {
  if (String(dragId) === String(targetId)) return false;
  if (!findCollectionNode(tree, dragId)) return false;

  // The one that matters: dragging a group into its own subtree would detach
  // that subtree from the tree entirely.
  if (isCollectionDescendant(tree, dragId, targetId)) return false;

  const target = findCollectionNode(tree, targetId);
  if (!target) return false;
  if (position === 'inside' && target.node.type !== 'group') return false;

  return true;
}

/** → { parentId, index } | null */
function resolveCollectionDrop(tree, dragId, targetId, position) {
  if (!isValidCollectionMove(tree, dragId, targetId, position)) return null;

  const target = findCollectionNode(tree, targetId);
  const parentId = (target.parentId === null || target.parentId === undefined)
    ? null : String(target.parentId);

  if (position === 'inside') {
    return { parentId: String(targetId), index: target.node.children.length };
  }
  return { parentId, index: target.index + (position === 'after' ? 1 : 0) };
}

/**
 * moveCollectionNode(tree, dragId, targetId, position)
 *
 * → a new tree, or null if the move is invalid. A move that would change
 * nothing returns the SAME reference, so the caller can tell "nothing
 * happened" (skip the write and the self-mutation window) from "invalid".
 */
function moveCollectionNode(tree, dragId, targetId, position) {
  const dest = resolveCollectionDrop(tree, dragId, targetId, position);
  if (!dest) return null;

  const found = findCollectionNode(tree, dragId);
  if (!found) return null;

  const sameParent = String(found.parentId === null || found.parentId === undefined ? '' : found.parentId)
                  === String(dest.parentId === null ? '' : dest.parentId);

  // Removing the dragged node shifts every later sibling left by one, so an
  // index past its old home has to come back by one.
  const shiftsBack = sameParent && dest.index > found.index;
  const finalIndex = shiftsBack ? dest.index - 1 : dest.index;

  if (sameParent && finalIndex === found.index) return tree;   // no-op

  const without = removeCollectionNodes(tree.nodes, dragId);
  if (!without) return null;

  const nodes = insertCollectionNodes(without, dest.parentId, finalIndex, found.node);
  if (!nodes) return null;

  return Object.assign({}, tree, { nodes });
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
/**
 * Two hand-picked palettes rather than one derived from the tokens: half of
 * the light set — sage, slate, rose — is dark enough to disappear against a
 * dark page, so the dark set substitutes lighter versions rather than reusing
 * them at a different alpha.
 */
const CONFETTI_PALETTE = {
  light: ['#c8713a', '#e8a070', '#5a7a62', '#8aaa92', '#5a6b7a', '#8a9baa', '#d4b896', '#b35a5a'],
  dark:  ['#e59a63', '#f0b98a', '#93b79d', '#bcd9c4', '#9ab0c4', '#b8cadb', '#e9e3da', '#d98c8c'],
};

function currentConfettiPalette() {
  const theme = (document.documentElement && document.documentElement.dataset)
    ? document.documentElement.dataset.theme
    : 'light';

  return CONFETTI_PALETTE[theme] || CONFETTI_PALETTE.light;
}

function shootConfetti(x, y) {
  const colors = currentConfettiPalette();

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
  plus:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>`,
  folder:  `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg>`,
  move:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4 12h14m0 0-5-5m5 5-5 5" /></svg>`,
  note:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h10" /></svg>`,
  code:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m9 8-4 4 4 4m6-8 4 4-4 4" /></svg>`,
  copy:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" /></svg>`,
  pencil:  `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" /></svg>`,
  trash:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>`,
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
        <button class="chip-action chip-collect" data-action="collect-tab" data-tab-id="${tab.id}" title="Collect into your library — leaves the tab open">
          ${ICONS.folder}
        </button>
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
    // The badge's own class already carries the amber colour and wash; the
    // inline copy it used to have was redundant AND pinned to the light
    // palette, so it stayed a dark-on-dark smudge in the dark theme.
    ? `<span class="open-tabs-badge">
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

  actionsHtml += renderGroupCollectBtn(group);

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
   COLLECTED TABS — rendering
   ---------------------------------------------------------------- */

/**
 * safeCollectionHref(url)
 *
 * Only a URL with a scheme we're willing to follow becomes a link. A
 * whitelist rather than a blacklist, so javascript:, data:, vbscript: and
 * chrome-extension: all fall out for free.
 *
 * The scheme-less case is the one that matters. A value like
 * `wsj/d2d_mem/mid-0901-1` would otherwise become <a href="wsj/…">, which on
 * chrome-extension://<id>/index.html resolves to a path *inside the
 * extension* — so clicking it either 404s or navigates the new-tab page away
 * and loses you the whole dashboard. Those entries render as plain text.
 *
 * Guessing a base URL would be worse than not linking: the app has no way to
 * know whether that value is a repo path, a task id or a note, and a
 * confidently wrong link is worse than an honest non-link.
 */
/**
 * isSafeHttpUrl(value)
 *
 * True only for http(s) — a whitelist, so javascript:, data:, vbscript: and
 * chrome-extension: all fall out for free. A collected entry is just text
 * somebody typed, so it can carry any scheme at all, and only one we're
 * willing to follow is allowed to reach an href on this page.
 */
function isSafeHttpUrl(value) {
  return /^https?:/i.test(String(value || '').trim());
}

/**
 * collectionLinkPrefixes()
 *
 * Personal mappings from a bare path prefix onto a base URL, read from
 * config.local.js:
 *
 *   const LOCAL_LINK_PREFIXES = { 'wsj/': 'https://tracker.internal/' };
 *
 * This is what turns entries like `wsj/d2d_mem/mid-0901-1` — stored without a
 * scheme because that's how they were copied — into real links. Sorted longest
 * prefix first so a more specific mapping wins.
 */
function collectionLinkPrefixes() {
  const configured = typeof LOCAL_LINK_PREFIXES !== 'undefined' ? LOCAL_LINK_PREFIXES : null;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return [];

  return Object.entries(configured)
    .filter(([prefix, base]) =>
      typeof prefix === 'string' && prefix &&
      typeof base === 'string' && /^https?:/i.test(base))
    .sort((a, b) => b[0].length - a[0].length);
}

function safeCollectionHref(url) {
  const raw = String(url || '').trim();
  if (isSafeHttpUrl(raw)) return raw;

  for (const [prefix, base] of collectionLinkPrefixes()) {
    if (!raw.startsWith(prefix)) continue;
    return base.replace(/\/+$/, '') + '/' + raw.slice(prefix.length).replace(/^\/+/, '');
  }

  return '';
}

/** A favicon, but only when there is one — manual entries have no tab behind them. */
function collectionFaviconHtml(node) {
  const src = usableFaviconUrl(node.favIconUrl);
  if (!src) return '';

  let host = '';
  try { host = new URL(node.url).hostname; } catch {}

  return `<img class="chip-favicon collection-favicon" src="${escapeHtml(src)}" alt="" width="14" height="14" loading="lazy" referrerpolicy="no-referrer" draggable="false" data-host="${escapeHtml(host)}">`;
}

/**
 * renderCollectionName(node, wrap)
 *
 * The name, or the rename field when this node is being edited. `wrap` lets a
 * link render its name as an anchor without needing a second code path.
 */
/**
 * renderCollectionMoveSelect(node)
 *
 * The "move to another group" control, which takes over the name slot the same
 * way the rename field does. Options come from collectionMoveTargets(), so an
 * invalid destination (the node itself, or anything inside it) is never
 * offered in the first place.
 */
function renderCollectionMoveSelect(node) {
  const found   = findCollectionNode(collectionTreeForRender, node.id);
  const current = (found && found.parentId !== null && found.parentId !== undefined)
    ? String(found.parentId) : '';

  const options = collectionMoveTargets(collectionTreeForRender, node.id)
    .map(target => {
      const selected = target.id === current ? ' selected' : '';
      return `<option value="${escapeHtml(target.id)}"${selected}>${escapeHtml(target.label)}</option>`;
    })
    .join('');

  return `<select class="collection-rename collection-move" id="collection-move-${escapeHtml(node.id)}" data-action="collection-edit-field" draggable="false" aria-label="Move to">${options}</select>`;
}

function renderCollectionName(node, cssClass) {
  if (editingCollectionNodeId === String(node.id)) {
    if (editingCollectionMode === 'move') return renderCollectionMoveSelect(node);

    // data-action on the field matters: it lives inside a clickable row, and
    // without its own action a click into it would be read as a click on the
    // row underneath — which on a link chip means opening the link.
    return `<input class="collection-rename" id="collection-rename-${escapeHtml(node.id)}" type="text" spellcheck="false" aria-label="Name" data-action="collection-edit-field" draggable="false" data-rename-session="${renameSession}" value="${escapeHtml(renameDraft)}">`;
  }

  // A nameless note or snippet shows its body instead of a title — the
  // first-line fallback would just repeat what's underneath it.
  const isBody = node.type === 'note' || node.type === 'snippet';
  if (isBody && !(node.name || '').trim()) return '';

  return `<span class="${cssClass}">${escapeHtml(displayCollectionName(node))}</span>`;
}

function renderCollectionRowActions(node) {
  const id = escapeHtml(node.id);
  const addHere = node.type === 'group'
    ? `<button class="collection-action" type="button" draggable="false" data-action="add-collection-here" data-node-id="${id}" title="Add a link to this group">${ICONS.plus}</button>`
    : '';

  return `<span class="collection-row-actions">
      ${addHere}<button class="collection-action" type="button" draggable="false" data-action="move-collection-node" data-node-id="${id}" title="Move to another group">${ICONS.move}</button><button class="collection-action" type="button" draggable="false" data-action="rename-collection-node" data-node-id="${id}" title="Rename">${ICONS.pencil}</button><button class="collection-action is-danger" type="button" draggable="false" data-action="delete-collection-node" data-node-id="${id}" title="Delete">${ICONS.trash}</button>
    </span>`;
}

/** "3 groups · 2 items" — the card's badge. */
function describeCollectionChildren(node) {
  const children = node.children || [];
  const groups = children.filter(c => c.type === 'group').length;
  const items  = children.filter(c => c.type !== 'group').length;

  const parts = [];
  if (groups) parts.push(`${groups} group${groups !== 1 ? 's' : ''}`);
  if (items)  parts.push(`${items} item${items !== 1 ? 's' : ''}`);
  return parts.join(' · ') || 'empty';
}

// Only top-level groups are coloured, cycling the same palette the Open tabs
// cards use for Chrome's own group colours. Deeper cards stay neutral so a
// nested one never competes with the card containing it.
const COLLECTION_COLOR_CYCLE = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'red', 'yellow', 'grey'];

function collectionDepthClass(depth) {
  if (depth === 0) return 'is-depth-0';
  if (depth === 1) return 'is-depth-1';
  return 'is-deep';
}

function renderCollectionNodes(nodes, depth, columns) {
  let groupIndex = 0;

  return (nodes || []).map(node => {
    if (node.type !== 'group') return renderCollectionItemChip(node, depth);

    const color = COLLECTION_COLOR_CYCLE[groupIndex % COLLECTION_COLOR_CYCLE.length];
    groupIndex++;
    return renderCollectionGroupNode(node, depth, color, columns);
  }).join('');
}

/**
 * renderCollectionGroupNode(node, depth, accentColor)
 *
 * A group IS a .mission-card — the very same class the Open tabs cards use, so
 * the card language (top accent bar, header, badge, chips) is shared rather
 * than reimplemented and the two sections can't drift apart.
 *
 * Depth only ever subtracts from that: first the shadow goes, then the top bar
 * becomes a side accent. Nesting is real containment, so nothing has to be
 * indented by hand.
 */
function renderCollectionGroupNode(node, depth, accentColor, columns) {
  const collapsed  = !!node.collapsed;
  const confirming = pendingDeleteId === String(node.id) ? ' is-confirming' : '';
  const colorAttr  = accentColor ? ` data-group-color="${accentColor}"` : '';

  // Only top-level cards live on the board, so only they get a span and a
  // resize edge. Nested cards stack inside their parent, and a span is clamped
  // to the columns that actually exist — span 4 in a 2-column grid would push
  // the card into an implicit column and break the layout.
  const onBoard = depth === 0;
  const span    = onBoard ? Math.min(normalizeCollectionSpan(node.span), columns) : 1;

  const spanAttr = onBoard ? ` style="--card-span:${span}" data-span="${span}"` : '';
  const dragAttr = onBoard ? ' draggable="true"' : '';
  // draggable="false" on the handle and the buttons below stops them from
  // starting a card drag: the drag looks for the nearest draggable ancestor, so
  // without this, grabbing a button would pick the card up instead.
  const resizeEdge = onBoard
    ? `<div class="collection-resize" data-action="resize-collection-card" data-node-id="${escapeHtml(node.id)}" title="Drag to resize" aria-hidden="true" draggable="false"></div>`
    : '';

  // Collapsing removes the children from the markup entirely rather than
  // hiding them: no visibility maths, nothing to keep in sync.
  const children = collapsed ? '' : renderCollectionChildren(node.children, depth, columns);

  return `
    <div class="mission-card collection-card ${collectionDepthClass(depth)}${collapsed ? ' is-collapsed' : ''}${confirming}" data-node-id="${escapeHtml(node.id)}" data-node-type="group" data-depth="${depth}" role="treeitem" aria-expanded="${!collapsed}" aria-level="${depth + 1}"${colorAttr}${spanAttr}${dragAttr}>
      <div class="mission-content">
        <div class="mission-top">
          <button class="card-collapse-toggle" type="button" data-action="toggle-collection-group" data-node-id="${escapeHtml(node.id)}" aria-label="${collapsed ? 'Expand' : 'Collapse'}">${ICONS.chevron}</button>
          ${renderCollectionName(node, 'mission-name')}
          <span class="open-tabs-badge">${ICONS.folder} ${describeCollectionChildren(node)}</span>
          ${renderCollectionRowActions(node)}
        </div>${children}
      </div>${resizeEdge}
    </div>`;
}

/**
 * renderGroupCollectBtn(group)
 *
 * The whole-group action, sitting at the right end of the action row rather
 * than up in the header — it belongs with the other thing you can do to the
 * entire group.
 *
 * Only real Chrome groups get one: the Ungrouped bucket isn't a unit you'd
 * file away.
 */
function renderGroupCollectBtn(group) {
  if (group.isUngrouped) return '';

  return `
      <button class="action-btn collect-group" type="button" data-action="collect-group-tabs" data-group-id="${group.id}" title="Collect this whole group into your library — leaves the tabs open">
        ${ICONS.folder} Collect
      </button>`;
}

/**
 * renderCollectionChildren(children, depth)
 *
 * Renders children in the order they were arranged. Links buffer into chip
 * rows; a subgroup flushes the buffer and emits a nested card — so a link
 * sitting between two subgroups keeps its place instead of being sorted to
 * one end of its parent.
 */
function renderCollectionChildren(children, depth, columns) {
  const out = [];
  let chips = [];

  const flush = () => {
    if (!chips.length) return;
    out.push(`<div class="mission-pages">${chips.join('')}</div>`);
    chips = [];
  };

  for (const child of children || []) {
    // Test for a group, not for a link: there are four node kinds, and writing
    // `=== 'link'` here silently rendered notes and snippets as group cards.
    if (child.type === 'group') {
      flush();
      out.push(renderCollectionGroupNode(child, depth + 1, null, columns));
    } else {
      // depth+1: a child of a depth-N group is at depth N+1, same as a nested
      // group. Passing the parent's depth here made every chip in a top-level
      // group claim to be a top-level tile.
      chips.push(renderCollectionItemChip(child, depth + 1));
    }
  }
  flush();

  return `<div class="collection-children">${out.join('')}</div>`;
}

/**
 * renderCollectionItemChip(node)
 *
 * A link is a .page-chip — the same element a tab is inside an Open tabs card,
 * so the whole page has one list idiom.
 *
 * It's a div with a click action rather than an <a href>, for the same reason
 * the tab chips are: the row contains buttons, and a button inside an anchor
 * is invalid markup.
 */
const COLLECTION_STATUS_META = {
  todo:    { label: 'To do',   className: 'is-todo' },
  doing:   { label: 'Doing',   className: 'is-doing' },
  done:    { label: 'Done',    className: 'is-done' },
  dropped: { label: 'Dropped', className: 'is-dropped' },
};

// Clicking the dot walks this; '' (no status) is part of the cycle
const COLLECTION_STATUS_ORDER = ['', 'todo', 'doing', 'done', 'dropped'];

function renderCollectionStatus(node) {
  if (node.type === 'group') return '';

  const status = normalizeCollectionStatus(node.status);
  const meta   = COLLECTION_STATUS_META[status];

  return `<button class="collection-status${meta ? ` ${meta.className}` : ''}" type="button" draggable="false" data-action="cycle-collection-status" data-node-id="${escapeHtml(node.id)}" data-status="${status}" title="${meta ? `${meta.label} — click to change` : 'No status — click to set one'}" aria-label="${meta ? meta.label : 'No status'}"></button>`;
}

function collectionItemIcon(node) {
  if (node.type === 'note')    return `<span class="chip-icon" aria-hidden="true">${ICONS.note}</span>`;
  if (node.type === 'snippet') return `<span class="chip-icon" aria-hidden="true">${ICONS.code}</span>`;
  return collectionFaviconHtml(node);
}

/** Notes and snippets carry a body; a link doesn't. */
function renderCollectionBody(node) {
  if (node.type === 'note') {
    return `<div class="collection-note">${escapeHtml(node.text)}</div>`;
  }

  if (node.type === 'snippet') {
    const language = (node.language || '').trim();
    return `<div class="collection-snippet">${language ? `<span class="collection-lang">${escapeHtml(language)}</span>` : ''}<pre class="collection-code">${escapeHtml(node.code)}</pre></div>`;
  }

  return '';
}

/**
 * renderCollectionItemChip(node)
 *
 * Every leaf — link, note or snippet — is a .page-chip, the same element a tab
 * is inside an Open tabs card, so the page keeps one list idiom. What differs
 * is the icon, the body, and what clicking the row does.
 */
function renderCollectionItemChip(node, depth) {
  const href = node.type === 'link' ? safeCollectionHref(node.url) : '';
  const confirming = pendingDeleteId === String(node.id) ? ' is-confirming' : '';

  // A click opens the row if we can resolve an address, and copies it if we
  // can't. A bare path is a perfectly good entry — it just isn't a link, and
  // it must not become a relative one (see safeCollectionHref).
  const value  = collectionNodeValue(node);
  const action = href ? ' data-action="open-collection-link"'
                      : ' data-action="copy-collection-node"';
  const hint   = href || value || displayCollectionName(node);

  return `<div class="page-chip ${href ? 'clickable' : 'is-copyable'}${confirming}"${action} data-node-id="${escapeHtml(node.id)}" data-node-type="${escapeHtml(node.type)}" data-depth="${depth}" title="${escapeHtml(hint)}">
      ${collectionItemIcon(node)}
      <div class="collection-item-main">
        ${renderCollectionName(node, 'chip-text')}
        ${renderCollectionBody(node)}
      </div>
      ${renderCollectionStatus(node)}
      <div class="chip-actions">
        <button class="chip-action" type="button" draggable="false" data-action="copy-collection-node" data-node-id="${escapeHtml(node.id)}" title="Copy${node.type === 'link' ? ' this address' : ''}">${ICONS.copy}</button>
        <button class="chip-action" type="button" draggable="false" data-action="rename-collection-node" data-node-id="${escapeHtml(node.id)}" title="Rename">${ICONS.pencil}</button>
        <button class="chip-action chip-delete" type="button" draggable="false" data-action="delete-collection-node" data-node-id="${escapeHtml(node.id)}" title="Delete">${ICONS.trash}</button>
      </div>
    </div>`;
}

/**
 * renderCollectionTargets(tree, selectEl)
 *
 * Rebuilds the "Add to" options: every group, depth-first, labelled with its
 * path. Uses the literal U+00A0 for indent — HTML collapses ordinary spaces
 * inside <option>, and &nbsp; is not interpreted there either.
 *
 * A native <select> is the right control here: Chrome renders the open
 * dropdown as an OS-level popup, so a live-sync rewrite of the page doesn't
 * slam it shut mid-selection the way a custom menu would.
 */
function renderCollectionTargets(tree, selectEl) {
  if (!selectEl) return;

  const groups = flattenCollectionTree(tree).filter(entry => entry.type === 'group');

  const options = ['<option value="">Top level</option>'].concat(
    groups.map((group) => {
      const indent = "\u00A0\u00A0".repeat(group.depth);
      const label  = group.path.length > 60 ? `… / ${group.path.slice(-56)}` : group.path;
      return `<option value="${escapeHtml(group.id)}">${indent}${escapeHtml(label)}</option>`;
    })
  ).join('');

  setHTML(selectEl, options);

  // The remembered target may have been deleted (here or in another window).
  // Re-resolve against the tree we just read rather than trusting the id.
  const stillExists = groups.some(group => String(group.id) === String(collectTargetId));
  collectTargetId = stillExists ? String(collectTargetId) : '';
  selectEl.value = collectTargetId;
}

async function renderCollectionSection() {
  // A drag or a resize is in flight. Rewriting the tree now would detach the
  // very elements the gesture is holding — the drop targets, or the handle the
  // pointer is captured on.
  if (collectionDragActive || collectionResize) return;

  const treeEl   = document.getElementById('collectedTree');
  const countEl  = document.getElementById('collectionsCount');
  const emptyEl  = document.getElementById('collectionsEmpty');
  const selectEl = document.getElementById('collectTargetSelect');
  if (!treeEl) return;

  let tree;
  try {
    tree = await getCollections();
  } catch (err) {
    console.warn('[tab-out] Could not load collections:', err);
    return;
  }

  // The renderers below read this to build the "move to" options — the whole
  // tree, so a filter doesn't change where a node can be moved to
  collectionTreeForRender = tree;

  const filtered = filterCollectionTree(tree, collectionQuery, collectionStatusFilter);

  const counts = countCollectionNodes(filtered);
  setHTML(countEl, (counts.groups + counts.items) > 0
    ? `${counts.groups} group${counts.groups !== 1 ? 's' : ''} · ${counts.items} item${counts.items !== 1 ? 's' : ''}`
    : '');

  const columns = collectionColumnCount();
  setHTML(treeEl, `<div class="collection-board" style="--collection-columns:${columns}">${renderCollectionNodes(filtered.nodes, 0, columns)}</div>`);

  // Same task as the write above, deliberately: reading layout back forces the
  // browser to lay out before it paints, so the row spans are already right by
  // the time anything appears on screen and nothing visibly settles.
  layoutCollectionBoard();

  // Unlike the saved-for-later column, the section itself never hides: the
  // toolbar is the only way to add the first link.
  const filtering = !!(collectionQuery.trim() || collectionStatusFilter);
  const showing   = filtered.nodes.length;

  if (treeEl.style) treeEl.style.display = showing ? 'block' : 'none';
  if (emptyEl) {
    if (emptyEl.style) emptyEl.style.display = showing ? 'none' : 'block';
    emptyEl.textContent = filtering
      ? 'Nothing matches that filter.'
      : 'Nothing collected yet. Paste a link above, or hit the folder icon on any tab.';
  }

  renderCollectionTargets(tree, selectEl);
}

/**
 * layoutCollectionBoard()
 *
 * Gives every top-level card a row span that matches its content height, so
 * the board packs cards tightly instead of leaving a hole under each short
 * one. This is what lets the board be a grid (and therefore support columns
 * that cards can span) without giving up the tight stacking.
 *
 * Cards are align-items: start, so a card's measured height is its content
 * height whatever span it currently has — re-measuring an already-spanned card
 * gives the same number back rather than ratcheting.
 */
function layoutCollectionBoard() {
  // Every direct child, not just the group cards: a leaf sitting loose at the
  // top level is a board tile too, and without a row span it would sit in an
  // 8px row and overlap its neighbours.
  const tiles = document.querySelectorAll('.collection-board > *');
  if (!tiles || !tiles.length) return;

  for (const card of tiles) {
    const rect = card.getBoundingClientRect ? card.getBoundingClientRect() : null;
    if (!rect || !rect.height) continue;

    const rows = collectionRowSpan(rect.height, COLLECTION_ROW_UNIT, COLLECTION_BOARD_GAP);
    if (card.style && typeof card.style.setProperty === 'function') {
      card.style.setProperty('--row-span', rows);
    }
  }
}

/**
 * restoreCollectionRenameFocus()
 *
 * Called at the end of every render. Most renders don't touch the rename field
 * at all — setHTML skips the DOM write when the markup is byte-identical, and
 * "node X is being renamed" being the only thing that changed produces exactly
 * that. This only matters for the renders that DID rewrite the tree (another
 * tab opened, a title changed), where the field was replaced underneath you.
 */
function restoreCollectionRenameFocus() {
  if (!editingCollectionNodeId) return;

  const fieldId = editingCollectionMode === 'move'
    ? `collection-move-${editingCollectionNodeId}`
    : `collection-rename-${editingCollectionNodeId}`;

  const field = document.getElementById(fieldId);
  if (!field || typeof field.focus !== 'function') return;
  if (document.activeElement === field) return;   // already focused; leave it alone

  field.focus();

  // Only the text field has a caret to put back
  if (editingCollectionMode !== 'rename') return;
  const caret = renameCaret == null ? String(field.value || '').length : renameCaret;
  if (typeof field.setSelectionRange === 'function') field.setSelectionRange(caret, caret);
}

function isCollectionRenameField(el) {
  return !!(el && typeof el.id === 'string' && el.id.startsWith('collection-rename-'));
}


/* ----------------------------------------------------------------
   COLLECTED TABS — interactions

   These are driven from the one delegated click handler, and read the node id
   off the clicked element's own dataset rather than walking up the DOM. That
   keeps each button unambiguous no matter how the row markup is nested.
   ---------------------------------------------------------------- */

const COLLECTION_MOVE_PREFIX = 'collection-move-';

function isCollectionMoveField(el) {
  return !!(el && typeof el.id === 'string' && el.id.startsWith(COLLECTION_MOVE_PREFIX));
}

/**
 * finishPendingCollectionEdit()
 *
 * Called before opening a different editor. A rename in progress is committed —
 * that's what clicking away from it normally does — while a move in progress is
 * simply dropped, since there's nothing half-typed to keep.
 */
async function finishPendingCollectionEdit() {
  if (!editingCollectionNodeId) return;
  if (editingCollectionMode === 'rename') await commitCollectionRename();
  else cancelCollectionRename();
}

async function beginCollectionRename(id) {
  const nodeId = String(id || '');
  if (!nodeId) return;

  await finishPendingCollectionEdit();

  const tree  = await getCollections();
  const found = findCollectionNode(tree, nodeId);
  if (!found) {
    await renderCollectionSection();
    return;
  }

  pendingDeleteId = null;
  editingCollectionNodeId = nodeId;
  editingCollectionMode = 'rename';
  renameDraft = found.node.name || '';
  renameCaret = null;              // open with the caret at the end
  renameSession++;

  await renderCollectionSection();
  restoreCollectionRenameFocus();
}

/**
 * beginCollectionMove(id)
 *
 * Opens the "move to" select in place of the node's name. Reuses the rename
 * machinery deliberately: same slot, same session token, same single editor
 * at a time — only the control and the commit differ.
 */
async function beginCollectionMove(id) {
  const nodeId = String(id || '');
  if (!nodeId) return;

  await finishPendingCollectionEdit();

  const tree  = await getCollections();
  const found = findCollectionNode(tree, nodeId);
  if (!found) {
    await renderCollectionSection();
    return;
  }

  // Only "Top level" on offer, and it's already there
  if (collectionMoveTargets(tree, nodeId).length === 1 && found.parentId === null) {
    showToast('There is nowhere else to move that yet');
    return;
  }

  pendingDeleteId = null;
  editingCollectionNodeId = nodeId;
  editingCollectionMode = 'move';
  renameDraft = '';
  renameCaret = null;
  renameSession++;

  await renderCollectionSection();
}

/**
 * commitCollectionReparent(nodeId, parentId)
 *
 * Applies a "move to" choice. A pick that resolves to where the node already
 * is changes nothing and — because reparentCollectionNode returns the same
 * tree — writes nothing and says nothing.
 */
async function commitCollectionReparent(nodeId, parentId) {
  renameSession++;                 // any focusout still in flight is now stale
  editingCollectionNodeId = null;
  editingCollectionMode = 'rename';
  renameDraft = '';
  renameCaret = null;

  noteSelfMutation();

  let moved = false;
  await queueCollectionWrite(tree => {
    const next = reparentCollectionNode(tree, nodeId, parentId);
    if (!next || next === tree) return tree;
    moved = true;
    return next;
  });

  if (moved) {
    const tree = await getCollections();
    const path = parentId ? collectionPathOf(tree, parentId) : '';
    showToast(path ? `Moved into ${path}` : 'Moved to the top level');
  }

  await renderCollectionSection();
}

async function commitCollectionRename() {
  const id = editingCollectionNodeId;
  if (!id) return;
  if (editingCollectionMode !== 'rename') return;   // a move has nothing half-typed

  const draft = renameDraft.trim();

  // Bump the session first: our own re-render is about to fire focusout, and
  // the token is what turns that echo into a no-op.
  renameSession++;
  editingCollectionNodeId = null;
  renameDraft = '';
  renameCaret = null;

  // An empty name is treated as a cancel — a nameless node can't be told apart
  // in the "Add to" list. An unchanged name writes nothing at all, so clicking
  // in and back out doesn't fire a pointless storage event.
  if (draft) {
    const tree  = await getCollections();
    const found = findCollectionNode(tree, id);
    if (found && (found.node.name || '') !== draft) {
      noteSelfMutation();
      await queueCollectionWrite(current => renameCollectionNode(current, id, draft));
    }
  }

  await renderCollectionSection();
  restoreCollectionRenameFocus();
}

function cancelCollectionRename() {
  if (!editingCollectionNodeId) return;

  renameSession++;                 // discard any focusout still in flight
  editingCollectionNodeId = null;
  editingCollectionMode = 'rename';
  renameDraft = '';
  renameCaret = null;
  renderCollectionSection();
}

/**
 * syncCollectionToolbar()
 *
 * Keeps the toolbar's static markup in step with the chosen kind. The toolbar
 * is never rewritten by a render (that's what keeps its fields typable through
 * a live-sync pass), so this has to be called deliberately.
 */
function syncCollectionToolbar() {
  const kindEl  = document.getElementById('collectKindSelect');
  const valueEl = document.getElementById('collectUrlInput');
  const langEl  = document.getElementById('collectLanguageInput');

  const kind = kindEl ? String(kindEl.value || 'link') : 'link';

  // The language only means anything for a snippet
  if (langEl && langEl.style) langEl.style.display = kind === 'snippet' ? '' : 'none';

  if (valueEl) {
    valueEl.placeholder = kind === 'note'    ? 'Write a note…'
                        : kind === 'snippet' ? 'Paste the code or command…'
                        : 'Paste a link, or a path…';
  }
}

/**
 * addCollectedFromToolbar()
 *
 * Adds whatever the toolbar is set to: a link (or a bare path), a note, or a
 * snippet. For links, several pasted lines become several entries — pasting a
 * list of run paths in one go is the case worth optimising for.
 *
 * An entry whose value is already in the collection is still added, but the
 * toast names where it already lives, rather than the library silently growing
 * duplicates.
 */
async function addCollectedFromToolbar() {
  const kindEl  = document.getElementById('collectKindSelect');
  const valueEl = document.getElementById('collectUrlInput');
  const nameEl  = document.getElementById('collectNameInput');
  const langEl  = document.getElementById('collectLanguageInput');
  if (!valueEl) return;

  const kind  = kindEl ? String(kindEl.value || 'link') : 'link';
  const value = String(valueEl.value || '').trim();
  if (!value) {
    if (typeof valueEl.focus === 'function') valueEl.focus();
    return;
  }

  const name     = nameEl ? String(nameEl.value || '').trim() : '';
  const language = langEl ? String(langEl.value || '').trim() : '';

  // collectTargetId, not the select's DOM value: the render WRITES that
  // element from this variable, so reading it back would make the element a
  // second source of truth that can disagree with the first.
  const target = collectTargetId;

  // Only links split on newlines — a note or a snippet is one multi-line entry
  const lines = kind === 'link'
    ? value.split('\n').map(line => line.trim()).filter(Boolean)
    : [value];

  const at = new Date().toISOString();

  pendingDeleteId = null;
  noteSelfMutation();

  let added = 0;
  let landedAt = '';
  let alreadyThere = '';

  await queueCollectionWrite(tree => {
    // Re-resolve the destination against the tree we just read: it may have
    // been deleted, here or in another window. Anything headed for the top
    // level gets an auto-named group instead.
    const wrapped = collectionWrapTopLevel(tree, target, kind);
    const wanted  = wrapped.parentId;

    let next = wrapped.tree;
    for (const line of lines) {
      if (!alreadyThere) {
        const duplicates = findCollectionDuplicates(next, line);
        if (duplicates.length) alreadyThere = duplicates[0].path;
      }

      // A paste of several lines doesn't get one shared name
      const shared = { name: lines.length === 1 ? name : '', groupId: wanted, addedAt: at };

      const result = kind === 'note'
        ? addCollectionNote(next, Object.assign({ text: line }, shared))
        : kind === 'snippet'
          ? addCollectionSnippet(next, Object.assign({ code: line, language }, shared))
          : addCollectionLink(next, Object.assign({ url: line }, shared));

      if (!result) continue;
      next = result.tree;
      added++;
      if (!landedAt) landedAt = wanted ? collectionPathOf(result.tree, wanted) : '';
    }

    return next === tree ? tree : next;
  });

  if (!added) {
    showToast('Nothing to add');
    return;
  }

  valueEl.value = '';
  if (nameEl) nameEl.value = '';
  // The kind, destination and language are kept on purpose, so filing a run of
  // similar entries is type, Enter, type, Enter.
  syncCollectionToolbar();

  const where = landedAt ? ` to ${landedAt}` : '';
  showToast(alreadyThere
    ? `Added ${added}${where} · already in ${alreadyThere}`
    : `Added ${added}${where}`);

  await renderCollectionSection();
}

/**
 * copyCollectionNode(nodeId)
 *
 * Copies a leaf's stored value. This is the whole point of a path-shaped
 * entry: `wsj/d2d_mem/mid-0901-1` isn't a link, but it is exactly what you
 * want on the clipboard.
 */
async function copyCollectionNode(nodeId) {
  const tree  = await getCollections();
  const found = findCollectionNode(tree, nodeId);
  if (!found) return;

  const value = collectionNodeValue(found.node);
  if (!value) {
    showToast('Nothing to copy');
    return;
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) {
    showToast('The clipboard is not available here');
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    showToast('Copied');
  } catch (err) {
    console.warn('[tab-out] Could not write to the clipboard:', err);
    showToast('Could not copy');
  }
}

/**
 * collectGroupIntoCollection(groupId)
 *
 * Files a whole Chrome tab group into the collection as one subgroup, with a
 * link per tab — the tree equivalent of "collect this tab", for when you're
 * done with a thread of work and want the whole thing recorded.
 *
 * The tabs are not closed, same as collecting a single one.
 */
async function collectGroupIntoCollection(groupId) {
  const tabs = await tabsInGroup(groupId);
  if (!tabs.length) {
    showToast('That group has no tabs left to collect');
    return;
  }

  const chromeGroups = await fetchChromeGroups();
  const chromeGroup  = chromeGroups.find(group => group.id === groupId);
  const name = (chromeGroup && chromeGroup.title) || 'Collected group';

  pendingDeleteId = null;
  noteSelfMutation();

  const at = new Date().toISOString();
  let landedAt = '';
  let collected = 0;

  await queueCollectionWrite(tree => {
    const wanted = collectTargetId && findCollectionNode(tree, collectTargetId) ? collectTargetId : null;

    const created = addCollectionGroup(tree, { name, parentId: wanted });
    if (!created) return tree;

    let next = created.tree;
    for (const tab of tabs) {
      const result = addCollectionLink(next, {
        url: tab.url,
        name: tab.title || tab.url,
        groupId: created.id,
        favIconUrl: tab.favIconUrl || '',
        addedAt: at,
      });
      if (!result) continue;
      next = result.tree;
      collected++;
    }

    landedAt = wanted ? collectionPathOf(next, wanted) : '';
    return next;
  });

  const where = landedAt ? ` into ${landedAt}` : '';
  showToast(`Collected ${collected} tab${collected !== 1 ? 's' : ''}${where}`);
  await renderCollectionSection();
}

/** Turns the handful of entities a clipboard fragment carries back into text. */
function decodeCollectionText(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    // last, so a literal "&amp;lt;" doesn't come out as "<"
    .replace(/&amp;/gi, '&');
}

/**
 * extractFirstHyperlink(html)
 *
 * Pulls the first anchor out of a clipboard's text/html flavour — the one that
 * survives a copy from a document or a chat window, where the plain-text
 * flavour has already dropped the address and left only the words.
 *
 * Returns { url, text } or null.
 *
 * Deliberately a strict regex rather than DOMParser: the input is one
 * clipboard fragment, the shape we accept is one anchor, and keeping this a
 * pure function is what makes it testable at all — the harness has no parser.
 */
function extractFirstHyperlink(html) {
  const source = String(html || '');
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/i.exec(source);
  if (!anchor) return null;

  const url  = decodeCollectionText(anchor[1]).trim();
  const text = decodeCollectionText(anchor[2].replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

  return url ? { url, text } : null;
}

/** Steps a leaf's status round the cycle, including back to none. */
async function cycleCollectionStatus(nodeId) {
  const tree  = await getCollections();
  const found = findCollectionNode(tree, nodeId);
  if (!found || found.node.type === 'group') return;

  const current = normalizeCollectionStatus(found.node.status);
  const next    = COLLECTION_STATUS_ORDER[
    (COLLECTION_STATUS_ORDER.indexOf(current) + 1) % COLLECTION_STATUS_ORDER.length];

  pendingDeleteId = null;
  noteSelfMutation();
  await queueCollectionWrite(current => setCollectionNodeStatus(current, nodeId, next));
  await renderCollectionSection();
}

async function addCollectedGroupFromToolbar() {
  const target = collectTargetId;

  pendingDeleteId = null;
  noteSelfMutation();

  let newId = null;
  await queueCollectionWrite(tree => {
    const wanted = target && findCollectionNode(tree, target) ? target : null;
    const result = addCollectionGroup(tree, { name: '', parentId: wanted });
    if (!result) return tree;
    newId = result.id;
    return result.tree;
  });

  // Straight into rename mode, so you can just type the name
  if (newId) await beginCollectionRename(newId);
  else       await renderCollectionSection();
}

async function toggleCollectionGroup(id) {
  const nodeId = String(id || '');
  pendingDeleteId = null;
  noteSelfMutation();

  await queueCollectionWrite(tree => {
    const found = findCollectionNode(tree, nodeId);
    if (!found || found.node.type !== 'group') return tree;
    return setCollectionNodeCollapsed(tree, nodeId, !found.node.collapsed);
  });

  await renderCollectionSection();
}

async function deleteCollectionNodeById(id) {
  const nodeId = String(id || '');
  if (!nodeId) return;

  // One click arms, a second confirms — a group takes its whole subtree with
  // it, and this has to survive being triggered by a mis-click.
  if (pendingDeleteId !== nodeId) {
    pendingDeleteId = nodeId;
    showToast('Click the bin again to delete that group and everything inside it');
    await renderCollectionSection();
    return;
  }

  pendingDeleteId = null;
  noteSelfMutation();
  await queueCollectionWrite(tree => deleteCollectionNode(tree, nodeId));

  showToast('Deleted');
  await renderCollectionSection();
}

/**
 * collectTabIntoCollection(tabId, chipEl)
 *
 * Files an open tab into the collection, and deliberately leaves the tab
 * open: collecting is filing something away for later, not clearing it out of
 * the way. The X next to it is still how you close it.
 *
 * The destination is re-resolved against the freshly-read tree, exactly like
 * addCollectedFromToolbar — the chosen group may have been deleted here or
 * in another window since the select was last drawn.
 */
async function collectTabIntoCollection(tabId, chipEl) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return;

  let tab;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    showToast('That tab is already gone');
    await renderDashboard();
    return;
  }

  // The label we actually displayed, same as the save-for-later path — it has
  // already had notification counts and email addresses stripped out of it.
  const chipText = chipEl && chipEl.querySelector ? chipEl.querySelector('.chip-text') : null;
  const name = (chipText && chipText.textContent) || tab.title || tab.url || '';

  pendingDeleteId = null;
  noteSelfMutation();

  let landedAt = '';
  await queueCollectionWrite(tree => {
    const wrapped = collectionWrapTopLevel(tree, collectTargetId, 'link');
    const wanted  = wrapped.parentId;

    const result = addCollectionLink(wrapped.tree, {
      url:        tab.url,
      name,
      groupId:    wanted,
      favIconUrl: tab.favIconUrl || '',
      addedAt:    new Date().toISOString(),
    });
    if (!result) return tree;

    landedAt = wanted ? collectionPathOf(result.tree, wanted) : '';
    return result.tree;
  });

  showToast(landedAt ? `Collected into ${landedAt}` : 'Collected at the top level');
  await renderCollectionSection();
}

/**
 * openCollectionLink(nodeId)
 *
 * Opens a collected link in a new tab. chrome.tabs.create rather than an
 * <a href>, because the chip has to hold its own buttons and a button nested
 * inside an anchor is invalid markup — same reason the tab chips work this way.
 */
async function openCollectionLink(nodeId) {
  const tree  = await getCollections();
  const found = findCollectionNode(tree, nodeId);
  if (!found) return;

  const href = safeCollectionHref(found.node.url);
  if (!href) {
    showToast('That entry has no link to open');
    return;
  }

  await chrome.tabs.create({ url: href });
}

/* ---- resizing a card by its right edge ---- */

/**
 * commitCollectionSpan(nodeId, span)
 *
 * Kept apart from the pointer handling so the part that matters — clamping,
 * persistence — is testable without a layout engine.
 */
async function commitCollectionSpan(nodeId, span) {
  noteSelfMutation();
  await queueCollectionWrite(tree => setCollectionNodeSpan(tree, nodeId, span));
  await renderCollectionSection();
}

function beginCollectionResize(event, handleEl) {
  const card  = handleEl && handleEl.closest ? handleEl.closest('.collection-card') : null;
  const board = card && card.parentElement;
  if (!card || !board) return;

  const cardRect  = card.getBoundingClientRect();
  const boardRect = board.getBoundingClientRect();
  const columns   = collectionColumnCount();
  const gap       = COLLECTION_BOARD_GAP;

  const span = normalizeCollectionSpan(card.dataset.span);
  collectionResize = {
    el: card,
    nodeId: String(card.dataset.nodeId),
    originalSpan: span,
    span,
    startX: Number(event.clientX) || 0,
    startWidth: cardRect.width,
    // The width one column occupies, gaps taken out
    colUnit: (boardRect.width - gap * (columns - 1)) / columns,
    gap,
    columns,
  };

  if (event.pointerId !== undefined && handleEl.setPointerCapture) {
    try { handleEl.setPointerCapture(event.pointerId); } catch {}
  }
}

function updateCollectionResize(event) {
  const gesture = collectionResize;
  if (!gesture) return;

  const span = collectionSpanFromDrag(
    gesture.startWidth,
    (Number(event.clientX) || 0) - gesture.startX,
    gesture.colUnit, gesture.gap, gesture.columns);

  if (span === gesture.span) return;
  gesture.span = span;

  // Resize the live element instead of re-rendering: a re-render would
  // replace the very handle the pointer is captured on, ending the gesture.
  if (gesture.el.style && typeof gesture.el.style.setProperty === 'function') {
    gesture.el.style.setProperty('--card-span', span);
  }
}

async function endCollectionResize() {
  const gesture = collectionResize;
  collectionResize = null;
  if (!gesture) return;
  if (gesture.span === gesture.originalSpan) return;   // never moved: no write
  await commitCollectionSpan(gesture.nodeId, gesture.span);
}

/* ---- reordering the board ---- */

/**
 * commitCollectionMove(dragId, targetId, position)
 *
 * Reorders the board. Kept apart from the drag events for the same reason as
 * the span commit: the DOM half is thin, the state half is what can be wrong.
 *
 * Returns whether anything actually moved.
 */
async function commitCollectionMove(dragId, targetId, position) {
  if (!dragId || !targetId || dragId === targetId) return false;

  noteSelfMutation();
  let moved = false;

  await queueCollectionWrite(tree => {
    const next = moveCollectionNode(tree, dragId, targetId, position);
    // null = refused (e.g. a cycle); same reference = a no-op worth no write
    if (!next || next === tree) return tree;
    moved = true;
    return next;
  });

  if (moved) await renderCollectionSection();
  return moved;
}

function markCollectionDropTarget(card, position) {
  document.querySelectorAll('.collection-card.is-drop-before, .collection-card.is-drop-after').forEach(el => {
    if (el !== card) el.classList.remove('is-drop-before', 'is-drop-after');
  });

  card.classList.toggle('is-drop-before', position === 'before');
  card.classList.toggle('is-drop-after',  position === 'after');
}

function finishCollectionDrag() {
  collectionDragActive = false;
  collectionDragId = null;
  document.querySelectorAll('.collection-card.is-drop-before, .collection-card.is-drop-after')
    .forEach(el => el.classList.remove('is-drop-before', 'is-drop-after'));
}

/** Point new links at a particular group (the "+" on a group row). */
async function selectCollectionTarget(id) {
  collectTargetId = String(id || '');
  pendingDeleteId = null;

  const selectEl = document.getElementById('collectTargetSelect');
  if (selectEl) selectEl.value = collectTargetId;

  const urlEl = document.getElementById('collectUrlInput');
  if (urlEl && typeof urlEl.focus === 'function') urlEl.focus();

  const tree = await getCollections();
  const path = collectionPathOf(tree, collectTargetId);
  showToast(path ? `New links go to ${path}` : 'New links go to the top level');
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
    // Saved tabs and collections live in chrome.storage, not chrome.tabs —
    // they're still worth showing even when the tab list can't be read.
    await renderDeferredColumn();
    await renderCollectionSection();
    restoreCollectionRenameFocus();
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

  // --- Render the collected-links library ---
  await renderCollectionSection();
  restoreCollectionRenameFocus();
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
   THEME — light, dark, or whatever the system says

   The preference lives in localStorage rather than chrome.storage.local,
   because theme.js has to read it synchronously before the first paint:
   chrome.storage is async, and a new tab page created constantly can't afford
   to flash the wrong theme every time. This file owns it from first paint on;
   theme.js only had to get that first frame right.
   ---------------------------------------------------------------- */

const THEME_STORAGE_KEY = 'tab-out-theme';
const THEME_CHOICES     = ['light', 'system', 'dark'];
const THEME_BUTTON_IDS  = [['themeLight', 'light'], ['themeSystem', 'system'], ['themeDark', 'dark']];

function normalizeThemeChoice(value) {
  return THEME_CHOICES.includes(value) ? value : 'system';
}

function systemPrefersDark() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    return false;
  }
}

/**
 * resolveThemeChoice(choice)
 *
 * The concrete light/dark the stylesheet gets — it never hears about "system",
 * which is what keeps the dark tokens defined in exactly one place.
 */
function resolveThemeChoice(choice) {
  if (choice === 'dark')  return 'dark';
  if (choice === 'light') return 'light';
  return systemPrefersDark() ? 'dark' : 'light';
}

function applyThemeChoice(choice) {
  const wanted   = normalizeThemeChoice(choice);
  const resolved = resolveThemeChoice(wanted);

  if (document.documentElement && document.documentElement.dataset) {
    document.documentElement.dataset.theme = resolved;
  }

  // The buttons report which CHOICE is active, not which colour happens to be
  // showing: "following the system" and "set to dark, and so is the system"
  // are different states and should look different.
  for (const [id, value] of THEME_BUTTON_IDS) {
    const button = document.getElementById(id);
    if (button && button.setAttribute) {
      button.setAttribute('aria-pressed', String(value === wanted));
    }
  }

  return resolved;
}

function readThemeChoice() {
  try {
    return normalizeThemeChoice(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function setThemeChoice(choice) {
  const wanted = normalizeThemeChoice(choice);

  applyThemeChoice(wanted);

  try { localStorage.setItem(THEME_STORAGE_KEY, wanted); } catch {}

  return wanted;
}

// The system preference can change while a dashboard is open. Follow it live,
// but only while it's what the preference actually says.
if (typeof window !== 'undefined' && window && window.matchMedia) {
  try {
    const query    = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readThemeChoice() === 'system') applyThemeChoice('system');
    };

    if (query.addEventListener)  query.addEventListener('change', onChange);
    else if (query.addListener)  query.addListener(onChange);   // older Chrome
  } catch {}
}

// A theme changed in another Tab Out page should carry over to this one
if (typeof window !== 'undefined' && window && window.addEventListener) {
  window.addEventListener('storage', (e) => {
    if (!e || e.key !== THEME_STORAGE_KEY) return;
    applyThemeChoice(normalizeThemeChoice(e.newValue));
  });
}


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

  // ---- Theme ----
  if (action === 'set-theme') {
    setThemeChoice(actionEl.dataset.themeChoice);
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    if (closeNeedsConfirmation('close-tabout-dupes',
        'Click again to close the other Tab Out tabs', actionEl)) return;

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

    if (closeNeedsConfirmation(`close-group-tabs:${groupId}`,
        `Click again to close all ${tabs.length} tab${tabs.length !== 1 ? 's' : ''} in ${labelText}`,
        actionEl)) return;

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

    if (closeNeedsConfirmation(`dedup-keep-one:${groupId}`,
        'Click again to close the duplicate tabs', actionEl)) return;

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
    if (closeNeedsConfirmation('close-all-open-tabs',
        'Click again to close every tab', actionEl)) return;

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

  // ---- Collected tabs ----
  if (action === 'collect-tab')             { await collectTabIntoCollection(actionEl.dataset.tabId, actionEl.closest('.page-chip')); return; }
  if (action === 'open-collection-link')    { await openCollectionLink(actionEl.dataset.nodeId); return; }
  if (action === 'add-collection-link')     { await addCollectedFromToolbar();  return; }
  if (action === 'add-collection-group')    { await addCollectedGroupFromToolbar(); return; }
  if (action === 'add-collection-here')     { await selectCollectionTarget(actionEl.dataset.nodeId); return; }
  if (action === 'toggle-collection-group') { await toggleCollectionGroup(actionEl.dataset.nodeId);  return; }
  if (action === 'rename-collection-node')  { await beginCollectionRename(actionEl.dataset.nodeId);  return; }
  if (action === 'move-collection-node')    { await beginCollectionMove(actionEl.dataset.nodeId);    return; }
  if (action === 'copy-collection-node')    { await copyCollectionNode(actionEl.dataset.nodeId);     return; }
  if (action === 'collect-group-tabs')      { await collectGroupIntoCollection(Number(actionEl.dataset.groupId)); return; }
  if (action === 'cycle-collection-status') { await cycleCollectionStatus(actionEl.dataset.nodeId);  return; }
  // The inline edit fields sit inside clickable rows. Giving them their own
  // action is what stops a click into one being read as a click on the row
  // underneath — which, on a link chip, would open the link.
  if (action === 'collection-edit-field')   { return; }
  if (action === 'delete-collection-node')  { await deleteCollectionNodeById(actionEl.dataset.nodeId); return; }
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

// ---- Collected tabs: the inline rename field ----
// The field lives inside a container that live sync rewrites wholesale, so the
// in-progress text is held in module state instead of being read back from the
// DOM. restoreCollectionRenameFocus() handles putting it back afterwards.
document.addEventListener('input', async (e) => {
  if (isCollectionRenameField(e.target)) {
    renameDraft = e.target.value;
    renameCaret = typeof e.target.selectionStart === 'number' ? e.target.selectionStart : null;
    // Deliberately no render and no storage write here: re-rendering on every
    // keystroke would cascade a full dashboard render behind each character.
    return;
  }

  // The filter box lives in the static toolbar, so re-rendering the tree under
  // it doesn't disturb what you're typing.
  if (e.target.id === 'collectionFilterInput') {
    collectionQuery = String(e.target.value || '');
    await renderCollectionSection();
  }
});

// The chosen destination lives in module state, not just in the select: every
// render re-applies it, so without this the user's pick would be wiped by the
// next live-sync re-render.
document.addEventListener('change', async (e) => {
  if (e.target.id === 'collectTargetSelect') {
    collectTargetId = String(e.target.value || '');
    return;
  }

  if (e.target.id === 'collectKindSelect') {
    syncCollectionToolbar();
    return;
  }

  if (e.target.id === 'collectionStatusFilter') {
    collectionStatusFilter = normalizeCollectionStatus(e.target.value);
    await renderCollectionSection();
    return;
  }

  // The "move to" select commits on choosing — there is nothing half-typed
  if (isCollectionMoveField(e.target)) {
    await commitCollectionReparent(
      e.target.id.slice(COLLECTION_MOVE_PREFIX.length),
      String(e.target.value || ''));
  }
});

// async, and it awaits the commit: the commit writes to storage and re-renders,
// and returning its promise is what lets a caller (or a test) know when that
// has actually landed rather than racing it.
document.addEventListener('keydown', async (e) => {
  // Both inline editors: Escape closes either, Enter only means something in
  // the text field (a select commits on choosing).
  if (isCollectionRenameField(e.target) || isCollectionMoveField(e.target)) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelCollectionRename();
      return;
    }
    if (e.key === 'Enter' && isCollectionRenameField(e.target)) {
      e.preventDefault();
      await commitCollectionRename();
    }
    return;
  }

  // Enter in either toolbar field adds the link, so filing several in a row
  // never needs the mouse
  if (e.key === 'Enter' && e.target.id !== 'collectTargetSelect' && e.target.id !== 'collectKindSelect' &&
      (e.target.id === 'collectUrlInput' || e.target.id === 'collectNameInput' || e.target.id === 'collectLanguageInput')) {
    e.preventDefault();
    await addCollectedFromToolbar();
  }
});

document.addEventListener('focusout', async (e) => {
  // Leaving the "move to" select without choosing just closes it
  if (isCollectionMoveField(e.target)) {
    if (String(e.target.id) === `${COLLECTION_MOVE_PREFIX}${editingCollectionNodeId}`) {
      cancelCollectionRename();
    }
    return;
  }

  if (!isCollectionRenameField(e.target)) return;
  if (editingCollectionMode !== 'rename') return;

  // focusout bubbles, which is why this isn't blur. The session token makes
  // the focusout caused by our own re-render a no-op — without it, committing
  // a rename would immediately commit again against the replacement field.
  if (String(e.target.dataset.renameSession) !== String(renameSession)) return;

  await commitCollectionRename();
});

/* ---- Collected tabs: dragging a card's right edge to resize it ---- */
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest && e.target.closest('[data-action="resize-collection-card"]');
  if (!handle) return;

  e.preventDefault();
  beginCollectionResize(e, handle);
});

document.addEventListener('pointermove', (e) => {
  if (collectionResize) updateCollectionResize(e);
});

document.addEventListener('pointerup', async () => {
  if (collectionResize) await endCollectionResize();
});

// How many columns fit depends on the window width, so a resize can leave a
// card's stored span wider than the grid now has. Re-render to re-clamp it.
if (typeof window !== 'undefined' && window && window.addEventListener) {
  let boardRelayoutTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(boardRelayoutTimer);
    boardRelayoutTimer = setTimeout(() => renderCollectionSection(), 150);
  });
}

// Web fonts can land after the first render and change text metrics, which
// changes card heights — so measure again once they're in.
if (typeof document !== 'undefined' && document.fonts && document.fonts.ready &&
    typeof document.fonts.ready.then === 'function') {
  document.fonts.ready.then(() => layoutCollectionBoard()).catch(() => {});
}

/* ---- Collected tabs: dragging a card to reorder the board ---- */
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest && e.target.closest('.collection-card[data-depth="0"]');
  if (!card) return;

  collectionDragId = String(card.dataset.nodeId);
  collectionDragActive = true;

  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    // Chrome won't start a drag unless some data is set, but the id is never
    // read back from here: getData() returns '' during dragover by design, so
    // the dragged id lives in module state instead.
    e.dataTransfer.setData('text/plain', collectionDragId);
  }
});

document.addEventListener('dragover', (e) => {
  if (!collectionDragActive) return;

  const card = e.target.closest && e.target.closest('.collection-card[data-depth="0"]');
  if (!card || String(card.dataset.nodeId) === collectionDragId) return;

  e.preventDefault();                 // this is what makes the drop possible
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

  markCollectionDropTarget(card, collectionDropZoneX(card.getBoundingClientRect(), e.clientX));
});

document.addEventListener('drop', async (e) => {
  if (!collectionDragActive) return;

  const card     = e.target.closest && e.target.closest('.collection-card[data-depth="0"]');
  const dragId   = collectionDragId;
  const position = card
    ? collectionDropZoneX(card.getBoundingClientRect(), e.clientX)
    : 'after';

  // Clear the indicators before the (async) move, whatever happens next
  finishCollectionDrag();
  if (!card) return;

  e.preventDefault();
  await commitCollectionMove(dragId, String(card.dataset.nodeId), position);
});

document.addEventListener('dragend', () => finishCollectionDrag());

// ---- Collected tabs: pasting a rich-text hyperlink ----
// Copying a link out of a document or a chat gives the clipboard two flavours,
// and the plain-text one has usually lost the address. Reading the HTML one
// back is the only way to recover what the words were pointing at.
document.addEventListener('paste', (e) => {
  const target = e.target;
  if (!target || target.id !== 'collectUrlInput') return;

  const kindEl = document.getElementById('collectKindSelect');
  const kind   = kindEl && kindEl.value ? String(kindEl.value) : 'link';
  if (kind !== 'link') return;         // a note or a snippet wants the raw text

  // Only hijack an empty field. Paste normally otherwise — replacing what
  // someone has already typed would be a surprise.
  if (String(target.value || '').trim()) return;
  if (!e.clipboardData || typeof e.clipboardData.getData !== 'function') return;

  const link = extractFirstHyperlink(e.clipboardData.getData('text/html'));
  if (!link) return;                   // no anchor in there; an ordinary paste

  e.preventDefault();
  target.value = link.url;

  const nameEl = document.getElementById('collectNameInput');
  if (nameEl && !String(nameEl.value || '').trim() && link.text) nameEl.value = link.text;

  showToast('Took the link out of that paste');
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
// Every element that renders a favicon, and the class that sizes its fallback.
// A new one added here without extending this list renders failed icons as a
// browser broken-image glyph instead of the letter avatar.
const FAVICON_CLASSES = ['chip-favicon', 'deferred-favicon', 'collection-favicon'];

document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;

  const faviconClass = FAVICON_CLASSES.find(cls => img.classList.contains(cls));
  if (!faviconClass) return;

  const host   = (img.getAttribute('data-host') || '').replace(/^www\./, '');
  const avatar = document.createElement('span');
  avatar.className = `${faviconClass} favicon-fallback`;
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

// Saved-for-later and collection changes — including ones made by another
// Tab Out tab, which is the whole point of listening at all
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.deferred || changes.collections) scheduleSync();
});

// The toolbar is static markup that no render rewrites, so its kind-dependent
// bits have to be applied once at load as well as on every change.
syncCollectionToolbar();

// theme.js already set the attribute before the first paint; this syncs the
// three buttons to the stored choice.
applyThemeChoice(readThemeChoice());

renderDashboard().catch(err => {
  console.error('[tab-out] Dashboard failed to render:', err);
});
