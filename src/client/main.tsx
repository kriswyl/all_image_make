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
// 分镜工作台的独立样式：大浮层、设定卡、镜头表，避免继续把 styles.css 撑大
import "./storyboard.css";
// 素材库抽屉：和分镜工作台一样独立成文件，避免 styles.css 继续膨胀
import "./asset-library.css";
// 最后加载的全局打磨：字体清晰度、下拉圆角、点击反馈、模型面板排版
import "./ui-polish.css";
// 沉浸式引导单独一份：它的视觉语言和工作台完全不同，隔离在独立样式文件里
import "./onboarding.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
