'use strict';

/*
  Runs extension/app.js against a stubbed chrome.* and a minimal DOM, so the
  grouping, tab-closing and live-sync logic can be exercised without a browser.

  The stubs are deliberately dumb — just enough surface for app.js to run:
    - element stubs record innerHTML / textContent / classList for assertions
    - chrome.* calls are recorded in `calls` so tests can assert what would
      have been closed, focused or collapsed
    - chrome.* *events* are captured in `events` so tests can fire them and
      watch what the app does about it
    - every write to #openTabsMissions is counted, as a stand-in for "a
      render happened"
*/

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const { GROUPS, TABS, SAVED, COLLECTIONS } = require('./fixtures');

const APP_PATH = path.join(__dirname, '..', 'extension', 'app.js');

/** Deep copy, so a stub can never leak a mutation into the fixtures */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeEl(id, styleLog) {
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    title: '',
    value: '',
    // Enough of CSSStyleDeclaration for app.js: it sets custom properties
    // (--card-span, --row-span) via setProperty and plain ones (display) by
    // assignment. styleLog records the former so layout passes are assertable.
    style: {
      setProperty(prop, value) {
        this[prop] = value;
        if (styleLog) styleLog.push({ id, prop, value });
      },
      getPropertyValue(prop) {
        return this[prop] === undefined ? '' : String(this[prop]);
      },
    },
    dataset: {},
    offsetWidth: 10,
    offsetHeight: 10,
    parentElement: null,
    // Input-ish surface, for the inline rename field
    focused: false,
    selectionStart: 0,
    selectionEnd: 0,
    focus() { this.focused = true; },
    select() { this.selectionStart = 0; this.selectionEnd = String(this.value).length; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    classList: {
      _set: new Set(),
      add(...cs) { cs.forEach(c => this._set.add(c)); },
      remove(...cs) { cs.forEach(c => this._set.delete(c)); },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : force;
        on ? this._set.add(c) : this._set.delete(c);
        return on;
      },
      contains(c) { return this._set.has(c); },
    },
    appendChild() {},
    remove() {},
    replaceWith() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] === undefined ? null : this[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; },
    closest() { return null; },
  };
  return el;
}

function makeEventStub() {
  const handlers = [];
  return {
    addListener: (fn) => handlers.push(fn),
    emit: (...args) => handlers.forEach(fn => fn(...args)),
    listenerCount: () => handlers.length,
  };
}

/**
 * loadApp({ degraded, noTabGroupsNamespace })
 *
 * Boots app.js in a fresh sandbox and returns handles for asserting on it.
 *
 *   degraded            chrome.tabGroups.query() throws — a tabGroups
 *                       permission that isn't in effect yet
 *   noTabGroupsNamespace  chrome.tabGroups is undefined entirely, which is
 *                       what that same situation actually looks like
 *
 * `ready` is the promise app.js's own top-level renderDashboard() call
 * returns — await it to know the first render is done.
 */
function loadApp({ degraded = false, noTabGroupsNamespace = false, globals = {} } = {}) {
  const els       = {};
  const listeners = [];
  const warnings  = [];
  const calls     = { remove: [], tabGroupsUpdate: [], tabsUpdate: [], windowsUpdate: [], created: [], copied: [] };

  // Every style.setProperty() app.js performs, so layout passes can be checked
  const styleWrites = [];

  // Every full render reads the live tab list, so counting these is the
  // "a render ran" signal. It's kept separate from how often the DOM was
  // actually rewritten (#openTabsMissions) — a render that changes nothing
  // still runs, but must not touch the DOM.
  let tabQueries = 0;

  const getEl = (id) => (els[id] = els[id] || makeEl(id));

  /**
   * CounterElement(id)
   *
   * An element that counts how often its markup is rewritten. `getEl` creates
   * elements lazily, so a counted container MUST be pre-registered here before
   * app.js runs — otherwise the first write creates a plain element and the
   * counter never moves.
   */
  function counterEl(id) {
    const el = makeEl(id);
    let html = '';
    let writes = 0;
    Object.defineProperty(el, 'innerHTML', {
      get() { return html; },
      set(v) { html = v; writes++; },
    });
    el.writes = () => writes;
    els[id] = el;
    return el;
  }

  const missionsEl    = counterEl('openTabsMissions');
  const treeEl        = counterEl('collectedTree');
  const targetSelEl   = counterEl('collectTargetSelect');

  // localStorage, so the theme preference round-trips; and a matchMedia stub
  // whose answer the test can flip, standing in for the OS switching.
  const localStore = new Map();
  let   prefersDark = false;
  const systemThemeListeners = [];

  const localStorageStub = {
    getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => { localStore.set(key, String(value)); },
    removeItem: (key) => { localStore.delete(key); },
  };

  const document = {
    hidden: false,
    getElementById: getEl,
    documentElement: { dataset: {}, setAttribute() {} },
    createElement: (tag) => {
      const el = makeEl(tag || 'created');
      // Just enough canvas for the note image path to run: the harness can't
      // decode or encode anything, so the encoded result is a fixed stub. That
      // still exercises the wiring — the sizing, the insertion, the preview.
      if (tag === 'canvas') {
        el.getContext = () => ({ drawImage() {} });
        el.toDataURL = () => 'data:image/webp;base64,STUB';
      }
      return el;
    },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    body: { appendChild() {} },
    querySelector: () => null,
    querySelectorAll(sel) {
      // Only the two selectors app.js relies on are understood; both counts
      // come from the markup the renderer actually wrote.
      if (sel.includes('collection-board')) {
        // The real selector is a direct-child one, so only depth-0 cards count —
        // counting every card would let a bug that lays out nested cards pass.
        const n = (treeEl.innerHTML.match(/data-depth="0"/g) || []).length;
        return Array.from({ length: n }, () => makeEl('collection-card', styleWrites));
      }
      if (sel.includes('mission-card')) {
        const n = (missionsEl.innerHTML.match(/class="mission-card/g) || []).length;
        return Array.from({ length: n }, () => makeEl('card'));
      }
      return [];
    },
  };

  // A mutable copy of the fixtures: closing a tab has to actually change what
  // the app reads back, or a re-render would produce identical markup and
  // tests about re-rendering would be measuring nothing.
  let liveTabs   = TABS.map(t => ({ ...t }));
  const liveGroups = GROUPS.map(g => ({ ...g }));

  const events = {
    'tabs.onCreated':     makeEventStub(),
    'tabs.onRemoved':     makeEventStub(),
    'tabs.onMoved':       makeEventStub(),
    'tabs.onAttached':    makeEventStub(),
    'tabs.onDetached':    makeEventStub(),
    'tabs.onReplaced':    makeEventStub(),
    'tabs.onUpdated':     makeEventStub(),
    'tabGroups.onCreated': makeEventStub(),
    'tabGroups.onUpdated': makeEventStub(),
    'tabGroups.onRemoved': makeEventStub(),
    'tabGroups.onMoved':   makeEventStub(),
    'storage.onChanged':   makeEventStub(),
  };

  const chrome = {
    runtime: { id: 'abc' },
    tabs: {
      onCreated:  events['tabs.onCreated'],
      onRemoved:  events['tabs.onRemoved'],
      onMoved:    events['tabs.onMoved'],
      onAttached: events['tabs.onAttached'],
      onDetached: events['tabs.onDetached'],
      onReplaced: events['tabs.onReplaced'],
      onUpdated:  events['tabs.onUpdated'],
      query:  async () => { tabQueries++; return liveTabs; },
      get:    async (id) => {
        const tab = liveTabs.find(t => t.id === id);
        if (!tab) throw new Error(`no tab ${id}`);
        return tab;
      },
      remove: async (ids) => {
        const targets = new Set([].concat(ids));
        calls.remove.push([].concat(ids));
        liveTabs = liveTabs.filter(t => !targets.has(t.id));
        // Chrome reports our own removals straight back to us, exactly as it
        // does for a close the user performed. That echo is the whole reason
        // the self-mutation guard exists, so the stub has to send it.
        targets.forEach(id => events['tabs.onRemoved'].emit(id, { windowId: 1, isWindowClosing: false }));
      },
      update: async (id, props) => {
        calls.tabsUpdate.push([id, props]);
        const tab = liveTabs.find(t => t.id === id);
        if (tab) Object.assign(tab, props);
      },
      create: async (props) => { calls.created.push(props); return { id: 999, ...props }; },
    },
    tabGroups: {
      onCreated: events['tabGroups.onCreated'],
      onUpdated: events['tabGroups.onUpdated'],
      onRemoved: events['tabGroups.onRemoved'],
      onMoved:   events['tabGroups.onMoved'],
      query:  async () => {
        if (degraded) throw new Error('tabGroups permission missing');
        return liveGroups;
      },
      update: async (id, props) => {
        calls.tabGroupsUpdate.push([id, props]);
        const group = liveGroups.find(g => g.id === id);
        if (group) Object.assign(group, props);
        events['tabGroups.onUpdated'].emit(Object.assign({ id }, props));   // echo
      },
    },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      update:     async (id, props) => { calls.windowsUpdate.push([id, props]); },
    },

    storage: {
      onChanged: events['storage.onChanged'],
      local: {
        // A real key→value store. It has to behave like chrome.storage.local
        // or storage-backed features can't be tested at all: `get` must honour
        // the key it's asked for, `set` must actually persist, and the
        // onChanged echo must name the keys that really changed.
        get: async (keys) => {
          if (keys === undefined || keys === null) return clone(store);
          const out = {};
          for (const key of [].concat(keys)) out[key] = clone(store[key]);
          return out;
        },
        set: async (obj) => {
          const changes = {};
          for (const [key, value] of Object.entries(obj)) {
            changes[key] = { oldValue: clone(store[key]), newValue: clone(value) };
            store[key] = clone(value);
          }
          events['storage.onChanged'].emit(changes, 'local');
        },
      },
    },
  };

  // What a not-yet-reloaded extension actually sees: no namespace at all
  if (noTabGroupsNamespace) delete chrome.tabGroups;

  // Seeded fresh per loadApp, so tests can't leak state into each other
  let store = clone({ deferred: SAVED, collections: COLLECTIONS });

  const sandbox = {
    document, chrome, console: { ...console, warn: (...a) => warnings.push(a.join(' ')) },
    window: {
      matchMedia: (query) => ({
        matches: /prefers-color-scheme:\s*dark/.test(query) ? prefersDark : false,
        // Recorded rather than ignored, so a test can make the OS switch
        addEventListener: (type, fn) => { if (type === 'change') systemThemeListeners.push(fn); },
        addListener: (fn) => systemThemeListeners.push(fn),
      }),
      addEventListener() {},
    },
    localStorage: localStorageStub,
    performance, setTimeout, clearTimeout,
    requestAnimationFrame: () => {},
    HTMLImageElement: class HTMLImageElement {},
    navigator: { clipboard: { writeText: async (text) => { calls.copied.push(String(text)); } } },
    createImageBitmap: async (file) => ({ width: file && file.width || 3200, height: file && file.height || 1800 }),
    Date, Math, JSON, URL, Set, Map, Promise, Object, Array, String, Number, RegExp, Error,
    // Stands in for config.local.js, which index.html loads but nothing tested
    // could previously define
    ...globals,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const src = fs.readFileSync(APP_PATH, 'utf8');
  const ready = vm.runInContext(src, sandbox, { filename: APP_PATH });

  /**
   * fire(action, dataset, cardStub)
   *
   * Drives the real delegated click handler with a synthetic event, and
   * returns the chrome.* calls it made. Reset per call so each test sees only
   * its own effects.
   */
  async function fire(action, dataset, cardStub) {
    calls.remove.length = 0;
    calls.tabGroupsUpdate.length = 0;
    calls.tabsUpdate.length = 0;
    calls.windowsUpdate.length = 0;
    calls.created.length = 0;
    calls.copied.length = 0;

    const actionEl = makeEl('actionEl');
    actionEl.dataset = Object.assign({ action }, dataset);
    // The row a button lives in, for handlers that animate it out before
    // re-rendering. Lazily created so a test can look at it afterwards.
    let rowEl = null;
    actionEl.closest = (sel) =>
      sel === '[data-action]' ? actionEl :
      sel === '.mission-card' ? cardStub :
      sel === '.page-chip'    ? makeEl('chip') :
      sel === '.archive-item' ? (rowEl = rowEl || makeEl('archive-item')) : null;

    const clickHandler = listeners.find(l => l.type === 'click').fn;
    await clickHandler({ target: { closest: () => actionEl }, stopPropagation() {} });
    // Exposed so tests can inspect a control the app marked in place (e.g. a
    // button armed for a confirming second click), or the row an action
    // animated out
    calls.actionEl = actionEl;
    calls.rowEl    = rowEl;
    return calls;
  }

  /**
   * simulate.*
   *
   * Real changes made *outside* the dashboard: mutate the underlying state
   * and fire the event Chrome would, since a real change does both.
   */
  const simulate = {
    closeTab(id) {
      liveTabs = liveTabs.filter(t => t.id !== id);
      events['tabs.onRemoved'].emit(id, { windowId: 1, isWindowClosing: false });
    },
    updateTab(id, changeInfo) {
      const tab = liveTabs.find(t => t.id === id);
      if (tab) Object.assign(tab, changeInfo);
      events['tabs.onUpdated'].emit(id, changeInfo);
    },
    updateGroup(id, props) {
      const group = liveGroups.find(g => g.id === id);
      if (group) Object.assign(group, props);
      events['tabGroups.onUpdated'].emit(Object.assign({ id }, props));
    },
    savedTabsChanged() {
      events['storage.onChanged'].emit({ deferred: { newValue: clone(store.deferred) } }, 'local');
    },
    collectionsChanged() {
      events['storage.onChanged'].emit({ collections: { newValue: clone(store.collections) } }, 'local');
    },
    /** Stands in for the OS switching between light and dark */
    setSystemDark(value) {
      prefersDark = !!value;
      systemThemeListeners.forEach(fn => fn({ matches: prefersDark }));
    },
  };

  /**
   * fireEvent(type, event)
   *
   * Invokes every listener registered for a document event type. Used for the
   * channels that have exactly one listener (input, keydown, focusout, the
   * drag events). The caller builds the event object, so `target`, `key`,
   * `clientY` and friends are set explicitly per test.
   *
   * Unlike fire(), this makes no assumption about which listener it should
   * reach, so it's safe to add more document listeners later.
   */
  async function fireEvent(type, event = {}) {
    const handled = listeners.filter(l => l.type === type);
    for (const { fn } of handled) {
      // Real events carry these; the app calls preventDefault() on Enter and
      // Escape. A bare object would make that throw.
      await fn(Object.assign({
        target: makeEl('target'),
        preventDefault() {},
        stopPropagation() {},
      }, event));
    }
    return handled.length;
  }

  /** The dashboard's current markup, as last written */
  function html() { return missionsEl.innerHTML; }

  /** How many times the card grid's markup was actually rewritten (a reflow) */
  function gridWrites() { return missionsEl.writes(); }

  /** How many times the collection tree was rewritten */
  function treeWrites() { return treeEl.writes(); }

  /** How many times the collection target <select>'s options were rewritten */
  function selectWrites() { return targetSelEl.writes(); }

  /** How many full renders ran */
  function renders() { return tabQueries; }

  /** A deep copy of what's actually persisted — assert on this, not on markup */
  function storage() { return clone(store); }

  return {
    els, calls, warnings, events, fire, fireEvent, simulate, sandbox, styleWrites,
    html, gridWrites, treeWrites, selectWrites, renders, storage, makeEl, ready,
  };
}

module.exports = { loadApp, makeEl };
