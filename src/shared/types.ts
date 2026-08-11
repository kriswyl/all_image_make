export type AdapterType =
  | "openai-images"
  | "openai-chat-image"
  | "gemini-content"
  | "midjourney-task"
  | "generic-json";

export type AuthType = "bearer" | "x-api-key" | "query" | "custom-header" | "none";

export type TaskStatus =
  | "queued"
  | "validating"
  | "submitting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface Channel {
  id: string;
  name: string;
  baseUrl: string;
  adapterType: AdapterType;
  authType: AuthType;
  authHeaderName: string;
  secretEnv: string;
  endpoint: string;
  statusEndpoint: string;
  models: string[];
  allowPrivateNetwork: boolean;
  enabled: boolean;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelInput extends Omit<Channel, "id" | "hasKey" | "createdAt" | "updatedAt"> {
  apiKey?: string;
}

export interface ReferenceImageInput {
  base64: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  fileName: string;
}

export interface GenerationInput {
  channelId: string;
  model: string;
  prompt: string;
  referenceImage?: ReferenceImageInput;
  negativePrompt?: string;
  size?: string;
  aspectRatio?: string;
  count?: number;
  quality?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  background?: "auto" | "opaque" | "transparent";
  outputCompression?: number;
  moderation?: "auto" | "low";
  style?: "auto" | "vivid" | "natural";
  responseFormat?: "auto" | "url" | "b64_json";
  stream?: boolean;
  partialImages?: number;
  user?: string;
  imageSize?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  responseModalities?: Array<"TEXT" | "IMAGE">;
  seed?: number;
  mjVersion?: string;
  processMode?: "auto" | "fast" | "relax" | "turbo";
  stylize?: number;
  chaos?: number;
  weirdness?: number;
  rawParameters?: Record<string, unknown>;
}

export interface Asset {
  id: string;
  taskId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  url: string;
  createdAt: string;
}

export interface Task {
  id: string;
  channelId: string;
  channelName: string;
  model: string;
  prompt: string;
  status: TaskStatus;
  progress: number | null;
  remoteTaskId: string | null;
  effectiveParameters: Record<string, unknown> | null;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  assets: Asset[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Diagnostic {
  id: string;
  taskId: string;
  request: Record<string, unknown> | null;
  response: unknown;
  httpStatus: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface BootstrapData {
  channels: Channel[];
  tasks: Task[];
  service: {
    version: string;
    dataPath: string;
  };
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
