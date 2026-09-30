import {
  createRuntimeEndpointAdapterFacet, runtimeConfigExact, runtimeConfigObject,
  runtimeConfigPositiveInteger, runtimeConfigString,
} from "@hypit/hypit/runtime-kit";
import { magnificSession } from "./mcp.js";
import { createMagnificProvider, providerModule } from "./provider.js";

export default {
  format: "hypit.node-package@1" as const,
  hostFacets: [createRuntimeEndpointAdapterFacet({
    use: providerModule.name,
    activate(context) {
      const config = runtimeConfigObject(context.config, "Magnific");
      runtimeConfigExact(config, ["credentialsFile", "folderReference", "concurrency", "pollIntervalMs"], "Magnific");
      // Path to the socialmedia engine's `credentials/magnific-mcp.json` (a path, not a secret).
      const credentialsFile = runtimeConfigString(config.credentialsFile, "Magnific credentialsFile");
      // The workspace's Magnific folder: every generation lands there, never in "Personal".
      const folderReference = runtimeConfigString(config.folderReference, "Magnific folderReference");
      if (!credentialsFile || !folderReference || !context.pool) {
        throw new Error("Magnific requires credentialsFile, folderReference and pool");
      }
      return { endpoint: createMagnificProvider({
        instance: context.instance, pool: context.pool, folderReference,
        call: magnificSession(credentialsFile),
        concurrency: runtimeConfigPositiveInteger(config.concurrency, "concurrency") ?? 4,
        pollIntervalMs: runtimeConfigPositiveInteger(config.pollIntervalMs, "pollIntervalMs") ?? 5_000,
      }) };
    },
  })],
};
