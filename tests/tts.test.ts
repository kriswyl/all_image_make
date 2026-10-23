import { describe, expect, it } from "vitest";
import { buildGenerationRequest, extractAudioCandidates } from "../src/server/adapters";
import { wavDurationSeconds } from "../src/server/tasks";
import type { DbChannel } from "../src/server/db";
import type { GenerationInput } from "../src/shared/types";

const channel: DbChannel = {
  id: "tts-channel", name: "Gemini TTS", baseUrl: "https://api.tiantoken.com",
  adapterType: "gemini-tts", authType: "bearer", authHeaderName: "", secretEnv: "",
  endpoint: "/v1beta/models/{model}:generateContent", models: ["gemini-3.8-flash-lite-tts"],
  allowPrivateNetwork: false, enabled: true, createdAt: "", updatedAt: "",
};

function request(input: Partial<GenerationInput> = {}) {
  return buildGenerationRequest(channel, {
    channelId: channel.id,
    model: "gemini-3.8-flash-lite-tts",
    prompt: "你好，欢迎收听今天的节目。",
    ...input,
  }, "secret");
}

describe("Gemini TTS 请求体", () => {
  it("走原生 generateContent，音色、风格、语种都按实测字段放", () => {
    const built = request({
      ttsVoice: "kore",
      ttsStyle: "轻声耳语，放慢语速",
      ttsLanguage: "zh-CN",
    });
    expect(built.url).toBe(
      "https://api.tiantoken.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent",
    );
    expect(built.body).toEqual({
      contents: [{
        role: "user",
        parts: [{
          text: "你好，欢迎收听今天的节目。",
          annotations: [{ type: "speech_metadata", style: "轻声耳语，放慢语速" }],
        }],
      }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: "zh-CN",
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "kore" } },
        },
      },
    });
    // 手册实测：传 maxOutputTokens 会截断音频
    expect(JSON.stringify(built.body)).not.toContain("maxOutputTokens");
  });

  it("不填音色时补 Kore，不传风格就不带 annotations", () => {
    const built = request();
    const part = (built.body as { contents: Array<{ parts: Array<Record<string, unknown>> }> })
      .contents[0]!.parts[0]!;
    expect(part).not.toHaveProperty("annotations");
    expect(built.body).toMatchObject({
      generationConfig: {
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
    });
  });

  it("双人对话按 A/B 切 part，每段都带 speaker 标注", () => {
    const built = request({
      prompt: "A：你听说了吗？\nB：听说什么？",
      ttsStyle: "自然",
      ttsSpeakers: [
        { speaker: "A", voice: "Kore" },
        { speaker: "B", voice: "Puck" },
      ],
    });
    expect(built.body).toMatchObject({
      contents: [{
        role: "user",
        parts: [
          { text: "你听说了吗？", annotations: [{ type: "speech_metadata", speaker: "A", style: "自然" }] },
          { text: "听说什么？", annotations: [{ type: "speech_metadata", speaker: "B", style: "自然" }] },
        ],
      }],
      generationConfig: {
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              { speaker: "A", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
              { speaker: "B", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
            ],
          },
        },
      },
    });
  });

  it("同一行里的「A：…。B：…」也能切开", () => {
    const built = request({
      prompt: "A：你好。B：你好呀。",
      ttsSpeakers: [
        { speaker: "A", voice: "Kore" },
        { speaker: "B", voice: "Puck" },
      ],
    });
    expect(built.body).toMatchObject({
      contents: [{ parts: [{ text: "你好。" }, { text: "你好呀。" }] }],
    });
  });

  it("说话人不是两个、或正文缺 A/B 标签时本地就拒绝", () => {
    expect(() => request({ ttsSpeakers: [{ speaker: "A", voice: "Kore" }] }))
      .toThrow(/正好提供 2 个/);
    expect(() => request({
      prompt: "整段没有说话人标签",
      ttsSpeakers: [
        { speaker: "A", voice: "Kore" },
        { speaker: "B", voice: "Puck" },
      ],
    })).toThrow(/A：.*B：/);
    expect(() => request({ referenceImages: [{ base64: "AAA", mimeType: "image/png", fileName: "a.png" }] }))
      .toThrow(/不支持参考图/);
  });
});

describe("TTS 响应解析", () => {
  it("从 candidates[].content.parts[].inlineData 里取出 base64 WAV", () => {
    const candidates = extractAudioCandidates({
      candidates: [{
        content: {
          parts: [{
            inlineData: { mimeType: "audio/wav", data: "UklGRg==" },
          }],
        },
      }],
    });
    expect(candidates).toEqual([{ url: "data:audio/wav;base64,UklGRg==", mimeType: "audio/wav" }]);
  });

  it("兼容 inline_data 写法，并忽略不是音频的 part", () => {
    const candidates = extractAudioCandidates({
      candidates: [{
        content: {
          parts: [
            { text: "not audio" },
            { inline_data: { mime_type: "audio/l16", data: "AAAA" } },
          ],
        },
      }],
    });
    expect(candidates[0]?.mimeType).toBe("audio/wav");
    expect(candidates[0]?.url.startsWith("data:audio/wav;base64,")).toBe(true);
    const wav = Buffer.from(candidates[0]!.url.split(",")[1]!, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.length).toBe(44 + 3); // 3 字节 PCM + 44 字节头
  });
});

describe("WAV 时长", () => {
  it("从 PCM 头算 data 长度 / byteRate", () => {
    const data = 48_000; // 1 秒 @ 24kHz / 16bit / mono
    const bytes = Buffer.alloc(44 + data);
    bytes.write("RIFF", 0, "ascii");
    bytes.writeUInt32LE(36 + data, 4);
    bytes.write("WAVE", 8, "ascii");
    bytes.write("fmt ", 12, "ascii");
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(24_000, 24);
    bytes.writeUInt32LE(48_000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36, "ascii");
    bytes.writeUInt32LE(data, 40);
    expect(wavDurationSeconds(bytes)).toBe(1);
  });
});
