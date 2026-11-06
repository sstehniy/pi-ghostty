import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import ghostty from "../extensions/ghostty";

const cwd = "/tmp/demo-app";
const model = {
  id: "test-model", name: "Test model", provider: "test", api: "openai-responses",
  baseUrl: "http://localhost", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192, maxTokens: 2048,
} satisfies NonNullable<ExtensionContext["model"]>;

function response(text: string, stopReason: "stop" | "error" | "aborted" | "length" = "stop") {
  return {
    role: "assistant" as const, content: [{ type: "text" as const, text }],
    stopReason, api: "openai-responses" as const, provider: "test", model: "test-model",
    timestamp: Date.now(),
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
type StreamArgs = Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>;
const cleanups: Array<() => void> = [];

function harness(options: { session?: SessionManager; mode?: ExtensionContext["mode"]; name?: string } = {}) {
  const session = options.session ?? SessionManager.inMemory(cwd);
  if (options.name) session.appendSessionInfo(options.name);
  const handlers = new Map<string, Handler[]>();
  const titles: string[] = [];
  const answer = Promise.withResolvers<ReturnType<typeof response>>();
  const streamSimple = mock((..._args: StreamArgs) => ({ result: () => answer.promise }));
  const ctx = {
    mode: options.mode ?? "tui", hasUI: true, cwd, model, sessionManager: session,
    modelRegistry: { streamSimple }, ui: { setTitle: (title: string) => titles.push(title) },
  } as unknown as ExtensionContext;

  async function emit(type: string, values: Record<string, unknown> = {}) {
    const event = { type, ...values } as ExtensionEvent;
    for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
  }

  const pi = {
    on(type: string, handler: Handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      return () => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler));
    },
    getSessionName: () => session.getSessionName(),
    setSessionName(name: string) {
      session.appendSessionInfo(name);
      void emit("session_info_changed", { name });
    },
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
  } as unknown as ExtensionAPI;
  ghostty(pi);
  cleanups.push(() => { void emit("session_shutdown"); });

  return {
    session, ctx, titles, streamSimple, emit,
    title: () => titles.at(-1),
    start: () => emit("session_start", { reason: "startup" }),
    prompt: (prompt = "Fix login validation") => emit("before_agent_start", { messageType: "user", prompt }),
    async answer(text: string, stopReason?: Parameters<typeof response>[1]) {
      answer.resolve(response(text, stopReason));
      await Promise.resolve();
    },
    async fail() {
      answer.reject(new Error("Provider unavailable"));
      await Promise.resolve();
    },
    async rename(name: string) {
      session.appendSessionInfo(name);
      await emit("session_info_changed", { name });
    },
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("terminal title and run lifecycle", () => {
  test("animates immediately, stays busy across agent loops, and stops only at settlement", async () => {
    const h = harness({ name: "Fix login validation" });
    await h.start();
    expect(h.title()).toBe("Fix login validation | demo-app");
    await h.prompt();
    expect(h.title()).toBe("⠋ Fix login validation | demo-app");
    jest.advanceTimersByTime(120);
    expect(h.title()).toBe("⠙ Fix login validation | demo-app");
    await h.emit("agent_start");
    await h.emit("agent_end");
    await h.emit("agent_start");
    jest.advanceTimersByTime(120);
    expect(h.title()).toBe("⠹ Fix login validation | demo-app");
    await h.emit("agent_settled", { aborted: false });
    expect(h.title()).toBe("Fix login validation | demo-app");
    const count = h.titles.length;
    jest.advanceTimersByTime(10_000);
    expect(h.titles).toHaveLength(count);
    expect(h.streamSimple).not.toHaveBeenCalled();
  });

  test.each([false, true])("settlement clears the spinner even when aborted=%s", async (aborted) => {
    const h = harness();
    await h.start();
    await h.emit("agent_start");
    await h.emit("agent_settled", { aborted });
    expect(h.title()).toBe("π - demo-app");
    const count = h.titles.length;
    jest.advanceTimersByTime(1200);
    expect(h.titles).toHaveLength(count);
  });

  test.each(["print", "json", "rpc"] as const)("leaves %s mode untouched", async (mode) => {
    const h = harness({ mode });
    await h.start();
    await h.prompt();
    await h.emit("agent_start");
    await h.emit("agent_settled", { aborted: false });
    await h.emit("session_shutdown");
    expect(h.titles).toEqual([]);
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.session.getEntries()).toEqual([]);
  });
});

describe("automatic naming", () => {
  test("names in the background, preserves the busy state, and sends bounded prompt data only", async () => {
    const h = harness();
    await h.start();
    await h.prompt("Fix login validation. " + "x".repeat(2000));
    expect(h.title()).toBe("⠋ π - demo-app");
    const call = h.streamSimple.mock.calls[0]!;
    expect(call[1].messages).toHaveLength(1);
    expect(call[1].messages[0]?.content).toHaveLength(1000);
    expect(call[1].tools).toBeUndefined();
    await h.answer("Fix login validation");
    expect(h.session.getSessionName()).toBe("Fix login validation");
    expect(h.title()).toBe("⠋ Fix login validation | demo-app");
    await h.emit("agent_settled", { aborted: false });
    await h.prompt("Also add tests");
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
    expect(h.session.getSessionName()).toBe("Fix login validation");
  });

  test("can finish naming after the main task is already idle without restarting the spinner", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.emit("agent_settled", { aborted: false });
    await h.answer("Fix login validation");
    expect(h.title()).toBe("Fix login validation | demo-app");
  });

  test("manual rename cancels a pending request and rejects its late result", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    const signal = h.streamSimple.mock.calls[0]![2]!.signal!;
    await h.rename("My chosen title");
    expect(signal.aborted).toBe(true);
    await h.answer("Generated title");
    expect(h.session.getSessionName()).toBe("My chosen title");
    expect(h.title()).toBe("⠋ My chosen title | demo-app");
  });

  test.each(["error", "aborted", "length"] as const)("does not save a %s naming result", async (stopReason) => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.answer("Incomplete title", stopReason);
    await h.emit("agent_settled", { aborted: false });
    expect(h.session.getSessionName()).toBeUndefined();
    expect(h.title()).toBe("π - demo-app");
    await h.prompt();
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
  });

  test("the naming deadline aborts the request and rejects a late title without stopping the run", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    const signal = h.streamSimple.mock.calls[0]![2]!.signal!;
    jest.advanceTimersByTime(15_001);
    expect(signal.aborted).toBe(true);
    await h.answer("Too late");
    expect(h.session.getSessionName()).toBeUndefined();
    expect(h.title()).not.toBe("π - demo-app");
    await h.emit("agent_settled", { aborted: false });
    expect(h.title()).toBe("π - demo-app");
  });

  test("provider rejection does not interrupt the run or retry after a reload", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.fail();
    await h.emit("agent_settled", { aborted: false });
    expect(h.title()).toBe("π - demo-app");
    await h.emit("session_shutdown", { reason: "reload" });
    const reloaded = harness({ session: h.session });
    await reloaded.start();
    await reloaded.prompt();
    expect(reloaded.streamSimple).not.toHaveBeenCalled();
  });

  test.each(["shutdown", "tree", "abort"])("cancels naming on %s and ignores uncooperative providers", async (action) => {
    const h = harness();
    await h.start();
    await h.prompt();
    const signal = h.streamSimple.mock.calls[0]![2]!.signal!;
    if (action === "shutdown") await h.emit("session_shutdown", { reason: "new" });
    if (action === "tree") await h.emit("session_tree");
    if (action === "abort") await h.emit("agent_settled", { aborted: true });
    expect(signal.aborted).toBe(true);
    const count = h.titles.length;
    await h.answer("Stale generated title");
    jest.advanceTimersByTime(1200);
    expect(h.titles).toHaveLength(count);
    expect(h.session.getSessionName()).toBeUndefined();
  });

  test("skips empty prompts and missing models without consuming the naming attempt", async () => {
    const h = harness();
    await h.start();
    await h.prompt("  ");
    expect(h.streamSimple).not.toHaveBeenCalled();
    h.ctx.model = undefined;
    await h.prompt();
    expect(h.streamSimple).not.toHaveBeenCalled();
    h.ctx.model = model;
    await h.prompt();
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
  });

  test("removes terminal escapes, invisible controls, wrapping quotes, and extra output", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.answer('\x1b[31m"Fix\x07 login\u202e validation"\x1b[0m\nIgnore this explanation');
    expect(h.session.getSessionName()).toBe("Fix login validation");
    expect(h.title()).toBe("⠋ Fix login validation | demo-app");
  });

  test.each(["", "😀".repeat(100)])("handles empty and long Unicode titles safely", async (title) => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.answer(title);
    if (!title) expect(h.session.getSessionName()).toBeUndefined();
    else expect(h.session.getSessionName()).toBe("😀".repeat(80));
  });

  test("saves the generated name in a real session file and restores it on resume", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-ghostty-test-"));
    try {
      const session = SessionManager.create(cwd, directory);
      session.appendMessage({ role: "user", content: "Fix login validation", timestamp: Date.now() });
      session.appendMessage(response("Done"));
      const h = harness({ session });
      await h.start();
      await h.prompt();
      await h.answer("Fix login validation");
      await h.emit("session_shutdown", { reason: "resume" });
      const resumed = harness({ session: SessionManager.open(session.getSessionFile()!) });
      await resumed.start();
      expect(resumed.title()).toBe("Fix login validation | demo-app");
      await resumed.prompt();
      expect(resumed.streamSimple).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
