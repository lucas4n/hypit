import { canonicalize, defineEndpointPackage, wakeAfter } from "@hypit/hypit/endpoint-kit";
import type { AsyncEndpoint, CredentialRef, EndpointRequest } from "@hypit/hypit/endpoint-kit";
import {
  compileWireRequest, generationTypes, mappingSupportsRequest,
  sealGeneratedVideoSet, selectWireModelForRequest,
} from "@hypit/hypit/generation";
import type { GenerationRequest, GenerationWireMapping } from "@hypit/hypit/generation";

/**
 * Seedance 2 on fal.ai (`bytedance/seedance-2.0/*`).
 *
 * fal splits one Seedance model into three endpoints, and the author's inputs choose which one:
 * a first frame goes to `image-to-video`, any reference media to `reference-to-video`, and a bare
 * prompt to `text-to-video`. The Model already forbids mixing frames with references, so each
 * request lands on exactly one endpoint and only that endpoint's fields are written.
 *
 * Protocol (fal queue API, `Authorization: Key <FAL_KEY>`):
 * - upload: `POST rest.fal.ai/storage/upload/initiate` → `{ upload_url, file_url }`, then PUT bytes
 * - submit: `POST queue.fal.run/<endpoint>` → `{ request_id, status_url, response_url }`
 * - poll:   `GET status_url` → `IN_QUEUE` | `IN_PROGRESS` | `COMPLETED`
 * - result: `GET response_url` → `{ video: { url } }`, or an error body with `detail`
 */
export const providerModule = { name: "@machinement/provider-fal", version: "1" } as const;

const SEEDANCE = { name: "@hypit/seedance", version: "1" } as const;
const REST = "https://rest.fal.ai";
const QUEUE = "https://queue.fal.run";
/** fal switches to multipart above this size; a reference this large is a mistake, not a use case. */
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;

function seedanceMapping(model: "seedance-2" | "seedance-2-fast", prefix: string): GenerationWireMapping {
  const endpoint = (name: string) => `${prefix}/${name}`;
  return {
    capability: { module: SEEDANCE, name: model }, result: "video",
    routes: [
      { model: endpoint("image-to-video"), whenPresent: ["firstFrame"] },
      { model: endpoint("reference-to-video"), whenPresent: ["referenceImage"] },
      { model: endpoint("reference-to-video"), whenPresent: ["referenceVideo"] },
      { model: endpoint("text-to-video") },
    ],
    fields: {
      prompt: { as: "value", field: "prompt" },
      // fal takes no person flag: the resolver consumes it and the upload carries none.
      referenceImage: { as: "urlArray", field: "image_urls", resourceFields: ["personReference"] },
      referenceVideo: { as: "urlArray", field: "video_urls", resourceFields: ["personReference"] },
      referenceAudio: { as: "urlArray", field: "audio_urls" },
      firstFrame: { as: "url", field: "image_url", resourceFields: ["personReference"] },
      lastFrame: { as: "url", field: "end_image_url", resourceFields: ["personReference"] },
      resolution: { as: "value", field: "resolution" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      duration: { as: "string", field: "duration" },
      generateAudio: { as: "value", field: "generate_audio" },
      // Mapped so coverage holds; fal has no web search, so `supports` refuses `true` and the
      // compiled request drops the field before submission.
      webSearch: { as: "value", field: "web_search" },
    },
  };
}

export const mappings = {
  "seedance-2": seedanceMapping("seedance-2", "bytedance/seedance-2.0"),
  "seedance-2-fast": seedanceMapping("seedance-2-fast", "bytedance/seedance-2.0/fast"),
} as const;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected fal object");
  return value as Record<string, unknown>;
}
function text(value: unknown, subject = "fal text"): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected nonempty ${subject}`);
  return value;
}
function redact(message: string): string {
  return message.replace(/https?:\/\/\S+/giu, "[redacted-url]");
}
/** fal errors carry `detail` as a string or as a validation list of `{ msg }`. */
function falDetail(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const detail = (value as Record<string, unknown>).detail ?? (value as Record<string, unknown>).error;
  if (typeof detail === "string") return redact(detail);
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => (item !== null && typeof item === "object" && typeof item.msg === "string"
      ? item.msg : undefined)).filter((item): item is string => item !== undefined);
    return messages.length === 0 ? undefined : redact(messages.join("; "));
  }
  return undefined;
}
/** The account key only ever travels to fal's own API hosts. */
function falApi(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["queue.fal.run", "rest.fal.ai"].includes(url.hostname)) {
    throw new Error(`Refusing to send the fal key to ${url.hostname}`);
  }
  return url.href;
}
function https(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("fal media URLs must be HTTPS");
  return url.href;
}

function requestOf(request: EndpointRequest): GenerationRequest {
  return request.constraints as unknown as GenerationRequest;
}

export function createFalProvider(options: {
  instance: string; pool: string; apiKey: CredentialRef;
  concurrency?: number; pollIntervalMs?: number; fetch?: typeof globalThis.fetch;
}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const interval = options.pollIntervalMs ?? 5_000;
  const key = (credentials: Readonly<Record<string, { secret: string }>>) => text(credentials.apiKey?.secret, "FAL_KEY");

  async function json(url: string, secret: string, init: RequestInit = {}) {
    const response = await fetcher(falApi(url), {
      ...init,
      headers: { ...init.headers, authorization: `Key ${secret}` },
      // Submission enqueues; the bound covers the API call, not the render.
      signal: AbortSignal.timeout(120_000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = falDetail(body);
      const requestId = response.headers.get("x-fal-request-id");
      throw new Error(`fal ${init.method ?? "GET"} ${new URL(url).pathname} returned HTTP ${response.status}`
        + (requestId === null ? "" : `; request=${requestId}`)
        + (detail === undefined ? "" : `; ${detail}`));
    }
    return object(body);
  }

  function capabilityFor(mapping: GenerationWireMapping) {
    function supports(request: EndpointRequest) {
      const ports = requestOf(request).ports;
      if (ports.webSearch?.[0] === true) {
        return { status: "unsupported" as const, reason: "fal's Seedance 2 has no web search; author web-search=\"false\"" };
      }
      return mappingSupportsRequest(mapping, request.constraints)
        ? { status: "supported" as const }
        : { status: "unsupported" as const, reason: "fal does not accept one of the requested inputs" };
    }

    const endpoint: AsyncEndpoint = {
      async start(context) {
        const supported = supports(context.need);
        if (supported.status === "unsupported") throw new Error(supported.reason);
        const secret = key(context.credentials);
        const authored = requestOf(context.need);
        const model = selectWireModelForRequest(mapping, authored);
        await context.reportProgress?.({ phase: `Preparing fal request: ${model}` });
        const compiled = await compileWireRequest(mapping, authored, async (artifact) => {
          const bytes = await context.resources.get(artifact.resource);
          if (bytes === undefined) throw new Error("Reference media is unavailable");
          if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("Reference media exceeds fal's 90 MB single upload");
          const extension = artifact.mediaType.split("/")[1]?.split("+")[0] ?? "bin";
          const initiated = await json(`${REST}/storage/upload/initiate?storage_type=fal-cdn-v3`, secret, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ content_type: artifact.mediaType, file_name: `reference.${extension}` }),
          });
          const put = await fetcher(https(text(initiated.upload_url, "fal upload URL")), {
            method: "PUT", headers: { "content-type": artifact.mediaType },
            body: new Blob([new Uint8Array(bytes)]), signal: AbortSignal.timeout(120_000),
          });
          if (!put.ok) throw new Error(`fal storage upload returned HTTP ${put.status}`);
          return https(text(initiated.file_url, "fal file URL"));
        });
        const input = { ...object(compiled.input) };
        delete input.web_search;
        // Seedance's own word for "let the model pick" is `adaptive`; fal spells it `auto`.
        if (input.aspect_ratio === "adaptive") input.aspect_ratio = "auto";
        await context.reportProgress?.({ phase: `Submitting fal request: ${model}` });
        const queued = await json(`${QUEUE}/${model}`, secret, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
        });
        const handle = {
          id: text(queued.request_id, "fal request id"),
          statusUrl: falApi(text(queued.status_url, "fal status URL")),
          responseUrl: falApi(text(queued.response_url, "fal response URL")),
        };
        const receipt = { id: handle.id, model };
        await context.checkpoint?.({ handle, receipt });
        return { ...wakeAfter(handle, interval), receipt };
      },
      async poll(context) {
        const handle = object(context.handle);
        const id = text(handle.id), statusUrl = text(handle.statusUrl), responseUrl = text(handle.responseUrl);
        const secret = key(context.credentials);
        const status = await json(statusUrl, secret);
        const state = text(status.status, "fal status");
        if (state === "IN_QUEUE" || state === "IN_PROGRESS") {
          return wakeAfter({ id, statusUrl, responseUrl }, interval, Date.now(), { phase: state.toLowerCase() });
        }
        if (state !== "COMPLETED") throw new Error(`fal returned an unknown request state ${state}`);
        const failure = falDetail(status);
        if (failure !== undefined) {
          return { status: "failed", receipt: { id }, failure: { code: "FAL_FAILED", message: `fal request ${id} failed: ${failure}` } };
        }
        let result: Record<string, unknown>;
        try { result = await json(responseUrl, secret); }
        catch (error) {
          return { status: "failed", receipt: { id }, failure: {
            code: "FAL_FAILED", message: `fal request ${id} failed: ${redact((error as Error).message)}`,
          } };
        }
        // A completed request without a video is a contract violation, not a pending job.
        const url = https(text(object(result.video).url, "fal video URL"));
        return { status: "ready", handle: { id, url } };
      },
      async collect(context) {
        // Signed CDN URL: the account key is not sent with the download.
        const url = https(text(object(context.handle).url));
        await context.reportProgress?.({ phase: "Receiving generated video" });
        const response = await fetcher(url, { signal: AbortSignal.timeout(600_000) });
        if (!response.ok) throw new Error(`fal video download returned HTTP ${response.status}`);
        const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
        if (!mediaType?.startsWith("video/")) throw new Error("fal returned a non-video result");
        const artifact = await context.resources.put(new Uint8Array(await response.arrayBuffer()), mediaType);
        return { status: "completed", result: { value: {
          kind: "inline", value: canonicalize(sealGeneratedVideoSet({ videos: [artifact] })),
        } } };
      },
    };
    return { capability: mapping.capability, returns: generationTypes.videoSet, lifecycle: "asynchronous" as const, supports, endpoint };
  }

  return defineEndpointPackage({
    module: providerModule, facet: "videos", instance: options.instance, pool: options.pool,
    credentials: { apiKey: options.apiKey }, credentialInputs: { apiKey: { label: "fal.ai API key (FAL_KEY)" } },
    defaultConcurrency: options.concurrency ?? 2,
    actionLimits: { submit: { concurrency: 2 }, poll: { concurrency: 4 }, collect: { concurrency: 2 } },
    pricing: { kind: "page", url: "https://fal.ai/models/bytedance/seedance-2.0/reference-to-video" },
    capabilities: Object.values(mappings).map(capabilityFor),
  });
}
