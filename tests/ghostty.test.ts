import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  SessionManager, initTheme,
  type ExtensionAPI, type ExtensionContext, type ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import ghostty from "../extensions/ghostty";
import { readModel, saveModel } from "../extensions/model";

const cwd = "/tmp/demo-app";
const model = {
  id: "titles", name: "Title model", provider: "test", api: "openai-responses",
  baseUrl: "http://localhost", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192, maxTokens: 2048,
} satisfies NonNullable<ExtensionContext["model"]>;

function response(text: string, stopReason: "stop" | "error" | "aborted" | "length" = "stop") {
  return {
    role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason,
    api: "openai-responses" as const, provider: "test", model: "titles", timestamp: Date.now(),
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
type StreamArgs = Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>;
const cleanups: Array<() => void> = [];
let directory: string;
let previousAgentDir: string | undefined;

function harness(options: {
  session?: SessionManager; mode?: ExtensionContext["mode"]; name?: string;
  configured?: boolean; available?: boolean;
} = {}) {
  if (options.configured !== false) saveModel({ provider: model.provider, id: model.id });
  const session = options.session ?? SessionManager.inMemory(cwd);
  if (options.name) session.appendSessionInfo(options.name);
  const handlers = new Map<string, Handler[]>();
  const titles: string[] = [];
  const pending: Array<ReturnType<typeof Promise.withResolvers<ReturnType<typeof response>>>> = [];
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
  const streamSimple = mock((..._args: StreamArgs) => {
    const answer = Promise.withResolvers<ReturnType<typeof response>>();
    pending.push(answer);
    return { result: () => answer.promise };
  });
  let component: Component | undefined;
  const custom: ExtensionContext["ui"]["custom"] = (factory) => new Promise((resolve) => {
    component = factory({ requestRender() {} } as never,
      { fg: (_color: string, text: string) => text } as never, getKeybindings() as never, resolve) as Component;
  });
  const notify = mock(() => {});
  const ctx = {
    mode: options.mode ?? "tui", hasUI: true, cwd, model: { ...model, id: "coding" }, sessionManager: session,
    modelRegistry: {
      streamSimple, find: () => options.available === false ? undefined : model,
      hasConfiguredAuth: () => true, getAvailable: () => [{ ...model, id: "coding" }, model],
    },
    ui: { setTitle: (title: string) => titles.push(title), notify, custom },
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
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) => commands.set(name, command.handler),
  } as unknown as ExtensionAPI;
  ghostty(pi);
  cleanups.push(() => { void emit("session_shutdown"); });
  let timestamp = 1000;
  return {
    session, ctx, titles, streamSimple, emit, notify,
    component: () => component!,
    title: () => titles.at(-1),
    start: () => emit("session_start", { reason: "startup" }),
    command: (args: string) => commands.get("ghostty")!(args, ctx),
    async consume(text = "Fix login validation", time = timestamp++) {
      const message = { role: "user" as const, content: text, timestamp: time };
      await emit("message_start", { message });
      session.appendMessage(message);
      return message;
    },
    async prompt(text = "Fix login validation") {
      await emit("before_agent_start", { messageType: "user", prompt: text });
      await emit("agent_start");
      return this.consume(text);
    },
    async answer(text: string, index = pending.length - 1, stopReason?: Parameters<typeof response>[1]) {
      pending[index]!.resolve(response(text, stopReason));
      await Promise.resolve();
    },
    async fail() {
      pending.at(-1)!.reject(new Error("Provider unavailable"));
      await Promise.resolve();
    },
    async rename(name: string) {
      session.appendSessionInfo(name);
      await emit("session_info_changed", { name });
    },
  };
}

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  directory = mkdtempSync(join(tmpdir(), "pi-ghostty-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  initTheme("dark", false);
  jest.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(directory, { recursive: true, force: true });
});

describe("spinner and activation", () => {
  test("needs no title model to animate and stays busy until final settlement", async () => {
    const h = harness({ name: "Fix login validation", configured: false });
    await h.start();
    await h.prompt();
    expect(h.title()).toBe("⠋ Fix login validation | demo-app");
    jest.advanceTimersByTime(120);
    expect(h.title()).toBe("⠙ Fix login validation | demo-app");
    await h.emit("agent_end");
    await h.emit("agent_start");
    jest.advanceTimersByTime(120);
    expect(h.title()).toBe("⠹ Fix login validation | demo-app");
    await h.emit("agent_settled", { aborted: false });
    expect(h.title()).toBe("Fix login validation | demo-app");
    const count = h.titles.length;
    jest.advanceTimersByTime(1000);
    expect(h.titles).toHaveLength(count);
    expect(h.streamSimple).not.toHaveBeenCalled();
  });

  test("an unnamed unconfigured session makes no naming requests", async () => {
    const h = harness({ configured: false });
    await h.start();
    await h.prompt();
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.session.getSessionName()).toBeUndefined();
  });

  test.each(["print", "json", "rpc"] as const)("leaves %s mode untouched", async (mode) => {
    const h = harness({ mode });
    await h.start();
    await h.prompt();
    await h.emit("agent_settled", { aborted: false });
    expect(h.titles).toEqual([]);
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.session.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
  });
});

describe("managed titles", () => {
  test("uses the selected model, keeps its task anchor through follow-ups, and updates on a new goal", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    expect(h.streamSimple.mock.calls[0]![0].id).toBe("titles");
    expect(h.title()).toBe("⠋ π - demo-app");
    await h.answer("TITLE: Fix login validation");
    await h.consume("Add tests and commit");
    await h.answer("KEEP");
    expect(h.session.getSessionName()).toBe("Fix login validation");
    await h.consume("Now implement billing");
    const context = JSON.parse(h.streamSimple.mock.calls[2]![1].messages[0]!.content as string);
    expect(context.title_task).toBe("Fix login validation");
    expect(context.new_request).toBe("Now implement billing");
    expect(h.streamSimple.mock.calls[2]![1].tools).toBeUndefined();
    await h.answer("TITLE: Implement billing");
    expect(h.title()).toBe("⠋ Implement billing | demo-app");
    await h.emit("agent_settled", { aborted: false });
    expect(h.title()).toBe("Implement billing | demo-app");
  });

  test("a queued request is checked only when consumed, not on submission or tool turns", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.answer("TITLE: Fix login validation");
    await h.emit("input", { text: "Implement billing", source: "interactive", streamingBehavior: "followUp" });
    await h.emit("turn_start");
    await h.emit("tool_execution_start", { toolName: "read" });
    await h.emit("message_start", { message: response("Working") });
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
    await h.consume("Implement billing");
    expect(h.streamSimple).toHaveBeenCalledTimes(2);
  });

  test("duplicate message events do not cancel or repeat an in-flight check", async () => {
    const h = harness();
    await h.start();
    const message = await h.prompt();
    await h.emit("message_start", { message });
    await h.answer("TITLE: Fix login validation");
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
    expect(h.session.getSessionName()).toBe("Fix login validation");
  });

  test("bounds long requests at both ends and preserves Unicode", async () => {
    const h = harness();
    await h.start();
    await h.prompt("Begin: " + "😀".repeat(3000) + " End: implement billing");
    const context = JSON.parse(h.streamSimple.mock.calls[0]![1].messages[0]!.content as string);
    expect(Array.from(context.new_request)).toHaveLength(1000);
    expect(context.new_request.startsWith("Begin: ")).toBe(true);
    expect(context.new_request.endsWith("End: implement billing")).toBe(true);
    expect(Array.from(context.title_task)).toHaveLength(500);
  });

  test("manual names and unknown old-version names stay pinned until explicit opt-in", async () => {
    const h = harness({ name: "Release preparation" });
    h.session.appendCustomEntry("pi-ghostty:naming-attempt", {});
    await h.start();
    await h.prompt("Implement billing");
    expect(h.streamSimple).not.toHaveBeenCalled();
    await h.command("auto");
    expect(h.streamSimple).not.toHaveBeenCalled();
    await h.consume("Implement billing");
    await h.answer("TITLE: Implement billing");
    expect(h.session.getSessionName()).toBe("Implement billing");
    await h.rename("My title");
    await h.consume("Build search");
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
    expect(h.session.getSessionName()).toBe("My title");
  });

  test("manual rename rejects late results even when set to the same generated name", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.answer("TITLE: Fix login validation");
    await h.consume("Implement billing");
    await h.rename("Fix login validation");
    await h.answer("TITLE: Implement billing");
    expect(h.session.getSessionName()).toBe("Fix login validation");
    await h.consume("Build search");
    expect(h.streamSimple).toHaveBeenCalledTimes(2);
  });

  test("newer consumed requests supersede late results from older ones", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    const firstSignal = h.streamSimple.mock.calls[0]![2]!.signal!;
    await h.consume("Implement billing");
    expect(firstSignal.aborted).toBe(true);
    await h.answer("TITLE: Implement billing", 1);
    await h.answer("TITLE: Fix login validation", 0);
    expect(h.session.getSessionName()).toBe("Implement billing");
  });

  test("ownership and checked-message identity survive a real file resume", async () => {
    const session = SessionManager.create(cwd, directory);
    session.appendMessage(response("Earlier reply"));
    const h = harness({ session });
    await h.start();
    const message = await h.prompt();
    await h.answer("TITLE: Fix login validation");
    await h.emit("session_shutdown", { reason: "resume" });
    const resumed = harness({ session: SessionManager.open(session.getSessionFile()!) });
    await resumed.start();
    await resumed.emit("message_start", { message });
    expect(resumed.streamSimple).not.toHaveBeenCalled();
    await resumed.consume("Implement billing", 2000);
    await resumed.answer("TITLE: Implement billing");
    expect(resumed.session.getSessionName()).toBe("Implement billing");
  });

  test("can apply a late completed check without restarting an idle spinner", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.emit("agent_settled", { aborted: false });
    await h.answer("TITLE: Fix login validation");
    expect(h.title()).toBe("Fix login validation | demo-app");
  });
});

describe("failure boundaries", () => {
  test.each(["shutdown", "tree", "abort"])("%s cancels pending checks and clears the spinner", async (action) => {
    const h = harness();
    await h.start();
    await h.prompt();
    const signal = h.streamSimple.mock.calls[0]![2]!.signal!;
    if (action === "shutdown") await h.emit("session_shutdown");
    if (action === "tree") await h.emit("session_tree");
    if (action === "abort") await h.emit("agent_settled", { aborted: true });
    expect(signal.aborted).toBe(true);
    const count = h.titles.length;
    await h.answer("TITLE: Stale result");
    jest.advanceTimersByTime(1200);
    expect(h.titles).toHaveLength(count);
    expect(h.session.getSessionName()).toBeUndefined();
  });

  test("a timeout cannot rename the session or interrupt the main run", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    jest.advanceTimersByTime(15_001);
    expect(h.streamSimple.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    await h.answer("TITLE: Too late");
    expect(h.session.getSessionName()).toBeUndefined();
    expect(h.title()).not.toBe("π - demo-app");
  });

  test.each(["error", "aborted", "length"] as const)("ignores a %s result without retrying", async (reason) => {
    const h = harness();
    await h.start();
    const message = await h.prompt();
    await h.answer("TITLE: Incomplete", 0, reason);
    await h.emit("message_start", { message });
    expect(h.session.getSessionName()).toBeUndefined();
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
  });

  test("provider rejection keeps the current title and permits a check on the next request", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.answer("TITLE: Fix login validation");
    await h.consume("Implement billing");
    await h.fail();
    expect(h.session.getSessionName()).toBe("Fix login validation");
    await h.consume("Implement billing with invoices");
    await h.answer("TITLE: Implement billing");
    expect(h.session.getSessionName()).toBe("Implement billing");
  });

  test("an unavailable configured model never falls back to the coding model", async () => {
    const h = harness({ available: false });
    await h.start();
    await h.prompt();
    await h.consume("Implement billing");
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  test.each(["KEEP", "", "Unstructured response", "TITLE: Name\nExplanation"])("leaves the title unchanged for %j", async (result) => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.answer(result);
    expect(h.session.getSessionName()).toBeUndefined();
  });

  test("sanitizes terminal escapes and invisible controls in a valid title", async () => {
    const h = harness();
    await h.start();
    await h.prompt();
    await h.answer('TITLE: \x1b[31m"Fix\x07 login\u202e validation"\x1b[0m');
    expect(h.session.getSessionName()).toBe("Fix login validation");
  });
});

describe("model settings and picker", () => {
  test("a searchable connected-provider picker saves the model without changing the coding model", async () => {
    const h = harness({ configured: false });
    await h.start();
    const choosing = h.command("model");
    h.component().handleInput!("titles");
    const visible = stripVTControlCharacters(h.component().render(100).join("\n"));
    expect(visible).toContain("test/titles");
    expect(visible).not.toContain("test/coding");
    h.component().handleInput!("\r");
    await choosing;
    expect(readModel()).toEqual({ provider: "test", id: "titles" });
    expect(h.ctx.model?.id).toBe("coding");
    expect(h.streamSimple).not.toHaveBeenCalled();
    await h.prompt();
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
  });

  test("cancelling selection preserves settings; disabling removes them and cancels pending work", async () => {
    const h = harness();
    await h.start();
    const cancelling = h.command("model");
    h.component().handleInput!("\x1b");
    await cancelling;
    expect(readModel()?.id).toBe("titles");
    await h.prompt();
    const choosing = h.command("model");
    h.component().handleInput!("Disable naming");
    h.component().handleInput!("\r");
    await choosing;
    expect(readModel()).toBeUndefined();
    await h.answer("TITLE: Stale result");
    await h.consume("Implement billing");
    expect(h.streamSimple).toHaveBeenCalledTimes(1);
    expect(h.session.getSessionName()).toBeUndefined();
  });

  test("malformed settings disable calls without overwriting the file", async () => {
    const h = harness({ configured: false });
    writeFileSync(join(directory, "pi-ghostty.json"), '{"provider":7}');
    await h.start();
    await h.prompt();
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(directory, "pi-ghostty.json"), "utf8")).toBe('{"provider":7}');
  });
});
