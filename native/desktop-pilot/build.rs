fn main() {
    let package = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(package).expect("package.json")).expect("package JSON");
    println!("cargo:rustc-env=LOLPING_APP_VERSION={}", value["version"].as_str().expect("app version"));
    tauri_build::build();
}
