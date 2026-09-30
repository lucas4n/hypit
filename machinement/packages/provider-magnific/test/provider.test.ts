import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { gptImage2Ports, sealGptImage2Request } from "@hypit/gpt-image";
import { nanoBananaPorts, sealNanoBananaRequest } from "@hypit/nano-banana";
import { sealSeedanceRequest, seedancePorts } from "@hypit/seedance";
import type { BlobRef, EndpointStartContext } from "@hypit/hypit/endpoint-kit";
import { canonicalize } from "@hypit/hypit/endpoint-kit";
import { assertMappingCoversPorts, generationTypes } from "@hypit/hypit/generation";
import type { GenerationRequest } from "@hypit/hypit/generation";
import { createMagnificProvider, offers } from "../src/provider.js";

const FOLDER = "7e9cc827-60ed-4960-a69d-4d0a776efc02";

/** A fake Magnific MCP plus its upload proxy and CDN. */
function fakeMagnific(options: { status?: () => Record<string, unknown>; resultUrl?: string; contentType?: string } = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const puts: string[] = [];
  let uploads = 0;
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool === "creations_request_upload") { uploads += 1; return { proxyUploadUrl: `https://ak-data.magnific.com/proxy/${uploads}`, path: `temp-files/${uploads}` }; }
    if (tool === "creations_finalize_upload") return { identifier: `up-${String(args.path).split("/")[1]}`, status: "completed" };
    if (tool === "images_generate" || tool === "video_generate") {
      return { creation: { identifier: "cr-1", status: "processing", credits: 75 }, adjustments: [], instruction: "" };
    }
    if (tool === "creation_status") {
      return options.status?.() ?? { creationIdentifier: "cr-1", status: "completed", results: { url: options.resultUrl ?? "https://pikaso.cdnpk.net/private/render.png?token=x" } };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "PUT") { puts.push(url.href); return Response.json({ success: true }); }
    return new Response(new Uint8Array([9, 9]), { headers: { "content-type": options.contentType ?? "image/png" } });
  };
  return { calls, puts, call, fetch };
}

function needOf(key: keyof typeof offers, constraints: GenerationRequest) {
  const offer = offers[key];
  return {
    id: `need:${key}`, capability: offer.mapping.capability,
    returns: offer.family === "image" ? generationTypes.imageSet : generationTypes.videoSet,
    constraints: canonicalize(constraints), result: `record:${key}`,
  };
}

async function run(provider: ReturnType<typeof createMagnificProvider>, need: ReturnType<typeof needOf>, resources = new MemoryResourceStore()) {
  const registry = new EndpointRegistry(); await provider.install(registry);
  const resolved = registry.resolve(need);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "asynchronous");
  const endpoint = resolved.registration.endpoint;
  const context: EndpointStartContext = { need, command: { kind: "fulfill-need", id: "c", need }, operation: "o", resources, credentials: {} };
  const started = await endpoint.start(context);
  const polled = await endpoint.poll({ ...context, handle: started.handle });
  if (polled.status !== "ready") return { started, polled };
  const collected = await endpoint.collect!({ ...context, handle: polled.handle });
  return { started, polled, collected };
}

test("every Magnific mapping covers its Model's ports", () => {
  assertMappingCoversPorts(gptImage2Ports, offers["gpt-image-2"].mapping);
  assertMappingCoversPorts(nanoBananaPorts["nano-banana-2"], offers["nano-banana-2"].mapping);
  assertMappingCoversPorts(nanoBananaPorts["nano-banana-pro"], offers["nano-banana-pro"].mapping);
  assertMappingCoversPorts(seedancePorts["seedance-2"], offers["seedance-2"].mapping);
  assertMappingCoversPorts(seedancePorts["seedance-2-fast"], offers["seedance-2-fast"].mapping);
  assertMappingCoversPorts(seedancePorts["seedance-2-mini"], offers["seedance-2-mini"].mapping);
});

test("GPT Image 2 uploads its reference invisibly, generates in the folder and collects a PNG", async () => {
  const resources = new MemoryResourceStore();
  const ref = await resources.put(new Uint8Array([1]), "image/png");
  const magnific = fakeMagnific();
  const provider = createMagnificProvider({ instance: "m", pool: "m", folderReference: FOLDER, call: magnific.call, fetch: magnific.fetch, pollIntervalMs: 0 });
  const need = needOf("gpt-image-2", sealGptImage2Request({
    prompt: ["A goth presenter"], aspectRatio: ["9:16"], resolution: ["2K"], background: ["transparent"],
    images: [{ role: "image", artifact: ref }],
  }));
  const { started, collected } = await run(provider, need, resources);
  assert.deepEqual(started.status === "pending" ? started.receipt : undefined, { id: "cr-1", slug: "gpt-2", credits: 75 });
  const finalize = magnific.calls.find((c) => c.tool === "creations_finalize_upload")!;
  assert.deepEqual(finalize.args, { path: "temp-files/1", visible: false, folderReference: FOLDER });
  const generate = magnific.calls.find((c) => c.tool === "images_generate")!;
  assert.deepEqual(generate.args, {
    prompt: "A goth presenter", folderReference: FOLDER, mode: "gpt-2", count: 1,
    aspectRatio: "9:16", resolution: "2k", transparentBackground: true,
    references: [{ type: "image", identifier: "up-1" }],
  });
  assert.equal(collected?.status, "completed");
  const images = (collected!.result.value.value as unknown as { images: BlobRef[] }).images;
  assert.equal(images[0]?.mediaType, "image/png");
});

test("Nano Banana names are not swapped: 2 is -flash, Pro is imagen-nano-banana-2", async () => {
  for (const [key, slug] of [["nano-banana-2", "imagen-nano-banana-2-flash"], ["nano-banana-pro", "imagen-nano-banana-2"]] as const) {
    const magnific = fakeMagnific();
    const provider = createMagnificProvider({ instance: "m", pool: "m", folderReference: FOLDER, call: magnific.call, fetch: magnific.fetch, pollIntervalMs: 0 });
    await run(provider, needOf(key, sealNanoBananaRequest(key, { prompt: ["x"], aspectRatio: ["16:9"], resolution: ["1K"], outputFormat: ["png"] })));
    assert.equal(magnific.calls.find((c) => c.tool === "images_generate")!.args.mode, slug);
  }
});

test("a presenter take: Seedance 2 with face and voice references, audio on, 4k spelled 4K", async () => {
  const resources = new MemoryResourceStore();
  const face = await resources.put(new Uint8Array([1]), "image/png");
  const voice = await resources.put(new Uint8Array([2]), "audio/mpeg");
  const magnific = fakeMagnific({ resultUrl: "https://pikaso.cdnpk.net/private/video.mp4?token=x", contentType: "application/octet-stream" });
  const provider = createMagnificProvider({ instance: "m", pool: "m", folderReference: FOLDER, call: magnific.call, fetch: magnific.fetch, pollIntervalMs: 0 });
  const need = needOf("seedance-2", sealSeedanceRequest("seedance-2", {
    prompt: ["She ranks players"], duration: [8], resolution: ["4k"], aspectRatio: ["9:16"], generateAudio: [true], webSearch: [false],
    referenceImage: [{ role: "image", artifact: face, fields: { personReference: true } }],
    referenceAudio: [{ role: "audio", artifact: voice }],
  }));
  const { collected } = await run(provider, need, resources);
  assert.deepEqual(magnific.calls.find((c) => c.tool === "video_generate")!.args, {
    prompt: "She ranks players", folderReference: FOLDER, slug: "bytedance-seedance-pro-2.0",
    duration: 8, resolution: "4K", aspectRatio: "9:16", withSoundEffects: true,
    references: [{ type: "image", url: "up-1" }, { type: "audio", url: "up-2" }],
  });
  assert.deepEqual(magnific.calls.filter((c) => c.tool === "creations_request_upload").map((c) => c.args.mimeType), ["image/png", "audio/mpeg"]);
  // The CDN said octet-stream; the .mp4 path decides.
  const videos = (collected!.result.value.value as unknown as { videos: BlobRef[] }).videos;
  assert.equal(videos[0]?.mediaType, "video/mp4");
});

test("first and last frames become keyframes", async () => {
  const resources = new MemoryResourceStore();
  const frame = await resources.put(new Uint8Array([1]), "image/png");
  const magnific = fakeMagnific({ resultUrl: "https://pikaso.cdnpk.net/v.mp4", contentType: "video/mp4" });
  const provider = createMagnificProvider({ instance: "m", pool: "m", folderReference: FOLDER, call: magnific.call, fetch: magnific.fetch, pollIntervalMs: 0 });
  await run(provider, needOf("seedance-2-fast", sealSeedanceRequest("seedance-2-fast", {
    prompt: ["bridge"], duration: [5], resolution: ["720p"], aspectRatio: ["adaptive"], generateAudio: [false], webSearch: [false],
    firstFrame: [{ role: "image", artifact: frame, fields: { personReference: false } }],
    lastFrame: [{ role: "image", artifact: frame, fields: { personReference: false } }],
  })), resources);
  const args = magnific.calls.find((c) => c.tool === "video_generate")!.args;
  assert.equal(args.slug, "bytedance-seedance-fast-2.0");
  assert.equal("aspectRatio" in args, false);
  assert.deepEqual(args.keyframes, { start: { type: "image", url: "up-1" }, end: { type: "image", url: "up-2" } });
});

test("requests Magnific cannot carry are refused before anything is paid", () => {
  const magnific = fakeMagnific();
  const provider = createMagnificProvider({ instance: "m", pool: "m", folderReference: FOLDER, call: magnific.call });
  const verdict = (key: keyof typeof offers, request: GenerationRequest) => {
    const offer = provider.offers.find((o) => o.capability.name === offers[key].mapping.capability.name)!;
    return offer.supports!(needOf(key, request));
  };
  const video = { prompt: ["x"], duration: [5], resolution: ["720p"], generateAudio: [true] };
  assert.equal(verdict("seedance-2", sealSeedanceRequest("seedance-2", { ...video, aspectRatio: ["9:16"], webSearch: [true] })).status, "unsupported");
  assert.equal(verdict("seedance-2", sealSeedanceRequest("seedance-2", { ...video, aspectRatio: ["adaptive"], webSearch: [false] })).status, "unsupported");
  assert.equal(verdict("gpt-image-2", sealGptImage2Request({ prompt: ["x"], aspectRatio: ["auto"], resolution: ["1K"] })).status, "unsupported");
  assert.equal(verdict("gpt-image-2", sealGptImage2Request({ prompt: ["x"], aspectRatio: ["3:1"], resolution: ["1K"] })).status, "unsupported");
  assert.equal(verdict("nano-banana-2", sealNanoBananaRequest("nano-banana-2", { prompt: ["x"], aspectRatio: ["1:1"], resolution: ["1K"], outputFormat: ["jpg"] })).status, "unsupported");
  assert.equal(magnific.calls.length, 0);
});

test("a failed creation keeps its id, hides URLs, and a pending one waits", async () => {
  let state = "processing";
  const magnific = fakeMagnific({ status: () => (state === "processing"
    ? { creationIdentifier: "cr-1", status: "processing", poll_after_seconds: 7 }
    : { creationIdentifier: "cr-1", status: "failed", failureReason: "Content policy, see https://x.example/why" }) });
  const provider = createMagnificProvider({ instance: "m", pool: "m", folderReference: FOLDER, call: magnific.call, fetch: magnific.fetch, pollIntervalMs: 0 });
  const need = needOf("gpt-image-2", sealGptImage2Request({ prompt: ["x"], aspectRatio: ["1:1"], resolution: ["1K"] }));
  const pending = await run(provider, need);
  assert.equal(pending.polled.status, "pending");
  state = "failed";
  const failed = await run(provider, need);
  assert.equal(failed.polled.status, "failed");
  const message = failed.polled.status === "failed" ? failed.polled.failure.message : "";
  assert.match(message, /creation cr-1 failed: Content policy/u);
  assert.doesNotMatch(message, /x\.example/u);
});
