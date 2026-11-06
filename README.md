# Pi Ghostty

Automatic task titles and a working spinner for [Pi](https://pi.dev), like Codex and Claude Code. Ghostty shows them in its tab title and, when available, its sidebar.

```text
Working:  ⠋ Fix login validation | demo-app
Idle:       Fix login validation | demo-app
```

## Install

```sh
pi install npm:@sstehniy/pi-ghostty
```

Or install from GitHub:

```sh
pi install git:github.com/sstehniy/pi-ghostty
```

Run `/reload` in an existing Pi session. Requires Pi **1.5.0+**. Disable other extensions that change the terminal title.

## Usage

Just send a prompt. An unnamed session gets a short task title in the background, without delaying Pi's work. The title is saved as the session name and stays stable across follow-ups and resumes. Use Pi's built-in `/name My task` to rename it manually; manual names always win.

The spinner starts immediately when the run starts and stays visible through tool calls, retries, automatic compaction, and queued continuations. It disappears when Pi fully settles, including on cancellation or errors. No spinner means idle, not necessarily success.

Naming runs once per unnamed session, using the current model and credentials. It sends only a naming instruction and the first **1,000 characters** of the prompt that starts the run, after Pi's skill/template expansion. No conversation history, images, files, or tool output are attached. This is an extra model request, may be billed, and is not included in Pi's session usage totals. Requests time out after 15 seconds. If naming fails, the normal title stays; use `/name` to set one yourself.

Uses Pi's public terminal-title API. No Ghostty configuration changes, AppleScript, native progress bars, or runtime dependencies. Works in other terminals that honor application-set titles, but Ghostty is the target. A manually pinned terminal title or a multiplexer may override it. Print, JSON, and RPC modes are unchanged.

## Development

```sh
bun install
bun run check
bun run test:terminal # macOS/Linux; Python 3 and Node.js required
pi -e ./extensions/ghostty.ts
```

## Remove

```sh
pi remove npm:@sstehniy/pi-ghostty
```

Use the same source you installed from, then `/reload`. Saved session names are kept.
