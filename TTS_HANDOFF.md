# Gemini TTS 接入说明

> 结论来自 2026-10-23 对 `https://api.tiantoken.com` 的真实调用，不照抄文档。
> 参考手册：桌面 `claudecodeuse/api-cs/tts-test/verify3/Gemini-TTS使用手册.md`。

## 端点

```
POST /v1beta/models/{model}:generateContent
Authorization: Bearer <key>
Content-Type: application/json
```

- 适配器：`gemini-tts`
- 渠道预设：`tiantoken-gemini-tts`（词元流墟-语音）
- 模型：`gemini-3.8-flash-tts`、`gemini-3.8-flash-lite-tts`、`gemini-3.1-flash-tts-preview`
- **Key 必须在有 TTS 模型的分组里**：拿 `kling专属` 的 Key 调 TTS 会返回
  `No available channel for model ... under group kling专属`。这是账号分组问题，不是代码问题。

## 请求体

单人：

```json
{
  "contents": [{
    "role": "user",
    "parts": [{
      "text": "你好，欢迎收听今天的节目。",
      "annotations": [{ "type": "speech_metadata", "style": "亲切、像聊天" }]
    }]
  }],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": {
      "languageCode": "zh-CN",
      "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Kore" } }
    }
  }
}
```

双人：

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "你听说了吗？", "annotations": [{ "type": "speech_metadata", "speaker": "A", "style": "自然" }] },
      { "text": "听说什么？", "annotations": [{ "type": "speech_metadata", "speaker": "B", "style": "自然" }] }
    ]
  }],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": {
      "multiSpeakerVoiceConfig": {
        "speakerVoiceConfigs": [
          { "speaker": "A", "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Kore" } } },
          { "speaker": "B", "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Puck" } } }
        ]
      }
    }
  }
}
```

## 实测坑

1. **双人对话不能把整段 `A：… B：…` 塞进一个 part。**
   3.8 系列会 400：`Multi-speaker generation requests must specify speech_metadata.speaker for each text part`。
   必须按说话人切成多个 part，每段 `annotations` 里带 `speaker`。3.1 preview 接受单 part，但统一切段更稳。
2. **3.1 preview 即使非流式也返回 `audio/l16; rate=24000; channels=1`**，是裸 PCM，不是 WAV。
   服务端会补 44 字节 WAV 头再落盘，否则浏览器播放不了。实测按小端 PCM 处理正确
   （同一段音频按小端解释的相邻样本差约 577，按大端解释约 16025）。
3. **不要传 `maxOutputTokens`**，会截断音频。
4. `speed`、`candidateCount`、`systemInstruction` 都不支持；不要发。
5. 风格必须放 `annotations`，不要写进正文，否则有被念出来的风险。
6. 只支持 30 个预置音色，没有克隆、没有自定义音色、没有 SSML；输出固定 24kHz / 16bit / mono。
7. 长文本建议按 50–200 字分段，当前工作台一次提交一段；分段合成留到下一阶段。

## 代码落点

- 请求构造：[`src/server/adapters.ts`](src/server/adapters.ts) 的 `gemini-tts` 分支
- 响应解析：[`extractAudioCandidates`](src/server/adapters.ts) + `pcmToWav`
- 落盘/时长：[`src/server/tasks.ts`](src/server/tasks.ts) 的 `saveAudios` / `wavDurationSeconds`
- 音色与风格常量：[`src/shared/tts.ts`](src/shared/tts.ts)
- 工作台：[`src/client/SpeechGenerateView.tsx`](src/client/SpeechGenerateView.tsx)
- 对话工具：[`generate_speech`](src/server/agent-tools.ts)，系统提示词在 [`agent-prompt.ts`](src/server/agent-prompt.ts)
- 测试：`tests/tts.test.ts`、`tests/tts-e2e.test.ts`

## 真实联调记录

- `gemini-3.8-flash-tts` 单人：HTTP 200，`audio/wav`，124,828 字节
- `gemini-3.8-flash-lite-tts` 单人：HTTP 200，`audio/wav`，134,756 字节
- `gemini-3.1-flash-tts-preview` 单人：HTTP 200，`audio/l16; rate=24000; channels=1`，149,760 字节
- `gemini-3.1-flash-tts-preview` 双人单 part：HTTP 200，`audio/l16`，153,600 字节
- 3.8 双人：按 part 带 `speaker` 后 HTTP 200
- 应用全链路（临时数据目录，真实 Key）：`gemini-3.8-flash-lite-tts` 2.4 秒 WAV，122,908 字节，`succeeded`，时长和标题都正确落库
