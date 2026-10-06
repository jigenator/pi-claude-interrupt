import assert from "node:assert/strict";
import { setImmediate as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { TuiMainScreen, visibleWidth, type TUI, type Component, type Terminal } from "@earendil-works/pi-tui";

import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	type ExtensionActions,
	type ExtensionContextActions,
	type ExtensionUIContext,
	type ModelRegistry,
	SessionManager,
	type TerminalInputHandler,
	Theme,
} from "@earendil-works/pi-coding-agent";

type Delivery = "steer" | "followUp";
type Queued = { text: string; deliverAs: Delivery };

// Rendered rows reduced to their label/indicator columns at Pi's default outputPad 1.
const live = (indicator: string) => ` DIRECTIVE UPDATED  ${indicator} `;
const settled = live("✓  ");
// The same rows at outputPad 0: one column left, so the rule starts inside the 24-column slice.
const unpadded = (row: string) => row.slice(1) + "─";
const conveyor = (step: number) => ["▶··", "›▶·", "·›▶"][Math.floor(step / 2) % 3];
const indicatorAt = (step: number) => step >= 34 ? "✓  " : conveyor(step);

async function createRunnerHarness(t: TestContext, savedSession?: SessionManager) {
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const loaded = await discoverAndLoadExtensions(
		[join(root, "src/index.ts")],
		root,
		join(root, "test", "fixtures", "empty-agent-dir"),
	);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);

	let terminalInput: ((data: string) => void) | undefined;
	let terminalResult: ReturnType<TerminalInputHandler>;
	const focusedInput: string[] = [];
	// Real TUI routing, isolated terminal transport: no process stdin/stdout or provider.
	const terminal: Terminal = {
		start: (onInput) => { terminalInput = onInput; },
		stop() {}, drainInput: async () => {}, write() {},
		columns: 80, rows: 24, kittyProtocolActive: true,
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
		clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const inputTui = new TuiMainScreen(terminal);
	inputTui.setFocus({ render: () => [], invalidate() {}, handleInput: (data) => { focusedInput.push(data); } });
	inputTui.start();
	t.after(() => inputTui.stop());
	let editorText = "";
	let active = true;
	let allowStart = true;
	let aborts = 0;
	const coreQueue: Queued[] = [];
	const started: string[] = [];
	const delivered: string[] = [];
	const trace: string[] = [];
	const jobs = new Set<Promise<void>>();
	let widget: (Component & { dispose?(): void }) | undefined;
	let renderRequests = 0;
	let widgetDisposals = 0;
	let outputPad: 0 | 1 | undefined;
	let replaced = false;
	const session = savedSession ?? SessionManager.inMemory(root);
	// A real Pi Theme exercises the renderer's style calls and color conversion.
	const theme = new Theme(
		{ accent: "#5f87ff", muted: "#808080", text: "#d0d0d0", thinkingXhigh: "#d0d0d0" } as ConstructorParameters<typeof Theme>[0],
		{ selectedBg: "#303030" } as ConstructorParameters<typeof Theme>[1],
		"truecolor",
	);
	const components = new Map<string, Component>();

	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		root,
		session,
		{} as ModelRegistry,
	);

	const schedule = (work: () => Promise<void>): void => {
		const job = work().finally(() => jobs.delete(job));
		jobs.add(job);
	};

	const actions: ExtensionActions = {
		sendMessage: () => { assert.fail("Steering feedback must not enter model context"); },
		sendUserMessage: (content, options) => {
			assert.equal(typeof content, "string");
			const text = content as string;
			trace.push(`send:${text}:active=${active}:as=${options?.deliverAs ?? "main"}`);
			schedule(async () => {
				// Exercise Pi's real async input dispatcher before changing fake session
				// state. The event runner awaits every registered input handler.
				await delay();
				const result = await runner.emitInput(text, undefined, "extension", active ? options?.deliverAs : undefined);
				if (result.action === "handled") return;

				await delay();
				if (active) {
					assert.ok(options?.deliverAs);
					coreQueue.push({ text, deliverAs: options.deliverAs });
					trace.push(`queued:${text}`);
					return;
				}

				if (!allowStart) {
					trace.push(`preflight-failed:${text}`);
					return;
				}

				active = true;
				trace.push(`started:${text}`);
				started.push(text);
				await runner.emit({ type: "agent_start" });
				await runner.emit({
					type: "message_start",
					message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
				});
				session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
				delivered.push(text);
			});
		},
		appendEntry: (customType, data) => {
			const id = session.appendCustomEntry(customType, data);
			const entry = session.getEntry(id);
			assert.ok(entry?.type === "custom");
			const renderer = runner.getEntryRenderer(customType);
			assert.ok(renderer);
			const component = renderer(entry, { expanded: false }, theme);
			assert.ok(component);
			components.set(id, component);
			trace.push(`marker:${id}`);
		},
		setSessionName: () => undefined,
		getSessionName: () => undefined,
		setLabel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [],
		getSettings: () => ({ outputPad }),
		setActiveTools: () => undefined,
		refreshTools: () => undefined,
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => undefined,
	};

	const contextActions: ExtensionContextActions = {
		getModel: () => undefined,
		getScopedModels: () => [],
		isIdle: () => !active,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {
			trace.push(`abort:${coreQueue.map((item) => item.text).join(",")}`);
			aborts += 1;
			if (coreQueue.length > 0) {
				editorText = `${coreQueue.map((item) => item.text).join("\n\n")}\n\n${editorText}`;
			}
			coreQueue.length = 0;
			active = false;
		},
		hasPendingMessages: () => coreQueue.length > 0,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
	};

	const ui = {
		onTerminalInput: (handler: TerminalInputHandler) => inputTui.addInputListener((data) => {
			terminalResult = handler(data);
			return terminalResult;
		}),
		getEditorText: () => editorText,
		setEditorText: (text: string) => {
			editorText = text;
		},
		notify: () => undefined,
		setWidget: (_key: string, factory: ((tui: TUI, theme: Theme) => typeof widget) | undefined) => {
			if (widget) {
				widgetDisposals++;
				widget.dispose?.();
			}
			widget = undefined;
			if (factory) widget = factory(
				{ requestRender: () => { renderRequests++; } } as unknown as TUI,
				theme,
			);
		},
	} as unknown as ExtensionUIContext;

	runner.bindCore(actions, contextActions);
	runner.setUIContext(ui, "tui");
	await runner.emit({ type: "session_start", reason: "startup" });
	t.after(async () => {
		if (!replaced) await runner.emit({ type: "session_shutdown", reason: "quit" });
	});

	const flush = async (): Promise<void> => {
		while (jobs.size > 0) await Promise.all([...jobs]);
	};

	return {
		runner,
		session,
		get renderRequests() { return renderRequests; },
		get widgetDisposals() { return widgetDisposals; },
		renderMarkers: (rowWidth = outputPad === 0 ? 80 : 79) => session.getBranch().flatMap((entry) => {
			if (entry.type !== "custom") return [];
			let component = components.get(entry.id);
			if (!component) {
				component = runner.getEntryRenderer(entry.customType)?.(entry, { expanded: false }, theme);
				assert.ok(component);
				components.set(entry.id, component);
			}
			const lines = component.render(80);
			assert.equal(lines.length, 1);
			assert.equal(visibleWidth(lines[0]), rowWidth, "rule stops at the right outputPad column");
			return lines.map((line) => stripAnsi(line).slice(0, 24));
		}),
		setOutputPad(value: 0 | 1 | undefined) { outputPad = value; },
		/** Pi's session replacement order: shutdown handlers, then the old runner is invalidated. */
		async replaceSession(): Promise<void> {
			await runner.emit({ type: "session_shutdown", reason: "new" });
			runner.invalidate();
			replaced = true;
		},
		assertRuntimeStale: () => assert.throws(() => loaded.runtime.assertActive(), /ctx is stale after session replacement/),
		renderWidget: () => widget?.render(80),
		coreQueue,
		started,
		delivered,
		trace,
		get aborts() {
			return aborts;
		},
		get editorText() {
			return editorText;
		},
		setEditorText(text: string) {
			editorText = text;
		},
		setAllowStart(value: boolean) {
			allowStart = value;
		},
		async queue(text: string, deliverAs: Delivery): Promise<void> {
			const result = await runner.emitInput(text, undefined, "interactive", deliverAs);
			assert.equal(result.action, "continue");
			coreQueue.push({ text, deliverAs });
		},
		focusedInput,
		escape(data = "\x1b") {
			assert.ok(terminalInput);
			terminalResult = undefined;
			terminalInput(data);
			return terminalResult;
		},
		async settle(): Promise<void> {
			await runner.emit({ type: "agent_settled" });
			await flush();
		},
		async deliverQueued(): Promise<void> {
			const message = coreQueue.shift();
			assert.ok(message);
			await runner.emit({
				type: "message_start",
				message: {
					role: "user",
					content: [{ type: "text", text: message.text }],
					timestamp: Date.now(),
				},
			});
			session.appendMessage({ role: "user", content: message.text, timestamp: Date.now() });
			delivered.push(message.text);
		},
	};
}

test("real ExtensionRunner asynchronously re-interrupts a replayed queue without delivered duplicates", async (t) => {
	const h = await createRunnerHarness(t);
	await h.queue("first", "steer");
	await h.queue("second", "steer");
	await h.queue("third", "followUp");

	assert.deepEqual(h.escape(), { consume: true });
	await h.settle();
	assert.deepEqual(h.started, ["first"]);
	assert.deepEqual(h.renderWidget(), []);
	assert.deepEqual(h.renderMarkers(), [live("▶··")]);
	assert.deepEqual(h.coreQueue.map((item) => item.text), ["second", "third"]);

	// Interrupt before either replayed queue entry reaches message_start.
	assert.deepEqual(h.escape(), { consume: true });
	await h.settle();
	assert.deepEqual(h.started, ["first", "second"]);
	assert.deepEqual(h.renderWidget(), []);
	assert.deepEqual(h.renderMarkers(), [settled, live("▶··")]);
	assert.deepEqual(h.coreQueue.map((item) => item.text), ["third"], h.trace.join(" | "));

	await h.deliverQueued();
	assert.deepEqual(h.delivered, ["first", "second", "third"]);
	assert.equal(h.aborts, 2);
});

test("real ExtensionRunner leaves Escape available after asynchronous start failure", async (t) => {
	const h = await createRunnerHarness(t);
	await h.queue("retry me", "steer");
	await h.queue("then me", "followUp");
	h.setEditorText("draft");
	h.setAllowStart(false);

	assert.deepEqual(h.escape(), { consume: true });
	await h.settle();
	assert.deepEqual(h.started, []);
	assert.equal(h.renderWidget(), undefined);
	assert.deepEqual(h.renderMarkers(), []);

	assert.deepEqual(h.escape(), { consume: true });
	assert.equal(h.editorText, "retry me\n\nthen me\n\ndraft");
	assert.equal(h.escape(), undefined);
});

test("real ExtensionRunner persists exactly one non-context marker at start and reloads it completed", async (t) => {
	const h = await createRunnerHarness(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	await h.queue("continue here", "steer");
	await h.queue("later action", "followUp");
	h.escape();
	await h.settle();
	const markers = h.session.getEntries().filter((entry) => entry.type === "custom");
	assert.equal(markers.length, 1);
	assert.equal(markers[0].customType, "claude-interrupt-steering");
	assert.ok(h.trace.indexOf(`marker:${markers[0].id}`) > h.trace.indexOf("started:continue here"));
	assert.ok(h.trace.indexOf(`marker:${markers[0].id}`) < h.trace.indexOf("queued:later action"));
	assert.deepEqual(h.renderMarkers(), [live("▶··")]);
	assert.deepEqual(h.renderWidget(), []);
	for (let step = 1; step <= 37; step++) {
		t.mock.timers.tick(80);
		assert.deepEqual(h.renderMarkers(), [live(indicatorAt(step))]);
	}
	t.mock.timers.tick(39);
	assert.deepEqual(h.renderWidget(), [], "the last partial interval is kept");
	t.mock.timers.tick(1);
	assert.deepEqual(h.renderMarkers(), [settled]);
	assert.equal(h.renderRequests, 38);
	assert.equal(h.widgetDisposals, 1);
	assert.equal(h.renderWidget(), undefined);
	await h.deliverQueued();
	await h.runner.emit({ type: "agent_start" }); // Ordinary activity cannot add a marker.
	t.mock.timers.tick(60_000);
	assert.equal(h.renderRequests, 38);
	assert.deepEqual(h.renderMarkers(), [settled]);
	assert.equal(h.session.getEntries().filter((entry) => entry.type === "custom").length, 1);
	assert.ok(h.session.buildContextEntries().some((entry) => entry.id === markers[0].id));
	assert.deepEqual(h.session.buildSessionContext().messages.map((message) => message.role), ["user", "user"]);
	assert.ok(!JSON.stringify(h.session.buildSessionContext()).includes("claude-interrupt-steering"));

	await h.runner.emit({ type: "session_shutdown", reason: "reload" });
	const reloaded = await createRunnerHarness(t, h.session);
	assert.deepEqual(reloaded.renderMarkers(), [settled]);
	assert.equal(reloaded.renderWidget(), undefined);
	await reloaded.queue("new continuation", "steer");
	reloaded.escape();
	await reloaded.settle();
	assert.deepEqual(reloaded.renderMarkers(), [settled, live("▶··")]);
	const ids = reloaded.session.getEntries().flatMap((entry) => entry.type === "custom" ? [(entry.data as { id: string }).id] : []);
	assert.equal(new Set(ids).size, 2);
	await reloaded.runner.emit({ type: "session_shutdown", reason: "quit" });
	const renders = reloaded.renderRequests;
	t.mock.timers.runAll();
	assert.equal(reloaded.renderRequests, renders);
	assert.equal(reloaded.widgetDisposals, 1);
	assert.deepEqual(reloaded.renderMarkers(), [settled, settled]);
});

test("real TUI routes Kitty release before focus without ending continuation feedback", async (t) => {
	const h = await createRunnerHarness(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	await h.queue("continue", "steer");
	assert.deepEqual(h.escape("\x1b[27;1:1u"), { consume: true });
	assert.deepEqual(h.escape("\x1b[27;1:2u"), { consume: true });
	h.escape("\x1b[27;1:3u"); // Aborting.
	assert.equal(h.aborts, 1);
	await h.settle();
	assert.deepEqual(h.started, ["continue"]);
	for (let step = 0; step <= 37; step++) {
		h.escape("\x1b[27;1:3u"); // The real router still passes release to listeners.
		assert.deepEqual(h.renderWidget(), []);
		assert.deepEqual(h.renderMarkers(), [live(indicatorAt(step))]);
		t.mock.timers.tick(step === 37 ? 39 : 79);
		assert.deepEqual(h.renderWidget(), []);
		t.mock.timers.tick(1);
	}
	assert.deepEqual(h.renderMarkers(), [settled]);
	assert.equal(h.renderRequests, 38);
	assert.deepEqual(h.focusedInput, [], "release filtered; owned press/repeat consumed before focus");
	assert.equal(h.escape("\x1b[27;1:1u"), undefined);
	assert.deepEqual(h.focusedInput, ["\x1b[27;1:1u"], "a new no-queue press reaches native focus");
});

test("real TUI keeps owned repeats out of native focus across failed preflight and live continuation", async (t) => {
	const h = await createRunnerHarness(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	await h.queue("retry", "steer");
	h.setAllowStart(false);
	h.escape("\x1b[27;1:1u");
	await h.settle(); // No agent_start: extension is still in starting phase.
	assert.deepEqual(h.escape("\x1b[27;1:2u"), { consume: true });
	assert.equal(h.aborts, 1);
	h.escape("\x1b[27;1:3u");
	assert.equal(h.aborts, 1);
	assert.equal(h.editorText, "");
	assert.deepEqual(h.focusedInput, []);
	assert.deepEqual(h.escape("\x1b[27;1:1u"), { consume: true });
	assert.equal(h.editorText, "retry");
	assert.equal(h.aborts, 2);

	h.setAllowStart(true);
	await h.queue("continue", "steer");
	h.escape("\x1b[27;1:1u");
	await h.settle();
	assert.deepEqual(h.escape("\x1b[27;1:2u"), { consume: true });
	assert.deepEqual(h.renderWidget(), []);
	assert.deepEqual(h.focusedInput, [], "owned repeat cannot reach native interrupt handling");
});

test("real ExtensionRunner keeps retained marker components renderable after session replacement", async (t) => {
	const h = await createRunnerHarness(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	await h.queue("continue here", "steer");
	h.escape();
	await h.settle();
	assert.deepEqual(h.renderMarkers(), [live("▶··")]);

	// Pi does not rebuild entry components when outputPad changes mid-stream.
	h.setOutputPad(0);
	assert.deepEqual(h.renderMarkers(), [unpadded(live("▶··"))]);

	await h.replaceSession();
	h.assertRuntimeStale();
	assert.equal(h.widgetDisposals, 1, "shutdown disposes the zero-row widget");
	// Components of the old session stay in Pi's transcript until the new session
	// rebinds it; their renderer must not call the invalidated runtime.
	assert.deepEqual(h.renderMarkers(), [unpadded(settled)], "finalized, keeping the last live outputPad");
	h.setOutputPad(1); // Settings are no longer read once the runtime is retired.
	assert.deepEqual(h.renderMarkers(80), [unpadded(settled)]);

	const renders = h.renderRequests;
	t.mock.timers.runAll();
	assert.equal(h.renderRequests, renders, "no animation timer outlives the replaced session");

	// The replacement runtime renders the saved entry with its own settings.
	const next = await createRunnerHarness(t, h.session);
	assert.deepEqual(next.renderMarkers(), [settled]);
	next.setOutputPad(0);
	assert.deepEqual(next.renderMarkers(), [unpadded(settled)]);
});
