#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  run_app();
}

use std::{net::TcpStream, sync::Mutex, thread, time::Duration};
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

const BACKEND_PORT: u16 = 17892;

struct BackendState(Mutex<Option<CommandChild>>);

fn start_backend(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  let resource_dir = app.path().resource_dir()?;
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
    .ok_or_else(|| format!("backend script not found below {}", resource_dir.display()))?;
  let data_dir = app.path().app_data_dir()?.join("data");
  std::fs::create_dir_all(&data_dir)?;

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
  let (mut events, child) = app
    .shell()
    .sidecar("node")?
    .args([script_arg])
    .env("PORT", BACKEND_PORT.to_string())
    .env("DATA_DIR", data_arg)
    .current_dir(resource_dir)
    .spawn()?;

  app.state::<BackendState>().0.lock().unwrap().replace(child);
  tauri::async_runtime::spawn(async move {
    while let Some(event) = events.recv().await {
      match event {
        CommandEvent::Stdout(output) => {
          log::info!("backend: {}", String::from_utf8_lossy(&output).trim());
        }
        CommandEvent::Stderr(output) => {
          log::error!("backend: {}", String::from_utf8_lossy(&output).trim());
        }
        CommandEvent::Error(message) => log::error!("backend sidecar: {message}"),
        CommandEvent::Terminated(payload) => {
          log::warn!("backend sidecar terminated with code {:?}", payload.code);
        }
        _ => {}
      }
    }
  });

  for _ in 0..100 {
    if TcpStream::connect(("127.0.0.1", BACKEND_PORT)).is_ok() { return Ok(()); }
    thread::sleep(Duration::from_millis(100));
  }
  Err(format!("backend did not start on port {BACKEND_PORT}").into())
}

fn stop_backend(app: &tauri::AppHandle) {
  if let Some(child) = app.state::<BackendState>().0.lock().unwrap().take() {
    let _ = child.kill();
  }
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
        start_backend(app)?;
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if matches!(event, RunEvent::Exit) { stop_backend(app); }
    });
}
