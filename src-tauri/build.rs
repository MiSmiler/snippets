fn main() {
    // Expose the build profile ("debug"/"release") as a compile-time
    // environment variable, so single_instance.rs can scope its mutex per
    // profile (debug builds and the release build must not fight over the
    // same single-instance guard).
    println!(
        "cargo:rustc-env=PROFILE={}",
        std::env::var("PROFILE").unwrap_or_default()
    );
    tauri_build::build()
}
