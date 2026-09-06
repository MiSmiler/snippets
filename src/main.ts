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
  historyKeymap,
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
import { markdown } from "@codemirror/lang-markdown";
import { insertNewlineContinueMarkupCommand } from "./markdown-enter";
import { insertLineAboveCommand } from "./insert-line";
import { GFM } from "@lezer/markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { joinToEvent } from "./undo-history";
import { wordNavCommands } from "./word-nav";
import { taskCheckboxExtension } from "./task-checkbox";
import { codeFontExtension } from "./code-font";
import { dividerExtension, selectBlockOrAllCommand } from "./divider";
import {
  DATA_MD,
  freeUntitledName,
  isMarkdownName,
  planStartup,
  stripMarkdownExt,
  type StartupPlan,
} from "./note-utils";
import { dropSlot, dropSlotIsNoOp, moveItem, type TabBounds } from "./tab-order";

const SAVE_DEBOUNCE_MS = 500;
const SESSION_DEBOUNCE_MS = 300;
const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 32;

type ThemeChoice = "light" | "dark" | "system";

interface NormalizedSettings {
  font_size: number;
  theme: ThemeChoice;
  open_files: string[] | null;
  active_file: string | null;
}

type SaveStatus = { status: "saved"; name: string } | { status: "file_missing" };

/** One open note: its own CodeMirror state (doc, selection, undo history). */
interface Tab {
  /** File name on disk, e.g. "note.md" (also the reserved name of a new note). */
  name: string;
  /** Display label without the ".md" extension. */
  label: string;
  /** The file exists on disk (loaded, or materialized on first content). */
  onDisk: boolean;
  /** The file was deleted externally; saving is refused (red tab). */
  missing: boolean;
  /** Content of the last successful save (used to detect unsaved changes). */
  lastSaved: string;
  state: EditorState;
  scrollTop: number;
  saveTimer: number | undefined;
  saving: boolean;
  pending: boolean;
}

const toast = document.getElementById("toast")!;

function showToast(message: string): void {
  toast.textContent = message;
  toast.hidden = false;
}

function hideToast(): void {
  toast.hidden = true;
}

function errMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

// Avoid a flash of the wrong theme: assume system preference until settings load.
document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches
  ? "dark"
  : "light";

const appWindow = getCurrentWindow();
const IS_MAC = /mac/i.test(navigator.platform);
const MOD_LABEL = IS_MAC ? "Cmd" : "Ctrl";
// Vite dev server port (see vite.config.ts); release builds load from the
// Tauri asset protocol instead.
const IS_DEV = window.location.port === "1420";
const BASE_TITLE = IS_DEV ? "daytasks - dev" : "daytasks";

function normalizeSettings(raw: unknown): NormalizedSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const font = obj.font_size;
  const font_size =
    typeof font === "number" && font >= MIN_FONT_SIZE && font <= MAX_FONT_SIZE
      ? Math.round(font)
      : DEFAULT_FONT_SIZE;
  const theme =
    obj.theme === "light" || obj.theme === "dark" || obj.theme === "system"
      ? (obj.theme as ThemeChoice)
      : "system";
  let open_files: string[] | null = null;
  if (Array.isArray(obj.open_files)) {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const n of obj.open_files) {
      if (typeof n === "string" && isMarkdownName(n) && !seen.has(n)) {
        seen.add(n);
        names.push(n);
      }
    }
    open_files = names;
  }
  const active = obj.active_file;
  const active_file = typeof active === "string" && isMarkdownName(active) ? active : null;
  return { font_size, theme, open_files, active_file };
}

async function loadSettings(): Promise<NormalizedSettings> {
  try {
    return normalizeSettings(await invoke("load_settings"));
  } catch (error) {
    showToast(`Cannot read settings: ${errMessage(error)}`);
    return normalizeSettings(null);
  }
}

async function listFiles(): Promise<string[]> {
  try {
    return await invoke<string[]>("list_files");
  } catch (error) {
    showToast(`Cannot list notes: ${errMessage(error)}`);
    return [];
  }
}

async function main(): Promise<void> {
  const [settings, diskFiles] = await Promise.all([loadSettings(), listFiles()]);

  let fontSize = settings.font_size;
  let theme = settings.theme;
  const darkMode = window.matchMedia("(prefers-color-scheme: dark)");

  const darkTheme = new Compartment();
  const fontTheme = new Compartment();

  function effectiveTheme(): "light" | "dark" {
    if (theme === "system") return darkMode.matches ? "dark" : "light";
    return theme;
  }

  function applyDocumentTheme(): void {
    document.documentElement.dataset.theme = effectiveTheme();
  }

  /** Update the theme/font compartments in every tab state. */
  function refreshStates(): void {
    if (tabs.length === 0) return;
    for (const tab of tabs) {
      tab.state = tab.state.update({ effects: currentVisualEffects() }).state;
    }
    if (activeIndex >= 0) view.setState(tabs[activeIndex].state);
  }

  function currentVisualEffects() {
    return [
      darkTheme.reconfigure(effectiveTheme() === "dark" ? oneDark : []),
      fontTheme.reconfigure(EditorView.theme({ "&": { fontSize: `${fontSize}px` } })),
    ];
  }

  function setTheme(next: ThemeChoice): void {
    if (next === theme) return;
    theme = next;
    applyDocumentTheme();
    refreshStates();
    persistSoon();
  }

  function setFontSize(next: number): void {
    fontSize = next;
    applyFontSizeLabel();
    refreshStates();
    persistSoon();
  }

  function adjustFontSize(delta: number): void {
    const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fontSize + delta));
    if (next !== fontSize) setFontSize(next);
  }

  function resetFontSize(): void {
    setFontSize(DEFAULT_FONT_SIZE);
  }

  // Word navigation (Ctrl+Arrow on Windows/Linux, Option+Arrow on macOS, +Shift
  // selection, +Backspace/Delete deletion) jumps between Chinese words instead
  // of skipping a whole CJK run. `mac:` swaps the modifier like CodeMirror's
  // own group-movement bindings, so macOS keeps its native Option+Arrow combo
  // and Cmd+Arrow stays line-boundary movement (defaultKeymap).
  const wordNav = wordNavCommands();

  function makeState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history({ joinToEvent }),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        // addKeymap: false: markdown() would otherwise register its own
        // Prec.high keymap (Enter -> unconfigured insertNewlineContinueMarkup,
        // Backspace -> deleteMarkupBackward) before the keymap below. At
        // equal precedence the earlier registration wins, which would shadow
        // our configured Enter binding entirely. Take over the Enter binding
        // explicitly instead; Backspace is left to deleteCharBackward so it
        // deletes one character at a time.
        markdown({ extensions: [GFM], addKeymap: false }),
        indentUnit.of("  "),
        EditorView.lineWrapping,
        taskCheckboxExtension(),
        codeFontExtension(),
        dividerExtension(),
        // High-precedence keymap: Tab indents the whole line (no tab
        // character inserted), Alt+arrows move lines, and the Enter binding
        // falls back to defaultKeymap's insertNewline when not inside a
        // list/quote. Shift+Mod+Enter inserts a blank line above (the "blank
        // line below" counterpart, Mod+Enter, ships in defaultKeymap as
        // insertBlankLine).
        Prec.high(
          keymap.of([
            indentWithTab,
            { key: "Alt-ArrowUp", run: moveLineUp },
            { key: "Alt-ArrowDown", run: moveLineDown },
            { key: "Enter", run: insertNewlineContinueMarkupCommand() },
            {
              key: "Shift-Mod-Enter",
              run: insertLineAboveCommand(),
            },
            {
              key: "Mod-ArrowLeft",
              mac: "Alt-ArrowLeft",
              run: wordNav.cursorLeft,
              shift: wordNav.selectLeft,
            },
            {
              key: "Mod-ArrowRight",
              mac: "Alt-ArrowRight",
              run: wordNav.cursorRight,
              shift: wordNav.selectRight,
            },
            { key: "Mod-Backspace", mac: "Alt-Backspace", run: wordNav.deleteBackward },
            { key: "Mod-Delete", mac: "Alt-Delete", run: wordNav.deleteForward },
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
            // Ctrl+A selects the block the caret is in (`---` divider rows
            // split the document into blocks); a second press -- or any
            // state where the whole block is already selected -- selects
            // everything. Overrides defaultKeymap's selectAll.
            {
              key: "Mod-a",
              run: selectBlockOrAllCommand(),
            },
          ]),
        ),
        // defaultKeymap's Mod-a is shadowed by the block-selection command
        // registered above (higher precedence).
        keymap.of(defaultKeymap),
        // defaultKeymap does not include undo bindings, so without this
        // Mod-z falls through to the WebView's native undo. Registering
        // historyKeymap handles undo/redo directly in the CodeMirror keymap.
        keymap.of(historyKeymap),
        darkTheme.of(effectiveTheme() === "dark" ? oneDark : []),
        EditorView.updateListener.of((update) => {
          const tab = tabs[activeIndex];
          if (!tab) return;
          // Keep the per-tab state pointer live: every edit produces a new
          // EditorState in the view, and tab.state must follow it (doc,
          // selection, undo history) or switching tabs would restore a stale
          // snapshot -- wiping unsaved content. Transactions that touch a
          // dormant state (theme/font reconfigure) don't pass through here.
          if (tab.state !== update.state) tab.state = update.state;
          if (update.docChanged) scheduleSave(tab);
        }),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { lineHeight: "1.65" },
          // Prose (Chinese + English) renders in the proportional font stack;
          // markdown code regions are switched to --font-code by code-font.ts.
          ".cm-content": { fontFamily: "var(--font-prose)", padding: "14px 0" },
          "&.cm-focused": { outline: "none" },
        }),
        fontTheme.of(EditorView.theme({ "&": { fontSize: `${fontSize}px` } })),
      ],
    });
  }

  // Placeholder state; replaced by real tab states as tabs open.
  const view = new EditorView({
    parent: document.getElementById("editor")!,
    state: makeState(""),
  });

  // ---- State -----------------------------------------------------------

  let tabs: Tab[] = [];
  let activeIndex = -1; // -1 when no tab is open (empty page)

  function activeTab(): Tab | undefined {
    return activeIndex >= 0 ? tabs[activeIndex] : undefined;
  }

  function isDirty(tab: Tab): boolean {
    return tab.state.doc.toString() !== tab.lastSaved;
  }

  function createTab(name: string, content: string, onDisk: boolean): Tab {
    return {
      name,
      label: stripMarkdownExt(name),
      onDisk,
      missing: false,
      lastSaved: content,
      state: makeState(content),
      scrollTop: 0,
      saveTimer: undefined,
      saving: false,
      pending: false,
    };
  }

  // ---- Chrome (tab bar, empty page, window title) ----------------------

  function fillEmptyPage(): void {
    const rows: Array<[string, string]> = [
      [`${MOD_LABEL}+O`, "open files"],
      [`${MOD_LABEL}+N`, "create new file"],
    ];
    const fragments = rows.map(([combo, text]) => {
      const row = document.createElement("div");
      row.className = "empty-hint";
      const kbd = document.createElement("span");
      kbd.className = "kbd";
      kbd.textContent = combo;
      const label = document.createElement("span");
      label.textContent = text;
      row.append(kbd, label);
      return row;
    });
    document.getElementById("empty")!.replaceChildren(...fragments);
  }

  function renderTabBar(): void {
    const bar = document.getElementById("tabbar")!;
    bar.replaceChildren();
    for (let i = 0; i < tabs.length; i += 1) {
      const tab = tabs[i];
      const el = document.createElement("div");
      el.className = "tab";
      if (i === activeIndex) el.classList.add("active");
      if (tab.missing) el.classList.add("missing");
      el.dataset.name = tab.name;
      el.title = tab.name;

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tab.label;
      el.append(label);

      const close = document.createElement("button");
      close.className = "tab-close";
      close.title = `Close ${tab.label} (${MOD_LABEL}+W)`;
      close.textContent = "\u00d7"; // ×
      el.append(close);

      bar.append(el);
    }
  }

  function syncChrome(): void {
    const bar = document.getElementById("tabbar")!;
    const editor = document.getElementById("editor")!;
    const empty = document.getElementById("empty")!;
    const hasTabs = tabs.length > 0;
    bar.hidden = !hasTabs;
    editor.hidden = !hasTabs;
    empty.hidden = hasTabs;
  }

  function updateWindowTitle(): void {
    const tab = activeTab();
    appWindow.setTitle(tab ? `${BASE_TITLE} \u2014 ${tab.label}` : BASE_TITLE);
  }

  // ---- Persistence (settings.json: font, theme, session) --------------

  let settingsWriteChain: Promise<void> = Promise.resolve();
  let settingsTimer: number | undefined;
  let settingsErrorShown = false;

  function persistSoon(): void {
    if (settingsTimer !== undefined) clearTimeout(settingsTimer);
    settingsTimer = window.setTimeout(() => {
      settingsTimer = undefined;
      void writeSettings();
    }, SESSION_DEBOUNCE_MS);
  }

  function persistNow(): Promise<void> {
    if (settingsTimer !== undefined) {
      clearTimeout(settingsTimer);
      settingsTimer = undefined;
    }
    return writeSettings();
  }

  function writeSettings(): Promise<void> {
    const payload = {
      font_size: fontSize,
      theme,
      open_files: tabs.map((t) => t.name),
      active_file: activeIndex >= 0 ? tabs[activeIndex].name : null,
    };
    const run = settingsWriteChain
      .then(() => invoke("save_settings", { settings: payload }))
      .then(
        () => undefined,
        (error: unknown) => {
          if (!settingsErrorShown) {
            settingsErrorShown = true;
            showToast(`Failed to save settings: ${errMessage(error)}`);
          }
        },
      );
    settingsWriteChain = run;
    return run;
  }

  // ---- Save machinery (per tab) ---------------------------------------

  function markMissing(tab: Tab): void {
    if (tab.missing) return;
    tab.missing = true;
    renderTabBar();
    showToast(`"${tab.label}" was deleted on disk \u2014 changes can't be saved`);
  }

  function clearMissing(tab: Tab): void {
    if (!tab.missing) return;
    tab.missing = false;
    renderTabBar();
    hideToast();
  }

  function renameTab(tab: Tab, name: string): void {
    if (tab.name === name) return;
    tab.name = name;
    tab.label = stripMarkdownExt(name);
    renderTabBar();
    persistSoon();
  }

  /** One save attempt for `tab`; manages the saving/pending flags. */
  async function saveAttempt(tab: Tab): Promise<void> {
    if (tab.saving) {
      tab.pending = true;
      return;
    }
    const content = tab.state.doc.toString();
    if (content === tab.lastSaved) return; // nothing unsaved (covers empty new notes)
    tab.saving = true;
    try {
      const status = await invoke<SaveStatus>("save_file", {
        payload: { name: tab.name, content, create: !tab.onDisk },
      });
      if (status.status === "saved") {
        if (status.name !== tab.name) renameTab(tab, status.name);
        if (!tab.onDisk) {
          tab.onDisk = true;
          persistSoon();
        }
        tab.lastSaved = content;
        clearMissing(tab);
      } else {
        markMissing(tab);
      }
    } catch (error) {
      showToast(`Failed to save ${tab.name}: ${errMessage(error)}`);
    } finally {
      tab.saving = false;
    }
  }

  /** Flush `tab` fully: run any pending attempt and drain queued changes. */
  async function flushTab(tab: Tab): Promise<void> {
    if (tab.saveTimer !== undefined) {
      clearTimeout(tab.saveTimer);
      tab.saveTimer = undefined;
    }
    await saveAttempt(tab);
    while (tab.pending) {
      tab.pending = false;
      await saveAttempt(tab);
    }
  }

  function scheduleSave(tab: Tab): void {
    if (tab.saveTimer !== undefined) clearTimeout(tab.saveTimer);
    tab.saveTimer = window.setTimeout(() => {
      tab.saveTimer = undefined;
      void flushTab(tab);
    }, SAVE_DEBOUNCE_MS);
  }

  async function flushAllTabs(): Promise<void> {
    for (const tab of [...tabs]) await flushTab(tab);
  }

  /** Probe the disk: detect external deletion (or reappearance) early. */
  async function probeTab(tab: Tab): Promise<void> {
    if (!tab.onDisk) return;
    try {
      const exists = await invoke<boolean>("file_exists", { name: tab.name });
      if (!tabs.includes(tab)) return; // closed while probing
      if (exists) {
        if (tab.missing) {
          clearMissing(tab);
          if (isDirty(tab)) await flushTab(tab); // persist recovered content
        }
      } else {
        markMissing(tab);
      }
    } catch {
      // Probing is best-effort; a failed save will surface real errors.
    }
  }

  // ---- Tabs: lifecycle -------------------------------------------------

  function switchTo(tab: Tab): void {
    const idx = tabs.indexOf(tab);
    if (idx < 0) return;
    if (view.state === tab.state && idx === activeIndex) {
      renderTabBar();
      return;
    }
    const prev = tabs[activeIndex];
    if (prev && prev !== tab) {
      prev.scrollTop = view.scrollDOM.scrollTop;
      void flushTab(prev); // don't lose the outgoing tab's pending keystrokes
    }
    activeIndex = idx;
    view.setState(tab.state);
    renderTabBar();
    updateWindowTitle();
    syncChrome();
    persistSoon();
    void probeTab(tab);
    requestAnimationFrame(() => {
      view.focus();
      view.scrollDOM.scrollTop = tab.scrollTop;
    });
  }

  async function closeTab(tab: Tab): Promise<boolean> {
    if (tabs.indexOf(tab) < 0) return true;
    await flushTab(tab);
    if (isDirty(tab)) {
      // Content that couldn't be persisted (file deleted or save failed).
      const action = await askAboutUnsaved(tab);
      if (action === "cancel") return false;
      if (action === "recreate") {
        const ok = await recreateNote(tab);
        if (!ok) return false;
      }
    }
    removeTab(tab);
    return true;
  }

  function removeTab(tab: Tab): void {
    const idx = tabs.indexOf(tab);
    if (idx < 0) return;
    if (tab.saveTimer !== undefined) {
      clearTimeout(tab.saveTimer);
      tab.saveTimer = undefined;
    }
    const wasActive = idx === activeIndex;
    tabs.splice(idx, 1);
    if (wasActive) {
      if (tabs.length === 0) {
        activeIndex = -1;
      } else {
        const nextIndex = Math.min(idx, tabs.length - 1);
        const next = tabs[nextIndex];
        activeIndex = nextIndex;
        next.scrollTop = 0;
        view.setState(next.state);
        void probeTab(next);
        requestAnimationFrame(() => {
          view.focus();
          view.scrollDOM.scrollTop = next.scrollTop;
        });
      }
    }
    renderTabBar();
    syncChrome();
    updateWindowTitle();
    persistSoon();
  }

  async function newNote(): Promise<void> {
    const disk = await listFiles();
    const occupied = new Set<string>([...tabs.map((t) => t.name), ...disk]);
    const name = freeUntitledName(occupied);
    const tab = createTab(name, "", false);
    tabs.push(tab);
    renderTabBar();
    switchTo(tab);
    persistSoon();
  }

  /** Replace the active tab when it's an untouched new note; else add one. */
  function slotForOpen(): Tab {
    const cur = activeTab();
    if (cur && !cur.onDisk && !isDirty(cur) && cur.state.doc.length === 0) {
      const index = tabs.indexOf(cur);
      const tab = createTab("", "", false); // fields set by caller
      tabs[index] = tab;
      return tab;
    }
    const tab = createTab("", "", false);
    tabs.push(tab);
    return tab;
  }

  async function openNote(name: string): Promise<void> {
    let content: string;
    try {
      content = await invoke<string>("load_file", { name });
    } catch (error) {
      showToast(`Cannot open ${name}: ${errMessage(error)}`);
      return;
    }
    const existing = tabs.find((t) => t.name === name);
    if (existing) {
      switchTo(existing);
      return;
    }
    const tab = slotForOpen();
    tab.name = name;
    tab.label = stripMarkdownExt(name);
    tab.onDisk = true;
    tab.missing = false;
    tab.lastSaved = content;
    tab.state = makeState(content);
    tab.scrollTop = 0;
    renderTabBar();
    switchTo(tab);
    persistSoon();
  }

  async function recreateNote(tab: Tab): Promise<boolean> {
    const content = tab.state.doc.toString();
    try {
      const status = await invoke<SaveStatus>("save_file", {
        payload: { name: tab.name, content, create: true },
      });
      if (status.status === "saved") {
        if (status.name !== tab.name) renameTab(tab, status.name);
        tab.onDisk = true;
        tab.lastSaved = content;
        clearMissing(tab);
        return true;
      }
      return false;
    } catch (error) {
      showToast(`Failed to save ${tab.name}: ${errMessage(error)}`);
      return false;
    }
  }

  // ---- Command palette (Ctrl+O) ---------------------------------------

  const paletteEl = document.getElementById("palette")!;
  const paletteInput = document.getElementById("palette-input") as HTMLInputElement;
  const paletteList = document.getElementById("palette-list")!;
  let paletteOpen = false;
  let paletteNames: string[] = [];
  let paletteHighlight = 0;

  function closePalette(): void {
    if (!paletteOpen) return;
    paletteOpen = false;
    paletteEl.hidden = true;
    paletteList.replaceChildren();
    paletteInput.value = "";
    if (tabs.length > 0) view.focus();
  }

  function paletteChoose(name: string): void {
    closePalette();
    const open = tabs.find((t) => t.name === name);
    if (open) {
      switchTo(open);
    } else {
      void openNote(name);
    }
  }

  function renderPaletteList(): void {
    paletteList.replaceChildren();
    const query = paletteInput.value.trim().toLowerCase();
    const matches = paletteNames.filter((n) => n.toLowerCase().includes(query));
    paletteHighlight = Math.min(paletteHighlight, Math.max(matches.length - 1, 0));
    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent =
        paletteNames.length === 0
          ? `No notes yet \u2014 press ${MOD_LABEL}+N to create one`
          : "No matching notes";
      paletteList.append(empty);
      return;
    }
    matches.forEach((name, i) => {
      const row = document.createElement("div");
      row.className = "palette-row";
      if (i === paletteHighlight) row.classList.add("highlighted");
      if (tabs.some((t) => t.name === name)) row.classList.add("open");
      const dot = document.createElement("span");
      dot.className = "palette-dot";
      const label = document.createElement("span");
      label.className = "palette-label";
      label.textContent = stripMarkdownExt(name);
      row.append(dot, label);
      row.addEventListener("mousemove", () => {
        paletteHighlight = i;
        renderPaletteList();
      });
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", () => paletteChoose(name));
      paletteList.append(row);
    });
    const highlighted = paletteList.querySelector(".palette-row.highlighted");
    highlighted?.scrollIntoView({ block: "nearest" });
  }

  function filteredPaletteNames(): string[] {
    const query = paletteInput.value.trim().toLowerCase();
    return paletteNames.filter((n) => n.toLowerCase().includes(query));
  }

  async function openPalette(): Promise<void> {
    if (paletteOpen) return;
    const names = await listFiles();
    paletteNames = names;
    paletteHighlight = 0;
    paletteOpen = true;
    paletteEl.hidden = false;
    paletteInput.value = "";
    renderPaletteList();
    paletteInput.focus();
  }

  // ---- Unsaved-changes dialog ------------------------------------------

  const confirmEl = document.getElementById("confirm")!;
  const confirmMessage = document.getElementById("confirm-message")!;
  const confirmActions = document.getElementById("confirm-actions")!;
  let confirmResolve: ((action: "recreate" | "discard" | "cancel") => void) | null = null;

  function dismissConfirm(action: "recreate" | "discard" | "cancel"): void {
    const resolve = confirmResolve;
    confirmResolve = null;
    confirmEl.hidden = true;
    confirmActions.replaceChildren();
    confirmMessage.textContent = "";
    if (resolve) {
      resolve(action);
      if (tabs.length > 0) requestAnimationFrame(() => view.focus());
    }
  }

  function askAboutUnsaved(tab: Tab): Promise<"recreate" | "discard" | "cancel"> {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      confirmMessage.textContent = tab.missing
        ? `"${tab.label}" was deleted on disk. Your latest changes can't be saved to the file \u2014 keep them by recreating it, or close and discard them.`
        : `Changes to "${tab.label}" couldn't be saved. Close and discard them?`;

      confirmActions.replaceChildren();
      const addButton = (
        label: string,
        action: "recreate" | "discard" | "cancel",
        danger = false,
      ): void => {
        const button = document.createElement("button");
        button.textContent = label;
        if (danger) button.classList.add("danger");
        button.addEventListener("click", () => dismissConfirm(action));
        confirmActions.append(button);
      };
      if (tab.missing) addButton("Recreate file and save", "recreate");
      addButton("Close and discard", "discard", true);
      addButton("Cancel", "cancel");
      confirmEl.hidden = false;
      const cancelButton = confirmActions.lastElementChild as HTMLButtonElement;
      cancelButton.focus();
    });
  }

  // ---- Tab context menu & rename (right-click a tab) -------------------

  const tabbarEl = document.getElementById("tabbar")!;
  const tabMenuEl = document.getElementById("tabmenu")!;
  const tabMenuRename = document.getElementById("tabmenu-rename") as HTMLButtonElement;
  const renameEl = document.getElementById("rename")!;
  const renameInput = document.getElementById("rename-input") as HTMLInputElement;
  const renameError = document.getElementById("rename-error")!;

  let tabMenuOpen = false;
  let tabMenuTarget: Tab | null = null;
  let renameOpen = false;
  let renameTarget: Tab | null = null;

  function closeTabMenu(): void {
    if (!tabMenuOpen) return;
    tabMenuOpen = false;
    tabMenuEl.hidden = true;
    // Return focus to the editor, unless a rename dialog is about to take it.
    requestAnimationFrame(() => {
      if (!renameOpen && tabs.length > 0) view.focus();
    });
  }

  function openTabMenu(tab: Tab, x: number, y: number): void {
    tabMenuTarget = tab;
    tabMenuRename.disabled = tab.missing;
    tabMenuRename.title = tab.missing
      ? "File was deleted on disk"
      : `Rename "${tab.label}"`;
    tabMenuEl.hidden = false;
    tabMenuOpen = true;
    const rect = tabMenuEl.getBoundingClientRect();
    tabMenuEl.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    tabMenuEl.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - 4))}px`;
    tabMenuRename.focus();
  }

  function openRenameDialog(tab: Tab): void {
    closeTabMenu();
    renameTarget = tab;
    renameInput.value = tab.label;
    renameError.hidden = true;
    renameError.textContent = "";
    renameEl.hidden = false;
    renameOpen = true;
    renameInput.focus();
    renameInput.select();
  }

  function closeRenameDialog(): void {
    if (!renameOpen) return;
    renameOpen = false;
    renameEl.hidden = true;
    renameTarget = null;
    if (tabs.length > 0) requestAnimationFrame(() => view.focus());
  }

  function renameStemError(stem: string): string | null {
    if (!stem) return "Name can't be empty";
    if (/[\\/:*?"<>|]/.test(stem)) return `Name can't contain \\ / : * ? " < > |`;
    if (stem.startsWith(".") || stem.endsWith(".") || stem.endsWith(" ")) {
      return "Name is not allowed";
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) return "Name is reserved on Windows";
    return null;
  }

  async function submitRename(): Promise<void> {
    const tab = renameTarget;
    if (!tab) return;
    const stem = renameInput.value.trim();
    const problem = renameStemError(stem);
    if (problem) {
      renameError.textContent = problem;
      renameError.hidden = false;
      return;
    }
    const newName = `${stem}.md`;
    if (newName.toLowerCase() === tab.name.toLowerCase()) {
      closeRenameDialog();
      return;
    }
    if (tabs.some((t) => t !== tab && t.name.toLowerCase() === newName.toLowerCase())) {
      renameError.textContent = `A note named "${stem}" is already open`;
      renameError.hidden = false;
      return;
    }
    const disk = await listFiles();
    if (disk.some((n) => n.toLowerCase() === newName.toLowerCase())) {
      renameError.textContent = `"${stem}.md" already exists on disk`;
      renameError.hidden = false;
      return;
    }

    // Persist anything typed first, so an on-disk rename moves the newest content.
    await flushTab(tab);
    if (!tab.onDisk) {
      // Never written to disk yet: just adopt the new reserved name.
      renameTab(tab, newName);
      updateWindowTitle();
      closeRenameDialog();
      return;
    }
    try {
      const exists = await invoke<boolean>("file_exists", { name: tab.name });
      if (!exists) {
        markMissing(tab);
        renameError.textContent = `"${tab.label}" was deleted on disk`;
        renameError.hidden = false;
        return;
      }
    } catch {
      // Fall through: the rename call will surface real errors.
    }
    try {
      await invoke("rename_file", { payload: { old_name: tab.name, new_name: newName } });
    } catch (error) {
      renameError.textContent = errMessage(error);
      renameError.hidden = false;
      return;
    }
    renameTab(tab, newName);
    updateWindowTitle();
    closeRenameDialog();
  }

  tabbarEl.addEventListener("contextmenu", (event) => {
    const el = (event.target as Element).closest(".tab");
    if (!el) return;
    event.preventDefault();
    const name = (el as HTMLElement).dataset.name;
    const tab = name ? tabs.find((t) => t.name === name) : undefined;
    if (tab) openTabMenu(tab, event.clientX, event.clientY);
  });

  tabMenuRename.addEventListener("click", () => {
    const target = tabMenuTarget;
    closeTabMenu();
    if (target) openRenameDialog(target);
  });

  renameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitRename();
    }
  });
  document.getElementById("rename-ok")!.addEventListener("click", () => void submitRename());
  document.getElementById("rename-cancel")!.addEventListener("click", closeRenameDialog);
  renameEl.addEventListener("click", (event) => {
    if (event.target === renameEl) closeRenameDialog();
  });

  // ---- Global keyboard shortcuts ---------------------------------------

  document.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.defaultPrevented) return; // e.g. CodeMirror already handled it
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === "Escape") {
      if (confirmResolve) {
        event.preventDefault();
        dismissConfirm("cancel");
      } else if (paletteOpen) {
        event.preventDefault();
        closePalette();
      } else if (renameOpen) {
        event.preventDefault();
        closeRenameDialog();
      } else if (tabMenuOpen) {
        event.preventDefault();
        closeTabMenu();
      } else if (!settingsEl.hidden) {
        closeSettings();
      }
      return;
    }
    if (confirmResolve || paletteOpen || renameOpen || tabMenuOpen) return; // dialogs own their keys
    if (!mod) return;
    const key = event.key.toLowerCase();
    // Ctrl+, is bound inside the editor keymap when the editor is focused;
    // handle it here as well so settings stay reachable from the empty page.
    if (key === ",") {
      event.preventDefault();
      toggleSettings();
      return;
    }
    if (key === "o") {
      event.preventDefault();
      void openPalette();
      return;
    }
    if (key === "n") {
      event.preventDefault();
      void newNote();
      return;
    }
    if (key === "w") {
      event.preventDefault();
      const tab = activeTab();
      if (tab) void closeTab(tab);
      return;
    }
    if (tabs.length === 0) return;
    if (key >= "1" && key <= "8") {
      event.preventDefault();
      const index = Number(key) - 1;
      if (index < tabs.length) switchTo(tabs[index]);
      return;
    }
    if (key === "9") {
      event.preventDefault();
      switchTo(tabs[tabs.length - 1]);
      return;
    }
    if (key === "tab") {
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      const next = (activeIndex + direction + tabs.length) % tabs.length;
      switchTo(tabs[next]);
    }
  });

  paletteInput.addEventListener("input", () => {
    paletteHighlight = 0;
    renderPaletteList();
  });

  paletteInput.addEventListener("keydown", (event) => {
    const matches = filteredPaletteNames();
    if (event.key === "ArrowDown" && matches.length > 0) {
      event.preventDefault();
      paletteHighlight = Math.min(paletteHighlight + 1, matches.length - 1);
      renderPaletteList();
    } else if (event.key === "ArrowUp" && matches.length > 0) {
      event.preventDefault();
      paletteHighlight = Math.max(paletteHighlight - 1, 0);
      renderPaletteList();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const name = matches[paletteHighlight];
      if (name) paletteChoose(name);
    }
    // Escape is handled by the global keydown listener.
  });

  // Tab bar: click to switch, × to close. A click right after a real drag is
  // suppressed below, so a drop never also switches tabs.
  let suppressNextClick = false;
  document.getElementById("tabbar")!.addEventListener("click", (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const el = (event.target as Element).closest(".tab");
    if (!el) return;
    const name = (el as HTMLElement).dataset.name;
    const tab = name ? tabs.find((t) => t.name === name) : undefined;
    if (!tab) return;
    if ((event.target as Element).closest(".tab-close")) {
      void closeTab(tab);
    } else {
      switchTo(tab);
    }
  });

  // ---- Drag to reorder tabs (pointer events, ghost + slot caret) --------
  //
  // A press on a tab starts a drag once the pointer moves past a threshold;
  // below it the release is an ordinary click (handled above). While dragging,
  // the source tab stays in place (dimmed), a cloned ghost follows the cursor,
  // and a caret marks the target slot between tabs. Only a release inside the
  // bar commits; anything else (outside the bar, pointercancel) leaves the
  // order untouched. The active tab never changes during or after a drag.

  const DRAG_THRESHOLD_PX = 4;
  let dragPointerId: number | null = null;
  let dragSourceEl: HTMLElement | null = null;
  let dragIndex = -1;
  let dragDownX = 0;
  let dragDownY = 0;
  let dragActive = false;
  let dragGhost: HTMLElement | null = null;

  const caretEl = document.createElement("div");
  caretEl.className = "tab-caret";
  caretEl.hidden = true;

  /** Current tab geometry in viewport coordinates, in display order. */
  function tabBounds(): TabBounds[] {
    const bounds: TabBounds[] = [];
    for (const el of tabbarEl.querySelectorAll<HTMLElement>(".tab")) {
      const rect = el.getBoundingClientRect();
      bounds.push({ left: rect.left, right: rect.right });
    }
    return bounds;
  }

  function showDragVisuals(el: HTMLElement, x: number, y: number): void {
    dragActive = true;
    tabbarEl.classList.add("dragging");
    el.classList.add("dragging");
    const rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.remove("dragging");
    ghost.classList.add("tab-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    // Keep the cursor at the same spot inside the ghost as it was on the tab.
    ghost.dataset.ox = String(x - rect.left);
    ghost.dataset.oy = String(y - rect.top);
    document.body.append(ghost);
    dragGhost = ghost;
    tabbarEl.append(caretEl);
    caretEl.hidden = false;
    moveDragGhost(x, y);
  }

  function moveDragGhost(x: number, y: number): void {
    const ghost = dragGhost;
    if (!ghost) return;
    const ox = Number(ghost.dataset.ox ?? 0);
    const oy = Number(ghost.dataset.oy ?? 0);
    const baseX = parseFloat(ghost.style.left);
    const baseY = parseFloat(ghost.style.top);
    ghost.style.transform = `translate(${x - ox - baseX}px, ${y - oy - baseY}px)`;

    const bounds = tabBounds();
    const slot = dropSlot(bounds, x);
    const barRect = tabbarEl.getBoundingClientRect();
    let caretX: number;
    if (bounds.length === 0) {
      caretX = 0;
    } else if (slot < bounds.length) {
      caretX = bounds[slot].left - barRect.left;
    } else {
      caretX = bounds[bounds.length - 1].right - barRect.left;
    }
    caretEl.style.left = `${Math.min(Math.max(caretX, 0), barRect.width)}px`;
  }

  function clearDragVisuals(): void {
    if (dragGhost) {
      dragGhost.remove();
      dragGhost = null;
    }
    caretEl.hidden = true;
    caretEl.remove();
    tabbarEl.classList.remove("dragging");
    for (const el of tabbarEl.querySelectorAll<HTMLElement>(".tab.dragging")) {
      el.classList.remove("dragging");
    }
  }

  /** Commit the drag: reorder tabs so the dragged one lands at `slot`. */
  function commitDrag(from: number, slot: number): void {
    const prevActive = activeIndex >= 0 ? tabs[activeIndex] : undefined;
    tabs = moveItem(tabs, from, slot);
    activeIndex = prevActive !== undefined ? tabs.indexOf(prevActive) : -1;
    renderTabBar();
    persistSoon();
  }

  tabbarEl.addEventListener("pointerdown", (event) => {
    suppressNextClick = false; // a stale drag-click may never have fired
    if (dragPointerId !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // The × button owns its own gesture (close), never starts a drag.
    if ((event.target as Element).closest(".tab-close")) return;
    const el = (event.target as Element).closest<HTMLElement>(".tab");
    if (!el) return;
    const name = el.dataset.name;
    const idx = name ? tabs.findIndex((t) => t.name === name) : -1;
    if (idx < 0) return;
    dragPointerId = event.pointerId;
    dragSourceEl = el;
    dragIndex = idx;
    dragDownX = event.clientX;
    dragDownY = event.clientY;
    dragActive = false;
    // Deliberately no pointer capture here: capturing on press would retarget
    // the eventual click event to #tabbar, breaking click-to-switch. Capture is
    // taken only once the drag actually starts (see pointermove below).
  });

  tabbarEl.addEventListener("pointermove", (event) => {
    if (event.pointerId !== dragPointerId) return;
    if (!dragActive) {
      const dx = event.clientX - dragDownX;
      const dy = event.clientY - dragDownY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      const el = dragSourceEl;
      // A re-render (e.g. autosave renamed a file) may have detached the
      // pressed tab between down and the threshold: give up this gesture.
      if (!el || !el.isConnected) {
        dragPointerId = null;
        dragSourceEl = null;
        dragIndex = -1;
        dragActive = false;
        return;
      }
      // From here on the pointer may leave the bar, so keep receiving moves
      // and the release with capture.
      tabbarEl.setPointerCapture(event.pointerId);
      showDragVisuals(el, dragDownX, dragDownY);
    }
    moveDragGhost(event.clientX, event.clientY);
  });

  tabbarEl.addEventListener("pointerup", (event) => {
    if (event.pointerId !== dragPointerId) return;
    const wasActive = dragActive;
    const x = event.clientX;
    const from = dragIndex;
    dragPointerId = null;
    dragSourceEl = null;
    dragIndex = -1;
    dragActive = false;
    if (!wasActive) return; // plain press-release: the click listener handles it
    suppressNextClick = true; // a drop must not also switch tabs
    clearDragVisuals();
    const barRect = tabbarEl.getBoundingClientRect();
    const insideBar = x >= barRect.left && x <= barRect.right;
    if (insideBar && from >= 0) {
      const slot = dropSlot(tabBounds(), x);
      if (!dropSlotIsNoOp(from, slot)) commitDrag(from, slot);
    }
    if (tabs.length > 0) requestAnimationFrame(() => view.focus());
  });

  tabbarEl.addEventListener("pointercancel", (event) => {
    if (event.pointerId !== dragPointerId) return;
    dragPointerId = null;
    dragSourceEl = null;
    dragIndex = -1;
    dragActive = false;
    clearDragVisuals();
    if (tabs.length > 0) requestAnimationFrame(() => view.focus());
  });

  confirmEl.addEventListener("click", (event) => {
    if (event.target === confirmEl) dismissConfirm("cancel");
  });

  // ---- Settings popover ------------------------------------------------

  const settingsEl = document.getElementById("settings")!;
  const fontSizeLabel = document.getElementById("font-size-value")!;

  function applyFontSizeLabel(): void {
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
    if (paletteOpen && !paletteEl.contains(event.target as Node)) closePalette();
    if (tabMenuOpen && !tabMenuEl.contains(event.target as Node)) closeTabMenu();
  });

  // React to system theme changes, but only when the user hasn't overridden it.
  darkMode.addEventListener("change", () => {
    if (theme === "system") {
      applyDocumentTheme();
      refreshStates();
    }
  });

  // Save immediately when the window is hidden (e.g. minimized), and probe
  // the disk again for externally deleted files when it comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      void flushAllTabs();
    } else {
      for (const tab of [...tabs]) void probeTab(tab);
    }
  });

  // Flush pending changes before the window closes, then really close it.
  appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    for (const tab of [...tabs]) {
      await flushTab(tab);
      if (isDirty(tab)) {
        const action = await askAboutUnsaved(tab);
        if (action === "cancel") return; // stay open
        if (action === "recreate") {
          const ok = await recreateNote(tab);
          if (!ok) return;
        }
      }
    }
    await persistNow();
    await appWindow.destroy();
  });

  // ---- Startup ---------------------------------------------------------

  fillEmptyPage();
  applyDocumentTheme();
  applyFontSizeLabel();

  async function presentStartup(plan: StartupPlan): Promise<void> {
    const opened: Tab[] = [];
    if (plan.kind === "open") {
      for (const name of plan.names) {
        try {
          const content = await invoke<string>("load_file", { name });
          const tab = createTab(name, content, true);
          tabs.push(tab);
          opened.push(tab);
        } catch (error) {
          showToast(`Cannot open ${name}: ${errMessage(error)}`);
        }
      }
    } else if (plan.kind === "create-data") {
      try {
        const status = await invoke<SaveStatus>("save_file", {
          payload: { name: DATA_MD, content: "", create: true },
        });
        if (status.status === "saved") {
          const tab = createTab(status.name, "", true);
          tabs.push(tab);
          opened.push(tab);
        }
      } catch (error) {
        showToast(`Cannot create ${DATA_MD}: ${errMessage(error)}`);
      }
    }

    if (opened.length > 0) {
      const desired = plan.kind === "open" ? plan.active : 0;
      const index = Math.min(desired, opened.length - 1);
      activeIndex = tabs.indexOf(opened[index]);
      view.setState(tabs[activeIndex].state);
      renderTabBar();
      syncChrome();
      updateWindowTitle();
      void probeTab(tabs[activeIndex]);
      requestAnimationFrame(() => {
        view.focus();
        view.scrollDOM.scrollTop = 0;
      });
    } else {
      activeIndex = -1;
      renderTabBar();
      syncChrome();
      updateWindowTitle();
    }
  }

  await presentStartup(planStartup(settings.open_files, settings.active_file, diskFiles));
}

void main();
