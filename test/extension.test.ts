import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
} from "@earendil-works/pi-coding-agent";
import { createClaudeInterrupt } from "../src/index.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

type SentMessage = {
	text: string;
	options: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean } | undefined;
};

function harness() {
	const handlers = new Map<string, Handler[]>();
	const sent: SentMessage[] = [];
	let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let terminalUnsubscribed = false;
	let editorText = "";
	let coreHasPending = false;
	let aborts = 0;
	const notifications: string[] = [];

	const emitSync = (name: string, event: any, ctx: ExtensionContext): unknown => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = handler(event, ctx);
		return result;
	};

	const pi = {
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
		mode: "tui",
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

	return {
		ctx,
		sent,
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

test("Escape interrupts one queued text and continues only after settlement", () => {
	const h = harness();
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

test("several messages retain Pi's steering-before-follow-up order without duplication", () => {
	const h = harness();
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

test("Escape without a core queue remains native and an unsent draft is not a queue", () => {
	const h = harness();
	h.setDraft("draft only");
	h.setCorePending(false);

	assert.equal(h.escape(), undefined);
	assert.equal(h.aborts, 0);
	assert.equal(h.draft, "draft only");
});

test("repeated Escape while abort is settling is consumed without aborting twice", () => {
	const h = harness();
	h.input("queued", "steer");
	h.setCorePending(true);

	assert.deepEqual(h.escape(), { consume: true });
	assert.deepEqual(h.escape(), { consume: true });
	assert.equal(h.aborts, 1);

	h.emit("agent_settled", { type: "agent_settled" });
	h.emit("agent_start", { type: "agent_start" });
	assert.equal(h.sent.length, 1);
});

test("Escape can interrupt a replay and resumes the undelivered remainder once", () => {
	const h = harness();
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

test("Escape during continuation preflight restores captured text and exits starting state", () => {
	const h = harness();
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

test("already delivered messages are removed from the observed queue", () => {
	const h = harness();
	h.input("queued", "steer");
	h.emit("message_start", userMessageStart);
	h.setCorePending(true); // Deliberately inconsistent to exercise the observer guard.

	assert.equal(h.escape(), undefined);
	assert.equal(h.aborts, 0);
});

test("queued image attachments fall back to Pi's native Escape", () => {
	const h = harness();
	h.input("look at this", "steer", true);
	h.setCorePending(true);

	assert.equal(h.escape(), undefined);
	assert.equal(h.aborts, 0);
	assert.deepEqual(h.sent, []);
});

test("text submitted during abort settlement is cleared once and replayed once", () => {
	const h = harness();
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

test("a late image is rejected without discarding the captured text batch", () => {
	const h = harness();
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

test("session shutdown removes the terminal listener and clears state", () => {
	const h = harness();
	h.input("queued", "steer");
	h.setCorePending(true);

	h.emit("session_shutdown", { type: "session_shutdown" });
	assert.equal(h.terminalUnsubscribed, true);
	assert.equal(h.escape(), undefined);
	assert.equal(h.aborts, 0);
});
