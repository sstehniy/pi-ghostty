import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { replacementTitle, requestTitle } from "../extensions/titles";
import { titleCases } from "../tests/title-cases";

if (titleCases.length > 20) throw new Error("This evaluation is limited to 20 synthetic requests per run.");
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
if (!runtime.isUsingSubscription("openai-codex")) {
  throw new Error("A Codex subscription login is required. No API-key fallback is allowed.");
}
const model = runtime.getModel("openai-codex", "gpt-6-luna");
if (!model) throw new Error("openai-codex/gpt-6-luna is unavailable");
const registry = new ModelRegistry(runtime);
const results = [];
for (const item of titleCases) {
  const started = performance.now();
  const response = await requestTitle(registry, model, item.current, item.request, AbortSignal.timeout(15_000));
  if (response.stopReason !== "stop") throw new Error(`Evaluation stopped: ${response.stopReason}`);
  const output = response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  const valid = response.stopReason === "stop" && (output.trim() === "KEEP" || Boolean(replacementTitle(output)));
  const title = replacementTitle(output);
  const renamed = Boolean(title);
  const relevant = !item.topic || Boolean(title && item.topic.test(title));
  const result = {
    case: item.name, expected: item.rename ? "rename" : "keep", output,
    pass: valid && renamed === item.rename && relevant,
    milliseconds: Math.round(performance.now() - started),
    inputTokens: response.usage.input, outputTokens: response.usage.output,
    reasoningTokens: response.usage.reasoning ?? 0,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
const milliseconds = results.map((item) => item.milliseconds).sort((a, b) => a - b);
const middle = Math.floor(milliseconds.length / 2);
let median = milliseconds[middle] ?? 0;
if (milliseconds.length % 2 === 0 && middle > 0) median = (milliseconds[middle - 1]! + median) / 2;
const summary = {
  model: `${model.provider}/${model.id}`, cases: results.length,
  passed: results.filter((item) => item.pass).length,
  falseRenames: results.filter((item) => item.expected === "keep" && item.output.trim() !== "KEEP").length,
  failedRenames: results.filter((item) => item.expected === "rename" && !item.pass).length,
  inputTokens: results.reduce((sum, item) => sum + item.inputTokens, 0),
  outputTokens: results.reduce((sum, item) => sum + item.outputTokens, 0),
  reasoningTokens: results.reduce((sum, item) => sum + item.reasoningTokens, 0),
  medianMilliseconds: median,
  maxMilliseconds: milliseconds.at(-1),
};
console.log(JSON.stringify({ summary }, null, 2));
if (results.some((item) => !item.pass)) process.exitCode = 1;
