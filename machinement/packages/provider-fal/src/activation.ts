import {
  createRuntimeEndpointAdapterFacet, runtimeConfigCredentialRef, runtimeConfigExact,
  runtimeConfigObject, runtimeConfigPositiveInteger,
} from "@hypit/hypit/runtime-kit";
import { createFalProvider, providerModule } from "./provider.js";

export default {
  format: "hypit.node-package@1" as const,
  hostFacets: [createRuntimeEndpointAdapterFacet({
    use: providerModule.name,
    activate(context) {
      const config = runtimeConfigObject(context.config, "fal");
      runtimeConfigExact(config, ["apiKey", "concurrency", "pollIntervalMs"], "fal");
      const apiKey = runtimeConfigCredentialRef(config.apiKey, "fal apiKey");
      if (!apiKey || !context.pool) throw new Error("fal requires apiKey and pool");
      return { endpoint: createFalProvider({
        instance: context.instance, pool: context.pool, apiKey,
        concurrency: runtimeConfigPositiveInteger(config.concurrency, "concurrency") ?? 2,
        pollIntervalMs: runtimeConfigPositiveInteger(config.pollIntervalMs, "pollIntervalMs") ?? 5_000,
      }) };
    },
  })],
};
