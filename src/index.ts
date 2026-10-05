import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	Theme,
	ThemeStyle,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, parseColor, truncateToWidth } from "@earendil-works/pi-tui";

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

// Marker timeline in ms after continuation start. Updates are stepped every
// STEP; the final 2960-3000 interval is kept rather than rounded away.
const STEP = 80;
const WIPE = 320;
const CHEVRON_STEP = 160;
const SNAP = 2720;
const SETTLE_WIPE = 2800;
const WINDOW = 3000;

// Acid/Black palette. The marker owns every cell's colors so it reads the same
// on light and dark themes; Pi converts them for truecolor or 256-color output.
const acid = parseColor("#c0fe04");
const black = parseColor("#000000");
const bone = parseColor("#ffffff");
const grey = parseColor("#717171");
const darkGrey = parseColor("#555555");
const livePlate: ThemeStyle = { fg: black, bg: acid, bold: true };
const outline: ThemeStyle = { fg: acid, bg: black, bold: true };
const recordPlate: ThemeStyle = { fg: bone, bg: darkGrey, bold: true };
const track: ThemeStyle = { fg: grey, bg: black };
const tick: ThemeStyle = { fg: black, bg: bone, bold: true };
const rule: ThemeStyle = { fg: darkGrey, bg: black };
const blank: ThemeStyle = { bg: black };

/**
 * One marker row at `elapsed` ms, or settled when undefined. The label starts
 * at the native outputPad column; the strip ends before the right padding.
 */
export function renderMarker(theme: Theme, width: number, outputPad: 0 | 1, elapsed?: number): string {
	const label = `${outputPad ? " " : ""}DIRECTIVE UPDATED `;
	const plate = label.length;
	const contentWidth = Math.max(0, width - outputPad);
	const ruleLength = Math.max(0, contentWidth - (plate + 5));
	const m = elapsed === undefined ? WINDOW : Math.max(0, elapsed);
	const runs: [string, ThemeStyle][] = [];
	const add = (text: string, style: ThemeStyle): void => {
		const last = runs[runs.length - 1];
		if (last?.[1] === style) last[0] += text;
		else runs.push([text, style]);
	};
	const addPlate = (split: number, before: ThemeStyle, after: ThemeStyle): void => {
		add(label.slice(0, split), before);
		add(label.slice(split), after);
	};

	const step = Math.floor(m / STEP);
	if (m >= WINDOW) addPlate(plate, recordPlate, recordPlate);
	else if (m < SETTLE_WIPE) addPlate(Math.min(plate, Math.ceil(((step + 1) * plate * STEP) / WIPE)), livePlate, outline);
	else addPlate(Math.min(plate, Math.ceil(((m - SETTLE_WIPE + STEP) * plate) / (WINDOW - SETTLE_WIPE))), recordPlate, livePlate);
	add(" ", blank);

	if (m < SNAP) {
		// A looping conveyor, never a fill, so it cannot read as progress.
		const head = Math.floor(m / CHEVRON_STEP) % 3;
		for (let i = 0; i < 3; i++) {
			if (i === head) add("▶", outline);
			else if (i === head - 1) add("›", outline);
			else add("·", track);
		}
	} else {
		add("✓", m < SETTLE_WIPE ? tick : outline);
		add("  ", blank);
	}
	add(" ", blank);

	const shown = m >= WIPE ? ruleLength : Math.min(ruleLength, Math.floor(((step + 1) * ruleLength * STEP) / WIPE) + 1);
	add("─".repeat(shown), rule);
	add(" ".repeat(ruleLength - shown), blank);

	const line = runs.filter(([text]) => text).map(([text, style]) => theme.style(text, style)).join("");
	return truncateToWidth(line, contentWidth, "");
}

/** Exported for the regression harness; Pi uses the default export. */
export function createClaudeInterrupt(pi: ExtensionAPI): void {
	let pending = emptyQueues();
	let interrupt: InterruptState | undefined;
	let expectedReplay: PendingText[] = [];
	let skipNextUserStart = false;
	let unsubscribeTerminal: (() => void) | undefined;
	let ownsEscape = false;
	const markerType = "claude-interrupt-steering";
	let animation: {
		id: string;
		startedAt: number;
		/** Stepped animation time; render state is a pure function of it. */
		elapsed: number;
		ctx: ExtensionContext;
		timer?: ReturnType<typeof setTimeout>;
		requestRender?: () => void;
	} | undefined;

	// Only this runtime's live identity animates. Saved entries always render done.
	pi.registerEntryRenderer<{ id: string }>(markerType, (entry, _options, theme) => ({
		render: (width) => {
			const live = animation && entry.data?.id === animation.id ? animation : undefined;
			const pad = pi.getSettings().outputPad === 0 ? 0 : 1;
			return [renderMarker(theme, width, pad, live?.elapsed)];
		},
		invalidate() {},
	}));

	const disposeAnimation = (): void => {
		const live = animation;
		if (!live) return;
		clearTimeout(live.timer);
		animation = undefined;
		live.requestRender?.(); // Finalize the transcript row, never remove it.
	};

	const clearAnimation = (): void => {
		const ctx = animation?.ctx;
		disposeAnimation();
		ctx?.ui.setWidget(markerType, undefined);
	};

	const reset = (): void => {
		unsubscribeTerminal?.();
		unsubscribeTerminal = undefined;
		ownsEscape = false;
		clearAnimation();
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
			// Raw input listeners run before Pi filters Kitty release events. Only
			// presses act; a held extension-owned Escape must not natively abort the
			// continuation through repeats after agent_start has cleared interrupt.
			if (isKeyRelease(data)) {
				ownsEscape = false;
				return;
			}
			if (isKeyRepeat(data)) return ownsEscape ? { consume: true } : undefined;
			ownsEscape = false; // A genuine new press chooses ownership again.
			clearAnimation();

			if (interrupt?.phase === "aborting") {
				// Another press while the original abort settles is idempotent.
				ownsEscape = true;
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
				ownsEscape = true;
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
			ownsEscape = true;
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

	pi.on("agent_start", (_event, ctx) => {
		if (interrupt?.phase !== "starting") return;

		clearAnimation();
		if (ctx.mode === "tui") {
			const live: NonNullable<typeof animation> = { id: randomUUID(), startedAt: Date.now(), elapsed: 0, ctx };
			animation = live;
			pi.appendEntry(markerType, { id: live.id });
			// Entry renderers have no TUI handle. This zero-row widget supplies only
			// redraw/lifecycle access; the single visible row belongs to history.
			ctx.ui.setWidget(markerType, (tui) => {
				live.requestRender = () => tui.requestRender();
				// Each timer advances at least one step and catches up after a late
				// wake-up, so the animation ends within WINDOW / STEP + 1 timers.
				const schedule = (): void => {
					const due = Math.min(WINDOW, live.elapsed + STEP) - (Date.now() - live.startedAt);
					live.timer = setTimeout(advance, Math.min(STEP, Math.max(0, due)));
				};
				const advance = (): void => {
					if (animation !== live) return;
					const reached = Math.floor((Date.now() - live.startedAt) / STEP) * STEP;
					live.elapsed = Math.min(WINDOW, Math.max(live.elapsed + STEP, reached));
					if (live.elapsed === WINDOW) {
						clearAnimation();
						return;
					}
					tui.requestRender();
					schedule();
				};
				schedule();
				return {
					render: () => [],
					invalidate() {},
					// Pi disposes before removal; never recurse into setWidget here.
					dispose: () => { if (animation === live) disposeAnimation(); },
				};
			});
		}

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
