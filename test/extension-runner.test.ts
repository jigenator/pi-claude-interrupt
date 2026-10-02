import assert from "node:assert/strict";
import { setImmediate as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Component, TUI } from "@earendil-works/pi-tui";

import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	type ExtensionActions,
	type ExtensionContextActions,
	type ExtensionUIContext,
	type ModelRegistry,
	SessionManager,
	type TerminalInputHandler,
	type Theme,
} from "@earendil-works/pi-coding-agent";

type Delivery = "steer" | "followUp";
type Queued = { text: string; deliverAs: Delivery };

async function createRunnerHarness(t: TestContext, savedSession?: SessionManager) {
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const loaded = await discoverAndLoadExtensions(
		[join(root, "src/index.ts")],
		root,
		join(root, "test", "fixtures", "empty-agent-dir"),
	);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);

	let terminalHandler: TerminalInputHandler | undefined;
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
	const session = savedSession ?? SessionManager.inMemory(root);
	const theme = { fg: (_key: string, text: string) => text } as Theme;
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
		getSettings: () => ({}),
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
		onTerminalInput: (handler: TerminalInputHandler) => {
			terminalHandler = handler;
			return () => {
				terminalHandler = undefined;
			};
		},
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
	t.after(() => runner.emit({ type: "session_shutdown", reason: "quit" }));

	const flush = async (): Promise<void> => {
		while (jobs.size > 0) await Promise.all([...jobs]);
	};

	return {
		runner,
		session,
		get renderRequests() { return renderRequests; },
		get widgetDisposals() { return widgetDisposals; },
		renderMarkers: () => session.getBranch().flatMap((entry) => {
			if (entry.type !== "custom") return [];
			let component = components.get(entry.id);
			if (!component) {
				component = runner.getEntryRenderer(entry.customType)?.(entry, { expanded: false }, theme);
				assert.ok(component);
				components.set(entry.id, component);
			}
			return component.render(80);
		}),
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
		escape() {
			assert.ok(terminalHandler);
			return terminalHandler("\x1b");
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
	assert.deepEqual(h.renderMarkers(), ["›··  Conversation Steered"]);
	assert.deepEqual(h.coreQueue.map((item) => item.text), ["second", "third"]);

	// Interrupt before either replayed queue entry reaches message_start.
	assert.deepEqual(h.escape(), { consume: true });
	await h.settle();
	assert.deepEqual(h.started, ["first", "second"]);
	assert.deepEqual(h.renderWidget(), []);
	assert.deepEqual(h.renderMarkers(), [" ✓   Conversation Steered", "›··  Conversation Steered"]);
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
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await h.queue("continue here", "steer");
	await h.queue("later action", "followUp");
	h.escape();
	await h.settle();
	const markers = h.session.getEntries().filter((entry) => entry.type === "custom");
	assert.equal(markers.length, 1);
	assert.equal(markers[0].customType, "claude-interrupt-steering");
	assert.ok(h.trace.indexOf(`marker:${markers[0].id}`) > h.trace.indexOf("started:continue here"));
	assert.ok(h.trace.indexOf(`marker:${markers[0].id}`) < h.trace.indexOf("queued:later action"));
	assert.deepEqual(h.renderMarkers(), ["›··  Conversation Steered"]);
	assert.deepEqual(h.renderWidget(), []);
	for (let step = 1; step <= 20; step++) t.mock.timers.tick(150);
	assert.deepEqual(h.renderMarkers(), [" ✓   Conversation Steered"]);
	assert.equal(h.renderRequests, 20);
	assert.equal(h.widgetDisposals, 1);
	assert.equal(h.renderWidget(), undefined);
	await h.deliverQueued();
	await h.runner.emit({ type: "agent_start" }); // Ordinary activity cannot add a marker.
	t.mock.timers.tick(60_000);
	assert.equal(h.renderRequests, 20);
	assert.deepEqual(h.renderMarkers(), [" ✓   Conversation Steered"]);
	assert.equal(h.session.getEntries().filter((entry) => entry.type === "custom").length, 1);
	assert.ok(h.session.buildContextEntries().some((entry) => entry.id === markers[0].id));
	assert.deepEqual(h.session.buildSessionContext().messages.map((message) => message.role), ["user", "user"]);
	assert.ok(!JSON.stringify(h.session.buildSessionContext()).includes("claude-interrupt-steering"));

	await h.runner.emit({ type: "session_shutdown", reason: "reload" });
	const reloaded = await createRunnerHarness(t, h.session);
	assert.deepEqual(reloaded.renderMarkers(), [" ✓   Conversation Steered"]);
	assert.equal(reloaded.renderWidget(), undefined);
	await reloaded.queue("new continuation", "steer");
	reloaded.escape();
	await reloaded.settle();
	assert.deepEqual(reloaded.renderMarkers(), [" ✓   Conversation Steered", "›··  Conversation Steered"]);
	const ids = reloaded.session.getEntries().flatMap((entry) => entry.type === "custom" ? [(entry.data as { id: string }).id] : []);
	assert.equal(new Set(ids).size, 2);
	await reloaded.runner.emit({ type: "session_shutdown", reason: "quit" });
	const renders = reloaded.renderRequests;
	t.mock.timers.runAll();
	assert.equal(reloaded.renderRequests, renders);
	assert.equal(reloaded.widgetDisposals, 1);
	assert.deepEqual(reloaded.renderMarkers(), [" ✓   Conversation Steered", " ✓   Conversation Steered"]);
});
