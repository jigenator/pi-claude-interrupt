# pi-claude-interrupt

A minimal [Pi](https://github.com/earendil-works/pi) extension that gives ordinary queued **text** a Claude-style interrupt flow.

While Pi is working:

1. Submit one or more messages normally. Pi queues them as steering messages; `Alt+Enter` queues follow-ups.
2. Press `Esc`.
3. The active response is aborted, then Pi automatically starts on the queued text. Remaining messages keep Pi's steering-before-follow-up order. At that continuation's start, a themed “Conversation Steered” marker appears in the transcript.

The indicator follows the label: `Conversation Steered ›··`. It sweeps every 150 ms for three seconds, then settles into `Conversation Steered  ✓`. The label uses Pi's configured `outputPad` (0 or 1), aligning with the native abort notice. The marker stays in transcript history and scrolls upward naturally with new text and tool actions. Saved-session markers render completed without replaying the animation. This feedback is excluded from model context: ordinary starts and failed preflight do not show it, and Pi's native “Operation aborted” notice remains unchanged.

An unsent editor draft is left in the editor. If Pi has no submitted queue, this extension does not consume `Esc`, so Pi's normal interrupt behavior remains in effect. If the continuation cannot reach `agent_start` (for example, an authentication preflight fails), press `Esc` again to leave the extension's restart mode and restore every captured text message to the editor.

## Install

From GitHub:

```sh
pi install git:github.com/jigenator/pi-claude-interrupt
```

For local development without changing Pi's settings:

```sh
pi --no-extensions --extension .
```

The package has an explicit `pi.extensions` manifest and no runtime dependencies. Pi supplies its extension and TUI APIs.

## Compatibility

Tested against `@earendil-works/pi-coding-agent` **0.99.1** on Node.js 22. Pi's queue and abort APIs do not currently expose an atomic "abort but retain this structured queue" operation, so this extension observes queued input and replays it after `agent_settled`.

This is deliberately a best-effort text-only extension:

- **Queued images/attachments:** unsupported. If an already observed queued message has an image, the extension falls through to Pi's native `Esc` handling instead of performing a lossy replay. An image submitted after an interrupt has begun is explicitly rejected with a warning; its text is restored to the editor and the earlier text batch still continues.
- **Other input-transforming extensions:** unsupported in combination. Replay passes through Pi's input pipeline again, so another extension may transform the text twice or handle it differently.
- **Compaction-time queue:** unsupported. Pi keeps that queue inside the interactive UI and does not expose it to extensions.
- **Slow restart preflight:** Escape restores captured text, but Pi cannot guarantee cancellation of work that has not reached `agent_start`. A delayed preflight may still start; check the transcript before resubmitting restored text.
- **Physical Escape only:** the extension listens for Escape presses. Kitty key releases never act; held-key repeats are consumed only when the initiating press belonged to this extension, including during restart and animation. A fresh press still recovers failed preflight or interrupts again; no-queue/native presses and their repeats remain native. Legacy terminals cannot distinguish held-key repeats from fresh presses. Remapping `app.interrupt` does not remap this extension.
- **Completely unobserved queue:** if Pi reports pending messages but this extension observed no queued text at all, it falls through to native handling. Pi exposes only a boolean, so a mixed queue containing both observed and unobserved entries cannot be detected reliably.

For exact structured-content semantics, Pi needs a public atomic queue snapshot plus abort/requeue API (or a native interrupt-and-continue operation).

## Development

```sh
npm install
npm run check
```

Tests use Node's built-in test runner. They cover one and several queued messages, steering/follow-up order, no-queue behavior, repeated Escape, re-interrupting a replay, failed-start recovery, draft preservation, delivery cleanup, abort/settle races, attachment fallback/rejection, and session cleanup. Deterministic animation tests cover all 20 steps, press/repeat/release timing, persistent history, saved markers, output padding, theme/width safety, invisible redraw widgets, and timer cleanup. The integration test loads the real extension through Pi's loader, routes key events through the real `TuiMainScreen` input router with an isolated terminal transport, and dispatches lifecycle/input events through Pi's real asynchronous `ExtensionRunner`, using a real `SessionManager` to verify history persistence and model-context exclusion. Its terminal and local session bridge perform no provider call and do not constitute interactive/provider end-to-end verification.

A non-interactive Pi load check can be run without a model call:

```sh
printf '' | pi --mode rpc --no-extensions --extension .
```

This checks package discovery and extension loading. It is not a substitute for interactive terminal verification.
