import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
// 拉丁字母用 Inter（Codex 那套 Söhne 的免费替身）；中文字面由系统里的
// Noto Sans SC 可变字体接管，见 styles.css 里的 font-family 栈。
// 这份 CSS 带 unicode-range，浏览器只会去取真正用到的 latin 子集。
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
