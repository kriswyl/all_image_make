fn main() {
  println!("cargo:rerun-if-env-changed=BRAND_BACKEND_PORT");
  let port = std::env::var("BRAND_BACKEND_PORT").unwrap_or_else(|_| "17892".into());
  let port = port.parse::<u16>().expect("invalid BRAND_BACKEND_PORT");
  println!("cargo:rustc-env=BRAND_BACKEND_PORT={port}");
  tauri_build::build()
}
