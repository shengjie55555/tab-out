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
const { REAL_TAB_IDS, COLLECTIONS } = require('./fixtures');

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
   0. The harness itself

   Everything below is built on the stubbed storage and event dispatcher, so
   if those are subtly wrong the rest of the suite proves nothing.
   ================================================================ */
async function testHarnessStore() {
  section('Harness — storage is a real store, not a fixture echo');
  const app = await boot();
  const local = app.sandbox.chrome.storage.local;

  eq('the collections fixture is seeded',
     app.storage().collections.nodes.length, COLLECTIONS.nodes.length);

  const got = await local.get('deferred');
  ok('get(key) returns the key that was asked for',
     Array.isArray(got.deferred) && got.deferred.length === 3, JSON.stringify(Object.keys(got)));
  ok('get(key) does not leak other keys',
     got.collections === undefined, JSON.stringify(Object.keys(got)));

  const copy = await local.get('deferred');
  copy.deferred.push({ id: 'injected' });
  eq('mutating what get() returned does not reach the store',
     app.storage().deferred.length, 3);

  await local.set({ collections: { version: 1, nodes: [] } });
  eq('a write persists', app.storage().collections.nodes.length, 0);
  eq('...without disturbing other keys', app.storage().deferred.length, 3);

  let seen = null;
  app.events['storage.onChanged'].addListener((changes, area) => { seen = { changes, area }; });
  await local.set({ collections: { version: 1, nodes: [{ id: '1', type: 'group', name: 'x', collapsed: false, children: [] }] } });
  ok('onChanged names the key that actually changed',
     seen && 'collections' in seen.changes, JSON.stringify(seen && Object.keys(seen.changes)));
  eq('onChanged reports the local area', seen && seen.area, 'local');

  section('Harness — dispatch and counters');
  const reached = await app.fireEvent('input', { target: { id: 'archiveSearch', value: '' } });
  ok('fireEvent reaches the document listener', reached >= 1, String(reached));

  // Both counters must have moved exactly once during the initial render —
  // if the elements weren't pre-registered they'd read 0 forever
  eq('the tree counter saw the initial render', app.treeWrites(), 1);
  eq('the select counter saw the initial render', app.selectWrites(), 1);
}

/* ================================================================
   0b. The collections tree model

   Pure functions, reached straight through the vm sandbox. Every destructive
   operation gets the same two-part assertion: the change landed, AND the tree
   it was handed came back untouched. The second half is what fails if anyone
   ever "optimises" one of these into an in-place mutation.
   ================================================================ */
async function testCollectionModel() {
  section('Collections — sanitising untrusted storage');
  const app = await boot();
  const M = app.sandbox;

  for (const garbage of [undefined, null, 'nope', 42, [], { nodes: 'nope' },
                         { nodes: [null, 7, { type: 'nope' }, {}] }]) {
    const out = M.sanitizeCollectionTree(garbage);
    ok(`survives ${JSON.stringify(garbage) ?? String(garbage)}`,
       out && Array.isArray(out.nodes) && out.version === 1, JSON.stringify(out));
  }

  eq('a link with no url is dropped',
     M.sanitizeCollectionTree({ nodes: [{ id: '1', type: 'link', name: 'x' }] }).nodes.length, 0);
  eq('a non-string name becomes empty',
     M.sanitizeCollectionTree({ nodes: [{ id: '1', type: 'group', name: 42 }] }).nodes[0].name, '');
  eq('non-array children become empty',
     M.sanitizeCollectionTree({ nodes: [{ id: '1', type: 'group', children: 'nope' }] }).nodes[0].children.length, 0);

  const dupes = M.sanitizeCollectionTree({ nodes: [
    { id: '1', type: 'group', name: 'first', children: [] },
    { id: '1', type: 'group', name: 'second', children: [] },
  ]});
  eq('a duplicate id is dropped, not allowed to shadow', dupes.nodes.length, 1);
  eq('...and the first one wins', dupes.nodes[0].name, 'first');

  const deep = M.sanitizeCollectionTree({ nodes: [{ id: '1', type: 'group', children:
    [{ id: '2', type: 'group', children: [{ id: '3', type: 'group', children: [] }] }] }] });
  eq('a well-formed tree passes through', deep.nodes[0].children[0].children[0].id, '3');

  section('Collections — versions');
  const future = M.migrateCollectionTree({ version: 99, nodes: COLLECTIONS.nodes });
  eq('a tree from a newer build still renders', future.nodes.length, COLLECTIONS.nodes.length);
  ok('...and is reported', app.warnings.some(w => w.includes('version 99')),
     app.warnings.join(' | ').slice(0, 80));

  section('Collections — ids');
  eq('nextCollectionId derives max + 1', M.nextCollectionId(COLLECTIONS), '25');
  eq('an empty tree starts at 1', M.nextCollectionId({ nodes: [] }), '1');

  const tree0 = JSON.parse(JSON.stringify(COLLECTIONS));
  const first  = M.addCollectionLink(tree0, { url: 'https://a.example' });
  const second = M.addCollectionLink(first.tree, { url: 'https://b.example' });
  ok('two links added in the same tick get different ids',
     first.id !== second.id, `${first.id} vs ${second.id}`);
  ok('...and neither collides with an existing node',
     !M.findCollectionNode(COLLECTIONS, first.id) && !M.findCollectionNode(COLLECTIONS, second.id));

  section('Collections — walking');
  eq('flatten covers every node', M.flattenCollectionTree(COLLECTIONS).length, 24);

  const paths = M.flattenCollectionTree(COLLECTIONS).map(n => n.path);
  ok('paths are /-joined the way the user writes them',
     paths.includes('d2d_mem / v1 / mid'), JSON.stringify(paths.slice(0, 4)));
  ok('flatten is pre-order',
     paths.indexOf('d2d_mem') < paths.indexOf('d2d_mem / v1') &&
     paths.indexOf('d2d_mem / v1') < paths.indexOf('d2d_mem / v1 / mid'));

  eq('counts groups and links',
     M.countCollectionNodes(COLLECTIONS), { groups: 12, items: 12 });
  eq('path of a deeply nested link',
     M.collectionPathOf(COLLECTIONS, '18'), 'Deep / L2 / L3 / L4 / very deep link');

  const found = M.findCollectionNode(COLLECTIONS, '4');
  eq('find reports parent and index',
     [found.node.name, found.parentId, found.index], ['wsj-d2dmid-0901-1-n32-09012201', '3', 0]);

  // Identity is the id, not the URL: the same link may legitimately live under
  // two groups, and neither may be silently dropped
  eq('two nodes may share a url',
     M.findCollectionNode(COLLECTIONS, '8').node.url,
     M.findCollectionNode(COLLECTIONS, '11').node.url);

  ok('a node is inside its ancestor', M.isCollectionDescendant(COLLECTIONS, '3', '4'));
  ok('but not the other way round', !M.isCollectionDescendant(COLLECTIONS, '4', '3'));
  ok('and not its own descendant', !M.isCollectionDescendant(COLLECTIONS, '3', '3'));

  section('Collections — name fallbacks');
  eq('an unnamed group reads Untitled group',
     M.displayCollectionName({ type: 'group', name: '' }), 'Untitled group');
  eq('an unnamed link falls back to its url',
     M.displayCollectionName({ type: 'link', name: '', url: 'https://x.example' }), 'https://x.example');

  section('Collections — structural edits are pure');
  const pristine = JSON.stringify(COLLECTIONS);

  const added = M.addCollectionLink(COLLECTIONS, { url: 'https://new.example', name: 'New', groupId: '12' });
  eq('a link lands in the group it was aimed at', M.findCollectionNode(added.tree, added.id).parentId, '12');
  eq('...at the end of that group', M.findCollectionNode(added.tree, added.id).index, 0);
  eq('the input tree is untouched', JSON.stringify(COLLECTIONS), pristine);
  eq('a link aimed at a group that is gone is refused', M.addCollectionLink(COLLECTIONS, { url: 'https://x.example', groupId: 'nope' }), null);

  const newGroup = M.addCollectionGroup(COLLECTIONS, { name: 'Child', parentId: '12' });
  eq('a subgroup lands inside its parent', M.findCollectionNode(newGroup.tree, newGroup.id).parentId, '12');

  const renamed = M.renameCollectionNode(COLLECTIONS, '12', 'Renamed');
  eq('rename lands', M.findCollectionNode(renamed, '12').node.name, 'Renamed');
  eq('the input tree is untouched', JSON.stringify(COLLECTIONS), pristine);

  const collapsed = M.setCollectionNodeCollapsed(COLLECTIONS, '12', true);
  eq('collapse lands', M.findCollectionNode(collapsed, '12').node.collapsed, true);

  const deleted = M.deleteCollectionNode(COLLECTIONS, '2');
  ok('deleting a group takes its whole subtree',
     !M.findCollectionNode(deleted, '2') && !M.findCollectionNode(deleted, '4') && !M.findCollectionNode(deleted, '9'));
  eq('the input tree is untouched', JSON.stringify(COLLECTIONS), pristine);

  section('Collections — drop zones and resize maths');
  const rect = { left: 100, width: 200 };
  eq('the left half is "before"',  M.collectionDropZoneX(rect, 120), 'before');
  eq('the right half is "after"',  M.collectionDropZoneX(rect, 280), 'after');
  eq('exactly on the midpoint is "after"', M.collectionDropZoneX(rect, 200), 'after');
  eq('a missing rect falls back', M.collectionDropZoneX(null, 10), 'after');

  // A card of span N is N columns plus (N-1) gaps wide
  const colUnit = 280, colGap = 12;
  const widthFor = (span) => span * colUnit + (span - 1) * colGap;

  eq('standing still keeps the span',
     M.collectionSpanFromDrag(widthFor(1), 0, colUnit, colGap, 4), 1);
  eq('one column of movement widens to two',
     M.collectionSpanFromDrag(widthFor(1), colUnit, colUnit, colGap, 4), 2);
  eq('dragging left shrinks, but never below one',
     M.collectionSpanFromDrag(widthFor(2), -colUnit * 3, colUnit, colGap, 4), 1);
  eq('a wide drag cannot exceed the columns available',
     M.collectionSpanFromDrag(widthFor(2), colUnit * 10, colUnit, colGap, 3), 3);
  eq('a zero column width leaves the card alone rather than maxing it out',
     M.collectionSpanFromDrag(300, 50, 0, colGap, 4), 1);

  section('Collections — tight packing');
  // Rows are 8px and the card's own 12px margin is part of its span
  eq('a tall card claims more rows', M.collectionRowSpan(100, 8, 12), 14);
  eq('...and a short one fewer',     M.collectionRowSpan(20, 8, 12), 4);
  ok('the span always covers the card plus its gap',
     M.collectionRowSpan(97, 8, 12) * 8 >= 97 + 12);
  eq('a zero height is left at one', M.collectionRowSpan(0, 8, 12), 1);
  eq('a nonsense row unit is refused', M.collectionRowSpan(100, 0, 12), 1);
  eq('a missing gap still works', M.collectionRowSpan(16, 8, undefined), 2);

  section('Collections — moving a node into another group');
  const moved4 = M.reparentCollectionNode(COLLECTIONS, '4', '6');      // mid's link into sft
  eq('it lands at the end of the new parent',
     M.findCollectionNode(moved4, '4').parentId, '6');
  eq('...and left the old one', M.findCollectionNode(moved4, '3').node.children.length, 1);
  eq('...with nothing lost', JSON.stringify(M.countCollectionNodes(moved4)), JSON.stringify({ groups: 12, items: 12 }));
  eq('the input tree is untouched', JSON.stringify(COLLECTIONS), pristine);

  const toRoot = M.reparentCollectionNode(COLLECTIONS, '4', null);
  eq('an empty parent means the top level', M.findCollectionNode(toRoot, '4').parentId, null);
  eq('...and it really is at the root', M.findCollectionNode(toRoot, '4').index,
     COLLECTIONS.nodes.length);

  eq('a group cannot move inside itself',
     M.reparentCollectionNode(COLLECTIONS, '2', '2'), null);
  eq('...nor into its own subtree',
     M.reparentCollectionNode(COLLECTIONS, '2', '6'), null);
  eq('an unknown node is refused', M.reparentCollectionNode(COLLECTIONS, 'nope', '6'), null);
  eq('an unknown parent is refused', M.reparentCollectionNode(COLLECTIONS, '4', 'nope'), null);

  // Assert WHY, not just that the outcome was null: a cyclic move returns null
  // anyway (the destination went away with the removed subtree), so the outcome
  // can't show the guard is doing anything.
  eq('the validator refuses a cycle', M.isValidCollectionReparent(COLLECTIONS, '2', '6'), false);
  eq('...refuses moving into itself', M.isValidCollectionReparent(COLLECTIONS, '2', '2'), false);
  eq('...refuses an unknown parent', M.isValidCollectionReparent(COLLECTIONS, '4', 'nope'), false);
  eq('...and allows a move that is fine', M.isValidCollectionReparent(COLLECTIONS, '4', '6'), true);
  eq('...including to the top level', M.isValidCollectionReparent(COLLECTIONS, '4', null), true);
  ok('moving a node that is already last returns the same tree',
     M.reparentCollectionNode(COLLECTIONS, '11', '9') === COLLECTIONS);

  section('Collections — where a node may move to');
  const targets = M.collectionMoveTargets(COLLECTIONS, '2');   // the v1 group
  const ids = targets.map(t => t.id);
  ok('the top level is always offered', ids.includes(''), JSON.stringify(ids));
  ok('the node itself is not offered', !ids.includes('2'));
  ok('nor anything inside it', !ids.includes('3') && !ids.includes('6') && !ids.includes('9'));
  ok('but unrelated groups are', ids.includes('12') && ids.includes('14'));
  ok('with readable path labels',
     targets.some(t => t.label === 'Deep / L2'), JSON.stringify(targets.map(t => t.label)));

  section('Collections — card width');
  // The fixture omits span entirely, like anything saved before this existed
  ok('an untouched tree carries no width at all',
     M.findCollectionNode(COLLECTIONS, '1').node.span === undefined);
  eq('...and sanitising defaults it to one column',
     M.findCollectionNode(M.sanitizeCollectionTree(COLLECTIONS), '1').node.span, 1);
  const widened = M.setCollectionNodeSpan(COLLECTIONS, '1', 3);
  eq('the span is set', M.findCollectionNode(widened, '1').node.span, 3);
  eq('the input tree is untouched', JSON.stringify(COLLECTIONS), pristine);
  eq('an oversized span is clamped',
     M.findCollectionNode(M.setCollectionNodeSpan(COLLECTIONS, '1', 99), '1').node.span, 4);
  eq('a nonsense span becomes one',
     M.findCollectionNode(M.setCollectionNodeSpan(COLLECTIONS, '1', 'wide'), '1').node.span, 1);
  eq('storage-level junk is clamped too',
     M.sanitizeCollectionTree({ nodes: [{ id: '1', type: 'group', span: -3 }] }).nodes[0].span, 1);

  section('Collections — moving');
  const moved = M.moveCollectionNode(COLLECTIONS, '13', '12', 'inside');
  eq('a link moves into another group',
     [M.findCollectionNode(moved, '13').parentId, M.findCollectionNode(moved, '12').node.children.length], ['12', 1]);
  eq('the input tree is untouched', JSON.stringify(COLLECTIONS), pristine);

  eq('a group cannot be dropped into its own subtree',
     M.moveCollectionNode(COLLECTIONS, '2', '3', 'inside'), null);
  eq('a group cannot be dropped into itself',
     M.moveCollectionNode(COLLECTIONS, '2', '2', 'inside'), null);
  eq('"inside" a link is refused', M.moveCollectionNode(COLLECTIONS, '13', '4', 'inside'), null);

  // Assert WHY each move is refused, not just that it produced null. A cycle
  // happens to return null even with the guard removed — the target group goes
  // away with the removed subtree — so the outcome alone proves nothing.
  eq('the validator rejects a cycle', M.isValidCollectionMove(COLLECTIONS, '2', '3', 'inside'), false);
  eq('...rejects dropping onto itself', M.isValidCollectionMove(COLLECTIONS, '2', '2', 'inside'), false);
  eq('...rejects "inside" a link', M.isValidCollectionMove(COLLECTIONS, '13', '4', 'inside'), false);
  eq('...and allows a move that is actually fine', M.isValidCollectionMove(COLLECTIONS, '13', '12', 'inside'), true);
  ok('a move that changes nothing returns the same tree',
     M.moveCollectionNode(COLLECTIONS, '4', '5', 'before') === COLLECTIONS);
}

/* ================================================================
   0c. Rendering the collected tabs tree
   ================================================================ */
async function testCollectionRender() {
  section('Collections — the tree renders');
  const app = await boot();
  const html = app.els.collectedTree.innerHTML;

  ok('groups render', html.includes('>d2d_mem<'));
  ok('nested children render', html.includes('>mid<') && html.includes('>sft<'));
  ok('deep nesting renders', html.includes('>L4<'));
  // Every group renders; the 2 links inside the collapsed group don't
  eq('every group renders as a card',
     (html.match(/class="mission-card collection-card/g) || []).length, 12);
  eq('...and the reachable links as chips',
     (html.match(/class="page-chip/g) || []).length, 10);
  eq('the header counts the whole tree, collapsed or not',
     app.els.collectionsCount.innerHTML, '12 groups · 12 items');
  eq('the initial render writes the tree exactly once', app.treeWrites(), 1);

  section('Collections — the cards match Open tabs');
  // The whole point of the restyle: these are literally the same classes an
  // Open tabs card uses, so the two sections can't drift apart.
  ok('a group card IS a .mission-card', /class="mission-card collection-card/.test(html));
  ok('...with the shared card header', html.includes('class="mission-content"') && html.includes('class="mission-top"'));
  ok('...the shared name style', html.includes('class="mission-name"'));
  ok('...the shared badge', html.includes('class="open-tabs-badge"'));
  ok('...and the shared chip container', html.includes('class="mission-pages"'));
  ok('...with the shared collapse toggle', html.includes('class="card-collapse-toggle"'));

  section('Collections — depth only subtracts');
  ok('the top level is the full card', html.includes('collection-card is-depth-0'));
  ok('level two drops the shadow', html.includes('collection-card is-depth-1'));
  ok('level three goes flat', html.includes('collection-card is-deep'));
  ok('only top-level groups are coloured',
     /data-depth="0"[^>]*data-group-color="\w+"/.test(html));
  ok('...and nested ones are not',
     !/data-depth="[1-9]"[^>]*data-group-color="\w+"/.test(html));
  ok('nesting is real containment', html.includes('class="collection-children"'));
  ok('the badge counts what is inside',
     html.includes('3 groups'), html.slice(0, 60));

  section('Collections — notes, snippets and status');
  ok('a note renders as a note', /data-node-type="note"/.test(html));
  ok('...showing its text', html.includes('encoder_old'));
  ok('a snippet renders as code', /data-node-type="snippet"/.test(html));
  ok('...inside a code block', html.includes('collection-code') && html.includes('torchrun'));
  ok('...labelled with its language', html.includes('collection-lang') && html.includes('bash'));
  eq('every visible leaf gets a status dot',
     (html.match(/class="collection-status/g) || []).length, 10);
  ok('a set status shows', html.includes('data-status="doing"') && html.includes('is-doing'));
  ok('...and an unset one is unset', html.includes('data-status=""'));

  section('Collections — the board');
  ok('the top-level cards sit on a grid',
     /class="collection-board" style="--collection-columns:\d+"/.test(html));
  eq('only top-level cards get a resize edge',
     (html.match(/class="collection-resize"/g) || []).length, 5);   // the five top-level groups
  ok('a board card carries its width', /data-depth="0"[^>]*data-span="1"/.test(html));
  ok('...and is draggable', /data-depth="0"[^>]*draggable="true"/.test(html));
  ok('a nested card is not draggable', !/data-depth="1"[^>]*draggable="true"/.test(html));
  ok('...and has no resize edge', !/data-depth="1"[^>]*[\s\S]{0,400}?collection-resize/.test(html));

  section('Collections — every board tile gets measured');
  // Six tiles: the five top-level groups plus the loose link at the root.
  // Measuring only the cards left that link in an 8px row, overlapping its
  // neighbours — which is exactly what a top-level note or snippet did.
  eq('the initial render already measured the board',
     app.styleWrites.filter(w => w.prop === '--row-span').length, 6);

  const writesBefore = app.styleWrites.length;
  app.sandbox.layoutCollectionBoard();
  const rowSpans = app.styleWrites.slice(writesBefore).filter(w => w.prop === '--row-span');
  eq('every tile gets a row span', rowSpans.length, 6);
  eq('...computed from its measured height',
     rowSpans[0] && rowSpans[0].value, 3);   // harness rects are 10px tall

  ok('a loose leaf on the board is a tile, not a stray row',
     /class="page-chip[^"]*" data-action="[^"]*" data-node-id="13" data-node-type="link" data-depth="0"/
       .test(html), html.slice(0, 80));
  ok('...while a chip inside a group reports its own depth',
     /data-node-type="link" data-depth="1"/.test(html) ||
     /data-node-type="note" data-depth="1"/.test(html));

  section('Collections — collapsing');
  ok('a collapsed group still shows its own row', html.includes('data-node-id="9"'));
  ok('...but not its children', !html.includes('wsj-d2dmemr-0919-1-n16-09212312'));
  ok('an expanded group does show its children', html.includes('wsj/d2d_mem/sft-0919-1'));

  section('Collections — untrusted names and urls');
  ok('a name containing markup is escaped',
     html.includes('&lt;img src=x') && !html.includes('<img src=x'));
  // Stronger than "no javascript: href": nothing in this tree is an anchor at
  // all, so there is no href for anything to hide in.
  ok('nothing in the collection tree is an anchor', !/<a\s/i.test(html));
  ok('...so there is no href to hide a javascript: url in', !/href=/i.test(html));

  ok('a scheme-less entry copies instead of opening',
     /class="page-chip is-copyable"[^>]*data-action="copy-collection-node"/.test(html));
  ok('a real url gets an open action',
     /class="page-chip clickable" data-action="open-collection-link"/.test(html));
  ok('a prose name renders verbatim', html.includes('encoder_old'));
  // Node 11 shares that url but sits inside the collapsed group, so exactly
  // one copy is on screen — the model suite proves the no-dedupe property
  eq('only the visible copy of a shared url renders',
     (html.match(/shared-report/g) || []).length, 1);

  section('Collections — the "Add to" select');
  const opts = app.els.collectTargetSelect.innerHTML;
  ok('offers the root', opts.includes('>Top level</option>'));
  ok('lists nested paths', opts.includes('d2d_mem / v1 / mid'), opts.slice(0, 120));
  ok('indents nested options with non-breaking spaces', opts.includes(' '));
  eq('offers the root plus every group',
     (opts.match(/<option/g) || []).length, 13);
}

async function testCollectionReflow() {
  section('Collections — one action, one visible update');
  const app = await boot();
  const local = app.sandbox.chrome.storage.local;

  const t0 = app.treeWrites();
  app.simulate.closeTab(3);
  app.simulate.updateTab(1, { title: 'Changed' });
  await wait(300);
  eq('tab churn does not touch the collection tree', app.treeWrites(), t0);

  const t1 = app.treeWrites();
  app.simulate.savedTabsChanged();
  await wait(300);
  eq('a saved-for-later change does not touch the tree', app.treeWrites(), t1);

  const r0 = app.renders();
  app.simulate.collectionsChanged();
  await wait(300);
  ok('a collections change re-renders', app.renders() > r0, `${r0} → ${app.renders()}`);
  eq('...but writes nothing when the content is unchanged', app.treeWrites(), t1);

  await local.set({ collections: { version: 1, nodes: [
    { id: '1', type: 'group', name: 'Brand new', collapsed: false, children: [] },
  ] } });
  await wait(300);
  ok('new content does rewrite the tree', app.els.collectedTree.innerHTML.includes('>Brand new<'));
}

/* ================================================================
   0d. Collected tabs — interactions

   Everything here asserts on app.storage(), not on markup: a correct paint
   over a lost write has to fail.
   ================================================================ */
async function testCollectionInteractions() {
  section('Collections — adding a link');
  const app = await boot();
  app.els.collectUrlInput  = app.makeEl('collectUrlInput');
  app.els.collectNameInput = app.makeEl('collectNameInput');

  app.els.collectUrlInput.value  = 'https://new.example/page';
  app.els.collectNameInput.value = 'A new link';
  await app.fire('add-collection-link', {});

  const added = allItems(app.storage().collections).find(n => n.name === 'A new link');
  ok('the link reached storage', !!added, JSON.stringify(app.storage().collections.nodes.map(n => n.name)));
  eq('...with the url it was given', added && added.url, 'https://new.example/page');
  eq('the url field is cleared for the next one', app.els.collectUrlInput.value, '');

  section('Collections — choosing a destination');
  await app.fireEvent('change', { target: { id: 'collectTargetSelect', value: '12' } });
  app.els.collectUrlInput.value = 'https://into-group.example';
  await app.fire('add-collection-link', {});

  const group12 = app.storage().collections.nodes.find(n => n.id === '12');
  ok('it landed inside the chosen group',
     group12.children.some(c => c.url === 'https://into-group.example'),
     JSON.stringify(group12.children.map(c => c.url)));

  await app.fireEvent('change', { target: { id: 'collectTargetSelect', value: '999' } });
  app.els.collectUrlInput.value = 'https://orphan-target.example';
  await app.fire('add-collection-link', {});
  ok('a link aimed at a group that no longer exists still lands somewhere',
     allItems(app.storage().collections).some(n => n.url === 'https://orphan-target.example'));

  section('Collections — renaming');
  await app.fire('rename-collection-node', { nodeId: '12' });
  let tree = app.els.collectedTree.innerHTML;
  ok('the label is replaced by a field', tree.includes('id="collection-rename-12"'));
  ok('...prefilled with the current name',
     /id="collection-rename-12"[^>]*value="Empty group"/.test(tree), tree.slice(0, 100));
  eq('...and it has focus', app.els['collection-rename-12'].focused, true);

  await app.fireEvent('input', { target: { id: 'collection-rename-12', value: 'Renamed' } });
  eq('typing alone does not write',
     app.storage().collections.nodes.find(n => n.id === '12').name, 'Empty group');

  await app.fireEvent('keydown', { key: 'Enter', target: { id: 'collection-rename-12', value: 'Renamed' } });
  eq('Enter commits it', app.storage().collections.nodes.find(n => n.id === '12').name, 'Renamed');
  ok('...and leaves edit mode', !app.els.collectedTree.innerHTML.includes('id="collection-rename-12"'));

  await app.fire('rename-collection-node', { nodeId: '12' });
  await app.fireEvent('keydown', { key: 'Escape', target: { id: 'collection-rename-12', value: 'Discarded' } });
  eq('Escape discards', app.storage().collections.nodes.find(n => n.id === '12').name, 'Renamed');

  section('Collections — a stale focusout cannot commit');
  await app.fire('rename-collection-node', { nodeId: '12' });
  await app.fireEvent('input', { target: { id: 'collection-rename-12', value: 'From a stale field' } });
  await app.fireEvent('focusout', { target: { id: 'collection-rename-12', value: 'From a stale field',
                                              dataset: { renameSession: '999999' } } });
  eq('the stale one is ignored',
     app.storage().collections.nodes.find(n => n.id === '12').name, 'Renamed');
  ok('...and the field is still open', app.els.collectedTree.innerHTML.includes('id="collection-rename-12"'));

  // The commit takes the draft the input events recorded, so type first
  const session = (app.els.collectedTree.innerHTML.match(/data-rename-session="(\d+)"/) || [])[1];
  await app.fireEvent('input', { target: { id: 'collection-rename-12', value: 'From the live field' } });
  await app.fireEvent('focusout', { target: { id: 'collection-rename-12',
                                              dataset: { renameSession: session } } });
  eq('the live one commits the current draft',
     app.storage().collections.nodes.find(n => n.id === '12').name, 'From the live field');

  section('Collections — collapsing persists');
  await app.fire('toggle-collection-group', { nodeId: '9' });   // fixture says collapsed
  eq('expanding is written', app.storage().collections.nodes.find(n => n.id === '1')
       .children[0].children[2].collapsed, false);
  ok('...and the children appear', app.els.collectedTree.innerHTML.includes('wsj-d2dmemr-0919-1-n16-09212312'));
  await app.fire('toggle-collection-group', { nodeId: '9' });
  ok('collapsing hides them again', !app.els.collectedTree.innerHTML.includes('wsj-d2dmemr-0919-1-n16-09212312'));

  section('Collections — resizing a card');
  await app.sandbox.commitCollectionSpan('12', 3);
  eq('the width is persisted',
     app.storage().collections.nodes.find(n => n.id === '12').span, 3);
  ok('...and rendered',
     /data-node-id="12"[^>]*data-span="3"/.test(app.els.collectedTree.innerHTML));

  await app.sandbox.commitCollectionSpan('12', 99);
  eq('an oversized width is clamped, not honoured',
     app.storage().collections.nodes.find(n => n.id === '12').span, 4);

  section('Collections — reordering the board');
  const rootIdsBefore = app.storage().collections.nodes.map(n => n.id);
  eq('the board starts in its authored order', rootIdsBefore.slice(0, 3), ['1', '12', '13']);

  eq('moving a card reports that it happened',
     await app.sandbox.commitCollectionMove('19', '1', 'before'), true);
  eq('...and lands before its target',
     app.storage().collections.nodes.map(n => n.id).slice(0, 2), ['19', '1']);
  eq('...with nothing lost',
     app.storage().collections.nodes.length, rootIdsBefore.length);

  eq('dropping a card onto itself does nothing',
     await app.sandbox.commitCollectionMove('19', '19', 'before'), false);

  // Repeating that move is VALID but resolves to where the card already sits —
  // this is the path that returns the same tree, not the early bail above
  const frozen = JSON.stringify(app.storage().collections.nodes);
  eq('repeating a move that changes nothing reports nothing',
     await app.sandbox.commitCollectionMove('19', '1', 'before'), false);
  eq('...and writes nothing at all',
     JSON.stringify(app.storage().collections.nodes), frozen);

  await app.sandbox.commitCollectionMove('19', '1', 'after');
  eq('dropping after a card puts it behind',
     app.storage().collections.nodes.map(n => n.id).slice(0, 2), ['1', '19']);

  section('Collections — deleting takes two clicks');
  await app.fire('delete-collection-node', { nodeId: '14' });
  ok('the first click only arms', !!app.els.collectedTree.innerHTML.match(/is-confirming/));
  ok('...and deletes nothing',
     app.storage().collections.nodes.some(n => n.id === '14'));
  await app.fire('delete-collection-node', { nodeId: '14' });
  const after = app.storage().collections;
  ok('the second click removes the group and its subtree',
     !after.nodes.some(n => n.id === '14') && !after.nodes.some(n => n.id === '18'));

  section('Collections — opening a link');
  const opened = await app.fire('open-collection-link', { nodeId: '4' });
  eq('a real link opens in a new tab',
     opened.created, [{ url: 'https://tracker.example/runs/wsj-d2dmid-0901-1-n32-09012201' }]);

  const notOpened = await app.fire('open-collection-link', { nodeId: '5' });   // no scheme
  eq('a scheme-less entry opens nothing at all', notOpened.created, []);

  section('Collections — moving a link to another group');
  await app.fire('move-collection-node', { nodeId: '4' });
  let moveHtml = app.els.collectedTree.innerHTML;
  ok('the name gives way to a destination picker', moveHtml.includes('id="collection-move-4"'));
  ok('...preselecting where it lives now', /<option value="3" selected>/.test(moveHtml), moveHtml.slice(0, 60));
  ok('...and offering the other groups', /<option value="6">/.test(moveHtml));

  await app.fireEvent('change', { target: { id: 'collection-move-4', value: '6' } });
  const v1 = app.storage().collections.nodes[0].children[0];
  ok('choosing a destination moves it there',
     v1.children[1].children.some(c => c.id === '4'),
     JSON.stringify(v1.children.map(c => c.id)));
  ok('...and it left the old group',
     !v1.children[0].children.some(c => c.id === '4'));
  ok('...and the picker closed',
     !app.els.collectedTree.innerHTML.includes('id="collection-move-4"'));

  section('Collections — a group is never offered itself');
  await app.fire('move-collection-node', { nodeId: '3' });
  moveHtml = app.els.collectedTree.innerHTML;
  ok('the group itself is not a destination', !/<option value="3"/.test(moveHtml));
  ok('...nor anything inside it',
     !/<option value="4"/.test(moveHtml) && !/<option value="5"/.test(moveHtml));
  ok('...but unrelated groups are', /<option value="12"/.test(moveHtml));

  await app.fireEvent('keydown', { key: 'Escape', target: { id: 'collection-move-3' } });
  ok('Escape closes it', !app.els.collectedTree.innerHTML.includes('id="collection-move-3"'));

  section('Collections — clicking away from the picker');
  await app.fire('move-collection-node', { nodeId: '4' });
  const v1Before = JSON.stringify(app.storage().collections.nodes[0].children[0]);
  await app.fireEvent('focusout', { target: { id: 'collection-move-4' } });
  ok('closing without choosing changes nothing',
     JSON.stringify(app.storage().collections.nodes[0].children[0]) === v1Before);
  ok('...and closes the picker',
     !app.els.collectedTree.innerHTML.includes('id="collection-move-4"'));

  section('Collections — the edit fields own their clicks');
  await app.fire('rename-collection-node', { nodeId: '4' });
  ok('the rename field carries its own action',
     /id="collection-rename-4"[^>]*data-action="collection-edit-field"/.test(app.els.collectedTree.innerHTML));
  await app.fireEvent('keydown', { key: 'Escape', target: { id: 'collection-rename-4' } });
  await app.fire('move-collection-node', { nodeId: '4' });
  ok('...and so does the move picker',
     /id="collection-move-4"[^>]*data-action="collection-edit-field"/.test(app.els.collectedTree.innerHTML));
  await app.fireEvent('keydown', { key: 'Escape', target: { id: 'collection-move-4' } });

  section('Collections — typing is cheap');
  await app.fire('rename-collection-node', { nodeId: '12' });
  const writes = app.treeWrites();
  const renders = app.renders();
  await app.fireEvent('input', { target: { id: 'collection-rename-12', value: 'a' } });
  await app.fireEvent('input', { target: { id: 'collection-rename-12', value: 'ab' } });
  eq('keystrokes do not rewrite the tree', app.treeWrites(), writes);
  eq('...and do not run a render', app.renders(), renders);
}

async function testCollectionRenameSurvivesSync() {
  section('Collections — a rename survives a live-sync rewrite');
  const app = await boot();

  await app.fire('rename-collection-node', { nodeId: '12' });
  await app.fireEvent('input', { target: { id: 'collection-rename-12', value: 'half typed' } });

  // Force a rewrite of the tree from outside: another window collecting
  // something. This is what replaces the field underneath you.
  const changed = JSON.parse(JSON.stringify(COLLECTIONS));
  changed.nodes.push({ id: '99', type: 'link', name: 'From another window', url: 'https://other.example' });
  await app.sandbox.chrome.storage.local.set({ collections: changed });
  await wait(400);

  const tree = app.els.collectedTree.innerHTML;
  ok('the other window\'s link arrived', tree.includes('From another window'));
  ok('...and the half-typed name is still in the field',
     tree.includes('value="half typed"'), tree.slice(0, 120));
  eq('...with nothing written yet',
     app.storage().collections.nodes.find(n => n.id === '12').name, 'Empty group');
  eq('...and the field has focus back', app.els['collection-rename-12'].focused, true);
}

/* ================================================================
   0e. Collecting a tab from an Open tabs chip
   ================================================================ */
async function testCollectFromChip() {
  section('Collections — collecting from Open tabs');
  const app = await boot();

  section('Chips carry a collect button');
  const gridHtml = app.html();
  ok('the chip offers collecting', gridHtml.includes('data-action="collect-tab"'));
  ok('...carrying the tab id', /data-action="collect-tab" data-tab-id="1"/.test(gridHtml));
  ok('...and saying the tab stays open',
     /data-action="collect-tab"[^>]*leaves the tab open/.test(gridHtml));

  section('Collecting leaves the tab alone');
  const calls = await app.fire('collect-tab', { tabId: '1' });
  eq('it does NOT close the tab', calls.remove, []);

  let collected = allItems(app.storage().collections).find(n => n.url === 'https://github.com/a');
  ok('the tab reached the collection', !!collected,
     JSON.stringify(app.storage().collections.nodes.map(n => n.url || n.name)));
  eq('...with the icon captured from the live tab', collected && collected.favIconUrl,
     'https://github.githubassets.com/favicon.ico');
  eq('...and a name from the tab', collected && collected.name, 'a/b — GitHub');

  section('Collecting into a chosen group');
  await app.fireEvent('change', { target: { id: 'collectTargetSelect', value: '3' } });
  const calls2 = await app.fire('collect-tab', { tabId: '2' });
  eq('still leaves the tab open', calls2.remove, []);

  const mid = app.storage().collections.nodes[0].children[0].children[0];
  ok('...and lands inside that group',
     mid.children.some(c => c.url === 'https://www.youtube.com/watch?v=1'),
     JSON.stringify(mid.children.map(c => c.url)));

  section('Collecting into a group that vanished');
  await app.fireEvent('change', { target: { id: 'collectTargetSelect', value: '424242' } });
  await app.fire('collect-tab', { tabId: '5' });
  ok('falls back to the top level',
     allItems(app.storage().collections).some(n => n.url === 'https://news.com'));
}

/* ================================================================
   0f. A personal link prefix, from config.local.js
   ================================================================ */
async function testCollectionLinkPrefixes() {
  section('Collections — a personal link prefix');
  const app = await boot({ globals: { LOCAL_LINK_PREFIXES: { 'wsj/': 'https://tracker.internal/' } } });

  eq('a bare path resolves through the mapping',
     app.sandbox.safeCollectionHref('wsj/d2d_mem/mid-0901-1'),
     'https://tracker.internal/d2d_mem/mid-0901-1');
  ok('...and the bare-path entry now opens rather than copying',
     /class="page-chip clickable"[^>]*data-action="open-collection-link"[^>]*data-node-id="5"/
       .test(app.els.collectedTree.innerHTML),
     app.els.collectedTree.innerHTML.slice(0, 80));

  const two = await boot({ globals: { LOCAL_LINK_PREFIXES: {
    'wsj/': 'https://a.example/',
    'wsj/d2d_mem/': 'https://b.example/',
  } } });
  eq('the longest matching prefix wins',
     two.sandbox.safeCollectionHref('wsj/d2d_mem/x'), 'https://b.example/x');
  eq('...and a short one still applies elsewhere',
     two.sandbox.safeCollectionHref('wsj/other'), 'https://a.example/other');

  // The mapping must not become a way to smuggle a javascript: link in
  const hostile = await boot({ globals: { LOCAL_LINK_PREFIXES: { 'wsj/': 'javascript:alert(1)' } } });
  eq('a non-http base is refused outright',
     hostile.sandbox.safeCollectionHref('wsj/x'), '');
  eq('...and so is a non-object config',
     (await boot({ globals: { LOCAL_LINK_PREFIXES: 'nope' } })).sandbox.safeCollectionHref('wsj/x'), '');
}

/* ================================================================
   0g. The three kinds of entry, and what a click does
   ================================================================ */
/**
 * Batch closes take two clicks by design — the first arms, the second does it.
 * This fires both and returns the calls the confirming click made.
 */
async function fireTwice(app, action, dataset, card) {
  await app.fire(action, dataset, card);
  return app.fire(action, dataset, card);
}

/** Every entry in the tree, wherever it sits. */
function allItems(tree) {
  const out = [];
  (function walk(nodes) {
    for (const node of nodes || []) {
      if (node.type === 'group') walk(node.children);
      else out.push(node);
    }
  })(tree && tree.nodes);
  return out;
}

function seedToolbar(app) {
  app.els.collectKindSelect    = app.makeEl('collectKindSelect');
  app.els.collectUrlInput      = app.makeEl('collectUrlInput');
  app.els.collectNameInput     = app.makeEl('collectNameInput');
  app.els.collectLanguageInput = app.makeEl('collectLanguageInput');
  return app.els;
}

async function testCollectionKinds() {
  section('Collections — adding a note');
  const app = await boot();
  const els = seedToolbar(app);

  els.collectKindSelect.value = 'note';
  els.collectUrlInput.value   = 'A note about the run\nsecond line';
  els.collectNameInput.value  = 'Why we froze it';
  await app.fire('add-collection-link', {});

  const note = allItems(app.storage().collections).find(n => n.name === 'Why we froze it');
  ok('the note is stored', !!note, JSON.stringify(app.storage().collections.nodes.map(n => n.type)));
  eq('...with its whole text, newlines intact', note && note.text, 'A note about the run\nsecond line');
  eq('...and its name', note && note.name, 'Why we froze it');

  section('Collections — adding a snippet');
  els.collectKindSelect.value    = 'snippet';
  els.collectUrlInput.value      = 'torchrun --nproc_per_node 8 train.py';
  els.collectLanguageInput.value = 'bash';
  await app.fire('add-collection-link', {});

  const snippet = allItems(app.storage().collections)
    .find(n => n.type === 'snippet' && n.code === 'torchrun --nproc_per_node 8 train.py');
  ok('the snippet is stored', !!snippet);
  eq('...with its code', snippet && snippet.code, 'torchrun --nproc_per_node 8 train.py');
  eq('...and its language', snippet && snippet.language, 'bash');

  section('Collections — a pasted list becomes several entries');
  els.collectKindSelect.value = 'link';
  els.collectUrlInput.value   = 'https://one.example\nhttps://two.example\n\nhttps://three.example';
  await app.fire('add-collection-link', {});

  const urls = allItems(app.storage().collections).map(n => n.url).filter(Boolean);
  ok('every non-empty line landed',
     ['https://one.example', 'https://two.example', 'https://three.example'].every(u => urls.includes(u)),
     JSON.stringify(urls));

  section('Collections — adding something already there');
  els.collectUrlInput.value = 'https://one.example';
  const before = allItems(app.storage().collections).length;
  await app.fire('add-collection-link', {});
  eq('it is still added — duplicates are allowed', allItems(app.storage().collections).length, before + 1);
  ok('...but the toast says where it already lives',
     String(app.els.toastText.textContent).includes('already in'), app.els.toastText.textContent);

  section('Collections — copying an entry');
  const copied = await app.fire('copy-collection-node', { nodeId: '5' });   // a bare path
  eq('the stored value goes to the clipboard', copied.copied, ['wsj/d2d_mem/mid-0901-1']);
  eq('...and the toast confirms it', app.els.toastText.textContent, 'Copied');

  section('Collections — the status cycle');
  const statusOf = (id) => {
    const found = app.sandbox.findCollectionNode(app.storage().collections, id);
    return found ? found.node.status : undefined;
  };
  eq('node 23 starts out doing', statusOf('23'), 'doing');
  await app.fire('cycle-collection-status', { nodeId: '23' });
  eq('...cycles to done', statusOf('23'), 'done');
  await app.fire('cycle-collection-status', { nodeId: '23' });
  eq('...to dropped', statusOf('23'), 'dropped');
  await app.fire('cycle-collection-status', { nodeId: '23' });
  eq('...and back to none', statusOf('23'), '');
  await app.fire('cycle-collection-status', { nodeId: '23' });
  eq('...then round again', statusOf('23'), 'todo');
}

async function testCollectionHyperlinkPaste() {
  section('Collections — the hyperlink extractor');
  const app = await boot();
  const M = app.sandbox;

  eq('pulls the href and the visible text',
     M.extractFirstHyperlink('<a href="https://x.example/a">Hello</a>'),
     { url: 'https://x.example/a', text: 'Hello' });
  eq('decodes entities in both',
     M.extractFirstHyperlink('<a href="https://x.example/?a=1&amp;b=2">A &amp; B</a>'),
     { url: 'https://x.example/?a=1&b=2', text: 'A & B' });
  eq('flattens nested markup',
     M.extractFirstHyperlink('<a href="https://x.example"><b>Bold</b> text</a>').text, 'Bold text');

  // &amp; has to be decoded last, or "&amp;lt;" comes out as "<"
  eq('an escaped entity is not decoded twice', M.decodeCollectionText('&amp;lt;'), '&lt;');
  eq('the first of several wins',
     M.extractFirstHyperlink('<a href="https://one.example">1</a><a href="https://two.example">2</a>').url,
     'https://one.example');
  eq('an anchor with no href is not a link', M.extractFirstHyperlink('<a name="x">y</a>'), null);
  eq('text with no anchor is not a link', M.extractFirstHyperlink('<p>just words</p>'), null);
  eq('junk is survived', M.extractFirstHyperlink(undefined), null);

  section('Collections — pasting from a document');
  const els = seedToolbar(app);
  const clipboardHtml = '<meta charset="utf-8"><a href="https://tracker.example/runs/xyz-1">wsj-d2dmem-mid-0901-1-n32</a>';
  const paste = (target, html) => app.fireEvent('paste', {
    target,
    clipboardData: { getData: (type) => (type === 'text/html' ? html : 'wsj-d2dmem-mid-0901-1-n32') },
  });

  await paste(els.collectUrlInput, clipboardHtml);
  eq('the address comes out of the hyperlink', els.collectUrlInput.value, 'https://tracker.example/runs/xyz-1');
  eq('...and the words become the name', els.collectNameInput.value, 'wsj-d2dmem-mid-0901-1-n32');

  await app.fire('add-collection-link', {});
  const added = allItems(app.storage().collections).find(n => n.url === 'https://tracker.example/runs/xyz-1');
  ok('both survive into the collection', !!added && added.name === 'wsj-d2dmem-mid-0901-1-n32',
     JSON.stringify(added));

  section('Collections — pastes it should leave alone');
  els.collectUrlInput.value = 'https://typed.example';
  await paste(els.collectUrlInput, clipboardHtml);
  eq('a paste into a field you have typed in is left to the browser',
     els.collectUrlInput.value, 'https://typed.example');

  els.collectUrlInput.value = '';
  await paste(els.collectUrlInput, '');
  eq('a paste with no hyperlink in it is left to the browser', els.collectUrlInput.value, '');

  els.collectKindSelect.value = 'note';
  await paste(els.collectUrlInput, clipboardHtml);
  eq('a note keeps the raw paste, hyperlink or not', els.collectUrlInput.value, '');
}

async function testCollectionAutoGroups() {
  section('Collections — a top-level entry gets a group of its own');
  const app = await boot();
  const els = seedToolbar(app);
  const tree = () => app.storage().collections;
  const groupNamed = (name) => tree().nodes.find(n => n.type === 'group' && n.name === name);

  els.collectKindSelect.value = 'link';
  els.collectUrlInput.value   = 'https://loose.example/one';
  await app.fire('add-collection-link', {});

  const link1 = groupNamed('Link1');
  ok('the link did not land loose at the top level', !!link1,
     JSON.stringify(tree().nodes.map(n => n.name)));
  eq('...it went into a group', link1 && link1.children.length, 1);
  eq('...holding the link itself', link1 && link1.children[0].url, 'https://loose.example/one');

  els.collectUrlInput.value = 'https://loose.example/two';
  await app.fire('add-collection-link', {});
  ok('the next one is Link2', !!groupNamed('Link2'));
  eq('...and Link1 was left alone', groupNamed('Link1').children.length, 1);

  section('Collections — a group per kind of entry');
  els.collectKindSelect.value = 'note';
  els.collectUrlInput.value   = 'a loose note';
  await app.fire('add-collection-link', {});
  ok('a note group is called Note1', !!groupNamed('Note1'));

  els.collectKindSelect.value    = 'snippet';
  els.collectUrlInput.value      = 'echo hi';
  els.collectLanguageInput.value = 'bash';
  await app.fire('add-collection-link', {});
  ok('a code group is called Code1', !!groupNamed('Code1'));

  section('Collections — a pasted list is one group, not many');
  els.collectKindSelect.value = 'link';
  els.collectUrlInput.value   = 'https://bulk.example/a\nhttps://bulk.example/b\nhttps://bulk.example/c';
  await app.fire('add-collection-link', {});

  const bulk = groupNamed('Link3');
  ok('the whole paste went into one new group', !!bulk, JSON.stringify(tree().nodes.map(n => n.name)));
  eq('...with every line in it', bulk && bulk.children.length, 3);

  section('Collections — an auto name never collides');
  const M = app.sandbox;
  const taken = { version: 1, nodes: [
    { id: '1', type: 'group', name: 'Link1', collapsed: false, children: [] },
    { id: '2', type: 'group', name: 'Link2', collapsed: false, children: [] },
  ]};
  eq('it skips numbers already used', M.nextCollectionAutoGroupName(taken, 'link'), 'Link3');
  eq('...and starts at one otherwise', M.nextCollectionAutoGroupName(taken, 'snippet'), 'Code1');
  eq('...falling back for an unknown kind', M.nextCollectionAutoGroupName(taken, 'nonsense'), 'Item1');

  const wrapped = M.collectionWrapTopLevel(taken, null, 'link');
  eq('wrapping reports the new group', wrapped.parentId, '3');
  eq('...created at the top level', wrapped.tree.nodes[wrapped.tree.nodes.length - 1].name, 'Link3');

  section('Collections — an explicit destination is left alone');
  const explicit = M.collectionWrapTopLevel(COLLECTIONS, '12', 'link');
  eq('a named group is used as-is', explicit.parentId, '12');
  ok('...and nothing new is created', explicit.tree === COLLECTIONS);
}

async function testCollectionFilter() {
  section('Collections — filtering');
  const app = await boot();

  await app.fireEvent('input', { target: { id: 'collectionFilterInput', value: 'encoder_old' } });
  let html = app.els.collectedTree.innerHTML;
  ok('the match survives', html.includes('encoder_old'));
  ok('...its group is kept for context', html.includes('Notes &amp; code'), html.slice(0, 90));
  ok('...and unrelated branches are gone', !html.includes('>d2d_mem<'));
  ok('...including its siblings that do not match', !html.includes('torchrun'));

  await app.fireEvent('input', { target: { id: 'collectionFilterInput', value: 'nothing at all matches this' } });
  ok('a filter matching nothing empties the board',
     app.els.collectionsEmpty.textContent.includes('Nothing matches'),
     app.els.collectionsEmpty.textContent);
  ok('...and the tree is hidden', app.els.collectedTree.style.display === 'none');

  section('Collections — filtering by status');
  await app.fireEvent('input', { target: { id: 'collectionFilterInput', value: '' } });
  await app.fireEvent('change', { target: { id: 'collectionStatusFilter', value: 'doing' } });

  html = app.els.collectedTree.innerHTML;
  ok('only that status shows', html.includes('torchrun'));
  ok('...and the rest does not', !html.includes('mid run'));

  await app.fireEvent('change', { target: { id: 'collectionStatusFilter', value: '' } });
  html = app.els.collectedTree.innerHTML;
  ok('clearing the filter brings everything back',
     html.includes('>d2d_mem<') && html.includes('torchrun'));
}

async function testCollectWholeGroup() {
  section('Collections — collecting a whole Chrome group');
  const app = await boot();

  const calls = await app.fire('collect-group-tabs', { groupId: '10' });   // Work: github + youtube
  eq('the tabs are left open', calls.remove, []);

  const work = app.storage().collections.nodes.find(n => n.type === 'group' && n.name === 'Work');
  ok('a subgroup named after the Chrome group appears', !!work,
     JSON.stringify(app.storage().collections.nodes.map(n => n.name)));
  eq('...holding one entry per tab', work.children.length, 2);
  ok('...with the tabs\' own addresses',
     work.children.some(c => c.url === 'https://github.com/a') &&
     work.children.some(c => c.url === 'https://www.youtube.com/watch?v=1'));

  section('Collections — the button only exists where it makes sense');
  const grid = app.html();
  ok('a real Chrome group offers it',
     /data-action="collect-group-tabs" data-group-id="10"/.test(grid));
  ok('the Ungrouped card does not',
     !/data-action="collect-group-tabs" data-group-id="-1"/.test(grid));
}

/* ================================================================
   0g2. Editing a note edits its text, not an incidental name
   ================================================================ */
async function testCollectionBodyEditing() {
  section('Collections — editing a note edits its text');
  const app = await boot();
  const nodeOf = (id) => app.sandbox.findCollectionNode(app.storage().collections, id).node;

  await app.fire('rename-collection-node', { nodeId: '22' });   // the fixture's note
  const html = app.els.collectedTree.innerHTML;

  ok('the note text becomes a field',
     /<textarea class="collection-body-edit"[^>]*id="collection-body-22"/.test(html), html.slice(0, 140));
  ok('...prefilled with the note', html.includes('encoder_old'));
  eq('...and the TEXT is what gets focus, not the name',
     app.els['collection-body-22'].focused, true);
  ok('...with the name field beside it', html.includes('id="collection-rename-22"'));

  await app.fireEvent('input', { target: { id: 'collection-body-22', value: 'rewritten text' } });
  ok('typing alone does not write yet', nodeOf('22').text.includes('encoder_old'));

  await app.fireEvent('focusout', { target: { id: 'collection-body-22' } });
  eq('clicking away saves the text', nodeOf('22').text, 'rewritten text');
  ok('...and the editor closes', !app.els.collectedTree.innerHTML.includes('id="collection-body-22"'));

  section('Collections — moving between the two fields keeps the editor open');
  await app.fire('rename-collection-node', { nodeId: '22' });
  await app.fireEvent('focusout', {
    target:        { id: 'collection-rename-22' },
    relatedTarget: { id: 'collection-body-22' },
  });
  ok('name → text does not commit it shut',
     app.els.collectedTree.innerHTML.includes('id="collection-body-22"'));

  section('Collections — Escape still discards');
  await app.fireEvent('input', { target: { id: 'collection-body-22', value: 'discarded' } });
  await app.fireEvent('keydown', { key: 'Escape', target: { id: 'collection-body-22' } });
  eq('the text is left as it was', nodeOf('22').text, 'rewritten text');

  section('Collections — a snippet edits its code the same way');
  await app.fire('rename-collection-node', { nodeId: '23' });
  ok('the code becomes a field',
     app.els.collectedTree.innerHTML.includes('id="collection-body-23"'));
  await app.fireEvent('input', { target: { id: 'collection-body-23', value: 'torchrun --nproc 2' } });
  await app.fireEvent('focusout', { target: { id: 'collection-body-23' } });
  eq('and it saves', nodeOf('23').code, 'torchrun --nproc 2');

  section('Collections — a link still edits its name');
  await app.fire('rename-collection-node', { nodeId: '4' });
  ok('a link has no body field',
     !app.els.collectedTree.innerHTML.includes('id="collection-body-4"'));
  ok('...just its name', app.els.collectedTree.innerHTML.includes('id="collection-rename-4"'));
}

/* ================================================================
   0h. A batch close asks first; closing one tab does not
   ================================================================ */
async function testBatchCloseConfirmation() {
  section('Closing — a batch close asks first');
  const app = await boot();
  const card = makeEl('card');
  card.classList.add('mission-card');

  const first = await app.fire('close-group-tabs', { groupId: '10' }, card);
  eq('the first click closes nothing', first.remove, []);
  ok('...it arms the button', first.actionEl.classList.contains('is-confirming'));
  ok('...and says so', String(app.els.toastText.textContent).includes('Click again'),
     app.els.toastText.textContent);

  // Arming is per control. Clicking a DIFFERENT group must not read as the
  // confirmation for this one — and it disarms this one, so coming back needs
  // two clicks again.
  const other = await app.fire('close-group-tabs', { groupId: '12' }, card);
  eq('a different group does not confirm the first', other.remove, []);
  ok('...it arms itself instead', other.actionEl.classList.contains('is-confirming'));

  const otherAgain = await app.fire('close-group-tabs', { groupId: '12' }, card);
  eq('...and its own second click does its work', otherAgain.remove, [[7]]);

  const back = await app.fire('close-group-tabs', { groupId: '10' }, card);
  eq('the first group was disarmed meanwhile', back.remove, []);
  const second = await app.fire('close-group-tabs', { groupId: '10' }, card);
  eq('...so it closes on the next click', second.remove, [[1, 2]]);

  section('Closing — duplicates ask first too');
  const dedup = await app.fire('dedup-keep-one', { groupId: '11' }, card);
  eq('the first click closes nothing', dedup.remove, []);
  const dedup2 = await app.fire('dedup-keep-one', { groupId: '11' }, card);
  eq('...the second closes the extras', dedup2.remove, [[4]]);

  section('Closing — one tab is still one click');
  const single = await app.fire('close-single-tab', { tabId: '3' }, card);
  eq('the chip X acts immediately', single.remove, [[3]]);

  section('Closing — the section-wide button');
  const wide = await app.fire('close-all-open-tabs', {}, card);
  eq('it asks first too', wide.remove, []);
  ok('...and arms', wide.actionEl.classList.contains('is-confirming'));

  const wide2 = await app.fire('close-all-open-tabs', {}, card);
  ok('...the second closes everything that is left',
     wide2.remove[0] && wide2.remove[0].length > 0, JSON.stringify(wide2.remove));

  section('Closing — the Tab Out banner');
  const banner = await app.fire('close-tabout-dupes', {}, card);
  eq('it asks first too', banner.remove, []);
  ok('...with its own wording',
     String(app.els.toastText.textContent).includes('Click again'),
     app.els.toastText.textContent);
}

/* ================================================================
   0i. Theme
   ================================================================ */
async function testTheme() {
  section('Theme — the three modes');
  const app = await boot();
  const applied = () => app.sandbox.document.documentElement.dataset.theme;
  const stored  = () => app.sandbox.localStorage.getItem('tab-out-theme');
  const pressed = () => ['themeLight', 'themeSystem', 'themeDark']
    .filter(id => app.els[id] && app.els[id]['aria-pressed'] === 'true');

  eq('it starts by following a light system', applied(), 'light');
  eq('...with nothing stored yet', stored(), null);

  section('Theme — choosing a mode');
  await app.fire('set-theme', { themeChoice: 'dark' });
  eq('dark applies immediately', applied(), 'dark');
  eq('...and is remembered', stored(), 'dark');
  eq('...and only that button reads as pressed', pressed(), ['themeDark']);

  await app.fire('set-theme', { themeChoice: 'light' });
  eq('light applies', applied(), 'light');
  eq('...and is remembered', stored(), 'light');
  eq('...and only that button reads as pressed', pressed(), ['themeLight']);

  section('Theme — following the system');
  await app.fire('set-theme', { themeChoice: 'system' });
  eq('a light system means light', applied(), 'light');
  eq('...but SYSTEM is the pressed button, not light',
     pressed(), ['themeSystem']);

  app.simulate.setSystemDark(true);
  eq('an OS switch is followed', applied(), 'dark');
  eq('...without changing which mode is chosen', pressed(), ['themeSystem']);

  section('Theme — an explicit choice ignores the system');
  await app.fire('set-theme', { themeChoice: 'light' });
  app.simulate.setSystemDark(false);
  app.simulate.setSystemDark(true);
  eq('explicit light stays light while the OS goes dark', applied(), 'light');

  section('Theme — the confetti follows it too');
  await app.fire('set-theme', { themeChoice: 'dark' });
  eq('dark gets the lighter palette', app.sandbox.currentConfettiPalette()[0], '#e59a63');
  await app.fire('set-theme', { themeChoice: 'light' });
  eq('light gets the original one', app.sandbox.currentConfettiPalette()[0], '#c8713a');
  // Reached through the function, not the constant: a top-level `const` lives
  // in the vm's lexical scope and never appears on the sandbox object.
  await app.fire('set-theme', { themeChoice: 'light' });
  const lightSet = app.sandbox.currentConfettiPalette();
  await app.fire('set-theme', { themeChoice: 'dark' });
  const darkSet = app.sandbox.currentConfettiPalette();
  ok('...and the two share no colours',
     lightSet.every(colour => !darkSet.includes(colour)), JSON.stringify({ lightSet, darkSet }));

  section('Theme — junk falls back to following the system');
  eq('an unknown mode reads as system', app.sandbox.normalizeThemeChoice('neon'), 'system');
  eq('a missing one too', app.sandbox.normalizeThemeChoice(undefined), 'system');
}

async function testThemeStylesheet() {
  section('Theme — the stylesheet carries no light-only colour');
  const fs   = require('fs');
  const path = require('path');
  const css  = fs.readFileSync(path.join(__dirname, '..', 'extension', 'style.css'), 'utf8');

  // Everything outside :root has to go through a hue token, or it stays pinned
  // to the light palette no matter what theme is active. This is the guard
  // that keeps a future edit from quietly reintroducing one.
  const rootEnd     = css.indexOf('\n}\n', css.indexOf(':root {'));
  const outsideRoot = css.slice(rootEnd);
  const literals    = outsideRoot.match(/rgba\([^)]*\)/g) || [];
  const lightOnly   = literals.filter(l => !/^rgba\(0,\s*0,\s*0/.test(l));

  eq('every alpha overlay outside :root goes through a token', lightOnly, []);

  const dark = css.slice(css.indexOf('[data-theme="dark"]'));
  ok('a dark theme exists', dark.length > 0);
  for (const token of ['--paper', '--card-bg', '--ink', '--muted', '--ink-soft',
                       '--shadow', '--rgb-ink', '--group-blue', '--accent-amber']) {
    ok(`...and redefines ${token}`, dark.includes(`${token}:`), token);
  }

  ok('the page declares a colour scheme for both',
     /color-scheme: light/.test(css) && /color-scheme: dark/.test(css));
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
  let c = await fireTwice(app, 'close-group-tabs', { groupId: '10' }, card);
  eq('closes exactly that group\'s tabs — not every tab on those hostnames',
     c.remove, [[1, 2]]);

  c = await fireTwice(app, 'close-group-tabs', { groupId: '-1' }, card);
  eq('Ungrouped closes every tab it displays, including the orphan',
     c.remove, [[5, 8, 9, 12]]);

  section('Duplicates');
  c = await fireTwice(app, 'dedup-keep-one', { groupId: '11' }, card);
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
  const c = await fireTwice(app, 'close-group-tabs', { groupId: '-1' }, card);
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
  await fireTwice(app, 'close-group-tabs', { groupId: '11' }, card);
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
  ['harness',                   testHarnessStore],
  ['collection model',          testCollectionModel],
  ['collection render',         testCollectionRender],
  ['collection reflow',         testCollectionReflow],
  ['collection interactions',   testCollectionInteractions],
  ['collection rename + sync',  testCollectionRenameSurvivesSync],
  ['collect from chip',         testCollectFromChip],
  ['collections: link prefix',  testCollectionLinkPrefixes],
  ['collections: entry kinds',  testCollectionKinds],
  ['collections: link paste',   testCollectionHyperlinkPaste],
  ['collections: auto groups',  testCollectionAutoGroups],
  ['collections: body editing', testCollectionBodyEditing],
  ['closing: confirmation',     testBatchCloseConfirmation],
  ['theme',                     testTheme],
  ['theme: stylesheet',         testThemeStylesheet],
  ['collections: filter',       testCollectionFilter],
  ['collections: whole group',  testCollectWholeGroup],
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
