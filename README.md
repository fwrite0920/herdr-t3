# Herdr T3

English · [中文](README.zh-CN.md)

A layout for [Herdr App](https://herdr.dev) that lets you keep many agents running and look only at the ones that need you.

![Herdr T3](preview.png)

## Why

> It's so nice to have 14 threads running and zero visible. Why let working threads get in the way of things that need your attention?
>
> — [Theo](https://x.com/theo/status/2114131018575962496)

I'd worked this way in T3 Code: what's running stays out of sight, what needs me shows up, I put it away when I'm done, and it comes back by itself when something new happens. I wanted to work the same way in Herdr, so I brought over T3 Code's Inbox and its look, and fitted them to Herdr's tabs, panes and machines.

## Features

- **Inbox and Lists**: two sidebars, one key apart. Inbox sorts agents by what needs you, with T3-style Settle and Snooze; Lists shows spaces by project and agents by priority or by space, without Inbox's Settle and Snooze.
- **Home**: putting away the agent you're looking at lands on a quiet page, not the next card. What to look at next is yours to pick. Settings (`cmd-shift-,`) can make it go on to the next card instead, or make Home a terminal or a mod of your own.
- **One name, one set of marks**: cards, lists, tabs and pane headers name and mark each terminal the same way.
- **Go to** (`cmd-p` / `ctrl-shift-p`): jump to any pane, agent or program, by its name.
- **Better Search** (`cmd-alt-p` / `ctrl-alt-p`): universal search popup across tabs, agents (`@`), commands (`>`), space files (`/`, opening directly in Herdr T3's Files panel), spaces (`~`), and agent output (`?`), with quick peek and direct message/file handoff to an agent.
- **Actions**: T3 Code's run button for your own commands, in a new tab or a split.
- **Slim tabs and framed panes**, in T3 Code's look.
- **Other machines**: their spaces grouped by machine, their Inbox cards marked. In Lists, hover an Agents row to see its machine's name.
- **Files**: the space's folder, read-only, in a top-and-bottom split inside the right panel: full-width file tree and search on top (draggable divider, full-height when no file is open, collapsible for full-height reading) and full-width code/Markdown/image preview below, with quick-switch recent file tabs and 1-click toolbar actions (Copy path, Open in VS Code, Wrap, Close). It stays put as you switch tabs and follows you to another space. Hidden pages do no file refreshes, and full data is cached for only three recent spaces per page.
- **Sessions (Inspector & History)**: A built-in agent telemetry dashboard and session history explorer in the right panel. Natively supports Google Antigravity, OpenAI Codex, Oh-My-Prompt, Inflection Pi, and terminal shells; features a 2x2 HUD (real-time context headroom & warning, cache hit rate, session/turn cost, speed & TTFT latency), dynamic 4-segment token breakdown, live tool activity stream, tools & skills catalog with emerald `ACTIVE` badges for invoked tools (and a dedicated "Used" filter tab), environment detection (`LOCAL` / `WSL` / remote SSH), persistent elapsed timers that never reset to zero when switching terminals, and a redesigned History browser with multi-agent categorization tabs, chronological time grouping, and 1-click terminal session resume.
- **Review** (optional): what's left to review in the worktree, on the same panel's other page. Files and Review keep their own files, reading positions, line wrapping and tree widths; switching pages restores each one.

Each in detail: [the guide](docs/user/guide.md).

## Install

### Method 1: One-Command Install / Update (Recommended)

Clone the repository and run the update script:

**macOS / Linux**:
```sh
git clone https://github.com/JinJieBeWater/herdr-t3.git
cd herdr-t3
./scripts/update.sh
```

**Windows** (PowerShell / Git Bash):
```pwsh
git clone https://github.com/JinJieBeWater/herdr-t3.git
cd herdr-t3
& "C:\Program Files\Git\bin\sh.exe" ./scripts/update.sh
```

What the script does automatically:
1. Syncs all shipped mods (`mods/t3-*` and `mods/better-search`, including `t3-sessions`, `t3-inbox`, `t3-agents`, `t3-tabs`, `t3-pane`, `t3-chrome`, `t3-files`, `t3-changes`, `t3-tools`, etc.) into your Herdr App configuration directory.
2. Installs `layouts/herdr-t3.json` and its vector icon into `layouts/`.
3. Safely merges shortcut bindings in `keys.json` without clobbering your existing custom shortcuts.
4. Preserves your pins, settled agents, custom actions, themes, and focus ring settings.

---

### Method 2: Manual Installation

If you prefer to install manually, locate your Herdr App home directory:
- **Windows**: `%USERPROFILE%\.config\herdr-app\` (e.g. `C:\Users\<username>\.config\herdr-app\`)
- **macOS / Linux**: `~/.config/herdr-app/`

1. **Install Layout**: Copy `layouts/herdr-t3.json` and `layouts/herdr-t3.svg` into your Herdr home's `layouts/` folder.
2. **Install Mods**: Copy all `t3-*` folders inside `mods/` into your Herdr home's `mods/` folder.
3. **Merge Keys**: Merge `keys.json` into your Herdr home's `keys.json` (or copy it directly if none exists).

---

### Activating the Layout

After installation:
1. Launch **Herdr App**.
2. Press `Cmd-K` (macOS) or `Ctrl-K` (Windows) to open the Command Palette, type `layout`, and select **Herdr T3** (or pick `herdr-t3` from the window's layout switcher).
3. The T3 sidebar and framed panes will activate immediately. Switch to `Sessions` in the right panel to view the Inspector HUD and History browser.

> **Requirements**:
> - Herdr App and its `hc` CLI.
> - [Node.js](https://nodejs.org/) (for session telemetry, token breakdown calculation, and multi-agent history parsing).
> - The automated install script requires `jq`, `rsync`, and `sh` (on Windows, run via Git for Windows' `sh.exe`).

Only want the Inbox? It is also published alone: [herdr-t3-inbox](https://github.com/JinJieBeWater/herdr-t3-inbox).

## Quick start

1. `cmd-shift-b` (or the button at the sidebar's top right) switches between Inbox and Lists.
2. In Inbox, hover a finished card and click `✓ Settle` to put it away; new work brings it back. `cmd-shift-s` settles the agent you're looking at and goes Home.
3. From Home, `cmd-]` opens the top card, so you can work down them one by one.
4. Hover a card and click the clock to Snooze it until a time you pick.

Dragging, sweeping across rows, pins and the rest: [Everyday use](docs/user/guide.md#everyday-use).

## Keys

| Key (macOS / Windows) | Does |
| --- | --- |
| `cmd-shift-b` / `ctrl-shift-b` | Switch the sidebar between Inbox and Lists |
| `cmd-shift-s` / `ctrl-shift-s` | Settle the agent you're looking at and go Home, or bring it back |
| `cmd-]` / `ctrl-shift-]`, `cmd-[` / `ctrl-shift-[` | Next or previous agent, in the sidebar's order |
| `cmd-p` / `ctrl-shift-p` | Go to any pane |
| `cmd-alt-p` / `ctrl-alt-p` | Better Search (tabs, agents, commands, files, spaces, agent output) |
| `cmd-shift-h` / `ctrl-shift-h` | Go Home |
| `cmd-shift-,` / `ctrl-shift-,` | The layout's settings |
| `cmd-alt-b` / `ctrl-alt-b` | Show or hide the space panel, on the page last shown |
| `cmd-shift-g` / `ctrl-shift-g` | Open Review, or close the panel showing it (Review extra) |
| `cmd-t` / `ctrl-shift-t` | New tab here; at Home, pick the space first |

All of them: [Keys](docs/user/guide.md#keys).

## Update

```sh
git clone --depth 1 https://github.com/JinJieBeWater/herdr-t3 && herdr-t3/scripts/update.sh
```

It overwrites the layout and its mods and merges `keys.json`; your pins, settled agents, actions, theme and focus ring stay. What it keeps and what it doesn't: [Update](docs/user/guide.md#update).

## What it runs

- `t3-spaces`: read-only `git status` / `git rev-parse` in your spaces' folders, watches those repos for changes (`watchFolder`), and `hc machine ls --json`. Clicking Connect on a rebuilt machine runs `hc machine rm` and `hc machine add`.
- `t3-inbox`: `hc label <agent> settled=<ms>:<turn>` when an agent is settled or unsettled.
- `t3-inbox`: `hc label <agent> snoozed=<ms>` when an agent is snoozed or wakes.
- `t3-tabs`: `hc get` before closing a terminal, to see whether a program is running in it. `hc label` when `cmd-shift-s` settles or brings back an agent, and to give back an unread done (`herdr.seen`) or a Woke mark (`snoozed`) that Herdr cleared when it showed a tab you didn't pick, and `hc label <agent> snoozed=` when a failed turn or new work in view ends a snooze.
- `t3-agents`: `hc label <agent> snoozed=` when pinning a snoozed agent ends its snooze.
- `t3-chrome`: on macOS, when the zoom changes, it rewrites the window button position in the installed `layouts/herdr-t3.json`, so the buttons stay on the brand bar's middle line.
- `t3-files`, read-only, where the space is (on its machine): `git rev-parse`, `git status`, `git check-ignore` and `git ls-files` (with `--no-optional-locks`, so nothing is written under `.git`), `sh` to list a folder or, on another machine, to check a file's size and search paths, `find` outside Git, `base64` for another machine's images. It copies images it shows into `cache/t3-files/` and deletes them when it stops. Right-click: Reveal in Finder (Reveal in File Explorer on Windows) and Open in default app run `open` (`xdg-open` on Linux, default app protocol handler on Windows).
- `t3-spaces`, `t3-agents`, `t3-inbox`, `t3-new-menu`, `t3-picker`: for each space's icon, `git rev-parse --show-toplevel`, `sh` file tests and `base64` where the space is (on its machine); a found icon is copied into `cache/t3-icons/`.
- `t3-sessions`: read-only. Polls telemetry every 1.5s via Node.js for the focused agent session (Antigravity, Codex, Omp, Pi, or terminal shell); inspects remote machine or WSL state via `hc exec` when remote; refreshes multi-agent session history every 4s; keeps independent elapsed runtimes per terminal. Writes no disk data and makes no network requests.
- `better-search`: runs `git rev-parse --show-toplevel` and `git ls-files` for `/` file searches, `hc machine ls --json` / `hc read` for machines, blocked agent questions and `?` output search, and `hc send` only when you explicitly send a message or file to an agent.

No network requests.

## Extras (optional)

- **pulls.review**: a Review bar and the panel's Review page.
- **Theme export for Pi**: Pi's colors follow Herdr's.
- **asciicn wallpaper**: Home in your theme's colours: four pictures built in, or preview your image in Braille, Blocks or Dots before applying it. Import Studio `.ans` files too, including Unicode, leading-dash and hidden filenames. A failed Apply keeps your preview for retry; deleting an added wallpaper asks for confirmation and stops its conversion. See [the extras](docs/user/extras.md#asciicn-wallpaper).
- **Themes**: Catppuccin and T3 Code, light and dark.

How to add them: [the extras](docs/user/extras.md).

## Credits and license

`t3-chrome`, `t3-spaces`, `t3-agents`, `t3-tabs`, `t3-pane`, `t3-new-menu`, `t3-picker` and the layout start from Herdr App's shipped `workspace-chrome`, `spaces`, `agents`, `tabs`, `pane`, `new-menu`, `picker` and `main`. Settle follows T3 Code's design. The Catppuccin themes use the [Catppuccin](https://github.com/catppuccin/catppuccin) palette (MIT License, Copyright (c) 2021 Catppuccin); the T3 Code themes take [T3 Code](https://github.com/pingdotgg/t3code)'s default colors (MIT License, Copyright (c) 2026 T3 Tools Inc.). Icons are [Lucide](https://lucide.dev)'s (ISC License, Copyright (c) Lucide Contributors); file and folder icons in Files and Review are [Catppuccin's VS Code icons](https://github.com/catppuccin/vscode-icons) (MIT License, Copyright (c) 2023 Catppuccin, Copyright (c) 2023 thang-nm). Files ranks search results with [uFuzzy](https://github.com/leeoniya/uFuzzy) (MIT License, Copyright (c) 2022 Leon Sorokin). Review counts characters' widths with [get-east-asian-width](https://github.com/sindresorhus/get-east-asian-width)'s table (MIT License, Copyright (c) Sindre Sorhus). `better-search` is adapted from [munza/herdr-mods](https://github.com/munza/herdr-mods) (Apache-2.0 License). Apache-2.0, as Herdr App.

## More

- [herdr-t3-inbox](https://github.com/JinJieBeWater/herdr-t3-inbox): this layout's Inbox sidebar as a standalone mod.
- [herdling](https://github.com/JinJieBeWater/herdling): a macOS menu bar companion for Herdr.
- [pi-stuff](https://github.com/JinJieBeWater/pi-stuff): my Pi extensions and skills.
