// Pure helpers for the multi-note / tab model. Kept free of DOM and Tauri
// dependencies so they can be unit-tested with `npm test`.

export const DATA_MD = "data.md";
export const UNTITLED_BASE = "Untitled";

/** Strip a trailing ".md" extension (case-insensitive) for display. */
export function stripMarkdownExt(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/** Whether `name` is a plain top-level note file name ("*.md", not hidden). */
export function isMarkdownName(name: string): boolean {
  if (name.length < 4 || name.startsWith(".")) return false;
  return name.toLowerCase().endsWith(".md");
}

/** Name of the n-th untitled note: "Untitled.md", "Untitled-1.md", ... */
export function untitledName(counter: number): string {
  return counter === 0 ? `${UNTITLED_BASE}.md` : `${UNTITLED_BASE}-${counter}.md`;
}

/**
 * First untitled name not already in `occupied` (on-disk files plus open
 * tabs), so a fresh Ctrl+N never collides with an existing note.
 */
export function freeUntitledName(occupied: ReadonlySet<string>): string {
  let counter = 0;
  while (occupied.has(untitledName(counter))) counter += 1;
  return untitledName(counter);
}

export type StartupPlan =
  | { kind: "open"; names: string[]; active: number }
  | { kind: "create-data" }
  | { kind: "empty" };

/**
 * Decide what to present at startup.
 *
 * - A recorded session (`openFiles !== null`, possibly empty) is restored as
 *  -is: vanished files are skipped, and if none survive the app starts on the
 *   empty page. `activeFile` picks the active tab when it survived.
 * - Without a session (fresh install / upgrade from the single-file era):
 *   open `data.md` if present, create it when the folder is empty (so you can
 *   start typing immediately, as before), and otherwise start empty.
 */
export function planStartup(
  openFiles: string[] | null,
  activeFile: string | null,
  available: string[],
): StartupPlan {
  if (openFiles !== null) {
    const names = openFiles.filter((n) => available.includes(n));
    if (names.length === 0) return { kind: "empty" };
    const active = activeFile === null ? 0 : names.indexOf(activeFile);
    return { kind: "open", names, active: active >= 0 ? active : 0 };
  }
  if (available.includes(DATA_MD)) return { kind: "open", names: [DATA_MD], active: 0 };
  if (available.length === 0) return { kind: "create-data" };
  return { kind: "empty" };
}
