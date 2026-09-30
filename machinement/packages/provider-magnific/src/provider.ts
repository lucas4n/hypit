import { canonicalize, defineEndpointPackage, wakeAfter } from "@hypit/hypit/endpoint-kit";
import type { AsyncEndpoint, EndpointRequest } from "@hypit/hypit/endpoint-kit";
import {
  compileWireRequest, generationTypes, mappingSupportsRequest,
  sealGeneratedImageSet, selectWireModelForRequest,
} from "@hypit/hypit/generation";
import type { GenerationRequest, GenerationWireMapping } from "@hypit/hypit/generation";
import type { MagnificCall } from "./mcp.js";

/**
 * Magnific (Freepik) through its MCP server, paid with the plan's credits. IMAGES ONLY, by
 * decision (Lucas, 2026-09-30): a 5 s Seedance take costs ~1,400 of the plan's 45k monthly
 * credits, which the channels need for their images, so video goes through fal instead. Not
 * offering Seedance here is what enforces it — an unbound capability with a single offer would
 * otherwise be picked silently.
 *
 * The "wire" here is MCP tool arguments, not an HTTP body. Each mapping still goes through
 * `compileWireRequest` — so `assertMappingCoversPorts` guards it like any Provider — and a small
 * shaper turns the flat result into `images_generate` arguments.
 *
 * - upload:  `creations_request_upload` → PUT bytes to `proxyUploadUrl` → `creations_finalize_upload`
 *            (visible: false) → creation `identifier`, which every reference field takes
 * - submit:  `images_generate` → `creation.identifier`, `credits`, `adjustments`
 * - poll:    `creation_status` → `completed` with `results.url`, or `failed` with `failureReason`
 * - collect: GET the signed CDN URL (no account credential travels with it)
 *
 * Every creating call carries `folderReference`: without it Magnific files the work under
 * "Personal" and only says so in prose (the socialmedia repo lost ~730 generations that way).
 */
export const providerModule = { name: "@machinement/provider-magnific", version: "1" } as const;

const GPT_IMAGE = { name: "@hypit/gpt-image", version: "1" } as const;
const NANO_BANANA = { name: "@hypit/nano-banana", version: "1" } as const;

/** `images_generate.aspectRatio` accepts exactly these; the Models admit more (auto, 3:1, 8:1…). */
const IMAGE_RATIOS = new Set(["1:1", "21:9", "16:9", "9:16", "2:3", "3:4", "1:2", "2:1", "5:4", "4:5", "3:2", "4:3"]);
const MAX_IMAGE_REFERENCES = 12;

type Offer = { mapping: GenerationWireMapping; slug: string };

function imageMapping(capability: GenerationWireMapping["capability"], slug: string, extra: GenerationWireMapping["fields"]): Offer {
  return {
    slug,
    mapping: {
      capability, result: "image", routes: [{ model: slug }],
      fields: {
        prompt: { as: "value", field: "prompt" },
        aspectRatio: { as: "value", field: "aspectRatio" },
        resolution: { as: "value", field: "resolution" },
        images: { as: "urlArray", field: "references" },
        ...extra,
      },
    },
  };
}

export const offers = {
  "gpt-image-2": imageMapping({ module: GPT_IMAGE, name: "gpt-image-2" }, "gpt-2", {
    background: { as: "value", field: "background" },
  }),
  // Naming trap documented by Magnific itself: "Nano Banana 2" is `-flash`, and
  // `imagen-nano-banana-2` is the Pro.
  "nano-banana-2": imageMapping({ module: NANO_BANANA, name: "nano-banana-2" }, "imagen-nano-banana-2-flash", {
    outputFormat: { as: "value", field: "outputFormat" },
  }),
  "nano-banana-pro": imageMapping({ module: NANO_BANANA, name: "nano-banana-pro" }, "imagen-nano-banana-2", {
    outputFormat: { as: "value", field: "outputFormat" },
  }),
} as const satisfies Record<string, Offer>;

function object(value: unknown, subject = "Magnific object"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected ${subject}`);
  return value as Record<string, unknown>;
}
function text(value: unknown, subject = "Magnific text"): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected nonempty ${subject}`);
  return value;
}
function redact(message: string): string {
  return message.replace(/https?:\/\/\S+/giu, "[redacted-url]");
}
function https(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Magnific media URLs must be HTTPS");
  return url.href;
}
function portsOf(request: EndpointRequest) {
  return (request.constraints as unknown as GenerationRequest).ports;
}

function supportsFor(offer: Offer) {
  return (request: EndpointRequest) => {
    const ports = portsOf(request);
    const refuse = (reason: string) => ({ status: "unsupported" as const, reason });
    const ratio = String(ports.aspectRatio?.[0]);
    if (!IMAGE_RATIOS.has(ratio)) return refuse(`Magnific images_generate has no aspect ratio ${ratio}; use one of ${[...IMAGE_RATIOS].join(", ")}`);
    if ((ports.images?.length ?? 0) > MAX_IMAGE_REFERENCES) return refuse(`Magnific takes at most ${MAX_IMAGE_REFERENCES} reference images`);
    // Magnific picks the file format; it delivers PNG for these models, and collect verifies it.
    if (ports.outputFormat?.[0] === "jpg") return refuse("Magnific delivers PNG; author output-format=\"png\"");
    return mappingSupportsRequest(offer.mapping, request.constraints)
      ? { status: "supported" as const }
      : refuse("Magnific does not accept one of the requested inputs");
  };
}

/** Flat compiled fields → the MCP tool's own argument shape. */
function shapeArguments(offer: Offer, flat: Record<string, unknown>, folderReference: string) {
  const args: Record<string, unknown> = {
    prompt: flat.prompt, folderReference, mode: offer.slug, count: 1,
    aspectRatio: flat.aspectRatio, resolution: String(flat.resolution).toLowerCase(),
  };
  if (flat.background === "transparent") args.transparentBackground = true;
  const references = (flat.references as string[] | undefined) ?? [];
  if (references.length > 0) args.references = references.map((identifier) => ({ type: "image", identifier }));
  return { tool: "images_generate", args };
}

/** The CDN does not always label its files; the URL path's extension is the fallback. */
function mediaTypeOf(response: Response, url: string): string {
  const header = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (header?.startsWith("image/")) return header;
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  const byExtension: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  };
  const guessed = extension === undefined ? undefined : byExtension[extension];
  if (guessed !== undefined) return guessed;
  throw new Error(`Magnific returned a non-image result (${header ?? "no content-type"})`);
}

export function createMagnificProvider(options: {
  instance: string; pool: string; folderReference: string; call: MagnificCall;
  concurrency?: number; pollIntervalMs?: number; fetch?: typeof globalThis.fetch;
}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const folderReference = text(options.folderReference, "Magnific folderReference");
  const interval = options.pollIntervalMs ?? 5_000;
  const call = options.call;

  async function upload(bytes: Uint8Array, mediaType: string): Promise<string> {
    const target = await call("creations_request_upload", { mimeType: mediaType });
    // One PUT per target: Magnific rate-limits re-PUTs of the same URL, so a failure is final here.
    const put = await fetcher(https(text(target.proxyUploadUrl, "Magnific upload URL")), {
      method: "PUT", headers: { "content-type": mediaType },
      body: new Blob([new Uint8Array(bytes)]), signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) throw new Error(`Magnific upload PUT returned HTTP ${put.status}`);
    const created = await call("creations_finalize_upload", {
      path: text(target.path, "Magnific upload path"), visible: false, folderReference,
    });
    return text(created.identifier, "Magnific upload identifier");
  }

  function capabilityFor(offer: Offer) {
    const supports = supportsFor(offer);
    const endpoint: AsyncEndpoint = {
      async start(context) {
        const supported = supports(context.need);
        if (supported.status === "unsupported") throw new Error(supported.reason);
        const authored = context.need.constraints as unknown as GenerationRequest;
        selectWireModelForRequest(offer.mapping, authored);
        await context.reportProgress?.({ phase: `Preparing Magnific request: ${offer.slug}` });
        const compiled = await compileWireRequest(offer.mapping, authored, async (artifact) => {
          const bytes = await context.resources.get(artifact.resource);
          if (bytes === undefined) throw new Error("Reference media is unavailable");
          return upload(bytes, artifact.mediaType);
        });
        const { tool, args } = shapeArguments(offer, object(compiled.input), folderReference);
        await context.reportProgress?.({ phase: `Submitting Magnific request: ${offer.slug}` });
        const answer = await call(tool, args);
        const creation = object(answer.creation ?? (answer.creations as unknown[] | undefined)?.[0], "Magnific creation");
        const id = text(creation.identifier, "Magnific creation identifier");
        // Magnific may snap a field it cannot honor; the paid request already ran, so the change
        // is kept as evidence rather than thrown away.
        const receipt = {
          id, slug: offer.slug,
          ...(typeof creation.credits === "number" ? { credits: creation.credits } : {}),
          ...(Array.isArray(answer.adjustments) && answer.adjustments.length > 0 ? { adjustments: canonicalize(answer.adjustments as never) } : {}),
        };
        const handle = { id };
        await context.checkpoint?.({ handle, receipt });
        return { ...wakeAfter(handle, interval), receipt };
      },
      async poll(context) {
        const id = text(object(context.handle).id);
        const status = await call("creation_status", { creationIdentifier: id });
        const state = text(status.status, "Magnific status");
        if (state === "completed") {
          const url = https(text(object(status.results, "Magnific results").url, "Magnific result URL"));
          return { status: "ready", handle: { id, url } };
        }
        if (["failed", "error", "cancelled", "canceled"].includes(state)) {
          const reason = typeof status.failureReason === "string" ? `: ${redact(status.failureReason)}` : "";
          return { status: "failed", receipt: { id }, failure: { code: "MAGNIFIC_FAILED", message: `Magnific creation ${id} failed${reason}` } };
        }
        const after = typeof status.poll_after_seconds === "number" ? status.poll_after_seconds * 1000 : interval;
        return wakeAfter({ id }, Math.max(after, interval), Date.now(), { phase: state });
      },
      async collect(context) {
        const url = https(text(object(context.handle).url));
        await context.reportProgress?.({ phase: "Receiving generated image" });
        const response = await fetcher(url, { signal: AbortSignal.timeout(600_000) });
        if (!response.ok) throw new Error(`Magnific download returned HTTP ${response.status}`);
        const mediaType = mediaTypeOf(response, url);
        const artifact = await context.resources.put(new Uint8Array(await response.arrayBuffer()), mediaType);
        return { status: "completed", result: { value: {
          kind: "inline", value: canonicalize(sealGeneratedImageSet({ images: [artifact] })),
        } } };
      },
    };
    return {
      capability: offer.mapping.capability,
      returns: generationTypes.imageSet,
      lifecycle: "asynchronous" as const, supports, endpoint,
    };
  }

  return defineEndpointPackage({
    module: providerModule, facet: "media", instance: options.instance, pool: options.pool,
    // Magnific's own ceiling: 6 concurrent images per account.
    defaultConcurrency: options.concurrency ?? 4,
    actionLimits: { submit: { concurrency: 2 }, poll: { concurrency: 4 }, collect: { concurrency: 2 } },
    pricing: { kind: "page", url: "https://www.magnific.com/pricing" },
    capabilities: Object.values(offers).map(capabilityFor),
  });
}
