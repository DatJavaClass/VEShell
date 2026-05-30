# VEShell

**VEShell** — *Very Easy Shell* — is a reliable terminal wrapper for
**PowerShell → Claude Code** with rock-solid mouse and keyboard
**cut / copy / paste**.

It opens a window, spawns a real PowerShell session inside it (via Windows
ConPTY), and that session invokes Claude Code. Selection and clipboard are
handled by a full terminal emulator (xterm.js) — the same engine VS Code's
integrated terminal uses — so copy/paste does not depend on conhost's flaky
"Quick Edit" mark mode. Copying *out* to other apps uses the normal OS
clipboard.

Launch chain: **VEShell window → powershell.exe (-NoExit) → claude**.
When Claude exits you drop back to a live PowerShell prompt in the same window.

## Project status

VEShell is an **ongoing project**. The aim is to keep adding quality-of-life
utility around the shell **without losing CLI efficiency** — conveniences that
stay out of the way, never a heavier workflow.

As of now there are **no plans to bring VEShell to other LLMs** in the near
future. That's a problem for Future Me... and when was the last time Future Me
ever did anything for Now Me?

## Cut / Copy / Paste

| Action | Keyboard | Mouse |
|---|---|---|
| Copy | **Ctrl+C** (when text is selected) or **Ctrl+Shift+C** | Right-click → Copy |
| Paste | **Ctrl+V** or **Ctrl+Shift+V** | Middle-click, or right-click → Paste |
| Cut | **Ctrl+Shift+X** | Right-click → Cut |
| Select all | **Ctrl+Shift+A** | Right-click → Select All |
| Interrupt Claude (^C) | **Ctrl+C** (when nothing is selected) | — |

Notes:
- **Ctrl+C is smart**: if you have a selection it copies; if not, it sends the
  interrupt signal to Claude. This matches Windows Terminal's behavior.
- **Select with the mouse** by click-dragging. If Claude's TUI has mouse mode
  active (so a drag would scroll/interact instead), hold **Shift** while
  dragging to force a text selection.
- **Cut** on terminal output can only *copy* — scrollback text cannot be
  removed from the screen, so Cut behaves as Copy there.
- Multiline pastes use bracketed-paste mode, so they land in Claude's prompt as
  one block instead of executing line-by-line.

## Install

### Option A — Installer (recommended; installs to Program Files)
1. Run **`dist\VEShell-Setup-1.0.0.exe`**.
2. Accept the UAC prompt (needed to write to `C:\Program Files\VEShell`).
3. It creates a **Desktop shortcut** and Start Menu entry, and can launch on
   finish. Uninstall via Settings → Apps like any program.

### Option B — Portable (no admin, run from anywhere)
- Use **`dist\VEShell-Portable-1.0.0.exe`** — a single self-contained
  executable. Put it wherever you like (Desktop, a USB stick, a tools folder)
  and double-click. To make a shortcut, right-click it → *Send to → Desktop*.
- Or use the unpacked folder **`dist\win-unpacked\`** and run `VEShell.exe`
  inside it. Copy the whole folder to keep it portable.

## Configuration

Drop a `config.json` next to `VEShell.exe` to override defaults. Lookup order:

1. The folder you launched the **portable** exe from (`PORTABLE_EXECUTABLE_DIR`)
2. The directory of the running exe (installer / `win-unpacked` builds)
3. `%APPDATA%\VEShell\config.json` (works for every build, including the
   single-file portable exe, which otherwise runs from a temp dir)

Example:

```json
{
  "shell": "powershell.exe",
  "shellArgs": ["-NoLogo", "-NoExit", "-Command", "claude"],
  "cwd": "",
  "fontSize": 14
}
```

- `cwd` — starting directory (empty = your user profile folder).
- To start in plain PowerShell without Claude, set
  `"shellArgs": ["-NoLogo"]`.
- Appearance (font, theme, copy-on-select) also lives in
  `src/renderer/renderer.js` for source builds.

## Build from source

```powershell
cd C:\Users\victo\Dropbox\Working\Projects\VEShell
npm install            # also rebuilds node-pty for Electron (postinstall)
npm start              # run in dev
npm run dist           # build installer + portable into dist\
```

Requires Node.js and the Visual Studio C++ build tools (node-pty is native).

## Testing

Three automated suites (all passing — 22 checks):

```powershell
npm test            # runs all three in sequence
npm run test:chain  # headless: node-pty -> powershell -> claude launch chain
npm run test:e2e    # real Electron GUI: copy/paste, keyboard, mouse, edge cases
npm run test:stress # headless: resize storm, output flood, spawn/kill churn, unicode
```

- `test:e2e` drives the real renderer and verifies clipboard data actually
  moves: Ctrl+Shift+C / smart Ctrl+C (copy vs. interrupt) / Ctrl+V / multiline
  bracketed paste / cut / select-all / unicode copy+paste / 20 KB paste /
  session restart / window-resize → pty resize.
- `test:stress` confirms stability: a 200-resize storm, a 30k-line output flood,
  25 spawn/kill cycles, a 100k-char line, and unicode round-trips.

Note: node-pty prints a harmless `AttachConsole failed` line to stderr at
session teardown (its console-list helper). It runs in a child process, is
bounded by a 5 s timeout, and cannot hang or crash VEShell — you'll only ever
see it when launching from a terminal, never from the shortcut.

## Project layout

```
VEShell/
├─ src/
│  ├─ main.js              Electron main: spawns ConPTY powershell→claude
│  ├─ preload.js           Secure IPC bridge
│  ├─ assets/icon.ico      App/window icon
│  └─ renderer/            xterm.js UI + clipboard/keyboard/mouse wiring
├─ build/
│  ├─ icon.ico             Multi-size icon for packaging
│  └─ make-icon.ps1        Regenerates icon.ico from the source .ico
├─ config.json            Runtime defaults (shell / cwd / font)
├─ package.json           Deps + electron-builder config
└─ dist/                  Build output (installer, portable) — not source
```

## Changelog

### 1.0.1
- **Fixed double-paste.** A real Ctrl+V inserted the clipboard twice — VEShell's
  own paste handler *and* the browser's native paste action both fired (xterm
  has its own `paste` DOM handler). Returning `false` from the key handler told
  xterm to skip the key but did not cancel the native default action. Handled
  shortcuts (Ctrl+V, Ctrl+Shift+V/C/X/A, smart Ctrl+C copy) now call
  `preventDefault()`, so copy/paste fire exactly once. Added e2e regression test
  5b asserting the shortcuts are default-prevented (synthetic key events don't
  trigger the OS-level native paste, so the original suite missed it).

### 1.0.0
- Initial release: PowerShell → Claude Code terminal wrapper with reliable
  mouse/keyboard cut/copy/paste, NSIS installer + portable build.

## License

VEShell is free software under the **GNU General Public License v3.0** — see
[LICENSE](LICENSE). You may use, study, share, and modify it under those terms;
derivative works must remain GPL-licensed.
