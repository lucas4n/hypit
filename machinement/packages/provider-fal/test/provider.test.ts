import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { sealSeedanceRequest, seedancePorts } from "@hypit/seedance";
import type { BlobRef, EndpointStartContext } from "@hypit/hypit/endpoint-kit";
import { canonicalize } from "@hypit/hypit/endpoint-kit";
import { assertMappingCoversPorts, generationTypes } from "@hypit/hypit/generation";
import { createFalProvider, mappings } from "../src/provider.js";

const base = { prompt: ["A presenter talks"], duration: [5], resolution: ["720p"], aspectRatio: ["9:16"], generateAudio: [true], webSearch: [false] };

function needFor(model: "seedance-2" | "seedance-2-fast", ports: Parameters<typeof sealSeedanceRequest>[1]) {
  return {
    id: `need:${model}`, capability: mappings[model].capability, returns: generationTypes.videoSet,
    constraints: canonicalize(sealSeedanceRequest(model, ports)), result: `record:${model}`,
  };
}

async function endpointOf(provider: ReturnType<typeof createFalProvider>, need: ReturnType<typeof needFor>) {
  const registry = new EndpointRegistry(); await provider.install(registry);
  const resolved = registry.resolve(need);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "asynchronous");
  return resolved.registration.endpoint;
}

/** A fake fal: records every call and answers the queue and storage protocol. */
function fakeFal(options: { result?: () => Response } = {}) {
  const calls: { url: string; auth: string | null; body?: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const raw = init?.body;
    calls.push({ url: url.href, auth, body: typeof raw === "string" ? JSON.parse(raw) : undefined });
    if (url.hostname === "rest.fal.ai") return Response.json({ upload_url: `https://upload.fal.media/put/${calls.length}`, file_url: `https://v3.fal.media/files/ref-${calls.length}` });
    if (url.hostname === "upload.fal.media") return new Response(null, { status: 200 });
    if (url.hostname === "v3.fal.media") return new Response(new Uint8Array([7, 8, 9]), { headers: { "content-type": "video/mp4" } });
    if (url.pathname.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (url.pathname.endsWith("/requests/req-1")) return options.result?.() ?? Response.json({ video: { url: "https://v3.fal.media/files/out.mp4" }, seed: 1 });
    return Response.json({
      request_id: "req-1",
      status_url: "https://queue.fal.run/bytedance/seedance-2.0/requests/req-1/status",
      response_url: "https://queue.fal.run/bytedance/seedance-2.0/requests/req-1",
    });
  };
  return { calls, fetch };
}

function contextFor(need: ReturnType<typeof needFor>, resources = new MemoryResourceStore()): EndpointStartContext {
  return {
    need, command: { kind: "fulfill-need", id: "command:test", need }, operation: "operation:test",
    resources, credentials: { apiKey: { secret: "fal-test-key" } },
  };
}

test("both fal mappings cover every port of their Seedance Model", () => {
  assertMappingCoversPorts(seedancePorts["seedance-2"], mappings["seedance-2"]);
  assertMappingCoversPorts(seedancePorts["seedance-2-fast"], mappings["seedance-2-fast"]);
});

test("a presenter with a voice sample goes to reference-to-video, uploads both, and collects the video", async () => {
  const resources = new MemoryResourceStore();
  const face = await resources.put(new Uint8Array([1]), "image/png");
  const voice = await resources.put(new Uint8Array([2]), "audio/mpeg");
  const fal = fakeFal();
  const provider = createFalProvider({ instance: "fal", pool: "fal", apiKey: { store: "env", key: "FAL_KEY" }, pollIntervalMs: 0, fetch: fal.fetch });
  const need = needFor("seedance-2", { ...base, aspectRatio: ["adaptive"],
    referenceImage: [{ role: "image", artifact: face, fields: { personReference: true } }],
    referenceAudio: [{ role: "audio", artifact: voice }],
  });
  const endpoint = await endpointOf(provider, need);
  const context = contextFor(need, resources);
  const start = await endpoint.start(context); assert.equal(start.status, "pending");
  const ready = await endpoint.poll({ ...context, handle: start.handle }); assert.equal(ready.status, "ready");
  const done = await endpoint.collect!({ ...context, handle: ready.handle }); assert.equal(done.status, "completed");

  const submit = fal.calls.find((call) => call.url === "https://queue.fal.run/bytedance/seedance-2.0/reference-to-video");
  assert.ok(submit, "submitted to reference-to-video");
  assert.deepEqual(submit.body, {
    prompt: "A presenter talks", duration: "5", resolution: "720p", aspect_ratio: "auto", generate_audio: true,
    image_urls: ["https://v3.fal.media/files/ref-1"], audio_urls: ["https://v3.fal.media/files/ref-3"],
  });
  // The key reaches fal's API hosts and nothing else.
  for (const call of fal.calls) {
    const host = new URL(call.url).hostname;
    assert.equal(call.auth === "Key fal-test-key", host === "queue.fal.run" || host === "rest.fal.ai", `auth on ${host}`);
  }
  const videos = (done.result.value.value as unknown as { videos: BlobRef[] }).videos;
  assert.deepEqual(await resources.get(videos[0]!.resource), new Uint8Array([7, 8, 9]));
});

test("routes: a first frame picks image-to-video, a bare prompt text-to-video, fast its own prefix", async () => {
  const resources = new MemoryResourceStore();
  const frame = await resources.put(new Uint8Array([1]), "image/png");
  const submitted = async (model: "seedance-2" | "seedance-2-fast", ports: Parameters<typeof sealSeedanceRequest>[1]) => {
    const fal = fakeFal();
    const provider = createFalProvider({ instance: "fal", pool: "fal", apiKey: { store: "env", key: "FAL_KEY" }, fetch: fal.fetch });
    const need = needFor(model, ports);
    await (await endpointOf(provider, need)).start(contextFor(need, resources));
    return fal.calls.find((call) => new URL(call.url).hostname === "queue.fal.run")!;
  };
  const framed = await submitted("seedance-2", { ...base, firstFrame: [{ role: "image", artifact: frame, fields: { personReference: false } }] });
  assert.equal(framed.url, "https://queue.fal.run/bytedance/seedance-2.0/image-to-video");
  assert.equal((framed.body as Record<string, unknown>).image_url, "https://v3.fal.media/files/ref-1");
  const bare = await submitted("seedance-2-fast", base);
  assert.equal(bare.url, "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video");
  assert.equal("web_search" in (bare.body as Record<string, unknown>), false);
});

test("web search is refused before anything is paid", async () => {
  const provider = createFalProvider({ instance: "fal", pool: "fal", apiKey: { store: "env", key: "FAL_KEY" } });
  const verdict = provider.offers[0]!.supports!(needFor("seedance-2", { ...base, webSearch: [true] }));
  assert.equal(verdict.status, "unsupported");
});

test("a fal error keeps the request id and hides URLs", async () => {
  const fal = fakeFal({ result: () => Response.json({ detail: [{ msg: "Face detected; see https://fal.ai/secret?x=1" }] }, { status: 422 }) });
  const provider = createFalProvider({ instance: "fal", pool: "fal", apiKey: { store: "env", key: "FAL_KEY" }, pollIntervalMs: 0, fetch: fal.fetch });
  const need = needFor("seedance-2", base);
  const endpoint = await endpointOf(provider, need);
  const context = contextFor(need);
  const start = await endpoint.start(context);
  const failed = await endpoint.poll({ ...context, handle: start.handle });
  assert.equal(failed.status, "failed");
  const message = failed.status === "failed" ? failed.failure.message : "";
  assert.match(message, /req-1 failed: .*Face detected/u);
  assert.doesNotMatch(message, /secret\?x=1|fal-test-key/u);
});

test("a status URL outside fal is refused instead of receiving the key", async () => {
  const fal = fakeFal();
  const provider = createFalProvider({ instance: "fal", pool: "fal", apiKey: { store: "env", key: "FAL_KEY" }, fetch: async (input, init) => {
    if (new URL(String(input)).hostname === "queue.fal.run" && init?.method === "POST") {
      return Response.json({ request_id: "x", status_url: "https://evil.example/status", response_url: "https://queue.fal.run/r" });
    }
    return fal.fetch(input, init);
  } });
  const need = needFor("seedance-2", base);
  await assert.rejects((await endpointOf(provider, need)).start(contextFor(need)), /Refusing to send the fal key to evil\.example/u);
});
