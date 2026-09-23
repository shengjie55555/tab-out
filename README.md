# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension that replaces your new tab page with two things: a dashboard of everything you have open — one card per **Chrome tab group**, each wearing its group's own name and colour — and **Collected tabs**, a library you build and arrange yourself.

No server. No account. Nothing you save leaves your browser. Just a Chrome extension.

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

```
https://github.com/zarazhangrui/tab-out
```

The agent will walk you through it. Takes about 1 minute.

---

## Features

### Open tabs — what you have right now

- **One card per Chrome tab group**, in your tab strip's own order; tabs you haven't grouped share one card at the end
- **Your group's name and colour**, mirrored onto the card — rename or recolour it in Chrome and the card follows
- **Collapse from here** — collapse a card and the group collapses in Chrome too
- **Stays current** — a dashboard left open keeps up with tabs you open, close, move or regroup
- **Click any tab to jump to it** across windows, no new tab opened
- **Close tabs with style** — swoosh sound + confetti burst
- **Duplicate detection** flags the same page open twice, with one-click cleanup
- **Batch closes ask first** — closing a whole group, the duplicates or everything takes two clicks. Closing one tab stays one click
- **Collect a whole group** — file an entire Chrome group into your library as a subtree, leaving the tabs open
- **Save for later** — bookmark individual tabs to a checklist before closing them
- **Localhost ports** shown next to localhost tabs, so you can tell your projects apart

### Collected tabs — a library you build

- **A nestable tree** of groups you name and arrange, as deep as you like
- **Two kinds of entry**: **links** (open on click) and **notes** (Markdown). Anything without a usable address copies to the clipboard instead of opening. (Entries saved as *code* under an earlier three-kind version still render and edit — there is simply no way to make a new one.)
- **Notes are Markdown** — links, images, bold/italic, lists and inline code — written with a live preview underneath the editor
- **Paste a hyperlink** into a note and the address comes with it, as `[the words](the url)`: the plain-text flavour of a copy has usually dropped it
- **Paste or drop an image straight into a note.** It is downscaled and re-encoded, then stored inside the note, so it travels with your backup. That does eat into `chrome.storage.local`'s 10MB, though: expect a few dozen screenshots rather than hundreds
- **Collect from your tabs** — the folder icon on any tab files it into the library; the one on a group card files the whole group
- **Drag anything to move it** — a note, a link or a whole group. Drop on a card's edge to put it before or after, or on its middle to move it *inside* that group. Board cards also resize by dragging their right edge, snapping between 1 and 4 columns. The board packs tiles tightly rather than leaving holes
- **Status marks** — tag an entry to-do / doing / done / dropped and filter by it
- **Filter** — by text or status, keeping matching branches in context and never hiding a hit inside a collapsed group
- **Paste a list** — a multi-line paste becomes one entry per line, all in one new group
- **Paste a hyperlink** — copy a link out of a document and the address comes with it, with the visible words as the name
- **Bring your own prefixes** — map a path prefix onto a base URL and bare paths like `team/project/run-3` become real links
- **Duplicates are allowed, but never silent** — adding something already in the library says where it already lives

### A note on Chrome's bookmarks bar

Tab Out can't draw Chrome's own bookmarks bar. Extensions cannot render browser UI, and no API exposes it. Chrome's **Only on new tab page** setting doesn't help either — that checks for a `chrome://newtab` URL, and this page's URL is `chrome-extension://…`, so Chrome doesn't count it as a new tab page. If you want the bar visible here, set Chrome's bookmarks bar to **Always**.

### Both

- **Light, dark, or whatever your system says** — the switch is in the header, and the choice is applied before the page paints, so a dark-mode new tab never flashes light first
- **Your data stays local** — titles and icons come straight from Chrome, never from a third party
- **Pure Chrome extension** — no server, no build step, nothing to install beyond loading the extension

---

## Personal config

`extension/config.local.js` is gitignored and optional. Create it to map your own paths onto real links:

```js
// Every entry starting with "team/" opens at https://tracker.internal/…
const LOCAL_LINK_PREFIXES = {
  'team/': 'https://tracker.internal/',
};
```

Only `http(s)` bases are accepted — a prefix mapping is never allowed to smuggle in a `javascript:` link. The longest matching prefix wins. Without a mapping, a bare path stays a non-link and clicking it copies it, which is usually what you want for an id.

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/zarazhangrui/tab-out.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Navigate to the `extension/` folder inside the cloned repo and select it

**3. Open a new tab**

You'll see Tab Out.

---

## How it works

```
You open a new tab
  -> One card per Chrome tab group, plus one for ungrouped tabs
  -> Each card wears its group's name and colour
  -> Click any tab title to jump to it
  -> Collect a tab, or a whole group, into your library
  -> Collapse a card (Chrome collapses the group with it)
  -> Close groups you're done with (swoosh + confetti)

In the library
  -> Groups nest as deep as you like; drag cards to arrange the board
  -> Entries are links, notes or code — whatever each one actually is
  -> Filter by text or status when the tree gets long
```

Everything runs inside the Chrome extension. No external server, no API calls, and your data goes nowhere — the one request the page makes is the Google Fonts stylesheet it uses for typography. Both saved tabs and the library are stored in `chrome.storage.local`.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |
| Layout | CSS grid, card widths in column units, row spans measured per tile |

---

## Development

The extension itself has no build step — edit a file in `extension/` and hit reload at `chrome://extensions`.

There's a test suite for everything that isn't visual:

```bash
npm test
```

It runs `extension/app.js` directly against stubbed `chrome.*` and DOM objects, so it needs **no dependencies and no browser** — plain Node. It covers the tab grouping, what each close button would actually close, the collapse round-trip, when the `tabGroups` permission isn't in effect, the whole collected-tabs tree model (as pure functions), and the rules about what may or may not reach the DOM — escaping, which values are allowed to become links, and how many times a render is allowed to touch it.

Anything visual — CSS, layout, sound, confetti — still wants a human with the extension loaded.

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
