# Changelog

## 0.2.0 - 2026-11-06

- Add conservative automatic title updates when the main task changes, using one bounded `KEEP`-or-title check per consumed user request.
- Add `/ghostty model`, a searchable picker of connected-provider models. The preference is saved globally without changing the main coding model. Both naming and relevance checks support any connected chat-model provider; no Codex login is required.
- **Setup change:** all naming now requires an explicitly selected model. Without one, only the spinner runs. There is no implicit coding-model fallback.
- Preserve manually assigned and unknown existing names. `/ghostty auto` explicitly enables updates for a pinned or older session.
- Persist title ownership, the bounded task excerpt, and checked-message identity across reload and resume.
- Keep follow-ups, brief asides, internal turns, and queued-but-not-started tasks from causing unnecessary title changes.
- Add lifecycle, model-picker, real-terminal, and subscription-only semantic verification.

## 0.1.0

- Generate an initial session title in the background.
- Animate the terminal title while Pi is busy, stopping at final settlement.
