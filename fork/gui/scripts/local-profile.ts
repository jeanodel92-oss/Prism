// Writes the throwaway profile's models.json for `run.sh local URL MODEL` the way adding a server in Prism does
// (a hand-written entry with only the id showed 128k of context and no reasoning levels for a model that has 256k and reasons)
// . Reads only what the server says (capabilities.ts); nothing is installed.
//
//   node --import <source-resolver> local-profile.ts MODELS_JSON URL MODEL
import { dirname } from "node:path";
import { detectCapabilities } from "../../../packages/coding-agent/src/fork/capabilities.ts";
import { capabilitiesPath, recordDetection } from "../../../packages/coding-agent/src/fork/capability-store.ts";
import {
	listCompatibleServerModels,
	writeCompatibleServer,
} from "../../../packages/coding-agent/src/fork/compatible-server.ts";

const [modelsPath, url, model] = process.argv.slice(2);
if (!modelsPath || !url || !model) throw new Error("usage: local-profile.ts MODELS_JSON URL MODEL");
const { baseUrl, models } = await listCompatibleServerModels(url, undefined);
if (!models.includes(model)) throw new Error(`${model} is not in the server's list: ${models.join(", ")}`);
const detected = await detectCapabilities(baseUrl, [model], undefined);
await writeCompatibleServer(modelsPath, { providerId: "local", baseUrl, models: [model], detected }, "openai-completions", false);
await recordDetection(capabilitiesPath(dirname(modelsPath)), "local", detected.models);
const found = detected.models.find((entry) => entry.id === model);
process.stderr.write(
	`local: ${model}, context ${found?.contextWindow ?? "unknown"}, reasoning ${found?.reasoning ?? "unknown"}\n`,
);
