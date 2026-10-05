import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { Text, visibleWidth, type Component, type TerminalColorMode, type TUI } from "@earendil-works/pi-tui";

import {
	Theme,
	type ExtensionAPI,
	type ExtensionContext,
	type CustomEntry,
	type EntryRenderer,
	type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { createClaudeInterrupt, renderMarker } from "../src/index.ts";

// A real Pi Theme, so stubs cannot hide style API or color-mode errors.
function makeTheme(mode: TerminalColorMode, appearance: "dark" | "light" = "dark"): Theme {
	const ink = appearance === "light" ? "#202020" : "#e0e0e0";
	const paper = appearance === "light" ? "#f4f4f4" : "#181818";
	// Only the tokens these tests touch, including the marker's light-theme accent.
	const fg = { accent: ink, error: ink, muted: ink, text: ink, thinkingXhigh: ink };
	const bg = { selectedBg: paper, customMessageBg: paper };
	return new Theme(fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1], mode, { appearance });
}

type Handler = (event: any, ctx: ExtensionContext) => unknown;

type SentMessage = {
	text: string;
	options: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean } | undefined;
};

function harness(t: TestContext, mode: ExtensionContext["mode"] = "tui") {
	const handlers = new Map<string, Handler[]>();
	const sent: SentMessage[] = [];
	let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let terminalUnsubscribed = false;
	let editorText = "";
	let coreHasPending = false;
	let aborts = 0;
	const notifications: string[] = [];
	let widget: (Component & { dispose?(): void }) | undefined;
	let renderRequests = 0;
	let widgetShows = 0;
	let outputPad: 0 | 1 | undefined;
	const tui = { requestRender: () => { renderRequests++; } } as unknown as TUI;
	let theme = makeTheme("truecolor");
	let entryRenderer: EntryRenderer | undefined;
	const markers: { entry: CustomEntry; component: Component }[] = [];
	const loadEntry = (entry: CustomEntry): void => {
		assert.ok(entryRenderer);
		const component = entryRenderer(entry, { expanded: false }, theme);
		assert.ok(component);
		markers.push({ entry, component });
	};

	const emitSync = (name: string, event: any, ctx: ExtensionContext): unknown => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = handler(event, ctx);
		return result;
	};

	const pi = {
		getSettings: () => ({ outputPad }),
		registerEntryRenderer(customType: string, renderer: EntryRenderer) {
			assert.equal(customType, "claude-interrupt-steering");
			entryRenderer = renderer;
		},
		appendEntry(customType: string, data: unknown) {
			loadEntry({ type: "custom", id: `entry-${markers.length}`, parentId: null,
				timestamp: new Date().toISOString(), customType, data });
		},
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => undefined;
		},
		sendUserMessage(text: string, options: SentMessage["options"]) {
			sent.push({ text, options });
			const result = emitSync(
				"input",
				{
					type: "input",
					text,
					source: "extension",
					streamingBehavior: options?.deliverAs,
				} satisfies InputEvent,
				ctx,
			) as { action?: string } | undefined;
			if (options?.deliverAs && result?.action !== "handled") coreHasPending = true;
		},

	} as unknown as ExtensionAPI;

	const ctx = {
		mode,
		ui: {
			onTerminalInput(handler: typeof terminalHandler) {
				terminalHandler = handler;
				terminalUnsubscribed = false;
				return () => {
					terminalUnsubscribed = true;
					terminalHandler = undefined;
				};
			},
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			setWidget(key: string, factory: ((tui: TUI, theme: Theme) => typeof widget) | undefined) {
				assert.equal(key, "claude-interrupt-steering");
				// Like Pi, dispose before removing the old component. This catches
				// recursive setWidget calls from a component's disposal callback.
				widget?.dispose?.();
				widget = undefined;
				if (factory) {
					widget = factory(tui, theme);
					widgetShows++;
				}
			},
		},
		hasPendingMessages: () => coreHasPending,
		abort: () => {
			aborts += 1;
			// This models Pi 0.99.1 prepending cleared queue text only when a
			// queue exists. The extension then restores its saved draft.
			if (coreHasPending) editorText = `native restored queue\n\n${editorText}`;
			coreHasPending = false;
		},

	} as unknown as ExtensionContext;

	createClaudeInterrupt(pi);
	emitSync("session_start", { type: "session_start" }, ctx);
	t.after(() => emitSync("session_shutdown", { type: "session_shutdown" }, ctx));

	return {
		ctx,
		sent,
		markers,
		loadEntry,
		renderMarker: (index = markers.length - 1, width = 80) => markers[index]?.component.render(width),
		renderWidget: (width = 80) => widget?.render(width),
		disposeWidget() {
			widget?.dispose?.();
			widget = undefined;
		},
		setOutputPad(value: 0 | 1 | undefined) { outputPad = value; },
		/** Like Pi's CustomEntryComponent.invalidate(): rebuild every entry with the new theme. */
		setTheme(next: Theme) {
			theme = next;
			for (const marker of markers) marker.component = entryRenderer!(marker.entry, { expanded: false }, theme)!;
		},
		get renderRequests() { return renderRequests; },
		get widgetShows() { return widgetShows; },
		emit(name: string, event: any) {
			emitSync(name, event, ctx);
		},
		input(text: string, deliverAs: "steer" | "followUp", withImage = false) {
			return emitSync(
				"input",
				{
					type: "input",
					text,
					images: withImage ? [{ type: "image", data: "AA==", mimeType: "image/png" }] : undefined,
					source: "interactive",
					streamingBehavior: deliverAs,
				} satisfies InputEvent,
				ctx,
			);
		},
		escape(data = "\x1b") {
			return terminalHandler?.(data);
		},
		setDraft(text: string) {
			editorText = text;
		},
		get draft() {
			return editorText;
		},
		setCorePending(value: boolean) {
			coreHasPending = value;
		},
		get aborts() {
			return aborts;
		},
		get notifications() {
			return notifications;
		},
		get terminalUnsubscribed() {
			return terminalUnsubscribed;
		},
	};
}

const userMessageStart = {
	type: "message_start",
	message: { role: "user", content: [{ type: "text", text: "queued" }], timestamp: 1 },
};

test("Escape interrupts one queued text and continues only after settlement", (t) => {
	const h = harness(t);
	h.input("new direction", "steer");
	h.setCorePending(true);
	h.setDraft("unsent draft");

	assert.deepEqual(h.escape(), { consume: true });
	assert.equal(h.aborts, 1);
	assert.equal(h.draft, "unsent draft");
	assert.deepEqual(h.sent, []);

	h.emit("agent_settled", { type: "agent_settled" });
	assert.deepEqual(h.sent, [
		{ text: "new direction", options: { expandPromptTemplates: true } },
	]);

	h.emit("agent_start", { type: "agent_start" });
	assert.equal(h.draft, "unsent draft");
});

test("several messages retain Pi's steering-before-follow-up order without duplication", (t) => {
	const h = harness(t);
	h.input("follow one", "followUp");
	h.input("steer one", "steer");
	h.input("follow two", "followUp");
	h.input("steer two", "steer");
	h.setCorePending(true);

	h.escape();
	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });

	assert.deepEqual(h.sent, [
		{ text: "steer one", options: { expandPromptTemplates: true } },
		{ text: "steer two", options: { deliverAs: "steer", expandPromptTemplates: true } },
		{ text: "follow one", options: { deliverAs: "followUp", expandPromptTemplates: true } },
		{ text: "follow two", options: { deliverAs: "followUp", expandPromptTemplates: true } },
	]);
	assert.equal(new Set(h.sent.map((entry) => entry.text)).size, 4);
});

test("Escape without a core queue remains native and an unsent draft is not a queue", (t) => {
	const h = harness(t);
	h.setDraft("draft only");
	h.setCorePending(false);

	assert.equal(h.escape(), undefined);
	assert.equal(h.aborts, 0);
	assert.equal(h.draft, "draft only");
});

test("repeated Escape while abort is settling is consumed without aborting twice", (t) => {
	const h = harness(t);
	h.input("queued", "steer");
	h.setCorePending(true);

	assert.deepEqual(h.escape(), { consume: true });
	assert.deepEqual(h.escape(), { consume: true });
	assert.equal(h.aborts, 1);

	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });
	assert.equal(h.sent.length, 1);
});

test("Escape can interrupt a replay and resumes the undelivered remainder once", (t) => {
	const h = harness(t);
	h.input("first", "steer");
	h.input("second", "steer");
	h.input("third", "followUp");
	h.setCorePending(true);

	h.escape();
	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });
	assert.deepEqual(h.sent.map((entry) => entry.text), ["first", "second", "third"]);

	// The first continuation has started, but second and third are still queued.
	assert.deepEqual(h.escape(), { consume: true });
	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });

	// The first head is not replayed. The earlier second/third queue was cleared by
	// the second abort, then the same remainder was submitted once for the new run.
	assert.deepEqual(h.sent.map((entry) => entry.text), ["first", "second", "third", "second", "third"]);
	assert.equal(h.sent.filter((entry) => entry.text === "first").length, 1);
});

test("Escape during continuation preflight restores captured text and exits starting state", (t) => {
	const h = harness(t);
	h.input("retry me", "steer");
	h.input("and me", "followUp");
	h.setCorePending(true);
	h.setDraft("unsent");

	h.escape();
	h.emit("agent_settled", { type: "agent_settled" });
	// No agent_start: model/auth/command preflight did not start the run.
	assert.deepEqual(h.escape(), { consume: true });
	assert.equal(h.draft, "retry me\n\nand me\n\nunsent");

	// The recovery Escape clears extension state; another Escape is native.
	assert.equal(h.escape(), undefined);
});

test("already delivered messages are removed from the observed queue", (t) => {
	const h = harness(t);
	h.input("queued", "steer");
	h.emit("message_start", userMessageStart);
	h.setCorePending(true); // Deliberately inconsistent to exercise the observer guard.

	assert.equal(h.escape(), undefined);
	assert.equal(h.aborts, 0);
});

test("queued image attachments fall back to Pi's native Escape", (t) => {
	const h = harness(t);
	h.input("look at this", "steer", true);
	h.setCorePending(true);

	assert.equal(h.escape(), undefined);
	assert.equal(h.aborts, 0);
	assert.deepEqual(h.sent, []);
});

test("text submitted during abort settlement is cleared once and replayed once", (t) => {
	const h = harness(t);
	h.input("first", "steer");
	h.setCorePending(true);
	h.setDraft("keep me");
	h.escape();

	h.input("raced follow-up", "followUp");
	h.setCorePending(true);
	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });

	assert.equal(h.aborts, 2);
	assert.equal(h.draft, "keep me");
	assert.deepEqual(h.sent.map((entry) => entry.text), ["first", "raced follow-up"]);
});

test("a late image is rejected without discarding the captured text batch", (t) => {
	const h = harness(t);
	h.input("first", "steer");
	h.setCorePending(true);
	h.setDraft("keep me");
	h.escape();

	assert.deepEqual(h.input("late image text", "followUp", true), { action: "handled" });
	assert.equal(h.draft, "late image text\n\nkeep me");
	assert.equal(h.notifications.length, 1);

	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });
	assert.deepEqual(h.sent.map((entry) => entry.text), ["first"]);
});

test("session shutdown removes the terminal listener and clears state", (t) => {
	const h = harness(t);
	h.input("queued", "steer");
	h.setCorePending(true);

	h.emit("session_shutdown", { type: "session_shutdown" });
	assert.equal(h.terminalUnsubscribed, true);
	assert.equal(h.escape(), undefined);
	assert.equal(h.aborts, 0);
});

function startContinuation(h: ReturnType<typeof harness>) {
	h.input("new direction", "steer");
	h.setCorePending(true);
	h.escape();
	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });
}

const mockClock = (t: TestContext) => t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
// Mock runAll() only reaches timers already queued, so step through the chain.
function finishAnimation(t: TestContext): void {
	for (let i = 0; i < 40; i++) t.mock.timers.tick(80);
}

// The label, gap, indicator and gap: the first 24 columns at outputPad 1.
const live = (indicator: string) => ` DIRECTIVE UPDATED  ${indicator} `;
const settled = live("✓  ");
function head(lines: string[] | undefined, pad: 0 | 1 = 1): string {
	assert.equal(lines?.length, 1, "the marker is always exactly one row");
	return stripAnsi(lines[0]).slice(0, 23 + pad);
}
const lastStep = 37; // 80ms steps 0..2960; the final 40ms interval ends at 3000.
const indicatorAt = (step: number) => step >= 34 ? "✓  " : ["▶··", "›▶·", "·›▶"][Math.floor(step / 2) % 3];

type Cell = { ch: string; fg?: string; bg?: string; bold: boolean };

/** Decodes the SGR stream into cells. Any non-SGR escape fails the test. */
function cells(line: string): Cell[] {
	const out: Cell[] = [];
	let fg: string | undefined;
	let bg: string | undefined;
	let bold = false;
	const hex = (n: number) => n.toString(16).padStart(2, "0");
	for (const [, sgr, ch] of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b])|\x1b/gu)) {
		if (ch !== undefined) {
			out.push({ ch, fg, bg, bold });
			continue;
		}
		assert.ok(sgr !== undefined, `unexpected escape in ${JSON.stringify(line)}`);
		const p = sgr.split(";").map(Number);
		for (let i = 0; i < p.length; i++) {
			const code = p[i];
			if (code === 0) [fg, bg, bold] = [undefined, undefined, false];
			else if (code === 1) bold = true;
			else if (code === 22) bold = false;
			else if (code === 39) fg = undefined;
			else if (code === 49) bg = undefined;
			else if (code === 38 || code === 48) {
				const value = p[i + 1] === 2 ? `#${hex(p[i + 2])}${hex(p[i + 3])}${hex(p[i + 4])}` : `@${p[i + 2]}`;
				i += p[i + 1] === 2 ? 4 : 2;
				if (code === 38) fg = value;
				else bg = value;
			} else assert.fail(`unexpected SGR ${code}`);
		}
	}
	return out;
}

const palettes = {
	truecolor: { acid: "#c0fe04", black: "#000000", bone: "#ffffff", grey: "#717171", darkGrey: "#555555" },
	// Pi's own 256-color approximation of the same palette.
	"256color": { acid: "@154", black: "@16", bone: "@231", grey: "@242", darkGrey: "@240" },
} as const;

/** L live plate, O acid ink, R grey record plate, T grey track, K bone tick, U rule, B default-background blank. */
function classes(line: string, mode: TerminalColorMode): string {
	const c = palettes[mode];
	return cells(line).map(({ ch, fg, bg, bold }) => {
		const key = `${fg}/${bg}/${bold}`;
		if (key === `${c.black}/${c.acid}/true`) return "L";
		if (key === `${c.acid}/undefined/true`) return "O";
		if (key === `${c.bone}/${c.darkGrey}/true`) return "R";
		if (key === `${c.grey}/undefined/false`) return "T";
		if (key === `${c.black}/${c.bone}/true`) return "K";
		if (key === `${c.darkGrey}/undefined/false`) return "U";
		if (ch === " " && fg === undefined && bg === undefined && !bold) return "B";
		return "?";
	}).join("");
}

test("marker cells carry the approved Acid/Black colors and attributes in every phase", () => {
	const r = (n: number, ch: string) => ch.repeat(n);
	// Width 30 at outputPad 1: 19-cell plate, gap, 3 indicator cells, gap, 5-cell rule, right pad.
	const frames: [number | undefined, string, string][] = [
		[0, " DIRECTIVE UPDATED  ▶·· ──   ", `${r(5, "L")}${r(14, "O")}BOTTBUUBBB`],
		[80, " DIRECTIVE UPDATED  ▶·· ───  ", `${r(10, "L")}${r(9, "O")}BOTTBUUUBB`],
		[160, " DIRECTIVE UPDATED  ›▶· ──── ", `${r(15, "L")}${r(4, "O")}BOOTBUUUUB`],
		[240, " DIRECTIVE UPDATED  ›▶· ─────", `${r(19, "L")}BOOTBUUUUU`],
		[320, " DIRECTIVE UPDATED  ·›▶ ─────", `${r(19, "L")}BTOOBUUUUU`],
		[2640, " DIRECTIVE UPDATED  ›▶· ─────", `${r(19, "L")}BOOTBUUUUU`],
		[2720, " DIRECTIVE UPDATED  ✓   ─────", `${r(19, "L")}BKBBBUUUUU`],
		[2800, " DIRECTIVE UPDATED  ✓   ─────", `${r(8, "R")}${r(11, "L")}BOBBBUUUUU`],
		[2880, " DIRECTIVE UPDATED  ✓   ─────", `${r(16, "R")}${r(3, "L")}BOBBBUUUUU`],
		[2960, " DIRECTIVE UPDATED  ✓   ─────", `${r(19, "R")}BOBBBUUUUU`],
		[3000, " DIRECTIVE UPDATED  ✓   ─────", `${r(19, "R")}BOBBBUUUUU`],
		[undefined, " DIRECTIVE UPDATED  ✓   ─────", `${r(19, "R")}BOBBBUUUUU`],
	];
	for (const mode of ["truecolor", "256color"] as const) {
		for (const [elapsed, glyphs, expected] of frames) {
			const line = renderMarker(makeTheme(mode), 30, 1, elapsed);
			assert.equal(stripAnsi(line), glyphs, `${mode} ${elapsed}`);
			assert.equal(classes(line, mode), expected, `${mode} ${elapsed}`);
			// Only plates/flash have backgrounds. Transparent acid ink follows the
			// native accent on light themes; the plate colors and glyphs stay fixed.
			const light = makeTheme(mode, "light");
			const accent = cells(light.style("x", { fg: "accent", bold: true }))[0].fg;
			assert.deepEqual(cells(renderMarker(light, 30, 1, elapsed)), cells(line).map((cell) => ({
				...cell, fg: cell.fg === palettes[mode].acid && cell.bg === undefined ? accent : cell.fg,
			})));
		}
	}
	// outputPad 0 drops the leading plate cell so the label stays on column 0.
	const flush = renderMarker(makeTheme("truecolor"), 30, 0, 0);
	assert.equal(stripAnsi(flush), "DIRECTIVE UPDATED  ▶·· ──     ");
	assert.equal(classes(flush, "truecolor"), `${r(5, "L")}${r(13, "O")}BOTTBUUBBBBB`);
	assert.equal(classes(renderMarker(makeTheme("truecolor"), 30, 0, 2800), "truecolor"), `${r(8, "R")}${r(10, "L")}BOBBBUUUUUUU`);
});

test("marker rows fit every width from 0 to 160 in every frame, pad and color mode", () => {
	const times = [...Array.from({ length: lastStep + 1 }, (_, step) => step * 80), 3000, undefined];
	for (const mode of ["truecolor", "256color"] as const) {
		const theme = makeTheme(mode);
		for (const pad of [0, 1] as const) {
			for (let width = 0; width <= 160; width++) {
				for (const elapsed of times) {
					const line = renderMarker(theme, width, pad, elapsed);
					// Narrow rows are clipped; wider rows run the rule to the right padding.
					assert.equal(visibleWidth(line), Math.max(0, width - pad), `${mode} pad ${pad} width ${width} at ${elapsed}`);
					assert.equal(renderMarker(theme, width, pad, elapsed), line, "rendering is stateless");
				}
			}
		}
	}
});

test("marker label starts on the same column as Pi's native abort notice for outputPad 0/1", () => {
	const theme = makeTheme("truecolor");
	for (const pad of [0, 1] as const) {
		const native = stripAnsi(new Text(theme.fg("error", "Operation aborted"), pad, 0).render(80)[0]);
		for (const elapsed of [0, 1000, 2800, undefined]) {
			const marker = stripAnsi(renderMarker(theme, 80, pad, elapsed));
			assert.equal(marker.indexOf("D"), native.indexOf("O"));
			assert.equal(visibleWidth(marker), 80 - pad, "native right padding stays unstyled");
		}
	}
});

test("history marker steps every 80ms through 38 frames and settles at exactly 3000ms without changing the draft", (t) => {
	mockClock(t);
	const h = harness(t);
	h.setDraft("keep my cursor text");
	startContinuation(h);
	assert.equal(h.markers.length, 1);
	for (let step = 0; step <= lastStep; step++) {
		assert.equal(head(h.renderMarker()), live(indicatorAt(step)), `step ${step}`);
		assert.deepEqual(h.renderWidget(), []); // No second visible copy.
		for (const width of [0, 1, 3, 12, 25, 80, 160]) {
			const lines = h.renderMarker(0, width)!;
			assert.equal(lines.length, 1);
			assert.ok(visibleWidth(lines[0]) <= width);
		}
		const interval = step === lastStep ? 40 : 80;
		t.mock.timers.tick(interval - 1);
		assert.equal(head(h.renderMarker()), live(indicatorAt(step)));
		assert.equal(h.renderRequests, step);
		t.mock.timers.tick(1);
		assert.equal(h.renderRequests, step + 1);
	}
	assert.equal(Date.now(), 3000);
	assert.equal(head(h.renderMarker()), settled);
	assert.equal(h.renderWidget(), undefined);
	assert.equal(h.widgetShows, 1);
	h.emit("message_start", userMessageStart);
	h.emit("tool_execution_start", { type: "tool_execution_start" });
	h.emit("agent_start", { type: "agent_start" });
	t.mock.timers.tick(60_000);
	t.mock.timers.runAll();
	assert.equal(h.renderRequests, 38);
	assert.equal(h.markers.length, 1);
	assert.equal(head(h.renderMarker()), settled);
	assert.equal(h.draft, "keep my cursor text");
});

test("theme, color-mode and width changes during the animation keep the current frame", (t) => {
	mockClock(t);
	const h = harness(t);
	startContinuation(h);
	for (let i = 0; i < 3; i++) t.mock.timers.tick(80);
	const before = h.renderRequests;
	for (const width of [80, 20, 0, 160, 37, 80]) assert.ok(visibleWidth(h.renderMarker(0, width)![0]) <= width);
	h.setTheme(makeTheme("256color", "dark"));
	const line = h.renderMarker()![0];
	assert.equal(head([line]), live("›▶·"));
	assert.equal(classes(line, "256color").slice(0, 24), `${"L".repeat(19)}BOOTB`);
	h.setTheme(makeTheme("truecolor", "light"));
	assert.equal(head(h.renderMarker()), live("›▶·"));
	assert.deepEqual(cells(h.renderMarker()![0])[20], { ch: "›", fg: "#202020", bg: undefined, bold: true });
	assert.equal(h.renderRequests, before, "rendering never schedules work");
	finishAnimation(t);
	assert.equal(head(h.renderMarker()), settled);
});

test("late timer wake-ups catch up and wall-clock jumps cannot extend the bounded animation", (t) => {
	// Timers run on their own mocked monotonic clock; Date.now is the wall clock.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let wall = 0;
	t.mock.method(Date, "now", () => wall);
	const tick = (ms: number) => {
		wall += ms;
		t.mock.timers.tick(ms);
	};
	const h = harness(t);
	startContinuation(h);
	wall += 1000; // An event-loop stall: time passes before the first timer runs.
	tick(80);
	assert.equal(h.renderRequests, 1, "one redraw, not a burst of missed frames");
	assert.equal(head(h.renderMarker()), live("▶··")); // 1040ms: conveyor step 13.
	wall += 5000;
	tick(40); // Next boundary was 1120ms.
	assert.equal(h.renderWidget(), undefined);
	assert.equal(head(h.renderMarker()), settled);
	assert.equal(h.renderRequests, 2);

	h.emit("session_start", { type: "session_start" });
	startContinuation(h);
	wall -= 10_000; // A backwards wall-clock jump still advances one step per timer.
	let timers = 0;
	while (h.renderWidget() !== undefined && timers < 100) {
		tick(80);
		timers++;
	}
	assert.equal(timers, 38);
	assert.equal(head(h.renderMarker()), settled);
	t.mock.timers.runAll();
	assert.equal(h.renderRequests, 2 + 38);
});

test("marker waits for confirmed continuation and stays out of ordinary, native and non-TUI paths", (t) => {
	mockClock(t);
	const h = harness(t);
	h.emit("agent_start", { type: "agent_start" });
	h.escape();
	h.input("image", "steer", true);
	h.setCorePending(true);
	h.escape();
	assert.equal(h.markers.length, 0);
	h.emit("session_start", { type: "session_start" });
	h.input("retry me", "steer");
	h.setCorePending(true);
	h.escape();
	h.emit("agent_settled", { type: "agent_settled" });
	t.mock.timers.runAll(); // Preflight never reaches agent_start.
	assert.equal(h.markers.length, 0);
	h.escape();
	h.emit("agent_start", { type: "agent_start" });
	assert.equal(h.markers.length, 0);
	assert.equal(h.widgetShows, 0);

	const rpc = harness(t, "rpc");
	startContinuation(rpc);
	assert.equal(rpc.aborts, 0);
	assert.equal(rpc.markers.length, 0);
	assert.equal(rpc.widgetShows, 0);
});

test("saved markers reload completed and distinct identities never animate old entries", (t) => {
	mockClock(t);
	const first = harness(t);
	startContinuation(first);
	const saved = structuredClone(first.markers[0].entry);
	const h = harness(t);
	h.loadEntry(saved);
	assert.equal(head(h.renderMarker()), settled);
	assert.equal(h.widgetShows, 0);
	startContinuation(h);
	assert.notDeepEqual(h.markers[0].entry.data, h.markers[1].entry.data);
	assert.equal(head(h.renderMarker(0)), settled);
	t.mock.timers.tick(80);
	t.mock.timers.tick(80);
	assert.equal(head(h.renderMarker(1)), live("›▶·"));
	startContinuation(h);
	assert.equal(new Set(h.markers.map(({ entry }) => (entry.data as { id: string }).id)).size, 3);
	assert.equal(head(h.renderMarker(0)), settled);
	assert.equal(head(h.renderMarker(1)), settled);
	assert.equal(head(h.renderMarker(2)), live("▶··"));
	t.mock.timers.tick(80);
	assert.equal(h.renderRequests, 4); // Two old frames, their finalization, one new frame.
	finishAnimation(t);
	assert.equal(h.renderRequests, 3 + 38);
	assert.equal(head(h.renderMarker(2)), settled);
});

test("Escape, widget disposal and session cleanup finalize history and cancel every timer", (t) => {
	mockClock(t);
	const h = harness(t);
	for (const cleanup of [
		() => h.escape(),
		() => h.disposeWidget(),
		() => h.emit("session_start", { type: "session_start" }),
		() => h.emit("session_shutdown", { type: "session_shutdown" }),
	]) {
		h.emit("session_start", { type: "session_start" });
		startContinuation(h);
		t.mock.timers.tick(80);
		cleanup();
		const renders: number = h.renderRequests;
		t.mock.timers.runAll();
		assert.equal(h.renderWidget(), undefined);
		assert.equal(head(h.renderMarker()), settled);
		assert.equal(h.renderRequests, renders);
	}
});

const escapePress = "\x1b[27;1:1u";
const escapeRepeat = "\x1b[27;1:2u";
const escapeRelease = "\x1b[27;1:3u";

test("Escape release and repeat during preflight cannot trigger failed-start recovery", (t) => {
	const h = harness(t);
	h.input("retry me", "steer");
	h.setCorePending(true);
	h.setDraft("draft");
	h.escape(escapePress);
	h.escape(escapeRepeat); // Aborting: same held key, not another action.
	h.escape(escapeRelease);
	assert.equal(h.aborts, 1);
	h.emit("agent_settled", { type: "agent_settled" });
	h.escape(escapeRelease); // Release can arrive after settlement.
	assert.equal(h.aborts, 1, "release must not request a second abort in starting phase");
	assert.equal(h.draft, "draft", "release must not restore the replay as failed preflight");
	h.emit("agent_start", { type: "agent_start" });
	assert.equal(h.markers.length, 1, "release must not abandon continuation tracking");
});

test("Escape release and repeat leave all 38 animation frames live until exactly 3000ms", (t) => {
	mockClock(t);
	const h = harness(t);
	h.input("continue", "steer");
	h.setCorePending(true);
	h.escape(escapePress);
	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });
	for (let step = 0; step <= lastStep; step++) {
		h.escape(step % 2 ? escapeRepeat : escapeRelease);
		assert.deepEqual(h.renderWidget(), [], "release/repeat must not finalize the live marker");
		assert.equal(head(h.renderMarker()), live(indicatorAt(step)), "release/repeat must not reset the clock");
		assert.equal(h.renderRequests, step, "release/repeat must not redraw");
		const interval = step === lastStep ? 40 : 80;
		t.mock.timers.tick(interval - 1);
		assert.deepEqual(h.renderWidget(), []);
		t.mock.timers.tick(1);
	}
	assert.equal(Date.now(), 3000);
	assert.equal(h.renderWidget(), undefined);
	assert.equal(h.renderRequests, 38);
	assert.equal(h.markers.length, 1);
	assert.equal(h.aborts, 1);
});

test("extension-owned repeats cannot abort preflight or a live no-queue continuation; new presses can", (t) => {
	mockClock(t);
	const h = harness(t);
	h.input("continue", "steer");
	h.setCorePending(true);
	h.escape(escapePress);
	h.emit("agent_settled", { type: "agent_settled" });
	assert.deepEqual(h.escape(escapeRepeat), { consume: true });
	assert.equal(h.aborts, 1);
	h.emit("agent_start", { type: "agent_start" });
	assert.deepEqual(h.escape(escapeRepeat), { consume: true }, "repeat must not fall through to native abort");
	assert.deepEqual(h.renderWidget(), []);
	h.escape(escapeRelease);
	assert.equal(h.escape(escapePress), undefined, "new no-queue press remains native");
	assert.equal(h.renderWidget(), undefined, "intentional press still ends the animation");
	assert.equal(head(h.renderMarker()), settled);
	assert.equal(h.escape(escapeRepeat), undefined, "native-owned repeats remain native");
});

test("genuine Kitty Escape presses still recover failed preflight and re-interrupt queued replay", (t) => {
	const h = harness(t);
	h.input("first", "steer");
	h.input("second", "followUp");
	h.setCorePending(true);
	h.escape(escapePress);
	h.emit("agent_settled", { type: "agent_settled" });
	h.escape(escapeRelease);
	assert.deepEqual(h.escape(escapePress), { consume: true });
	assert.equal(h.aborts, 2);
	assert.equal(h.draft, "first\n\nsecond");
	h.emit("session_start", { type: "session_start" });
	h.setDraft("");
	h.input("first", "steer");
	h.input("second", "followUp");
	h.setCorePending(true);
	h.escape(escapePress);
	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });
	h.escape(escapeRelease);
	assert.deepEqual(h.escape(escapePress), { consume: true });
	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });
	assert.deepEqual(h.sent.map(({ text }) => text), ["first", "first", "second", "second"]);
});

test("live marker follows outputPad 0/1/default and keeps a stable single-line width", (t) => {
	mockClock(t);
	const h = harness(t);
	startContinuation(h);
	for (const pad of [0, 1, undefined] as const) {
		h.setOutputPad(pad);
		const shift = pad === 0 ? 0 : 1;
		const prefix = pad === 0 ? "" : " ";
		assert.equal(head(h.renderMarker(), shift), `${prefix}DIRECTIVE UPDATED  ▶·· `);
		assert.equal(visibleWidth(h.renderMarker()![0]), 80 - shift);
		for (const width of [0, 1, 2, 19, 20, 21, 24, 25]) {
			assert.equal(h.renderMarker(0, width)!.length, 1);
			assert.ok(visibleWidth(h.renderMarker(0, width)![0]) <= width);
		}
		finishAnimation(t);
		assert.equal(head(h.renderMarker(), shift), `${prefix}DIRECTIVE UPDATED  ✓   `);
		assert.equal(visibleWidth(h.renderMarker()![0]), 80 - shift);
		startContinuation(h);
	}
});
