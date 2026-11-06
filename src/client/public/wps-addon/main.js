/* Runs only inside the WPS add-in host. Paths come from a short-lived backend capability. */
function RenderPreview(raw) {
  var stage = "校验任务";
  var presentation = null;
  try {
    var input = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!input || !/^[0-9a-f-]{36}$/i.test(input.id) || !/^[a-f0-9]{64}$/.test(input.secret)) throw new Error("预览任务参数无效");
    var origin = input.origin || location.origin;
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin) || Number(origin.split(":").pop()) > 65535) throw new Error("预览后端地址无效");
    var request = new XMLHttpRequest();
    request.open("GET", origin + "/api/wps-preview/" + encodeURIComponent(input.id) + "/claim", false);
    request.setRequestHeader("Authorization", "Bearer " + input.secret);
    request.send();
    if (request.status !== 200) throw new Error("预览任务不可用或已过期");
    var response = JSON.parse(request.responseText);
    if (!response.ok || !response.data) throw new Error("预览任务不可用或已过期");
    var job = response.data;
    var app = window.Application;
    if (!app || !app.Presentations) throw new Error("当前 WPS 版本不支持演示文稿加载项");
    stage = "打开 PPT";
    // A unique temporary copy is opened read-only and hidden; never close the host application.
    presentation = app.Presentations.Open(job.source, -1, 0, 0);
    if (!presentation || presentation.Slides.Count !== job.total) throw new Error("WPS 打开的页数与文件不一致");
    for (var page = job.first; page <= job.last; page++) {
      stage = "导出第 " + page + " 页";
      var output = job.dir + "\\page-" + ("000" + page).slice(-3);
      presentation.Slides.Item(page).Export(output, "PNG", 1600, 900);
    }
    return { ok: true, first: job.first, last: job.last };
  } catch (error) {
    return { ok: false, stage: stage, message: error && error.message ? String(error.message).slice(0, 300) : "WPS 未能完成预览" };
  } finally {
    if (presentation) { try { presentation.Close(); } catch (_) {} }
  }
}
