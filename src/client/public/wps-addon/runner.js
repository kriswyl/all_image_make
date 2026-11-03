window.addEventListener("message", function (event) {
  if (event.source !== window.parent || [location.origin, "http://tauri.localhost", "tauri://localhost", "http://127.0.0.1:5173"].indexOf(event.origin) < 0) return;
  var data = event.data;
  if (!data || data.channel !== "chatcanvas-wps-preview" || data.action !== "render" || !/^[0-9a-f-]{36}$/i.test(data.id) || !/^[a-f0-9]{64}$/.test(data.secret) || !/^[0-9a-f-]{36}$/i.test(data.requestId)) return;
  function done(result) { event.source.postMessage({ channel: "chatcanvas-wps-preview", requestId: data.requestId, result: result }, event.origin); }
  try {
    if (!window.WpsClient || !window.WpsInvoke) { done({ status: 1, message: "WPS 接口未加载" }); return; }
    var client = new window.WpsClient(window.WpsInvoke.ClientType.wpp);
    client.InvokeAsHttp("ChatCanvasPreview", "RenderPreview", JSON.stringify({ id: data.id, secret: data.secret }), done, false, 120000);
  } catch (error) { done({ status: 1, message: error && error.message ? error.message : "无法调用 WPS" }); }
});
