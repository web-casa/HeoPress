import { create } from 'zustand';

/** Narrow-screen drawer (< 900px, ADR-0019 §1). */
interface ShellState {
  drawerOpen: boolean;
  openDrawer(): void;
  closeDrawer(): void;
}

export const useShell = create<ShellState>((set) => ({
  drawerOpen: false,
  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
}));
