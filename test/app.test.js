'use strict';

/*
  Tests for the dashboard's grouping and tab-closing logic.

  These run app.js directly (no build step, no browser): test/harness.js stubs
  chrome.* and the DOM, then drives the real render path and the real click
  handler. What they can't cover — CSS, audio, confetti, actual Chrome
  behaviour — still needs a human loading the extension.

  Run with: npm test
*/

const { loadApp, makeEl } = require('./harness');
const { REAL_TAB_IDS } = require('./fixtures');

let passed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
     `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) { console.log(`\n${title}`); }

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function boot(opts) {
  const app = loadApp(opts);
  if (app.ready && typeof app.ready.then === 'function') await app.ready;
  else await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 0));   // let queued microtasks settle
  return app;
}

/* ================================================================
   1. Grouping — cards mirror Chrome's tab groups
   ================================================================ */
async function testGrouping() {
  const app = await boot();
  const html = app.els.openTabsMissions.innerHTML;

  const cards = [...html.matchAll(/data-group-id="(-?\d+)"[^>]*data-group-color="(\w+)"/g)]
    .map(m => `${m[1]}:${m[2]}`);

  eq('one card per Chrome group, in tab-strip order, Ungrouped last', cards,
     ['10:blue', '11:red', '14:purple', '12:green', '-1:grey']);

  ok('a group holding only browser-internal tabs gets no card',
     !html.includes('data-group-id="13"'));
  ok('named group keeps Chrome\'s own title', html.includes('>Work<'));
  ok('unnamed group falls back to "Untitled group"', html.includes('Untitled group'));
  ok('ungrouped tabs get their own card', html.includes('>Ungrouped<'));
  ok('a collapsed Chrome group renders collapsed',
     /is-collapsed[^>]*data-group-id="11"|data-group-id="11"[^>]*is-collapsed/.test(html)
     || /is-collapsed[^]*data-group-id="11"/.test(html));
  eq('collapse toggle only on real groups (not Ungrouped)',
     (html.match(/toggle-group-collapse/g) || []).length, 4);
  ok('a card shows 8 tabs then "+N more"',
     /data-group-id="14"[\s\S]*?\+2 more/.test(html));

  section('Grouping — tabs land in the right cards');
  ok('tab pointing at a group Chrome no longer reports is kept, as ungrouped',
     html.slice(html.indexOf('data-group-id="-1"')).includes('>Orphan<'));
  ok('chrome:// tab is excluded', !html.includes('chrome://settings'));
  ok('extension page is excluded', !html.includes('>Tab Out<'));
  ok('tab with no url is excluded', !html.includes('No URL'));
  ok('file:// tab is kept', html.slice(html.indexOf('data-group-id="-1"')).includes('>Local<'));

  section('Grouping — counts');
  ok('per-card "Close all" counts that card only',
     /data-group-id="10"[\s\S]*?Close all 2 tabs/.test(html));
  ok('Ungrouped counts every tab it displays (incl. the orphan)',
     /data-group-id="-1"[\s\S]*?Close all 4 tabs/.test(html));
  eq('footer stat counts real web tabs', app.els.statTabs.textContent, REAL_TAB_IDS.length);
  ok(`section header counts groups and real tabs`,
     new RegExp(`4 groups[^<]*${REAL_TAB_IDS.length} tabs`).test(app.els.openTabsSectionCount.innerHTML)
     || app.els.openTabsSectionCount.innerHTML.includes(`${REAL_TAB_IDS.length} tabs`),
     app.els.openTabsSectionCount.innerHTML.slice(0, 100));
  ok('"Close all N tabs" uses the same real-tab count',
     app.els.openTabsSectionCount.innerHTML.includes(`Close all ${REAL_TAB_IDS.length} tabs`));
}

/* ================================================================
   2. Chips — identity, escaping, icons
   ================================================================ */
async function testChips() {
  const app = await boot();
  const html = app.els.openTabsMissions.innerHTML;

  section('Chips');
  ok('chips identify their tab by id', html.includes('data-tab-id="1"'));
  ok('chips no longer carry a url', !html.includes('data-tab-url'));
  ok('close button carries the group id',
     /data-action="close-group-tabs" data-group-id="10"/.test(html));
  ok('dedup button carries the group id',
     /data-action="dedup-keep-one" data-group-id="11"/.test(html));
  ok('duplicate tabs get a (2x) badge', html.includes('(2x)'));

  section('Chips — untrusted page titles');
  ok('angle brackets in a page title are escaped',
     html.includes('&lt;img') && !html.includes('<img src=x'));
  ok('an injected data-action node cannot survive into the markup',
     !/onerror="alert/.test(html));

  section('Chips — favicons come from Chrome, never a third party');
  ok('uses the tab\'s own favIconUrl', html.includes('github.githubassets.com/favicon.ico'));
  ok('falls back to a letter avatar when favIconUrl is missing',
     html.includes('favicon-fallback'));
  ok('no google favicon service anywhere', !html.includes('google.com/s2/favicons'));
}

/* ================================================================
   3. Saved-for-later column
   ================================================================ */
async function testDeferredColumn() {
  const app = await boot();

  section('Saved for later');
  const list = app.els.deferredList.innerHTML;
  ok('uses the icon stored at save time', list.includes('saved-with-icon.com/f.ico'));
  ok('an item saved before icons existed degrades to a letter avatar',
     list.includes('deferred-favicon favicon-fallback'));
  ok('item titles are escaped', list.includes('Legacy item'));
  ok('archive renders completed items', app.els.archiveList.innerHTML.includes('Archived'));
  ok('no google favicon service here either',
     !list.includes('google.com/s2/favicons') &&
     !app.els.archiveList.innerHTML.includes('google.com/s2/favicons'));
}

/* ================================================================
   4. Destructive actions — driven through the real click handler
   ================================================================ */
async function testHandlers() {
  const app = await boot();
  const card = makeEl('card');
  card.classList.add('mission-card');

  section('Closing a group');
  let c = await app.fire('close-group-tabs', { groupId: '10' }, card);
  eq('closes exactly that group\'s tabs — not every tab on those hostnames',
     c.remove, [[1, 2]]);

  c = await app.fire('close-group-tabs', { groupId: '-1' }, card);
  eq('Ungrouped closes every tab it displays, including the orphan',
     c.remove, [[5, 8, 9, 12]]);

  section('Duplicates');
  c = await app.fire('dedup-keep-one', { groupId: '11' }, card);
  eq('keeps one copy, closes only the extras', c.remove, [[4]]);

  section('Collapse / expand writes through to Chrome');
  c = await app.fire('toggle-group-collapse', { groupId: '11' }, card);
  eq('expanded card → collapses the group in Chrome', c.tabGroupsUpdate, [[11, { collapsed: true }]]);

  const collapsedCard = makeEl('collapsedCard');
  collapsedCard.classList.add('mission-card', 'is-collapsed');
  c = await app.fire('toggle-group-collapse', { groupId: '11' }, collapsedCard);
  eq('collapsed card → expands the group again (round trip)',
     c.tabGroupsUpdate, [[11, { collapsed: false }]]);

  c = await app.fire('toggle-group-collapse', { groupId: '-1' }, card);
  eq('the Ungrouped card never writes to Chrome', c.tabGroupsUpdate, []);

  section('Focus and single close');
  c = await app.fire('focus-tab', { tabId: '7' }, card);
  eq('focus activates the tab that was clicked, in its own window',
     [c.tabsUpdate, c.windowsUpdate], [[[7, { active: true }]], [[2, { focused: true }]]]);

  c = await app.fire('close-single-tab', { tabId: '3' }, card);
  eq('single close acts on the tab id', c.remove, [[3]]);
}

/* ================================================================
   5. Degraded mode — "tabGroups" permission not in effect yet
   ================================================================ */
async function testDegraded() {
  const app = await boot({ degraded: true });
  const html = app.els.openTabsMissions.innerHTML;

  section('Degraded mode (chrome.tabGroups unavailable)');
  eq('everything falls into one card',
     (html.match(/class="mission-card/g) || []).length, 1);
  ok('that card is Ungrouped', html.includes('data-group-id="-1"'));
  ok('it still offers to close every real tab',
     new RegExp(`Close all ${REAL_TAB_IDS.length} tabs`).test(html));
  ok('no collapse toggles are offered', !html.includes('toggle-group-collapse'));
  ok('the header says one group',
     /1 group\b/.test(app.els.openTabsSectionCount.innerHTML),
     app.els.openTabsSectionCount.innerHTML.slice(0, 60));
  ok('it warns loudly rather than failing silently',
     app.warnings.some(w => w.includes('chrome.tabGroups unavailable')));

  const card = makeEl('card');
  card.classList.add('mission-card');
  const c = await app.fire('close-group-tabs', { groupId: '-1' }, card);
  eq('and "close all" really does close them all (count matches the button)',
     c.remove, [REAL_TAB_IDS]);
}

/* ================================================================
   6. Degraded mode — chrome.tabGroups missing entirely
   ================================================================ */
async function testMissingNamespace() {
  section('chrome.tabGroups is undefined (permission not in effect)');

  // If the namespace guard in app.js were missing, reading .onCreated off it
  // would throw and take the whole file down — every other test would fail too.
  const app = await boot({ noTabGroupsNamespace: true });

  ok('the app still boots', app.html().includes('data-group-id="-1"'),
     app.html().slice(0, 80));
  eq('and still shows the tabs, in one card',
     (app.html().match(/class="mission-card/g) || []).length, 1);
}

/* ================================================================
   7. One action, one visible update

   A single close triggers several *renders* — the one our own handler does
   once its animation ends, plus the one the resulting Chrome events schedule.
   Only the first of those changes anything; the rest must not touch the DOM,
   or the card grid visibly jumps over and over.
   ================================================================ */
async function testNoRedundantReflow() {
  section('One action, one visible update');

  const app = await boot();
  const card = makeEl('card');
  card.classList.add('mission-card');

  const before = app.gridWrites();
  await app.fire('close-single-tab', { tabId: '3' }, card);
  await wait(1200);
  eq('closing a tab from the dashboard rewrites the grid exactly once',
     app.gridWrites() - before, 1);

  // Closing from Chrome's own tab strip instead: several events arrive, all
  // describing the one change.
  const strip = await boot();
  const w0 = strip.gridWrites();
  strip.simulate.closeTab(3);
  strip.simulate.updateTab(1, { title: 'Something' });
  strip.events['tabGroups.onRemoved'].emit({ id: 11 });
  await wait(1200);
  eq('a burst of events from one external close rewrites the grid once',
     strip.gridWrites() - w0, 1);

  // A sync triggered by something that doesn't change the cards at all
  const quiet = await boot();
  const w1 = quiet.gridWrites();
  quiet.simulate.savedTabsChanged();
  await wait(400);
  eq('a sync that changes nothing leaves the grid untouched',
     quiet.gridWrites() - w1, 0);
}

/* ================================================================
   8. Live sync
   ================================================================ */
async function testLiveSync() {
  const app = await boot();

  section('Live sync — subscriptions');
  const expected = [
    'tabs.onCreated', 'tabs.onRemoved', 'tabs.onMoved', 'tabs.onAttached',
    'tabs.onDetached', 'tabs.onReplaced', 'tabs.onUpdated',
    'tabGroups.onCreated', 'tabGroups.onUpdated', 'tabGroups.onRemoved', 'tabGroups.onMoved',
    'storage.onChanged',
  ];
  const missing = expected.filter(e => app.events[e].listenerCount() === 0);
  ok('subscribes to tab, group and storage changes', missing.length === 0,
     `no listener for: ${missing.join(', ')}`);

  section('Live sync — reacting to changes');
  let before = app.renders();
  app.simulate.closeTab(3);
  await wait(300);
  ok('a tab closing elsewhere re-renders the dashboard', app.renders() > before,
     `${before} → ${app.renders()}`);

  before = app.renders();
  app.simulate.updateTab(1, { status: 'complete' });
  await wait(300);
  eq('a bare loading→complete flip does not (it isn\'t drawn)', app.renders(), before);

  before = app.renders();
  app.simulate.updateTab(1, { title: 'Renamed' });
  await wait(300);
  ok('a title change does re-render', app.renders() > before);

  before = app.renders();
  app.simulate.updateGroup(10, { title: 'Renamed' });
  await wait(300);
  ok('renaming or recolouring a group re-renders', app.renders() > before);

  before = app.renders();
  app.simulate.savedTabsChanged();
  await wait(300);
  ok('a saved-tab change re-renders (e.g. from another Tab Out tab)',
     app.renders() > before);

  before = app.renders();
  app.events['storage.onChanged'].emit({ unrelated: {} }, 'sync');
  await wait(300);
  eq('unrelated storage changes are ignored', app.renders(), before);
}

async function testSelfMutationSuppression() {
  section('Live sync — our own changes don\'t fight the sync');
  const app = await boot();
  const card = makeEl('card');
  card.classList.add('mission-card');

  // Closing a group changes Chrome, which echoes it straight back as events.
  // Our handler has already updated the DOM, so those echoes must not render.
  await app.fire('close-group-tabs', { groupId: '11' }, card);
  const after = app.renders();

  app.simulate.closeTab(3);
  await wait(250);
  eq('the echo is ignored while our own change settles', app.renders(), after);

  await wait(700);
  ok('...but it re-renders afterwards, so nothing is missed for good',
     app.renders() > after, `${after} → ${app.renders()}`);
}

async function testExpandedStateSurvivesSync() {
  section('Live sync — UI state survives a re-render');
  const app = await boot();

  ok('a 10-tab card starts with "+2 more"',
     /data-group-id="14"[\s\S]*?\+2 more/.test(app.html()));

  const card = makeEl('card');
  card.classList.add('mission-card');
  card.dataset.groupId = '14';
  await app.fire('expand-chips', {}, card);

  app.simulate.updateTab(20, { title: 'Reading 0 (renamed)' });
  await wait(300);

  const html = app.html();
  const cardHtml = html.slice(html.indexOf('data-group-id="14"'), html.indexOf('data-group-id="12"'));
  ok('an expanded card stays expanded across a sync re-render',
     !cardHtml.includes('+2 more') && cardHtml.includes('>Reading 9<'),
     cardHtml.slice(0, 100));
}

const SUITES = [
  ['grouping',                  testGrouping],
  ['chips',                     testChips],
  ['saved for later',           testDeferredColumn],
  ['destructive actions',       testHandlers],
  ['degraded mode',             testDegraded],
  ['missing tabGroups namespace', testMissingNamespace],
  ['reflow',                    testNoRedundantReflow],
  ['live sync',                 testLiveSync],
  ['self-mutation suppression', testSelfMutationSuppression],
  ['state across re-render',    testExpandedStateSurvivesSync],
];

(async () => {
  for (const [name, fn] of SUITES) {
    try {
      await fn();
    } catch (err) {
      // A throw (app.js failing to load, say) is a failure, not a crash
      failures.push(`${name}: threw ${err.message}`);
      console.log(`  FAIL  ${name} threw: ${err.message}`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`All ${passed} assertions passed.`);
    process.exit(0);
  }
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
})();
