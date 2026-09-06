use std::{fs, path::Path, path::PathBuf};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use tauri::{Manager, RunEvent};

#[cfg(windows)]
mod single_instance;

mod segment;

const SETTINGS_FILE_NAME: &str = "settings.json";
const DEFAULT_FONT_SIZE: u32 = 16;
const MIN_FONT_SIZE: u32 = 10;
const MAX_FONT_SIZE: u32 = 32;
/// Whole-app zoom as a percentage (100 = 1.0), adjusted by Ctrl+=/-/0.
const DEFAULT_SCALE: u32 = 100;
const MIN_SCALE: u32 = 50;
const MAX_SCALE: u32 = 200;
/// Default word-segmentation engine for word navigation (settings.word_seg).
const DEFAULT_WORD_SEG: &str = "jieba-standard";

/// Resolve the directory next to the executable: the app folder is the whole
/// data folder.
fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("cannot resolve executable path: {e}"))?;
    exe.parent()
        .map(PathBuf::from)
        .ok_or_else(|| "cannot resolve executable directory".to_string())
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(exe_dir()?.join(SETTINGS_FILE_NAME))
}

/// Whether `name` looks like a plain, top-level markdown note file name:
/// `*.md` (case-insensitive), not hidden (no leading dot), with a non-empty
/// stem. Temporary files used by atomic saves end in `.tmp`, so they never
/// match.
fn is_md_file_name(name: &str) -> bool {
    if name.starts_with('.') {
        return false;
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) => !stem.is_empty() && ext.eq_ignore_ascii_case("md"),
        None => false,
    }
}

/// Resolve a note file name to its path, validating that it is a plain
/// top-level `*.md` name. The frontend only ever passes names it got from
/// `list_files`, but the boundary is still checked so a bad payload can't
/// reach files outside the app folder.
fn note_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.contains(['/', '\\'])
        || name.contains("..")
        || !is_md_file_name(name)
    {
        return Err(format!("invalid note file name: {name:?}"));
    }
    Ok(exe_dir()?.join(name))
}

/// Write `content` to `path` atomically: write a temp file in the same
/// directory, then rename it over the target. A crash mid-write can never
/// corrupt a note, and the rename is atomic on Windows.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("cannot save {}: {e}", path.display()))?;
    Ok(())
}

/// The `-1`, `-2`, ... variant of a note name ("Untitled.md" ->
/// "Untitled-1.md"). `name` must already be a valid `*.md` name.
fn with_note_counter(name: &str, n: usize) -> String {
    let stem = &name[..name.len() - 3]; // drop the ".md" extension
    format!("{stem}-{n}.md")
}

/// Every note file (top-level `*.md`) in the app folder, sorted
/// case-insensitively. This is the source of truth for what can be opened.
#[tauri::command]
fn list_files() -> Result<Vec<String>, String> {
    let dir = exe_dir()?;
    let mut names: Vec<String> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if is_md_file_name(&name) {
            names.push(name);
        }
    }
    names.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));
    Ok(names)
}

#[tauri::command]
fn file_exists(name: String) -> Result<bool, String> {
    let path = note_path(&name)?;
    Ok(path.is_file())
}

#[tauri::command]
fn load_file(name: String) -> Result<String, String> {
    let path = note_path(&name)?;
    if !path.is_file() {
        return Err(format!("{name} does not exist"));
    }
    let bytes = fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let text =
        String::from_utf8(bytes).map_err(|e| format!("{} is not valid UTF-8: {e}", path.display()))?;
    // Strip a UTF-8 BOM if present.
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

#[derive(Deserialize)]
pub struct SaveFileArgs {
    /// Note file name. In `create` mode this is the preferred name only: if
    /// it is already taken, the first free `name`, `name-1`, `name-2`, ...
    /// variant is used instead (see `create`).
    pub name: String,
    pub content: String,
    /// Brand-new note being materialized on first content: create the file
    /// if it does not exist yet, never overwrite a file that appeared on
    /// disk since the name was reserved. Existing notes must already be on
    /// disk -- a vanished file means it was deleted externally, and saving
    /// is refused (returned as `FileMissing`, never silently recreated).
    pub create: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SaveStatus {
    /// File written; `name` is the file that was actually used (it may
    /// differ from the requested one in `create` mode after collision
    /// handling).
    Saved { name: String },
    /// The file no longer exists on disk (and `create` was false).
    FileMissing,
}

#[tauri::command]
fn save_file(payload: SaveFileArgs) -> Result<SaveStatus, String> {
    // Validate the requested name up front (path traversal etc.).
    note_path(&payload.name)?;

    if !payload.create {
        let path = note_path(&payload.name)?;
        if !path.is_file() {
            return Ok(SaveStatus::FileMissing);
        }
        write_atomic(&path, &payload.content)?;
        return Ok(SaveStatus::Saved {
            name: payload.name,
        });
    }

    // Materialize a brand-new note. Pick the first free name variant.
    let mut counter: usize = 0;
    loop {
        let candidate = if counter == 0 {
            payload.name.clone()
        } else {
            with_note_counter(&payload.name, counter)
        };
        let path = note_path(&candidate)?;
        if !path.exists() {
            write_atomic(&path, &payload.content)?;
            return Ok(SaveStatus::Saved { name: candidate });
        }
        counter += 1;
    }
}

#[derive(Deserialize)]
pub struct RenameFileArgs {
    pub old_name: String,
    pub new_name: String,
}

/// Rename a note file on disk. Refuses to overwrite an existing file
/// (checked case-insensitively, matching the Windows filesystem). A pure
/// case-only change is treated as a no-op.
#[tauri::command]
fn rename_file(payload: RenameFileArgs) -> Result<(), String> {
    if payload.old_name.eq_ignore_ascii_case(&payload.new_name) {
        return Ok(());
    }
    let old = note_path(&payload.old_name)?;
    if !old.is_file() {
        return Err(format!("{} does not exist", payload.old_name));
    }
    let new = note_path(&payload.new_name)?;

    let dir = exe_dir()?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        // The source file itself (any casing of `old_name`) is allowed;
        // anything else already using the target name blocks the rename.
        if name != payload.old_name && name.eq_ignore_ascii_case(&payload.new_name) {
            return Err(format!("{} already exists", payload.new_name));
        }
    }

    fs::rename(&old, &new).map_err(|e| format!("cannot rename {}: {e}", payload.old_name))?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub font_size: u32,
    /// Whole-app zoom percentage (100 = 1.0); Ctrl+=/-/0 in the frontend.
    pub scale: u32,
    pub theme: String,
    /// Word-segmentation engine for word navigation: "system" (WebView's
    /// Intl.Segmenter), "jieba-standard", or "jieba-fine".
    pub word_seg: String,
    /// Last session: note file names in tab order. `None` (absent in the
    /// JSON) means no session was ever recorded -- a fresh install or an
    /// upgrade from the single-file era -- and the frontend falls back to
    /// opening `data.md`.
    pub open_files: Option<Vec<String>>,
    /// Name of the tab that was active last, if any.
    pub active_file: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            font_size: DEFAULT_FONT_SIZE,
            scale: DEFAULT_SCALE,
            theme: "system".to_string(),
            word_seg: DEFAULT_WORD_SEG.to_string(),
            open_files: None,
            active_file: None,
        }
    }
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
    let word_seg = match settings.word_seg.as_str() {
        "system" | "jieba-standard" | "jieba-fine" => settings.word_seg,
        _ => DEFAULT_WORD_SEG.to_string(),
    };
    let open_files = settings.open_files.map(|names| {
        let mut seen = std::collections::HashSet::new();
        names
            .into_iter()
            .filter(|n| is_md_file_name(n) && seen.insert(n.clone()))
            .collect()
    });
    let clamped = Settings {
        font_size: settings.font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE),
        scale: settings.scale.clamp(MIN_SCALE, MAX_SCALE),
        theme,
        word_seg,
        open_files,
        active_file: settings.active_file,
    };
    let text = serde_json::to_string_pretty(&clamped).map_err(|e| e.to_string())?;
    let path = settings_path()?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("cannot save {}: {e}", path.display()))?;
    Ok(())
}

/// Make the dev build recognizable in the taskbar / Alt-Tab. Called both in
/// setup (initial title) and on page load, because the HTML `<title>`
/// overrides the window title once the page finishes loading.
#[cfg(debug_assertions)]
fn set_dev_window_title<R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &M,
) -> tauri::Result<()> {
    if let Some(window) = manager.get_webview_window("main") {
        let product = manager.config().product_name.as_deref().unwrap_or("snippets");
        window.set_title(&format!("{product} - dev"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Load the jieba dictionary on a background thread so the first
            // word-navigation keystroke never waits on it.
            segment::warm_up();

            #[cfg(windows)]
            // A second instance of the same build profile focuses the existing
            // window instead of starting a competing writer for the notes.
            // The guard is scoped per profile (see single_instance.rs), so a
            // debug build and the release build can run side by side.
            single_instance::init(&*app, |app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
            })?;

            #[cfg(debug_assertions)]
            set_dev_window_title(app)?;

            Ok(())
        })
        .on_page_load(|_webview, _payload| {
            #[cfg(debug_assertions)]
            {
                let _ = set_dev_window_title(_webview);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_files,
            file_exists,
            load_file,
            save_file,
            rename_file,
            load_settings,
            save_settings,
            segment::segment_line
        ])
        .build(tauri::generate_context!())
        .expect("error while building snippets")
        .run(|app, event| {
            #[cfg(windows)]
            {
                if let RunEvent::Exit = event {
                    single_instance::destroy(app);
                }
            }
            #[cfg(not(windows))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md_file_names_are_recognized() {
        for name in ["data.md", "note.md", "a.md", "UPPER.MD", "x.md.md"] {
            assert!(is_md_file_name(name), "{name:?} should be accepted");
        }
    }

    #[test]
    fn non_md_file_names_are_rejected() {
        for name in ["", ".", "..", "md", "data.txt", "data.md.tmp", ".md", ".hidden.md", "note"] {
            assert!(!is_md_file_name(name), "{name:?} should be rejected");
        }
    }

    #[test]
    fn note_counter_names_keep_md_extension() {
        assert_eq!(with_note_counter("Untitled.md", 1), "Untitled-1.md");
        assert_eq!(with_note_counter("note.md", 2), "note-2.md");
    }
}
