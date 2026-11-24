/**
 * The closing window's theme (FR-297, R470 c). The page reaches neither the service nor the shell,
 * so it cannot read the researcher's appearance settings: it follows the system's light or dark, as
 * the app does with its theme on "system" (the default; themes.ts `resolveTheme`, not imported here
 * so that the page carries no more than this).
 */
export function followSystemTheme(win: Window): void {
  const dark = win.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    win.document.documentElement.dataset.theme = dark.matches ? "dark" : "light";
  };
  apply();
  dark.addEventListener("change", apply);
}
