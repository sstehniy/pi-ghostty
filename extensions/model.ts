import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Text } from "@earendil-works/pi-tui";

export interface TitleModel {
  provider: string;
  id: string;
}

export function readModel(): TitleModel | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(getAgentDir(), "pi-ghostty.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read Pi Ghostty settings. Run /ghostty model to select a model.");
  }
  if (value && typeof value === "object" && "provider" in value && "id" in value &&
    typeof value.provider === "string" && value.provider.trim() &&
    typeof value.id === "string" && value.id.trim()) {
    return { provider: value.provider, id: value.id };
  }
  throw new Error("Invalid Pi Ghostty settings. Run /ghostty model to select a model.");
}

export function saveModel(model: TitleModel | null): void {
  const directory = getAgentDir();
  const file = join(directory, "pi-ghostty.json");
  if (!model) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.pi-ghostty-${randomUUID()}`);
  try {
    writeFileSync(temporary, JSON.stringify(model, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function selectModel(ctx: ExtensionContext, current?: TitleModel) {
  const models = ctx.modelRegistry.getAvailable()
    .slice().sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  return ctx.ui.custom<TitleModel | null | undefined>((tui, theme, keys, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", "Pi Ghostty title model"), 0, 1));
    const input = new Input({ placeholder: "Search connected providers and models" });
    container.addChild(input);
    const items = [
      { value: "", label: "Disable naming", description: "Spinner remains enabled" },
      ...models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}` })),
    ];
    const listContainer = new Container();
    let list: SelectList;
    function filter(query: string) {
      list = new SelectList(fuzzyFilter(items, query, (item) => item.label), 10, getSelectListTheme());
      list.onSelect = (item) => {
        if (!item.value) return done(null);
        const model = models.find((model) => `${model.provider}/${model.id}` === item.value);
        if (model) done({ provider: model.provider, id: model.id });
      };
      list.onCancel = () => done(undefined);
      listContainer.clear();
      listContainer.addChild(list);
    }
    filter("");
    if (current) list!.setSelectedIndex(models.findIndex((model) =>
      model.provider === current.provider && model.id === current.id) + 1);
    container.addChild(listContainer);
    container.addChild(new Text(theme.fg("dim", "Type to search · ↑↓ navigate · Enter select · Esc cancel"), 0, 1));
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some(
          (key) => keys.matches(data, key),
        )) {
          list.handleInput(data);
        } else {
          input.handleInput(data);
          filter(input.getValue());
        }
        tui.requestRender();
      },
    };
  });
}
