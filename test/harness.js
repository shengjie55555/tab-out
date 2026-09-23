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

const { GROUPS, TABS, SAVED } = require('./fixtures');

const APP_PATH = path.join(__dirname, '..', 'extension', 'app.js');

function makeEl(id) {
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    title: '',
    style: {},
    dataset: {},
    offsetWidth: 10,
    offsetHeight: 10,
    parentElement: null,
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
function loadApp({ degraded = false, noTabGroupsNamespace = false } = {}) {
  const els       = {};
  const listeners = [];
  const warnings  = [];
  const calls     = { remove: [], tabGroupsUpdate: [], tabsUpdate: [], windowsUpdate: [] };

  // Every full render reads the live tab list, so counting these is the
  // "a render ran" signal. It's kept separate from how often the DOM was
  // actually rewritten (#openTabsMissions) — a render that changes nothing
  // still runs, but must not touch the DOM.
  let tabQueries = 0;

  const getEl = (id) => (els[id] = els[id] || makeEl(id));

  // Count renders: every assignment to #openTabsMissions.innerHTML
  let renderCount = 0;
  const missionsEl = makeEl('openTabsMissions');
  let missionsHtml = '';
  Object.defineProperty(missionsEl, 'innerHTML', {
    get() { return missionsHtml; },
    set(v) { missionsHtml = v; renderCount++; },
  });
  els.openTabsMissions = missionsEl;

  const document = {
    hidden: false,
    getElementById: getEl,
    createElement: () => makeEl('created'),
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    body: { appendChild() {} },
    querySelector: () => null,
    querySelectorAll(sel) {
      // Only the mission-card count matters to app.js; derive it from the
      // markup the renderer actually wrote.
      if (sel.includes('mission-card')) {
        const n = (missionsHtml.match(/class="mission-card/g) || []).length;
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
        get: async () => ({ deferred: SAVED.map(i => ({ ...i })) }),
        set: async () => { events['storage.onChanged'].emit({ deferred: {} }, 'local'); },   // echo
      },
    },
  };

  // What a not-yet-reloaded extension actually sees: no namespace at all
  if (noTabGroupsNamespace) delete chrome.tabGroups;

  const sandbox = {
    document, chrome, console: { ...console, warn: (...a) => warnings.push(a.join(' ')) },
    window: {}, performance, setTimeout, clearTimeout,
    requestAnimationFrame: () => {},
    Date, Math, JSON, URL, Set, Map, Promise, Object, Array, String, Number, RegExp, Error,
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

    const actionEl = makeEl('actionEl');
    actionEl.dataset = Object.assign({ action }, dataset);
    actionEl.closest = (sel) =>
      sel === '[data-action]' ? actionEl :
      sel === '.mission-card' ? cardStub :
      sel === '.page-chip'    ? makeEl('chip') : null;

    const clickHandler = listeners.find(l => l.type === 'click').fn;
    await clickHandler({ target: { closest: () => actionEl }, stopPropagation() {} });
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
      events['storage.onChanged'].emit({ deferred: {} }, 'local');
    },
  };

  /** The dashboard's current markup, as last written */
  function html() { return missionsHtml; }

  /** How many times the card grid's markup was actually rewritten (a reflow) */
  function gridWrites() { return renderCount; }

  /** How many full renders ran */
  function renders() { return tabQueries; }

  return { els, calls, warnings, events, fire, simulate, html, gridWrites, renders, makeEl, ready };
}

module.exports = { loadApp, makeEl };
