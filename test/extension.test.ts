import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type {
	ExtensionAPI,
	ExtensionContext,
	CustomEntry,
	EntryRenderer,
	InputEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { createClaudeInterrupt } from "../src/index.ts";

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
	let color = "\x1b[36m";
	const tui = { requestRender: () => { renderRequests++; } } as unknown as TUI;
	const theme = { fg: (key: string, text: string) => {
		assert.equal(key, "accent");
		return `${color}${text}\x1b[0m`;
	} } as Theme;
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
		setColor(value: string) { color = value; widget?.invalidate(); },
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
		escape() {
			return terminalHandler?.("\x1b");
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

test("history marker sweeps every 150ms for all 20 steps then persists without changing the draft", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness(t);
	h.setDraft("keep my cursor text");
	startContinuation(h);
	assert.equal(h.markers.length, 1);
	for (let step = 0; step < 20; step++) {
		const indicator = ["›··", "·›·", "··›"][step % 3];
		assert.deepEqual(h.renderMarker()?.map(stripAnsi), [`${indicator}  Conversation Steered`]);
		assert.deepEqual(h.renderWidget(), []); // No second visible copy.
		for (const width of [0, 1, 3, 12, 25]) {
			const lines = h.renderMarker(0, width)!;
			assert.equal(lines.length, 1);
			assert.ok(visibleWidth(lines[0]) <= width);
		}
		t.mock.timers.tick(149);
		assert.deepEqual(h.renderMarker()?.map(stripAnsi), [`${indicator}  Conversation Steered`]);
		t.mock.timers.tick(1);
		assert.equal(h.renderRequests, step + 1);
	}
	assert.deepEqual(h.renderMarker()?.map(stripAnsi), [" ✓   Conversation Steered"]);
	assert.equal(h.renderWidget(), undefined);
	assert.equal(h.widgetShows, 1);
	h.setColor("\x1b[35m");
	assert.ok(h.renderMarker()![0].startsWith("\x1b[35m"));
	h.emit("message_start", userMessageStart);
	h.emit("tool_execution_start", { type: "tool_execution_start" });
	h.emit("agent_start", { type: "agent_start" });
	t.mock.timers.tick(60_000);
	t.mock.timers.runAll();
	assert.equal(h.renderRequests, 20);
	assert.equal(h.markers.length, 1);
	assert.deepEqual(h.renderMarker()?.map(stripAnsi), [" ✓   Conversation Steered"]);
	assert.equal(h.draft, "keep my cursor text");
});

test("marker waits for confirmed continuation and stays out of ordinary, native and non-TUI paths", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
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
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const first = harness(t);
	startContinuation(first);
	const saved = structuredClone(first.markers[0].entry);
	const h = harness(t);
	h.loadEntry(saved);
	assert.deepEqual(h.renderMarker()?.map(stripAnsi), [" ✓   Conversation Steered"]);
	assert.equal(h.widgetShows, 0);
	startContinuation(h);
	assert.notDeepEqual(h.markers[0].entry.data, h.markers[1].entry.data);
	assert.deepEqual(h.renderMarker(0)?.map(stripAnsi), [" ✓   Conversation Steered"]);
	t.mock.timers.tick(150);
	assert.deepEqual(h.renderMarker(1)?.map(stripAnsi), ["·›·  Conversation Steered"]);
	startContinuation(h);
	assert.equal(new Set(h.markers.map(({ entry }) => (entry.data as { id: string }).id)).size, 3);
	assert.deepEqual(h.renderMarker(0)?.map(stripAnsi), [" ✓   Conversation Steered"]);
	assert.deepEqual(h.renderMarker(1)?.map(stripAnsi), [" ✓   Conversation Steered"]);
	assert.deepEqual(h.renderMarker(2)?.map(stripAnsi), ["›··  Conversation Steered"]);
	t.mock.timers.tick(150);
	assert.equal(h.renderRequests, 3); // Old frame, its finalization, new frame only.
	for (let step = 1; step < 20; step++) t.mock.timers.tick(150);
	t.mock.timers.runAll();
	assert.equal(h.renderRequests, 22);
	assert.deepEqual(h.renderMarker(2)?.map(stripAnsi), [" ✓   Conversation Steered"]);
});

test("Escape, widget disposal and session cleanup finalize history and cancel every timer", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness(t);
	for (const cleanup of [
		() => h.escape(),
		() => h.disposeWidget(),
		() => h.emit("session_start", { type: "session_start" }),
		() => h.emit("session_shutdown", { type: "session_shutdown" }),
	]) {
		h.emit("session_start", { type: "session_start" });
		startContinuation(h);
		t.mock.timers.tick(150);
		cleanup();
		const renders: number = h.renderRequests;
		t.mock.timers.runAll();
		assert.equal(h.renderWidget(), undefined);
		assert.deepEqual(h.renderMarker()?.map(stripAnsi), [" ✓   Conversation Steered"]);
		assert.equal(h.renderRequests, renders);
	}
});
