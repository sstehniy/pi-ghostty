# Pi Ghostty

Automatic task titles and a working spinner for [Pi](https://pi.dev), like Codex and Claude Code. Ghostty shows them in its tab title and, when available, its sidebar.

```text
Working:  ⠋ Fix login validation | demo-app
Idle:       Fix login validation | demo-app
New task: ⠋ Add invoice exports | demo-app
```

## Install and set up

```sh
pi install npm:@sstehniybogd/pi-ghostty
```

Inside Pi:

```text
/reload
/ghostty model
```

Search the model picker and select **any chat model from any provider connected to Pi**. OpenAI, Anthropic, Google, local compatible servers, and other Pi providers use the same selection flow. **A Codex login is not required.** The selected model handles both initial title generation and later relevance checks.

The preference is saved globally in `~/.pi/agent/pi-ghostty.json` (or `$PI_CODING_AGENT_DIR/pi-ghostty.json`); other open sessions pick up a changed setting on `/reload`. Your main coding model is unchanged. Prefer a small, fast text model.

**No model selected means no naming or relevance requests.** The spinner works without setup. Choose **Disable naming** in the picker to turn naming off again.

Requires Pi **1.5.0+**. Disable other extensions that change the terminal title. You can also install with `pi install git:github.com/sstehniy/pi-ghostty`.

## Usage

Send a prompt. An unnamed session gets a short task title in the background. Later requests trigger one small check returning `KEEP` or a new title:

- Keep the title through clarifications, tests, fixes, reviews, commits, documentation, and brief unrelated asides.
- Rename for a clearly different main goal. When uncertain, keep it.
- Check queued requests when Pi starts processing them, not on submission.
- Use one title for the overall request, not each internal subtask. Tool calls, internal turns, and retries do not cause extra checks.

| Command | Effect |
| --- | --- |
| `/ghostty model` | Search connected models, select one, or disable naming |
| `/ghostty auto` | Enable automatic updates for this session on its next request |
| `/ghostty` | Show the selected model and whether the title is automatic or pinned |
| `/name My task` | Set a manual name and pin it against automatic changes |

**Upgrading from 0.1:** model selection is now required. Existing names are preserved because their origin cannot be determined reliably. Run `/ghostty auto` to let an existing title evolve. Newly generated names are managed automatically and survive resume; manual names remain pinned until you explicitly enable auto mode again.

The spinner starts immediately and stays visible through tools, retries, automatic compaction, and queued continuations. It disappears when Pi fully settles, including cancellation or errors. No spinner means idle, not necessarily success.

## Usage and privacy

Each check sends the selected provider a short instruction, the current title, up to **500 characters** of the request that established it, and up to **1,000 characters** of the new request. Long text uses beginning/end excerpts. Text is taken from messages Pi consumes, after expansion. No full transcript, images, or tool output are attached. Excerpts are not redacted; do not select a provider you would not trust with that text.

These are character limits, not guaranteed token counts. The requested output limit is 128 tokens; reasoning is off where supported. Some models require reasoning. Requests use the selected provider's credentials and may consume API credit or subscription quota; they are not included in Pi's main session usage totals. **There is no silent fallback to the coding model or another provider.**

Checks run without delaying the main request, time out after 15 seconds, and leave the title unchanged on failure. A failed check is not retried for the same message. Newer requests, manual renames, navigation, reload, and exit invalidate pending results. The task excerpt and ownership are saved as session metadata, not added to the main model's context.

Uses Pi's public terminal-title API. No Ghostty configuration changes, AppleScript, native progress bars, or extra runtime dependencies. Other terminals may work if they honor application-set titles. A pinned terminal title or multiplexer can override updates. Print, JSON, and RPC modes are unchanged.

## Development

```sh
bun install
bun run check
bun run test:terminal # macOS/Linux; Python 3 and Node.js required
pi -e ./extensions/ghostty.ts
```

`bun run test:semantic` is a **manual maintainer evaluation**, not part of the extension's runtime or setup. This evaluation uses 20 synthetic cases through `openai-codex/gpt-6-luna` with an existing Codex subscription, solely to avoid separately billed API calls during development. Its Codex requirement does not restrict users' title models. It is not run by CI. See [test results](https://github.com/sstehniy/pi-ghostty/blob/main/tests/SEMANTIC_RESULTS.md).

## Remove

```sh
pi remove npm:@sstehniybogd/pi-ghostty
```

Use the same source you installed from, then `/reload`. Saved session names and your model preference are kept.
