import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  indentWithTab,
  moveLineDown,
  moveLineUp,
} from "@codemirror/commands";
import {
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { insertNewlineContinueMarkup, markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { wordNavCommands } from "./word-nav";

const SAVE_DEBOUNCE_MS = 500;
const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 32;

interface Settings {
  font_size: number;
  theme: ThemeChoice;
}

type ThemeChoice = "light" | "dark" | "system";

const toast = document.getElementById("toast")!;

function showToast(message: string): void {
  toast.textContent = message;
  toast.hidden = false;
}

function hideToast(): void {
  toast.hidden = true;
}

async function loadInitialContent(): Promise<string> {
  try {
    return await invoke<string>("load_file");
  } catch (error) {
    showToast(`Cannot open data.md: ${String(error)}`);
    return "";
  }
}

// Avoid a flash of the wrong theme: assume system preference until settings load.
document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches
  ? "dark"
  : "light";

async function loadSettings(): Promise<Settings> {
  try {
    const settings = await invoke<Settings>("load_settings");
    const size = settings.font_size;
    if (typeof size !== "number" || size < MIN_FONT_SIZE || size > MAX_FONT_SIZE) {
      settings.font_size = DEFAULT_FONT_SIZE;
    }
    if (settings.theme !== "light" && settings.theme !== "dark" && settings.theme !== "system") {
      settings.theme = "system";
    }
    return settings;
  } catch (error) {
    showToast(`Cannot read settings: ${String(error)}`);
    return { font_size: DEFAULT_FONT_SIZE, theme: "system" };
  }
}

async function main(): Promise<void> {
  const [initialContent, settings] = await Promise.all([
    loadInitialContent(),
    loadSettings(),
  ]);

  const darkTheme = new Compartment();
  const fontTheme = new Compartment();
  const darkMode = window.matchMedia("(prefers-color-scheme: dark)");

  let fontSize = settings.font_size;
  let theme = settings.theme;
  let lastSaved = initialContent;
  let saveTimer: number | undefined;
  let saving = false;
  let pending = false;

  function effectiveTheme(): "light" | "dark" {
    if (theme === "system") return darkMode.matches ? "dark" : "light";
    return theme;
  }

  function applyTheme(): void {
    const effective = effectiveTheme();
    document.documentElement.dataset.theme = effective;
    view.dispatch({
      effects: darkTheme.reconfigure(effective === "dark" ? oneDark : []),
    });
  }

  function setTheme(next: ThemeChoice): void {
    if (next === theme) return;
    theme = next;
    applyTheme();
    void saveSettings();
  }

  function applyFontSize(): void {
    view.dispatch({
      effects: fontTheme.reconfigure(
        EditorView.theme({ "&": { fontSize: `${fontSize}px` } }),
      ),
    });
  }

  function setFontSize(next: number): void {
    fontSize = next;
    applyFontSize();
    updateFontSizeLabel();
    void saveSettings();
  }

  function adjustFontSize(delta: number): void {
    const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fontSize + delta));
    if (next !== fontSize) setFontSize(next);
  }

  function resetFontSize(): void {
    setFontSize(DEFAULT_FONT_SIZE);
  }

  async function saveSettings(): Promise<void> {
    try {
      await invoke("save_settings", { settings: { font_size: fontSize, theme } });
    } catch (error) {
      showToast(`Failed to save settings: ${String(error)}`);
    }
  }

  // Ctrl+ArrowLeft/Right (+Shift selection, +Backspace/Delete deletion) jump
  // between Chinese words instead of skipping a whole CJK run.
  const wordNav = wordNavCommands();

  const view = new EditorView({
    parent: document.getElementById("editor")!,
    state: EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ extensions: [GFM] }),
        indentUnit.of("  "),
        EditorView.lineWrapping,
        // High-precedence keymap: Tab indents the whole line (no tab character
        // inserted), Alt+arrows move lines, and the Enter binding falls back to
        // defaultKeymap's insertNewline when not inside a list/quote.
        Prec.high(
          keymap.of([
            indentWithTab,
            { key: "Alt-ArrowUp", run: moveLineUp },
            { key: "Alt-ArrowDown", run: moveLineDown },
            { key: "Enter", run: insertNewlineContinueMarkup },
            {
              key: "Mod-ArrowLeft",
              run: wordNav.cursorLeft,
              shift: wordNav.selectLeft,
            },
            {
              key: "Mod-ArrowRight",
              run: wordNav.cursorRight,
              shift: wordNav.selectRight,
            },
            { key: "Mod-Backspace", run: wordNav.deleteBackward },
            { key: "Mod-Delete", run: wordNav.deleteForward },
            {
              key: "Mod-,",
              run: () => {
                toggleSettings();
                return true;
              },
            },
            {
              key: "Mod-=",
              run: () => {
                adjustFontSize(1);
                return true;
              },
            },
            {
              key: "Mod-+",
              run: () => {
                adjustFontSize(1);
                return true;
              },
            },
            {
              key: "Mod--",
              run: () => {
                adjustFontSize(-1);
                return true;
              },
            },
            {
              key: "Mod-0",
              run: () => {
                resetFontSize();
                return true;
              },
            },
          ]),
        ),
        keymap.of(defaultKeymap),
        darkTheme.of(effectiveTheme() === "dark" ? oneDark : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) scheduleSave();
        }),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": {
            fontFamily: "'Consolas', 'Microsoft YaHei', monospace",
            lineHeight: "1.65",
          },
          ".cm-content": { padding: "14px 0" },
          "&.cm-focused": { outline: "none" },
        }),
        fontTheme.of(EditorView.theme({ "&": { fontSize: `${fontSize}px` } })),
      ],
    }),
  });

  // Sync the saved theme (the early data-theme guess only knew the system value).
  applyTheme();

  function scheduleSave(): void {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
  }

  async function flushSave(): Promise<void> {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    const content = view.state.doc.toString();
    if (saving) {
      pending = true;
      return;
    }
    if (content === lastSaved) return;
    saving = true;
    try {
      await invoke("save_file", { content });
      lastSaved = content;
      hideToast();
    } catch (error) {
      showToast(`Failed to save data.md: ${String(error)}`);
    } finally {
      saving = false;
      if (pending) {
        pending = false;
        scheduleSave();
      }
    }
  }

  // Flush every queued change, even if a save is currently in flight.
  async function saveNow(): Promise<void> {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    await flushSave();
    while (pending) {
      pending = false;
      await flushSave();
    }
  }

  // React to system theme changes, but only when the user hasn't overridden it.
  darkMode.addEventListener("change", () => {
    if (theme === "system") applyTheme();
  });

  // Save immediately when the window is hidden (e.g. minimized).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void flushSave();
  });

  // Font size settings popover.
  const settingsEl = document.getElementById("settings")!;
  const fontSizeLabel = document.getElementById("font-size-value")!;

  function updateFontSizeLabel(): void {
    fontSizeLabel.textContent = String(fontSize);
  }

  function toggleSettings(): void {
    settingsEl.hidden = !settingsEl.hidden;
  }

  function closeSettings(): void {
    settingsEl.hidden = true;
  }

  document.getElementById("font-minus")!.addEventListener("click", () => adjustFontSize(-1));
  document.getElementById("font-plus")!.addEventListener("click", () => adjustFontSize(1));
  document.getElementById("font-reset")!.addEventListener("click", resetFontSize);
  const themeSelect = document.getElementById("theme-select") as HTMLSelectElement;
  themeSelect.value = theme;
  themeSelect.addEventListener("change", () => {
    setTheme(themeSelect.value as ThemeChoice);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!settingsEl.hidden && !settingsEl.contains(event.target as Node)) closeSettings();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !settingsEl.hidden) closeSettings();
  });
  updateFontSizeLabel();

  // Flush pending changes before the window closes, then really close it.
  const appWindow = getCurrentWindow();
  appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    await saveNow();
    await appWindow.destroy();
  });
}

void main();
