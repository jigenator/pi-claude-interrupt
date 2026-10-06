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
	for (let i = 0; i < 75; i++) t.mock.timers.tick(40);
}

const lastFrame = 74; // 40ms frames 0..2960; the animation settles at exactly 3000.
const frames = Array.from({ length: lastFrame + 2 }, (_, frame) => frame * 40); // 0..3000

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

/**
 * L acid plate, O acid ink on the terminal background (unfilled plate letters or
 * a live bar), R grey record plate, G grey ghost bar, B default-background blank.
 */
function classes(line: string, mode: TerminalColorMode, ink: string = palettes[mode].acid): string {
	const c = palettes[mode];
	return cells(line).map(({ ch, fg, bg, bold }) => {
		const key = `${fg}/${bg}/${bold}`;
		if (key === `${c.black}/${c.acid}/true`) return "L";
		if (key === `${ink}/undefined/true`) return "O";
		if (key === `${c.bone}/${c.darkGrey}/true`) return "R";
		if (key === `${c.grey}/undefined/true`) return "G";
		if (ch === " " && fg === undefined && bg === undefined && !bold) return "B";
		return "?";
	}).join("");
}

// An oracle written from the approved timeline, not from the renderer: plate
// flashes at 0/80/160, grey wipe cells at 2800/2880/2960, seven fixed bars.
const barCells = [0, 1, 3, 5, 8, 11, 15];
const greyCells = { 2800: { 0: 8, 1: 8 }, 2880: { 0: 15, 1: 16 }, 2960: { 0: 18, 1: 19 } } as const;

function expectedRow(elapsed: number | undefined, pad: 0 | 1, width: number): { glyphs: string; classes: string } {
	const label = `${pad ? " " : ""}DIRECTIVE UPDATED `;
	const m = elapsed ?? 3000;
	const grey = m >= 3000 ? label.length : m < 2800 ? 0 : greyCells[(Math.floor(m / 80) * 80) as 2800 | 2880 | 2960][pad];
	const filled = m < 80 || m >= 160 ? "L" : "O";
	const span = Array.from({ length: 16 }, () => ({ glyph: " ", cls: "B" }));
	const frame = Math.floor(m / 40) * 40;
	for (const launch of [160, 880]) barCells.forEach((cell, bar) => {
		const on = launch + 40 * bar;
		if (frame >= on && frame < on + 280) span[cell] = { glyph: "│", cls: "O" };
		else if (frame >= on + 280 && frame < on + 400) span[cell] = { glyph: "│", cls: "G" };
	});
	const rest = Math.max(0, Math.max(0, width - pad) - (label.length + 1 + 16));
	const clip = (text: string) => Array.from(text).slice(0, Math.max(0, width - pad)).join("");
	return {
		glyphs: clip(`${label} ${span.map(({ glyph }) => glyph).join("")}${" ".repeat(rest)}`),
		classes: clip(`${filled.repeat(label.length - grey)}${"R".repeat(grey)}B${span.map(({ cls }) => cls).join("")}${"B".repeat(rest)}`),
	};
}

function assertRow(lines: string[] | undefined, elapsed: number | undefined, pad: 0 | 1 = 1, width = 80, mode: TerminalColorMode = "truecolor", message = ""): void {
	assert.equal(lines?.length, 1, "the marker is always exactly one row");
	const expected = expectedRow(elapsed, pad, width);
	assert.equal(stripAnsi(lines[0]), expected.glyphs, `${message} glyphs at ${elapsed}`);
	assert.equal(classes(lines[0], mode), expected.classes, `${message} cells at ${elapsed}`);
}

test("marker cells carry the approved Acid/Black colors and attributes at every ping, flash and wipe boundary", () => {
	const plate = (n: number, ch: string) => ch.repeat(n);
	// Width 40 at outputPad 1: 19-cell plate, one gap, the 16-cell bar span, then three blank cells.
	// Each span string lists the cells of offsets [0,1,3,5,8,11,15]; O live acid bar, G grey ghost, B blank.
	const span: [number, string][] = [
		[160, "OBBBBBBBBBBBBBBB"], [200, "OOBBBBBBBBBBBBBB"], [240, "OOBOBBBBBBBBBBBB"], [280, "OOBOBOBBBBBBBBBB"],
		[320, "OOBOBOBBOBBBBBBB"], [360, "OOBOBOBBOBBOBBBB"], [400, "OOBOBOBBOBBOBBBO"],
		[440, "GOBOBOBBOBBOBBBO"], [480, "GGBOBOBBOBBOBBBO"], [520, "GGBGBOBBOBBOBBBO"], [560, "BGBGBGBBOBBOBBBO"],
		[600, "BBBGBGBBGBBOBBBO"], [640, "BBBBBGBBGBBGBBBO"], [680, "BBBBBBBBGBBGBBBG"], [720, "BBBBBBBBBBBGBBBG"],
		[760, "BBBBBBBBBBBBBBBG"], [800, "BBBBBBBBBBBBBBBB"], [2000, "BBBBBBBBBBBBBBBB"],
	];
	const glyph = (cells: string) => Array.from(cells, (c) => (c === "B" ? " " : "│")).join("");
	const literal: [number | undefined, string, string][] = [
		[0, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "L")}${plate(20, "B")}`],
		[40, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "L")}${plate(20, "B")}`],
		[79, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "L")}${plate(20, "B")}`],
		[80, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "O")}${plate(20, "B")}`],
		[120, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "O")}${plate(20, "B")}`],
		[159, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "O")}${plate(20, "B")}`],
		...[...span, ...span.filter(([at]) => at <= 800).map(([at, cells]): [number, string] => [at + 720, cells])]
			.map(([at, cells]): [number, string, string] => [at, ` DIRECTIVE UPDATED  ${glyph(cells)}   `, `${plate(19, "L")}B${cells}BBB`]),
		[2799, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "L")}${plate(20, "B")}`],
		[2800, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(11, "L")}${plate(8, "R")}${plate(20, "B")}`],
		[2840, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(11, "L")}${plate(8, "R")}${plate(20, "B")}`],
		[2880, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(3, "L")}${plate(16, "R")}${plate(20, "B")}`],
		[2920, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(3, "L")}${plate(16, "R")}${plate(20, "B")}`],
		[2960, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "R")}${plate(20, "B")}`],
		[2999, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "R")}${plate(20, "B")}`],
		[3000, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "R")}${plate(20, "B")}`],
		[undefined, " DIRECTIVE UPDATED ".padEnd(36 + 3), `${plate(19, "R")}${plate(20, "B")}`],
	];
	for (const mode of ["truecolor", "256color"] as const) {
		for (const [elapsed, glyphs, expected] of literal) {
			const line = renderMarker(makeTheme(mode), 40, 1, elapsed);
			assert.equal(stripAnsi(line), glyphs, `${mode} ${elapsed}`);
			assert.equal(classes(line, mode), expected, `${mode} ${elapsed}`);
			// Transparent acid ink follows the native accent on light themes; filled
			// plates, grey ghosts and the record plate stay fixed.
			const light = makeTheme(mode, "light");
			const accent = cells(light.style("x", { fg: "accent", bold: true }))[0].fg;
			assert.deepEqual(cells(renderMarker(light, 40, 1, elapsed)), cells(line).map((cell) => ({
				...cell, fg: cell.fg === palettes[mode].acid && cell.bg === undefined ? accent : cell.fg,
			})));
		}
	}
	// outputPad 0 keeps the label on column 0: an 18-cell plate with the same proportional wipe.
	const flush = (elapsed: number) => renderMarker(makeTheme("truecolor"), 40, 0, elapsed);
	assert.equal(stripAnsi(flush(160)), "DIRECTIVE UPDATED  │" + " ".repeat(20));
	assert.equal(classes(flush(160), "truecolor"), `${plate(18, "L")}BO${plate(20, "B")}`);
	assert.equal(classes(flush(80), "truecolor"), `${plate(18, "O")}${plate(22, "B")}`);
	assert.equal(classes(flush(2800), "truecolor"), `${plate(10, "L")}${plate(8, "R")}${plate(22, "B")}`);
	assert.equal(classes(flush(2880), "truecolor"), `${plate(3, "L")}${plate(15, "R")}${plate(22, "B")}`);
	assert.equal(classes(flush(2960), "truecolor"), `${plate(18, "R")}${plate(22, "B")}`);
});

test("every 40ms frame matches the approved timeline in both pads, color modes and light themes", () => {
	for (const mode of ["truecolor", "256color"] as const) {
		for (const appearance of ["dark", "light"] as const) {
			const theme = makeTheme(mode, appearance);
			// Light themes replace only transparent acid ink with Pi's accent color.
			const ink = appearance === "light" ? cells(theme.style("x", { fg: "accent", bold: true }))[0].fg! : palettes[mode].acid;
			for (const pad of [0, 1] as const) {
				for (const elapsed of [...frames, undefined]) {
					const line = renderMarker(theme, 80, pad, elapsed);
					const expected = expectedRow(elapsed, pad, 80);
					assert.equal(stripAnsi(line), expected.glyphs, `${mode} ${appearance} pad ${pad} ${elapsed}`);
					assert.equal(classes(line, mode, ink), expected.classes, `${mode} ${appearance} pad ${pad} ${elapsed}`);
				}
			}
		}
	}
});

test("exactly two pings have an 80ms gap and individual 40ms transitions; the plate stays on its 80ms grid", () => {
	const theme = makeTheme("truecolor");
	const row = (elapsed: number) => classes(renderMarker(theme, 80, 1, elapsed), "truecolor");
	const barCols = barCells.map((cell) => 20 + cell);
	const plateOf = (elapsed: number) => row(elapsed).slice(0, 19);
	let appearances = 0;
	for (let elapsed = 40; elapsed <= 3000; elapsed += 40) {
		const before = row(elapsed - 40);
		const after = row(elapsed);
		const changes = barCols.map((col) => `${before[col]}${after[col]}`);
		const count = (change: string) => changes.filter((value) => value === change).length;
		// Only O→G (grey turn), B→O (new bar) and G→B (removal) are legal bar changes.
		assert.ok(changes.every((change) => ["BB", "OO", "GG", "BO", "OG", "GB"].includes(change)), `${elapsed}: ${changes}`);
		assert.equal(count("BO"), (elapsed >= 160 && elapsed <= 400) || (elapsed >= 880 && elapsed <= 1120) ? 1 : 0, `new bar at ${elapsed}`);
		assert.equal(count("OG"), (elapsed >= 440 && elapsed <= 680) || (elapsed >= 1160 && elapsed <= 1400) ? 1 : 0, `grey turn at ${elapsed}`);
		assert.equal(count("GB"), (elapsed >= 560 && elapsed <= 800) || (elapsed >= 1280 && elapsed <= 1520) ? 1 : 0, `removal at ${elapsed}`);
		appearances += count("BO");
		// The plate only moves on 80ms boundaries: odd 40ms frames equal the previous even frame.
		if (elapsed % 80 === 40) assert.equal(plateOf(elapsed), plateOf(elapsed - 40), `plate at ${elapsed}`);
	}
	assert.equal(appearances, 14, "seven bars appear exactly twice");
	for (let elapsed = 800; elapsed < 880; elapsed++) assert.equal(row(elapsed).slice(19), "B".repeat(60), `blank 80ms gap at ${elapsed}`);
	for (let elapsed = 0; elapsed <= 640; elapsed += 40) assert.equal(row(880 + elapsed), row(160 + elapsed), `identical second ping and unchanged plate at +${elapsed}`);
	for (let elapsed = 1520; elapsed <= 3000; elapsed += 40) assert.equal(row(elapsed).slice(19), "B".repeat(60), `no third ping at ${elapsed}`);
});

test("rendering quantizes ping to 40ms and the plate to 80ms at every millisecond", () => {
	const theme = makeTheme("truecolor");
	for (const pad of [0, 1] as const) {
		for (let elapsed = 0; elapsed <= 3100; elapsed++) {
			const line = renderMarker(theme, 80, pad, elapsed);
			assert.equal(line, renderMarker(theme, 80, pad, Math.floor(elapsed / 40) * 40), `pad ${pad} ${elapsed}`);
			assert.equal(classes(line, "truecolor"), expectedRow(elapsed, pad, 80).classes, `pad ${pad} ${elapsed}`);
		}
	}
	assert.equal(renderMarker(theme, 80, 1, -50), renderMarker(theme, 80, 1, 0), "negative time clamps to the start");
});

test("marker rows fit every width from 0 to 160 in every frame, pad and color mode, clipping instead of reflowing", () => {
	for (const mode of ["truecolor", "256color"] as const) {
		const theme = makeTheme(mode);
		for (const pad of [0, 1] as const) {
			for (const elapsed of [...frames, undefined]) {
				const wide = expectedRow(elapsed, pad, 160);
				for (let width = 0; width <= 160; width++) {
					const line = renderMarker(theme, width, pad, elapsed);
					// A 16-cell span independent of terminal width: narrow rows are exact prefixes.
					assert.equal(visibleWidth(line), Math.max(0, width - pad), `${mode} pad ${pad} width ${width} at ${elapsed}`);
					assert.equal(stripAnsi(line), wide.glyphs.slice(0, Math.max(0, width - pad)), `${mode} pad ${pad} width ${width} at ${elapsed}`);
					assert.equal(renderMarker(theme, width, pad, elapsed), line, "rendering is stateless");
					if (width % 7 === 0 || width < 40) assert.equal(classes(line, mode), wide.classes.slice(0, Math.max(0, width - pad)), `${mode} pad ${pad} width ${width} at ${elapsed}`);
				}
			}
		}
	}
	// The span is 16 cells wide: bars never extend past column plate + 1 + 16.
	const widest = stripAnsi(renderMarker(makeTheme("truecolor"), 160, 1, 400));
	assert.equal(widest.slice(36).trim(), "");
	assert.equal(widest.slice(20, 36), "││ │ │  │  │   │");
});

test("marker label starts on the same column as Pi's native abort notice for outputPad 0/1", () => {
	const theme = makeTheme("truecolor");
	for (const pad of [0, 1] as const) {
		const native = stripAnsi(new Text(theme.fg("error", "Operation aborted"), pad, 0).render(80)[0]);
		for (const elapsed of [0, 100, 1000, 2800, undefined]) {
			const marker = stripAnsi(renderMarker(theme, 80, pad, elapsed));
			assert.equal(marker.indexOf("D"), native.indexOf("O"));
			assert.equal(visibleWidth(marker), 80 - pad, "native right padding stays unstyled");
		}
	}
});

test("history marker redraws every 40ms through 75 frames and settles at exactly 3000ms without changing the draft", (t) => {
	mockClock(t);
	const h = harness(t);
	h.setDraft("keep my cursor text");
	startContinuation(h);
	assert.equal(h.markers.length, 1);
	for (let frame = 0; frame <= lastFrame; frame++) {
		const elapsed = frame * 40;
		assertRow(h.renderMarker(), elapsed, 1, 80, "truecolor", `frame ${frame}`);
		assert.deepEqual(h.renderWidget(), []); // No second visible copy.
		for (const width of [0, 1, 3, 12, 25, 80, 160]) {
			const lines = h.renderMarker(0, width)!;
			assert.equal(lines.length, 1);
			assert.ok(visibleWidth(lines[0]) <= width);
		}
		t.mock.timers.tick(39);
		assertRow(h.renderMarker(), elapsed, 1, 80, "truecolor", `frame ${frame} before its boundary`);
		assert.equal(h.renderRequests, frame);
		t.mock.timers.tick(1);
		assert.equal(h.renderRequests, frame + 1);
	}
	assert.equal(Date.now(), 3000);
	assertRow(h.renderMarker(), undefined);
	assert.equal(h.renderWidget(), undefined);
	assert.equal(h.widgetShows, 1);
	h.emit("message_start", userMessageStart);
	h.emit("tool_execution_start", { type: "tool_execution_start" });
	h.emit("agent_start", { type: "agent_start" });
	t.mock.timers.tick(60_000);
	t.mock.timers.runAll();
	assert.equal(h.renderRequests, 75);
	assert.equal(h.markers.length, 1);
	assertRow(h.renderMarker(), undefined);
	assert.equal(h.draft, "keep my cursor text");
});

test("theme, color-mode and width changes during the animation keep the current frame", (t) => {
	mockClock(t);
	const h = harness(t);
	startContinuation(h);
	for (let i = 0; i < 6; i++) t.mock.timers.tick(40); // 240ms: bars at cells 0, 1 and 3 are live.
	const before = h.renderRequests;
	for (const width of [80, 20, 0, 160, 37, 80]) assert.ok(visibleWidth(h.renderMarker(0, width)![0]) <= width);
	h.setTheme(makeTheme("256color", "dark"));
	assertRow(h.renderMarker(), 240, 1, 80, "256color");
	h.setTheme(makeTheme("truecolor", "light"));
	assert.equal(stripAnsi(h.renderMarker()![0]).slice(0, 36), " DIRECTIVE UPDATED  ││ │            ");
	assert.deepEqual(cells(h.renderMarker()![0])[20], { ch: "│", fg: "#202020", bg: undefined, bold: true });
	assert.deepEqual(cells(h.renderMarker()![0])[0], { ch: " ", fg: "#000000", bg: "#c0fe04", bold: true }, "the filled plate keeps its Acid/Black colors");
	for (let i = 0; i < 6; i++) t.mock.timers.tick(40); // 480ms: bars 0 and 1 are grey ghosts.
	assert.deepEqual(cells(h.renderMarker()![0]).slice(20, 22), [
		{ ch: "│", fg: "#717171", bg: undefined, bold: true },
		{ ch: "│", fg: "#717171", bg: undefined, bold: true },
	], "light themes only replace transparent acid ink; ghosts stay grey");
	assert.equal(h.renderRequests, before + 6);
	finishAnimation(t);
	assertRow(h.renderMarker(), undefined, 1, 80, "truecolor", "settled");
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
	tick(40);
	assert.equal(h.renderRequests, 1, "one redraw, not a burst of missed frames");
	assertRow(h.renderMarker(), 1040); // Catch up into the second ping; the plate is still filled.
	wall += 5000;
	tick(40); // Next boundary was 1080ms.
	assert.equal(h.renderWidget(), undefined);
	assertRow(h.renderMarker(), undefined);
	assert.equal(h.renderRequests, 2);

	h.emit("session_start", { type: "session_start" });
	startContinuation(h);
	wall -= 10_000; // A backwards wall-clock jump still advances one frame per timer.
	let timers = 0;
	while (h.renderWidget() !== undefined && timers < 200) {
		tick(40);
		timers++;
	}
	assert.equal(timers, 75);
	assertRow(h.renderMarker(), undefined);
	t.mock.timers.runAll();
	assert.equal(h.renderRequests, 2 + 75);

	// A stall inside the ping catches up to the current 40ms frame in a single redraw.
	h.emit("session_start", { type: "session_start" });
	startContinuation(h);
	wall += 330;
	tick(40); // Wall time is now 370ms: frame 360.
	assert.equal(h.renderRequests, 2 + 75 + 1);
	assertRow(h.renderMarker(), 360);
	tick(30); // The follow-up timer lands on the 400ms boundary.
	assert.equal(h.renderRequests, 2 + 75 + 2);
	assertRow(h.renderMarker(), 400);
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
	assertRow(h.renderMarker(), undefined);
	assert.equal(h.widgetShows, 0);
	startContinuation(h);
	assert.notDeepEqual(h.markers[0].entry.data, h.markers[1].entry.data);
	assertRow(h.renderMarker(0), undefined);
	for (let i = 0; i < 4; i++) t.mock.timers.tick(40);
	assertRow(h.renderMarker(1), 160);
	startContinuation(h);
	assert.equal(new Set(h.markers.map(({ entry }) => (entry.data as { id: string }).id)).size, 3);
	assertRow(h.renderMarker(0), undefined);
	assertRow(h.renderMarker(1), undefined);
	assertRow(h.renderMarker(2), 0);
	t.mock.timers.tick(40);
	assert.equal(h.renderRequests, 6); // Four old frames, their finalization, one new frame.
	finishAnimation(t);
	assert.equal(h.renderRequests, 5 + 75);
	assertRow(h.renderMarker(2), undefined);
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
		for (let i = 0; i < 9; i++) t.mock.timers.tick(40); // 360ms: mid-ping, with bars live.
		assertRow(h.renderMarker(), 360);
		cleanup();
		const renders: number = h.renderRequests;
		t.mock.timers.runAll();
		assert.equal(h.renderWidget(), undefined);
		assertRow(h.renderMarker(), undefined);
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

test("Escape release and repeat leave all 75 animation frames live until exactly 3000ms", (t) => {
	mockClock(t);
	const h = harness(t);
	h.input("continue", "steer");
	h.setCorePending(true);
	h.escape(escapePress);
	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });
	for (let frame = 0; frame <= lastFrame; frame++) {
		h.escape(frame % 2 ? escapeRepeat : escapeRelease);
		assert.deepEqual(h.renderWidget(), [], "release/repeat must not finalize the live marker");
		assertRow(h.renderMarker(), frame * 40, 1, 80, "truecolor", "release/repeat must not reset the clock");
		assert.equal(h.renderRequests, frame, "release/repeat must not redraw");
		t.mock.timers.tick(39);
		assert.deepEqual(h.renderWidget(), []);
		t.mock.timers.tick(1);
	}
	assert.equal(Date.now(), 3000);
	assert.equal(h.renderWidget(), undefined);
	assert.equal(h.renderRequests, 75);
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
	assertRow(h.renderMarker(), undefined);
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
		assertRow(h.renderMarker(), 0, shift, 80, "truecolor", `pad ${pad}`);
		assert.equal(visibleWidth(h.renderMarker()![0]), 80 - shift);
		for (let i = 0; i < 10; i++) t.mock.timers.tick(40); // 400ms: all seven bars are live.
		assertRow(h.renderMarker(), 400, shift, 80, "truecolor", `pad ${pad}`);
		// The bars follow the label: one gap after the 18- or 19-cell plate.
		assert.equal(stripAnsi(h.renderMarker()![0]).slice(18 + shift, 35 + shift), " ││ │ │  │  │   │");
		for (const width of [0, 1, 2, 19, 20, 21, 24, 25, 36, 37, 38]) {
			assert.equal(h.renderMarker(0, width)!.length, 1);
			assert.ok(visibleWidth(h.renderMarker(0, width)![0]) <= width);
		}
		finishAnimation(t);
		assertRow(h.renderMarker(), undefined, shift, 80, "truecolor", `pad ${pad}`);
		assert.equal(visibleWidth(h.renderMarker()![0]), 80 - shift);
		startContinuation(h);
	}
});
