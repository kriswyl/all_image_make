/*
 * 首屏防闪白：在 React 和主 CSS 加载之前先把 data-theme 定好。
 *
 * 必须做成 public 下的独立文件、用 <script src> 引入，不能写成内联脚本：
 * Tauri 的 CSP 是 default-src 'self'，内联脚本会被拦掉，桌面版每次启动都会先闪一下白底。
 * main.tsx 里的 initTheme 会再做一次同样的计算，并负责监听系统主题变化。
 */
(function () {
  try {
    var mode = localStorage.getItem("yida.theme") || "system";
    var dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
    // 主 CSS 还没加载，先给画布一个底色；initTheme 会清掉这行内联样式，交还给令牌
    root.style.backgroundColor = dark ? "#0e0e0e" : "#f7f7f8";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#111111" : "#f7f7f8");
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();
