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

const SAVE_DEBOUNCE_MS = 500;

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

async function main(): Promise<void> {
  const initialContent = await loadInitialContent();

  const darkTheme = new Compartment();
  const darkMode = window.matchMedia("(prefers-color-scheme: dark)");

  let lastSaved = initialContent;
  let saveTimer: number | undefined;
  let saving = false;
  let pending = false;

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
          ]),
        ),
        keymap.of(defaultKeymap),
        darkTheme.of(darkMode.matches ? oneDark : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) scheduleSave();
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "15px" },
          ".cm-scroller": {
            fontFamily:
              "'Cascadia Code', Consolas, ui-monospace, 'SF Mono', Menlo, monospace",
            lineHeight: "1.65",
          },
          ".cm-content": { padding: "14px 0" },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    }),
  });

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

  function applyTheme(): void {
    view.dispatch({
      effects: darkTheme.reconfigure(darkMode.matches ? oneDark : []),
    });
  }
  darkMode.addEventListener("change", applyTheme);

  // Save immediately when the window is hidden (e.g. minimized).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void flushSave();
  });

  // Flush pending changes before the window closes, then really close it.
  const appWindow = getCurrentWindow();
  appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    await saveNow();
    await appWindow.destroy();
  });
}

void main();
