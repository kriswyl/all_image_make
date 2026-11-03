document.getElementById("enable").addEventListener("click", function () {
  var message = document.getElementById("message");
  message.textContent = "正在请求 WPS 启用加载项…";
  if (!window.WpsAddonMgr) { message.textContent = "WPS 接口未加载，请检查应用安装。"; return; }
  window.WpsAddonMgr.enable({ name: "ChatCanvasPreview", addonType: "wpp", online: "true", url: new URL("./", location.href).href }, function (result) {
    message.textContent = result.status === 0 ? "加载项启用请求已完成，请返回 ChatCanvas 开始预览。" : "启用失败：" + (result.message || result.msg || "请确认 WPS 已安装并允许启动。");
  });
});
