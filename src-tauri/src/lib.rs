#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  run_app();
}

use std::{
  io::{Read, Write},
  net::{SocketAddr, TcpStream},
  process::Command,
  sync::atomic::{AtomicI32, Ordering},
  sync::{Arc, Mutex},
  thread,
  time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::{
  process::{CommandChild, CommandEvent},
  ShellExt,
};

const BACKEND_PORT: u16 = 17892;
const BACKEND_START_TIMEOUT_MS: u64 = 30_000;
const SIDECAR_NOT_EXITED: i32 = i32::MIN;

/// 端口上应答的是谁
enum PortOwner {
  /// 本应用后端的 /api/health 在应答（版本号只用于日志）
  OurBackend(String),
  /// 能连上，但不是本应用的接口
  SomeoneElse,
  /// 没人应答，端口可用
  Free,
}

fn loopback() -> SocketAddr {
  SocketAddr::from(([127, 0, 0, 1], BACKEND_PORT))
}

fn port_open(timeout: Duration) -> bool {
  TcpStream::connect_timeout(&loopback(), timeout).is_ok()
}

/// 用一条裸 HTTP 请求读回环上的 /api/health 响应体。
/// 只为判断“端口上回答的是不是本应用的后端”，不值得为此引入 HTTP 客户端依赖。
fn probe_health(timeout: Duration) -> Option<String> {
  let mut stream = TcpStream::connect_timeout(&loopback(), timeout).ok()?;
  let _ = stream.set_read_timeout(Some(timeout));
  let _ = stream.set_write_timeout(Some(timeout));
  stream
    .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
    .ok()?;
  let mut raw = Vec::new();
  // 服务端会主动关闭连接；read_to_end 可能以 WouldBlock 收尾，已读到的内容依然有效
  let _ = stream.read_to_end(&mut raw);
  let text = String::from_utf8_lossy(&raw).into_owned();
  Some(match text.split_once("\r\n\r\n") {
    Some((_, body)) => body.to_string(),
    None => text,
  })
}

/// 本应用健康检查的形状：{"ok":true,"data":{"status":"ok","version":"…"}}
fn our_backend_version(body: &str) -> Option<String> {
  let (_, rest) = body.split_once("\"version\":\"")?;
  let (version, _) = rest.split_once('"')?;
  body.contains("\"status\":\"ok\"").then(|| version.to_string())
}

fn inspect_port() -> PortOwner {
  if !port_open(Duration::from_millis(300)) {
    return PortOwner::Free;
  }
  match probe_health(Duration::from_millis(1500))
    .as_deref()
    .and_then(our_backend_version)
  {
    Some(version) => PortOwner::OurBackend(version),
    None => PortOwner::SomeoneElse,
  }
}

/// 监听指定端口的进程号（解析 netstat，省掉 Windows API 绑定）
fn listener_pid(port: u16) -> Option<u32> {
  let output = Command::new("netstat").args(["-ano", "-p", "TCP"]).output().ok()?;
  let text = String::from_utf8_lossy(&output.stdout).into_owned();
  let suffix = format!(":{port}");
  for line in text.lines() {
    let columns: Vec<&str> = line.split_whitespace().collect();
    if columns.len() < 5 || !columns[0].eq_ignore_ascii_case("TCP") {
      continue;
    }
    if !columns[1].ends_with(&suffix) || !columns[3].eq_ignore_ascii_case("LISTENING") {
      continue;
    }
    if let Ok(pid) = columns[4].parse() {
      return Some(pid);
    }
  }
  None
}

/// tasklist 的 CSV 第一列就是映像名，据此确认占用端口的确实是内置 node
fn process_image_name(pid: u32) -> Option<String> {
  let output = Command::new("tasklist")
    .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
    .output()
    .ok()?;
  let text = String::from_utf8_lossy(&output.stdout).into_owned();
  let first = text.lines().map(str::trim).find(|line| !line.is_empty())?;
  first.split('"').nth(1).map(str::to_string)
}

/// 端口上挂着本应用自己的旧后端时把它结束掉。
///
/// 旧版本残留、或桌面端被强杀后留下的孤儿进程都会一直占着 17892：Windows 允许
/// 两个进程绑同一个端口，新后端看起来"启动成功"，实际请求全被旧进程接走（旧代码、
/// 旧数据、甚至文件已被删除），用户看到的是"添加渠道报错"这类说不清的故障。
fn reclaim_backend_port(version: &str) -> Result<(), String> {
  log::warn!("端口 {BACKEND_PORT} 上已有本应用的后端在运行（版本 {version}），结束它让新后端接管");
  let pid = listener_pid(BACKEND_PORT)
    .ok_or_else(|| format!("端口 {BACKEND_PORT} 被占用，但查不出占用它的进程号"))?;
  match process_image_name(pid) {
    Some(name) if name.eq_ignore_ascii_case("node.exe") => {}
    Some(name) => {
      return Err(format!(
        "端口 {BACKEND_PORT} 被进程 {pid}（{name}）占用，这不是本应用的内置后端，未自动结束"
      ))
    }
    None => {
      return Err(format!(
        "端口 {BACKEND_PORT} 被进程 {pid} 占用，无法确认它是不是本应用的内置后端"
      ))
    }
  }
  let killed = Command::new("taskkill")
    .args(["/PID", &pid.to_string(), "/F"])
    .status()
    .map(|status| status.success())
    .unwrap_or(false);
  if !killed {
    return Err(format!("结束旧后端进程 {pid} 失败，请手动结束该进程后重新打开应用"));
  }
  log::warn!("已结束旧后端进程 {pid}");
  let deadline = Instant::now() + Duration::from_secs(5);
  while Instant::now() < deadline {
    if !port_open(Duration::from_millis(200)) {
      return Ok(());
    }
    thread::sleep(Duration::from_millis(100));
  }
  Err(format!("旧后端进程 {pid} 已结束，但端口 {BACKEND_PORT} 仍未释放"))
}

struct BackendState(Mutex<Option<CommandChild>>);

/// sidecar 启动期的诊断线索：退出码与 stderr 尾部若干行，
/// 用于后端起不来时向用户说明原因而不是无声 abort。
struct StartupTrace {
  exit_code: AtomicI32,
  stderr_tail: Mutex<Vec<String>>,
}

impl StartupTrace {
  fn new() -> Self {
    Self {
      exit_code: AtomicI32::new(SIDECAR_NOT_EXITED),
      stderr_tail: Mutex::new(Vec::new()),
    }
  }

  fn record_exit(&self, code: i32) {
    self.exit_code.store(code, Ordering::SeqCst);
  }

  fn exit_code(&self) -> i32 {
    self.exit_code.load(Ordering::SeqCst)
  }

  fn record_stderr(&self, line: String) {
    let mut tail = self.stderr_tail.lock().unwrap();
    tail.push(line);
    let overflow = tail.len().saturating_sub(15);
    if overflow > 0 {
      tail.drain(0..overflow);
    }
  }

  fn stderr_text(&self) -> String {
    self.stderr_tail.lock().unwrap().join("\n")
  }
}

fn start_backend(app: &mut tauri::App) -> Result<(), String> {
  let resource_dir = app
    .path()
    .resource_dir()
    .map_err(|error| format!("无法定位资源目录：{error}"))?;
  // Tauri bundles place resources below `resource_dir()`, while a direct
  // `--no-bundle` build keeps the generated `resources` folder below it.
  let script_candidates = [
    resource_dir.join("server").join("server").join("index.js"),
    resource_dir.join("resources").join("server").join("server").join("index.js"),
  ];
  let script = script_candidates
    .iter()
    .find(|candidate| candidate.is_file())
    .cloned()
    .ok_or_else(|| format!("资源目录下未找到后端脚本：{}", resource_dir.display()))?;
  let data_dir = app
    .path()
    .app_data_dir()
    .map_err(|error| format!("无法定位数据目录：{error}"))?
    .join("data");
  std::fs::create_dir_all(&data_dir)
    .map_err(|error| format!("无法创建数据目录 {}：{error}", data_dir.display()))?;

  log::info!(
    "starting backend: script={}, data_dir={}",
    script.display(),
    data_dir.display()
  );

  // Node's Windows entrypoint resolver does not accept the extended `\\?\`
  // prefix that Tauri may return for bundled paths.
  let script_arg = script
    .to_string_lossy()
    .strip_prefix("\\\\?\\")
    .unwrap_or(&script.to_string_lossy())
    .to_string();
  let data_arg = data_dir.to_string_lossy().to_string();

  // 端口若被上个版本残留的后端占着，必须先拿回来：Windows 允许两个进程绑同一端口，
  // 新后端会"启动成功"但请求全被旧进程接走，表现成"添加渠道报错"这类说不清的故障
  match inspect_port() {
    PortOwner::Free => {}
    PortOwner::OurBackend(version) => reclaim_backend_port(&version)?,
    PortOwner::SomeoneElse => {
      return Err(format!(
        "端口 {BACKEND_PORT} 被其他程序占用，后端服务无法启动。\n请结束占用该端口的程序后重试（命令行执行 netstat -ano | findstr {BACKEND_PORT} 可以查到占用它的进程号）。"
      ))
    }
  }

  let trace = Arc::new(StartupTrace::new());
  let events_trace = Arc::clone(&trace);
  let (mut events, child) = app
    .shell()
    .sidecar("node")
    .map_err(|error| format!("未找到打包的 node 可执行文件：{error}"))?
    .args([script_arg])
    .env("PORT", BACKEND_PORT.to_string())
    .env("DATA_DIR", data_arg)
    // 让后端看守桌面端进程，桌面端被强杀时后端跟着退出，不留占着端口的孤儿
    .env("EXIT_WITH_PARENT", "1")
    .current_dir(resource_dir.clone())
    .spawn()
    .map_err(|error| format!("启动 node 进程失败：{error}"))?;

  app.state::<BackendState>().0.lock().unwrap().replace(child);
  tauri::async_runtime::spawn(async move {
    while let Some(event) = events.recv().await {
      match event {
        CommandEvent::Stdout(output) => {
          log::info!("backend: {}", String::from_utf8_lossy(&output).trim());
        }
        CommandEvent::Stderr(output) => {
          let text = String::from_utf8_lossy(&output).trim().to_string();
          if !text.is_empty() {
            log::error!("backend: {text}");
            events_trace.record_stderr(text);
          }
        }
        CommandEvent::Error(message) => {
          log::error!("backend sidecar: {message}");
          events_trace.record_stderr(message);
        }
        CommandEvent::Terminated(payload) => {
          log::warn!("backend sidecar terminated with code {:?}", payload.code);
          events_trace.record_exit(payload.code.unwrap_or(-1));
        }
        _ => {}
      }
    }
  });

  let deadline = Instant::now() + Duration::from_millis(BACKEND_START_TIMEOUT_MS);
  // 等到端口上真的是本应用的后端在应答为止。只看 TCP 连得通是不够的：
  // 别的程序占着端口一样连得通，那样界面会连到不相干的服务上
  let mut answered_by_other = false;
  loop {
    if port_open(Duration::from_millis(300)) {
      if probe_health(Duration::from_millis(1500))
        .as_deref()
        .and_then(our_backend_version)
        .is_some()
      {
        return Ok(());
      }
      answered_by_other = true;
    }
    let exit_code = trace.exit_code();
    if exit_code != SIDECAR_NOT_EXITED {
      let stderr = trace.stderr_text();
      return Err(format!(
        "后端进程提前退出（退出码 {exit_code}）{}",
        if stderr.is_empty() {
          String::new()
        } else {
          format!("\n后端输出：\n{stderr}")
        }
      ));
    }
    if Instant::now() >= deadline {
      return Err(format!(
        "后端 {} 秒内未在端口 {BACKEND_PORT} 就绪{}",
        BACKEND_START_TIMEOUT_MS / 1000,
        if answered_by_other {
          "（端口有响应，但不是本应用的后端）"
        } else {
          ""
        }
      ));
    }
    thread::sleep(Duration::from_millis(100));
  }
}

fn stop_backend(app: &tauri::AppHandle) {
  if let Some(child) = app.state::<BackendState>().0.lock().unwrap().take() {
    let _ = child.kill();
  }
}

fn report_startup_failure(app: &tauri::AppHandle, error: String) {
  log::error!("backend startup failed: {error}");
  let handle = app.clone();
  thread::spawn(move || {
    handle
      .dialog()
      .message(format!(
        "后端服务启动失败，应用即将退出。\n\n原因：{error}\n\n排查建议：\n1. macOS：若正从安装镜像（DMG）直接运行，请先把应用拖入「应用程序」文件夹再打开；并在「终端」执行 xattr -cr /Applications/益达工作台.app 后重试\n2. 查看详细日志：macOS 在 ~/Library/Logs/com.imagerelay.studio/，Windows 在 %LOCALAPPDATA%\\com.imagerelay.studio\\logs\\"
      ))
      .kind(MessageDialogKind::Error)
      .title("益达工作台启动失败")
      .blocking_show();
    handle.exit(1);
  });
}

pub fn run_app() {
  tauri::Builder::default()
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .manage(BackendState(Mutex::new(None)))
    .setup(|app| {
      if !cfg!(debug_assertions) {
        if let Err(error) = start_backend(app) {
          report_startup_failure(&app.handle(), error);
        }
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if matches!(event, RunEvent::Exit) {
        stop_backend(app);
      }
    });
}
