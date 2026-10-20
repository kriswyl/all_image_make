import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
// 拉丁字母用 Inter（Codex 那套 Söhne 的免费替身）；中文字面由系统里的
// Noto Sans SC 可变字体接管，见 styles.css 里的 font-family 栈。
// 这份 CSS 带 unicode-range，浏览器只会去取真正用到的 latin 子集。
import "@fontsource-variable/inter/wght.css";
// 新手引导的标题/印章/竖排诗句用毛笔字体；只引中文简体 + 拉丁两份，避免整包 14MB
import "@fontsource/ma-shan-zheng/chinese-simplified-400.css";
import "@fontsource/ma-shan-zheng/latin-400.css";
import "./styles.css";
// 沉浸式引导单独一份：它的视觉语言和工作台完全不同，隔离在独立样式文件里
import "./onboarding.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
