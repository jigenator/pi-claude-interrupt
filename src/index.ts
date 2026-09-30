import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

type Delivery = "steer" | "followUp";

type PendingText = {
	text: string;
	deliverAs: Delivery;
	hasImages: boolean;
};

type PendingQueues = {
	steering: PendingText[];
	followUp: PendingText[];
};

type InterruptState = {
	phase: "aborting" | "starting";
	queues: PendingQueues;
};

function emptyQueues(): PendingQueues {
	return { steering: [], followUp: [] };
}

function ordered(queues: PendingQueues): PendingText[] {
	return [...queues.steering, ...queues.followUp];
}

function push(queues: PendingQueues, item: PendingText): void {
	(item.deliverAs === "steer" ? queues.steering : queues.followUp).push(item);
}

function queuesFrom(items: PendingText[]): PendingQueues {
	const queues = emptyQueues();
	for (const item of items) push(queues, item);
	return queues;
}

function prependEditorText(ctx: ExtensionContext, texts: string[]): void {
	const current = ctx.ui.getEditorText();
	ctx.ui.setEditorText([...texts, current].filter((text) => text.trim()).join("\n\n"));
}

/** Exported for the regression harness; Pi uses the default export. */
export function createClaudeInterrupt(pi: ExtensionAPI): void {
	let pending = emptyQueues();
	let interrupt: InterruptState | undefined;
	let expectedReplay: PendingText[] = [];
	let skipNextUserStart = false;
	let unsubscribeTerminal: (() => void) | undefined;

	const reset = (): void => {
		unsubscribeTerminal?.();
		unsubscribeTerminal = undefined;
		pending = emptyQueues();
		interrupt = undefined;
		expectedReplay = [];
		skipNextUserStart = false;
	};

	const consumeExpectedReplay = (event: InputEvent): boolean => {
		if (event.source !== "extension" || expectedReplay.length === 0) return false;

		const expected = expectedReplay[0];
		if (event.text !== expected.text || (event.images?.length ?? 0) !== 0) return false;

		expectedReplay.shift();
		return true;
	};

	pi.on("input", (event, ctx) => {
		if (consumeExpectedReplay(event)) return;
		if (!event.streamingBehavior) return;

		const item: PendingText = {
			text: event.text,
			deliverAs: event.streamingBehavior,
			hasImages: (event.images?.length ?? 0) > 0,
		};

		if (interrupt?.phase === "aborting") {
			// Once an interrupt has started, Pi cannot losslessly move a newly queued
			// image through the editor. Reject that late submission explicitly while
			// retaining its text, rather than invalidating the captured text batch.
			if (item.hasImages) {
				prependEditorText(ctx, item.text ? [item.text] : []);
				ctx.ui.notify("Attachment was not queued while interrupting; its text was restored to the editor.", "warning");
				return { action: "handled" };
			}

			// A text submit can race the old run settling after Escape. Include it in
			// the replay batch; Pi's old queue is cleared once more at settlement.
			push(interrupt.queues, item);
			return;
		}

		push(pending, item);
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "user" || interrupt) return;
		if (skipNextUserStart) {
			skipNextUserStart = false;
			return;
		}

		// Pi drains steering before follow-ups. Mirroring that priority keeps our
		// observer aligned even when equal text was submitted more than once.
		if (pending.steering.length > 0) pending.steering.shift();
		else pending.followUp.shift();
	});

	pi.on("session_start", (_event, ctx) => {
		reset();
		if (ctx.mode !== "tui") return;

		unsubscribeTerminal = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "escape")) return;

			if (interrupt?.phase === "aborting") {
				// A repeated Escape while the original abort settles is idempotent.
				return { consume: true };
			}

			if (interrupt?.phase === "starting") {
				// Preflight can fail before agent_start (for example, authentication).
				// A second Escape abandons extension restart tracking, requests an abort,
				// and restores every captured message visibly. Escape therefore never
				// remains disabled indefinitely even when no agent_start event arrives.
				const replay = ordered(interrupt.queues);
				interrupt = undefined;
				expectedReplay = [];
				pending = emptyQueues();
				skipNextUserStart = false;
				ctx.abort();
				prependEditorText(ctx, replay.map((item) => item.text));
				return { consume: true };
			}

			if (!ctx.hasPendingMessages()) return;

			const queue = ordered(pending);
			// We cannot recover structured queue entries through Pi 0.99.1. If Pi
			// reports a queue but we observed no text, or an observed image is present,
			// leave Escape to Pi's native handler.
			if (queue.length === 0 || queue.some((item) => item.hasImages)) return;

			const draft = ctx.ui.getEditorText();
			interrupt = {
				phase: "aborting",
				queues: pending,
			};
			expectedReplay = [];
			pending = emptyQueues();
			skipNextUserStart = false;

			// In TUI mode ctx.abort() clears Pi's queues and prepends their text to
			// the editor. Restore the exact pre-abort draft immediately; our captured
			// submitted messages are replayed only after agent_settled.
			ctx.abort();
			ctx.ui.setEditorText(draft);
			return { consume: true };
		});
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (interrupt?.phase !== "aborting") {
			// A normal settlement means Pi drained (or discarded) its queues.
			pending = emptyQueues();
			return;
		}

		const state = interrupt;
		const replay = ordered(state.queues);
		if (replay.length === 0) {
			interrupt = undefined;
			return;
		}

		// Clear text submitted during the short abort/settle window. It has already
		// been captured above, but may still be sitting in Pi's old queue.
		if (ctx.hasPendingMessages()) {
			const draft = ctx.ui.getEditorText();
			ctx.abort();
			ctx.ui.setEditorText(draft);
		}

		state.phase = "starting";
		expectedReplay = [...replay];
		pi.sendUserMessage(replay[0].text, { expandPromptTemplates: true });
	});

	pi.on("agent_start", () => {
		if (interrupt?.phase !== "starting") return;

		const state = interrupt;
		const replay = ordered(state.queues);
		const remainder = replay.slice(1);

		// Track the replayed remainder exactly like an ordinary Pi queue. This makes
		// another Escape during the continuation interrupt and resume it again.
		pending = queuesFrom(remainder);
		skipNextUserStart = true;

		for (const item of remainder) {
			pi.sendUserMessage(item.text, {
				deliverAs: item.deliverAs,
				expandPromptTemplates: true,
			});
		}

		interrupt = undefined;
	});

	pi.on("session_shutdown", () => {
		reset();
	});
}

export default createClaudeInterrupt;
