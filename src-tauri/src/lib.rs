#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  run_app();
}

use std::{
  net::TcpStream,
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

  let trace = Arc::new(StartupTrace::new());
  let events_trace = Arc::clone(&trace);
  let (mut events, child) = app
    .shell()
    .sidecar("node")
    .map_err(|error| format!("未找到打包的 node 可执行文件：{error}"))?
    .args([script_arg])
    .env("PORT", BACKEND_PORT.to_string())
    .env("DATA_DIR", data_arg)
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
  loop {
    if TcpStream::connect(("127.0.0.1", BACKEND_PORT)).is_ok() {
      return Ok(());
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
        "后端 {} 秒内未在端口 {BACKEND_PORT} 就绪",
        BACKEND_START_TIMEOUT_MS / 1000
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
        "后端服务启动失败，应用即将退出。\n\n原因：{error}\n\n排查建议：\n1. macOS：若正从安装镜像（DMG）直接运行，请先把应用拖入「应用程序」文件夹再打开；并在「终端」执行 xattr -cr /Applications/小勤画图.app 后重试\n2. 查看详细日志：macOS 在 ~/Library/Logs/com.imagerelay.studio/，Windows 在 %LOCALAPPDATA%\\com.imagerelay.studio\\logs\\"
      ))
      .kind(MessageDialogKind::Error)
      .title("小勤画图启动失败")
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
