# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension that replaces your new tab page with a dashboard of everything you have open, laid out as one card per **Chrome tab group** — each wearing its group's own name and color. Close tabs with a satisfying swoosh + confetti.

No server. No account. Nothing about your tabs leaves your browser. Just a Chrome extension.

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

```
https://github.com/zarazhangrui/tab-out
```

The agent will walk you through it. Takes about 1 minute.

---

## Features

- **See all your tabs at a glance** — one card per Chrome tab group, in your tab strip's own order
- **Mirrors your Chrome tab groups** each card takes its group's name and color; everything you haven't grouped shares one card at the end
- **Collapse from here** collapse a card and the group collapses in Chrome too
- **Stays current** an open dashboard keeps up with tabs you open, close, move or regroup — and catches up the moment you switch back to it
- **Close tabs with style** with swoosh sound + confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Click any tab to jump to it** across windows, no new tab opened
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost ports** shows port numbers next to localhost tabs so you can tell your vibe coding projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **Your tab data stays local** titles and icons come straight from Chrome, never from a third party
- **Pure Chrome extension** no server, no build step, nothing to install beyond loading the extension

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
  -> Tab Out shows one card per Chrome tab group, plus one for ungrouped tabs
  -> Each card wears its group's name and color
  -> Click any tab title to jump to it
  -> Collapse a card (Chrome collapses the group with it)
  -> Close groups you're done with (swoosh + confetti)
  -> Save tabs for later before closing them
```

Everything runs inside the Chrome extension. No external server, no API calls, and your tab data goes nowhere — the one request the page makes is the Google Fonts stylesheet it uses for typography. Saved tabs are stored in `chrome.storage.local`.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

---

## Development

The extension itself has no build step — edit a file in `extension/` and hit reload at `chrome://extensions`.

There's a small test suite for the dashboard's grouping and tab-closing logic:

```bash
npm test
```

It runs `extension/app.js` directly against stubbed `chrome.*` and DOM objects, so it needs **no dependencies and no browser** — plain Node. It covers how tabs are grouped into cards, what each "Close all" button would actually close, the collapse round-trip, and what happens when the `tabGroups` permission isn't in effect. Anything visual — CSS, sound, confetti — still wants a human with the extension loaded.

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
