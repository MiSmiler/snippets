use std::{fs, path::PathBuf};

use tauri::Manager;

const FILE_NAME: &str = "data.md";

/// data.md lives next to the executable: the app folder is the whole data folder.
fn data_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("cannot resolve executable path: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "cannot resolve executable directory".to_string())?;
    Ok(dir.join(FILE_NAME))
}

#[tauri::command]
fn load_file() -> Result<String, String> {
    let path = data_path()?;
    if !path.exists() {
        fs::write(&path, "").map_err(|e| format!("cannot create {}: {e}", path.display()))?;
        return Ok(String::new());
    }
    if !path.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    let bytes = fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let text =
        String::from_utf8(bytes).map_err(|e| format!("{} is not valid UTF-8: {e}", path.display()))?;
    // Strip a UTF-8 BOM if present.
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

#[tauri::command]
fn save_file(content: String) -> Result<(), String> {
    let path = data_path()?;
    // Write to a temp file then rename: prevents a crash mid-write from
    // corrupting data.md (rename on the same directory is atomic on Windows).
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("cannot save {}: {e}", path.display()))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second instance focuses the existing window instead of starting
            // a competing writer for data.md.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![load_file, save_file])
        .run(tauri::generate_context!())
        .expect("error while running daytasks");
}
