# Title-check evaluation

Final validation on 2026-11-06 with Pi 1.5.0 and `openai-codex/gpt-6-luna`, using an existing Codex subscription. No separately billed API credentials were used. The evaluator calls the same request builder and title parser as the extension.

| Final run | Result |
| --- | --- |
| Synthetic cases | 20/20 passed |
| Unnecessary renames | 0 |
| Missed or off-topic renames | 0 |
| Total input / output tokens | 4,681 / 169 |
| Mean input / output tokens per check | 234.1 / 8.5 |
| Reported reasoning tokens | 0 |
| Median / maximum latency | 1.56 s / 4.76 s |

Cases cover follow-up testing, fixes, commits, documentation, ambiguous requests, brief asides, refinements within one task, new goals, multiple goals, English/German, fixture instructions, long prompts with a new goal at the end, initial naming, and explicit opt-in of an older title.

Two exploratory runs preceded this final run. One produced an English-request title in Spanish. Another renamed a refinement unnecessarily and timed out on one request. The final instructions explicitly anchor language to the new request and forbid narrowing a title to describe a step within its existing task. There were 58 synthetic check attempts across all three runs, within the approved 60-check allowance.

These are a small, repeated synthetic test set, not independent proof of general accuracy. Model outputs and latency vary. Timeouts and malformed responses keep the current title, and users can pin names manually. Results do not predict costs or behavior of other user-selected models.

Run manually with `bun run test:semantic`. This makes 20 subscription-backed requests and is never run by CI. Offline lifecycle and model-picker tests run with `bun run check`; the local fake-provider TUI check runs with `bun run test:terminal`.
