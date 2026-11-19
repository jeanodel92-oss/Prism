// fork: load a vendored plug-in's module as Prism loads it (jiti with the host's virtual modules). The plug-ins'
// generated, untyped code then stays out of the root type check, which reports declaration errors for any file
// outside node_modules (vendor/forks/*).
import { createJiti } from "jiti";
import { getVirtualModules } from "../src/core/extensions/loader.ts";

export async function loadVendored<Module>(path: string): Promise<Module> {
	return createJiti(import.meta.url, { virtualModules: await getVirtualModules() }).import<Module>(path);
}
