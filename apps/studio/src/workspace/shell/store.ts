import { create } from 'zustand';

const FOCUS_KEY = 'heopress.studio.editorFocus';

function readFocus(): boolean {
  try {
    // Writing in focus is the default; "0" is a person's choice to see the panels.
    return window.localStorage.getItem(FOCUS_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Narrow-screen drawer (< 900px, ADR-0019 §1), and the article editor's focus mode (ADR-0020). */
interface ShellState {
  drawerOpen: boolean;
  openDrawer(): void;
  closeDrawer(): void;
  /** The person's choice: write with the navigation, outline and inspector hidden. Remembered in this browser. */
  editorFocus: boolean;
  setEditorFocus(on: boolean): void;
  /** An article editor is open: only then does focus mode hide the navigation. */
  editorOpen: boolean;
  setEditorOpen(open: boolean): void;
}

export const useShell = create<ShellState>((set) => ({
  drawerOpen: false,
  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  editorFocus: readFocus(),
  setEditorFocus: (on) => {
    try {
      window.localStorage.setItem(FOCUS_KEY, on ? '1' : '0');
    } catch {
      // Private windows: the choice lasts for this page only.
    }
    set({ editorFocus: on });
  },
  editorOpen: false,
  setEditorOpen: (open) => set({ editorOpen: open }),
}));
