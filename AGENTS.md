# AGENTS.md -- Tab Out: Setup & Onboarding Guide for Coding Agents

You're installing **Tab Out** for the user. Your job is not just to set it up -- it's to get them excited about using it.

---

## Step 0 -- Introduce the product

Before doing anything technical, tell the user what they're about to get:

> **Tab Out** replaces your new tab page with a clean dashboard of everything you have open, laid out as one card per Chrome tab group.
>
> Here's what makes it great:
> - **See all your open tabs at a glance** — one card per Chrome tab group, in your tab strip's own order
> - **Mirrors your Chrome tab groups** — each card takes its group's name and color, and everything you haven't grouped shares one card at the end
> - **Collapse from here** — collapse a card and the group collapses in Chrome too
> - **Stays current** — tabs you open, close or regroup show up right away; there's nothing to refresh
> - **Close tabs with style** satisfying swoosh sound + confetti burst
> - **A collected-tabs library** — a nestable tree of links and Markdown notes (images and all), with drag-to-arrange cards
> - **Duplicate detection** flags when you have the same page open twice
> - **Click any tab title to jump to it** even across different Chrome windows
> - **Save for later** bookmark individual tabs to a checklist before closing them, tick them off as you read, and dig anything back out of the archive
> - **Light, dark, or follow the system** — the switch sits in the header, and your choice sticks
> - **Your tab data stays local** no server, no accounts; titles and icons come straight from Chrome
>
> It's just a Chrome extension. Setup takes about 1 minute.

---

## Step 1 -- Clone the repo

```bash
git clone https://github.com/zarazhangrui/tab-out.git
cd tab-out
```

---

## Step 2 -- Install the Chrome extension

This is the one step that requires manual action from the user. Make it as easy as possible.

**First**, print the full path to the `extension/` folder:
```bash
echo "Extension folder: $(cd extension && pwd)"
```

**Then**, copy the `extension/` folder path to their clipboard:
- macOS: `cd extension && pwd | pbcopy && echo "Path copied to clipboard"`
- Linux: `cd extension && pwd | xclip -selection clipboard 2>/dev/null || echo "Path: $(pwd)"`
- Windows: `cd extension && echo %CD% | clip`

**Then**, open the extensions page:
```bash
open "chrome://extensions"
```

**Then**, walk the user through it step by step:

> I've copied the extension folder path to your clipboard. Now:
>
> 1. You should see Chrome's extensions page. In the **top-right corner**, toggle on **Developer mode** (it's a switch).
> 2. Once Developer mode is on, you'll see a button called **"Load unpacked"** appear in the top-left. Click it.
> 3. A file picker will open. **Press Cmd+Shift+G** (Mac) or **Ctrl+L** (Windows/Linux) to open the "Go to folder" bar, then **paste** the path I copied (Cmd+V / Ctrl+V) and press Enter.
> 4. Click **"Select"** or **"Open"** and the extension will install.
>
> You should see "Tab Out" appear in your extensions list.

**Also**, open the file browser directly to the extension folder as a fallback:
- macOS: `open extension/`
- Linux: `xdg-open extension/`
- Windows: `explorer extension\\`

---

## Step 3 -- Show them around

Once the extension is loaded:

> You're all set! Open a **new tab** and you'll see Tab Out.
>
> Here's how it works:
> 1. **Every Chrome tab group gets its own card**, in your tab strip's order. Tabs you haven't grouped share one "Ungrouped" card at the end.
> 2. **Each card wears its group's name and color** — rename or recolor the group in Chrome and the card follows.
> 3. **Click any tab title** to jump directly to that tab.
> 4. **Click the X** next to any tab to close just that one (with swoosh + confetti).
> 5. **Hit the arrow** next to a card's name to collapse that group — in Chrome as well as here.
> 6. **"Close all N tabs"** closes the whole group, and asks first: closing several tabs at once takes two clicks. Closing a single tab stays one click.
> 7. **Duplicate tabs** are flagged with an amber "(2x)" badge. Click "Close duplicates" to keep one copy.
> 8. **Save a tab for later** by clicking the bookmark icon before closing it. Saved tabs appear in the sidebar, newest first. Tick one off when you've read it and it drops into the archive underneath — where you can search it, put it back on the checklist, or delete it for good.
> 9. **Collect a tab** with the folder icon — or a whole group with "Collect" at the right of its action row. Either way the tabs stay open.
>
> Then scroll down to **Collected tabs**, the library:
>
> 1. **Add anything** from the bar at the top: a link, or a note written in Markdown. Pasting several lines makes one entry per line, all in one new group.
> 2. **Everything added at the top level gets its own group** — Link1, Note1, Code1 and so on — so the board stays a board of cards.
> 3. **Drag anything to move it** — drop on a card's edge to order it, or on its middle to move it inside that group. Board cards also widen by dragging their right edge.
> 4. **Filter** by text or status on the right, and tag an entry to-do / doing / done / dropped with the dot on its row.
>
> That's it! No server to run. Everything works right away.

---

## Key Facts

- Tab Out is a pure Chrome extension. No server, no build step, no dependencies to install.
- `npm test` (plain Node, no install needed) runs the tests for the grouping, the tab-closing rules, the collected-tabs tree and the theme.
- Saved tabs and the collected-tabs library are both stored in `chrome.storage.local` (they persist across sessions). The library lives under the `collections` key.
- `extension/config.local.js` is optional and gitignored. Its one current use is `LOCAL_LINK_PREFIXES`, which maps your own path prefixes onto a base URL so bare paths become real links. Only http(s) bases are accepted.
- Your tab data stays local: no server, no accounts, no analytics, and no third-party requests for titles or icons — they come from `chrome.tabs` / `chrome.tabGroups`. (The page does load its fonts from Google Fonts.)
- To update: `cd tab-out && git pull`, then reload the extension in `chrome://extensions`.
