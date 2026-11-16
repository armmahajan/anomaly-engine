/**
 * Model interfaces for the art pipeline, plus their OpenRouter
 * implementations. The pipeline only sees the interfaces, so tests and e2e
 * use scripted fakes (fake.ts) and spend nothing.
 */

export interface ModelUsage {
  /** USD as reported by the provider (0 if unknown). */
  cost: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ImageRequest {
  prompt: string;
  /** Reference images (PNG/JPEG/WebP bytes) for image-to-image. */
  references?: Buffer[];
  aspectRatio?: string;
  /** Ask for a transparent background (models that support it). */
  transparent?: boolean;
  /** Override the model's quality setting for this image (e.g. "low", "medium"). */
  quality?: string;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  image: Buffer;
  /** "png" | "jpg" | "webp" */
  ext: "png" | "jpg" | "webp";
  usage: ModelUsage;
  model: string;
}

export interface ImageModel {
  readonly id: string;
  generate(request: ImageRequest): Promise<GeneratedImage>;
}

export type VisionContent = { type: "text"; text: string } | { type: "image"; image: Buffer; mediaType?: string };

export interface VisionRequest {
  system: string;
  /** One user turn: text and images, in order. Prior turns go in `history`. */
  content: VisionContent[];
  history?: { role: "user" | "assistant"; content: VisionContent[] | string }[];
  /** Ask for a JSON object reply. */
  json?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface VisionReply {
  text: string;
  usage: ModelUsage;
  model: string;
}

export interface VisionModel {
  readonly id: string;
  complete(request: VisionRequest): Promise<VisionReply>;
}

// --- OpenRouter -------------------------------------------------------------

const BASE = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey: string;
  /** Identifies the app in OpenRouter's dashboard. Generic on purpose. */
  title?: string;
  fetch?: typeof fetch;
}

function headers(options: OpenRouterOptions): Record<string, string> {
  return {
    authorization: `Bearer ${options.apiKey}`,
    "content-type": "application/json",
    "x-title": options.title ?? "Anomaly Studio",
  };
}

async function postJson(options: OpenRouterOptions, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await (options.fetch ?? fetch)(`${BASE}${path}`, {
    method: "POST",
    headers: headers(options),
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`OpenRouter ${path} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const error = (json as { error?: { message?: string } }).error;
  if (!res.ok || error) {
    throw new Error(`OpenRouter ${path} failed (${res.status}): ${error?.message ?? text.slice(0, 300)}`);
  }
  return json;
}

function usageOf(raw: unknown): ModelUsage {
  const u = (raw ?? {}) as { cost?: number; prompt_tokens?: number; completion_tokens?: number };
  return { cost: u.cost ?? 0, promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 };
}

function sniffMediaType(image: Buffer): string {
  if (image[0] === 0x89 && image[1] === 0x50) return "image/png";
  if (image[0] === 0xff && image[1] === 0xd8) return "image/jpeg";
  if (image.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "image/png";
}

const dataUrl = (image: Buffer, mediaType?: string) => `data:${mediaType ?? sniffMediaType(image)};base64,${image.toString("base64")}`;

export function extForMediaType(mediaType: string | undefined, image: Buffer): "png" | "jpg" | "webp" {
  const type = mediaType ?? sniffMediaType(image);
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  return "png";
}

/** OpenRouter's image API (POST /images). */
export class OpenRouterImageModel implements ImageModel {
  readonly id: string;
  private readonly options: OpenRouterOptions;
  private readonly extra: Record<string, unknown>;

  /** `extra`: request fields for this model, e.g. {quality: "low"} or {resolution: "768"}. */
  constructor(options: OpenRouterOptions, id: string, extra: Record<string, unknown> = {}) {
    this.options = options;
    this.id = id;
    this.extra = extra;
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    const body = {
      model: this.id,
      prompt: request.prompt,
      n: 1,
      aspect_ratio: request.aspectRatio ?? "1:1",
      ...this.extra,
      ...(request.transparent ? { background: "transparent", output_format: "png" } : {}),
      ...(request.quality && "quality" in this.extra ? { quality: request.quality } : {}),
      ...(request.references?.length
        ? { input_references: request.references.map((r) => ({ type: "image_url", image_url: { url: dataUrl(r) } })) }
        : {}),
    };
    const json = (await postJson(this.options, "/images", body, request.signal)) as {
      data?: { b64_json?: string; media_type?: string }[];
      usage?: unknown;
    };
    const first = json.data?.[0];
    if (!first?.b64_json) throw new Error(`image model ${this.id} returned no image`);
    const image = Buffer.from(first.b64_json, "base64");
    return { image, ext: extForMediaType(first.media_type, image), usage: usageOf(json.usage), model: this.id };
  }
}

/** OpenRouter's chat completions API with image inputs. */
export class OpenRouterVisionModel implements VisionModel {
  readonly id: string;
  private readonly options: OpenRouterOptions;
  private readonly extra: Record<string, unknown>;

  /** `extra`: request fields for this model, e.g. {reasoning: {effort: "low"}}. */
  constructor(options: OpenRouterOptions, id: string, extra: Record<string, unknown> = {}) {
    this.options = options;
    this.id = id;
    this.extra = extra;
  }

  async complete(request: VisionRequest): Promise<VisionReply> {
    const toParts = (content: VisionContent[] | string) =>
      typeof content === "string"
        ? content
        : content.map((c) =>
            c.type === "text" ? { type: "text", text: c.text } : { type: "image_url", image_url: { url: dataUrl(c.image, c.mediaType) } },
          );
    const body = {
      model: this.id,
      messages: [
        { role: "system", content: request.system },
        ...(request.history ?? []).map((m) => ({ role: m.role, content: toParts(m.content) })),
        { role: "user", content: toParts(request.content) },
      ],
      max_tokens: request.maxTokens ?? 8000,
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
      ...this.extra,
    };
    const json = (await postJson(this.options, "/chat/completions", body, request.signal)) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: unknown;
      model?: string;
    };
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (!text.trim()) throw new Error(`vision model ${this.id} returned an empty reply (finish: ${choice?.finish_reason ?? "?"})`);
    return { text, usage: usageOf(json.usage), model: json.model ?? this.id };
  }
}
