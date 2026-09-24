fn main() {
    println!("cargo:rustc-check-cfg=cfg(scribe_microsoft_store)");
    println!("cargo:rerun-if-env-changed=SCRIBE_CHANNEL");
    if std::env::var("SCRIBE_CHANNEL").as_deref() == Ok("microsoft-store") {
        println!("cargo:rustc-cfg=scribe_microsoft_store");
    }
    println!("cargo:rerun-if-changed=Info.plist");
    tauri_build::build()
}
