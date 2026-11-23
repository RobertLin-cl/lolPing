fn main() {
    let bootstrap = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../out/desktop-pilot/bootstrap.json");
    println!("cargo:rerun-if-changed={}",bootstrap.display());
    let packaged = std::fs::read(&bootstrap).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v["packageBuild"] == true);
    println!("cargo:rustc-env=LOLPING_PACKAGE_BUILD={}",if packaged {"1"} else {"0"});
    let package = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(package).expect("package.json")).expect("package JSON");
    println!("cargo:rustc-env=LOLPING_APP_VERSION={}", value["version"].as_str().expect("app version"));
    tauri_build::build();
}
