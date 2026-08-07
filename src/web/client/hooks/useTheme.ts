/**
 * Theme preference hook: light / dark / auto.
 *
 * "auto" removes the `data-theme` attribute from `<html>` so the CSS
 * `@media (prefers-color-scheme: dark)` block in `styles/theme.css` governs;
 * an explicit "light"/"dark" choice stamps `data-theme` so the
 * `:root[data-theme="..."]` override blocks win instead. The choice is
 * persisted to `localStorage` so it survives reloads.
 *
 * Backed by a module-level store (via `useSyncExternalStore`) rather than
 * local `useState`, so every `useTheme()` call anywhere in the app — not
 * just the one in `ThemeToggle` — reads the same live value and re-renders
 * when it changes. No Context provider needed for that.
 */
import { useCallback, useSyncExternalStore } from "react";

/** A user-selectable theme preference. "auto" follows the OS setting. */
export type ThemePreference = "light" | "dark" | "auto";

const STORAGE_KEY = "docs-mcp-theme";

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "auto";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "auto" ? stored : "auto";
}

function applyThemeAttribute(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
}

// Module-level state, applied immediately (before React even mounts) so
// there's no flash of the wrong theme on first paint.
let currentPreference: ThemePreference = readStoredPreference();
const listeners = new Set<() => void>();

if (typeof document !== "undefined") {
  applyThemeAttribute(currentPreference);
}

function setPreference(next: ThemePreference): void {
  currentPreference = next;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, next);
  }
  applyThemeAttribute(next);
  for (const listener of listeners) listener();
}

function subscribePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getPreferenceSnapshot(): ThemePreference {
  return currentPreference;
}

export interface UseThemeResult {
  /** The stored preference: "light", "dark", or "auto". */
  preference: ThemePreference;
  /** Cycles auto -> light -> dark -> auto, matching the topbar toggle button. */
  cycleTheme: () => void;
}

/**
 * Reads the current theme preference and cycles it, keeping `<html data-theme>`
 * and `localStorage` in sync. Auto-mode follows the OS purely via CSS (the
 * `data-theme` attribute is removed so the `@media` block governs), so no
 * system-theme listener is needed here.
 */
export function useTheme(): UseThemeResult {
  const preference = useSyncExternalStore(subscribePreference, getPreferenceSnapshot);

  const cycleTheme = useCallback(() => {
    setPreference(
      currentPreference === "auto"
        ? "light"
        : currentPreference === "light"
          ? "dark"
          : "auto",
    );
  }, []);

  return { preference, cycleTheme };
}
