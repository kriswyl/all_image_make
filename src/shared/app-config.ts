import type { ChannelInput } from "./types.js";

export const APP_VERSION = "1.0.0";
export const VECTORENGINE_KEY_ENV = "VECTORENGINE_API_KEY";
export const VECTORENGINE_KEY_PLACEHOLDER = "{向量引擎key}";

export const DEFAULT_CHANNELS: ReadonlyArray<{ id: string; input: ChannelInput }> = [
  {
    id: "cc308913-5e33-4805-ae1d-51d7b9c1049e",
    input: {
      name: "向量引擎-gpt-image-2-c",
      baseUrl: "https://api.vectorengine.cn",
      adapterType: "openai-images",
      authType: "bearer",
      authHeaderName: "",
      secretEnv: VECTORENGINE_KEY_ENV,
      endpoint: "/v1/images/generations",
      statusEndpoint: "",
      models: ["gpt-image-2-c"],
      allowPrivateNetwork: false,
      enabled: true,
    },
  },
  {
    id: "db8e304c-2f66-4261-a9f8-8935c1a0c549",
    input: {
      name: "向量引擎-香蕉生图",
      baseUrl: "https://api.vectorengine.cn",
      adapterType: "gemini-content",
      authType: "bearer",
      authHeaderName: "",
      secretEnv: VECTORENGINE_KEY_ENV,
      endpoint: "/v1beta/models/{model}:generateContent",
      statusEndpoint: "",
      models: [
        "gemini-3-pro-image-preview",
        "gemini-3-pro-image",
        "gemini-3.1-flash-image-preview",
        "gemini-3.1-flash-image",
      ],
      allowPrivateNetwork: false,
      enabled: true,
    },
  },
  {
    id: "5f456034-eaf2-4f3a-bd0d-6800328d32e8",
    input: {
      name: "向量引擎-mj",
      baseUrl: "https://api.vectorengine.cn",
      adapterType: "midjourney-task",
      authType: "bearer",
      authHeaderName: "",
      secretEnv: VECTORENGINE_KEY_ENV,
      endpoint: "/mj/submit/imagine",
      statusEndpoint: "/mj/task/{taskId}/fetch",
      models: ["mj_imagine"],
      allowPrivateNetwork: false,
      enabled: true,
    },
  },
  {
    id: "82f37650-1ba2-434c-9149-0f82ee27357b",
    input: {
      name: "向量引擎-gpt-image-2",
      baseUrl: "https://api.vectorengine.cn",
      adapterType: "openai-images",
      authType: "bearer",
      authHeaderName: "",
      secretEnv: VECTORENGINE_KEY_ENV,
      endpoint: "/v1/images/generations",
      statusEndpoint: "",
      models: ["gpt-image-2"],
      allowPrivateNetwork: false,
      enabled: true,
    },
  },
];
