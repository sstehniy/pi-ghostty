import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readModel, saveModel, selectModel, type TitleModel } from "./model";
import { cleanTitle, excerpt, replacementTitle, requestTitle, type TaskTitle } from "./titles";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATE = "pi-ghostty:title";

interface TitleState extends TaskTitle {
  managed: boolean;
  lastMessage: string;
}

function restoreState(ctx: ExtensionContext): TitleState {
  const title = ctx.sessionManager.getSessionName() ?? "";
  const entry = ctx.sessionManager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === STATE);
  if (entry?.type === "custom" && entry.data && typeof entry.data === "object") {
    const data = entry.data as Partial<TitleState>;
    if (typeof data.managed === "boolean" && data.title === title &&
      typeof data.task === "string" && typeof data.lastMessage === "string") {
      return { managed: data.managed, title, task: excerpt(data.task, 500), lastMessage: data.lastMessage };
    }
  }
  // Old versions did not record ownership; existing names must be treated as manual.
  return { managed: !title, title, task: "", lastMessage: "" };
}

export default function ghostty(pi: ExtensionAPI): void {
  let active = false;
  let state: TitleState = { managed: false, title: "", task: "", lastMessage: "" };
  let preferred: TitleModel | undefined;
  let spinner: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let naming: AbortController | undefined;
  let expectedName: string | undefined;
  let warned = false;

  function render(ctx: ExtensionContext): void {
    const directory = cleanTitle(path.basename(ctx.cwd));
    const name = cleanTitle(pi.getSessionName() ?? "");
    let title = `π - ${directory}`;
    if (name) title = `${name} | ${directory}`;
    if (spinner) title = `${FRAMES[frame % FRAMES.length]} ${title}`;
    ctx.ui.setTitle(title);
  }

  function startSpinner(ctx: ExtensionContext): void {
    if (spinner) return;
    frame = 0;
    spinner = setInterval(() => {
      frame++;
      render(ctx);
    }, 120);
    spinner.unref();
    render(ctx);
  }

  function stopSpinner(ctx: ExtensionContext): void {
    clearInterval(spinner);
    spinner = undefined;
    render(ctx);
  }

  function cancelNaming(): void {
    naming?.abort();
    naming = undefined;
  }

  function persist(): void {
    pi.appendEntry(STATE, { ...state });
  }

  function warn(ctx: ExtensionContext): void {
    if (warned) return;
    warned = true;
    ctx.ui.notify("Pi Ghostty could not update the title. Check /ghostty model or /login.", "warning");
  }

  async function checkTitle(text: string, ctx: ExtensionContext): Promise<void> {
    if (!preferred) return;
    const model = ctx.modelRegistry.find(preferred.provider, preferred.id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return warn(ctx);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const sessionId = ctx.sessionManager.getSessionId();
    const currentName = pi.getSessionName() ?? "";
    naming = controller;

    try {
      const response = await requestTitle(ctx.modelRegistry, model, state, text, signal);
      if (!active || signal.aborted || naming !== controller || !state.managed ||
        ctx.sessionManager.getSessionId() !== sessionId || (pi.getSessionName() ?? "") !== currentName) return;
      if (response.stopReason !== "stop") return warn(ctx);
      warned = false;
      const title = replacementTitle(response.content
        .filter((part) => part.type === "text").map((part) => part.text).join(""));
      if (!title || title === currentName) return;
      state = { ...state, title, task: excerpt(text, 500) };
      expectedName = title;
      pi.setSessionName(title);
      persist();
      render(ctx);
    } catch {
      if (active && naming === controller && !signal.aborted) warn(ctx);
    } finally {
      if (naming === controller) naming = undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    active = true;
    state = restoreState(ctx);
    try {
      preferred = readModel();
    } catch (error) {
      ctx.ui.notify((error as Error).message, "warning");
    }
    render(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode === "tui") startSpinner(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode === "tui") startSpinner(ctx);
  });

  // User messages start only when consumed, including steering and queued follow-ups.
  pi.on("message_start", (event, ctx) => {
    if (ctx.mode !== "tui" || !active || event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content
      .filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const id = createHash("sha256").update(JSON.stringify([event.message.timestamp, text])).digest("hex");
    if (id === state.lastMessage) return;
    cancelNaming();
    if (!preferred || !state.managed || !text.trim()) return;
    state.lastMessage = id;
    if (!state.title && !state.task) state.task = excerpt(text, 500);
    // Record before calling the provider so retries and reloads cannot repeat this check.
    persist();
    void checkTitle(text, ctx);
  });

  pi.on("agent_settled", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (event.aborted) cancelNaming();
    stopSpinner(ctx);
  });

  pi.on("session_info_changed", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const name = event.name ?? "";
    if (expectedName !== undefined && name === expectedName) {
      expectedName = undefined;
      return;
    }
    expectedName = undefined;
    cancelNaming();
    state = { managed: false, title: name, task: "", lastMessage: "" };
    persist();
    render(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    cancelNaming();
    state = restoreState(ctx);
    stopSpinner(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    active = false;
    cancelNaming();
    stopSpinner(ctx);
  });

  pi.registerCommand("ghostty", {
    description: "Title settings: /ghostty model | /ghostty auto",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/ghostty requires interactive Pi", "warning");
        return;
      }
      if (args.trim() === "model") {
        const selected = await selectModel(ctx, preferred);
        if (selected === undefined) return;
        try {
          saveModel(selected);
          cancelNaming();
          preferred = selected ?? undefined;
          warned = false;
          if (selected) {
            ctx.ui.notify(`Title model: ${selected.provider}/${selected.id}. /ghostty auto enables updates for a pinned title.`, "info");
          } else {
            ctx.ui.notify("Naming disabled. The spinner remains enabled.", "info");
          }
        } catch {
          ctx.ui.notify("Could not save the title model; the previous setting is unchanged.", "error");
        }
        return;
      }
      if (args.trim() === "auto") {
        cancelNaming();
        state = { managed: true, title: pi.getSessionName() ?? "", task: "", lastMessage: "" };
        persist();
        ctx.ui.notify("Automatic title updates enabled for this session. Select a model with /ghostty model if needed.", "info");
        return;
      }
      let model = "not selected (naming disabled)";
      if (preferred) model = `${preferred.provider}/${preferred.id}`;
      const ownership = state.managed ? "automatic" : "pinned";
      ctx.ui.notify(`Title model: ${model}. Session: ${ownership}. /ghostty model | /ghostty auto`, "info");
    },
  });
}
