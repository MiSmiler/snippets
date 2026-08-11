use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const FILE_NAME: &str = "data.md";
const SETTINGS_FILE_NAME: &str = "settings.json";
const DEFAULT_FONT_SIZE: u32 = 16;
const MIN_FONT_SIZE: u32 = 10;
const MAX_FONT_SIZE: u32 = 32;

/// Resolve the directory next to the executable: the app folder is the whole
/// data folder.
fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("cannot resolve executable path: {e}"))?;
    exe.parent()
        .map(PathBuf::from)
        .ok_or_else(|| "cannot resolve executable directory".to_string())
}

fn data_path() -> Result<PathBuf, String> {
    Ok(exe_dir()?.join(FILE_NAME))
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(exe_dir()?.join(SETTINGS_FILE_NAME))
}

#[derive(Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub font_size: u32,
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            font_size: DEFAULT_FONT_SIZE,
            theme: "system".to_string(),
        }
    }
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

#[tauri::command]
fn load_settings() -> Result<Settings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    // Tolerate malformed files (e.g. hand-edited): fall back to defaults.
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let theme = match settings.theme.as_str() {
        "light" | "dark" | "system" => settings.theme,
        _ => "system".to_string(),
    };
    let clamped = Settings {
        font_size: settings.font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE),
        theme,
    };
    let text = serde_json::to_string_pretty(&clamped).map_err(|e| e.to_string())?;
    let path = settings_path()?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
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
        .invoke_handler(tauri::generate_handler![load_file, save_file, load_settings, save_settings])
        .run(tauri::generate_context!())
        .expect("error while running daytasks");
}
