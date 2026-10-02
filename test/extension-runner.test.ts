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
	type SessionManager,
	type TerminalInputHandler,
	type Theme,
} from "@earendil-works/pi-coding-agent";

type Delivery = "steer" | "followUp";
type Queued = { text: string; deliverAs: Delivery };

async function createRunnerHarness(t: TestContext) {
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

	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		root,
		{} as SessionManager,
		{} as ModelRegistry,
	);

	const schedule = (work: () => Promise<void>): void => {
		const job = work().finally(() => jobs.delete(job));
		jobs.add(job);
	};

	const actions: ExtensionActions = {
		sendMessage: () => undefined,
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
				delivered.push(text);
			});
		},
		appendEntry: () => undefined,
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
			widget?.dispose?.();
			widget = undefined;
			if (factory) widget = factory(
				{ requestRender: () => undefined } as unknown as TUI,
				{ fg: (_key: string, text: string) => text } as Theme,
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
	assert.deepEqual(h.renderWidget(), ["›··  Conversation Steered"]);
	assert.deepEqual(h.coreQueue.map((item) => item.text), ["second", "third"]);

	// Interrupt before either replayed queue entry reaches message_start.
	assert.deepEqual(h.escape(), { consume: true });
	await h.settle();
	assert.deepEqual(h.started, ["first", "second"]);
	assert.deepEqual(h.renderWidget(), ["›··  Conversation Steered"]);
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

	assert.deepEqual(h.escape(), { consume: true });
	assert.equal(h.editorText, "retry me\n\nthen me\n\ndraft");
	assert.equal(h.escape(), undefined);
});
