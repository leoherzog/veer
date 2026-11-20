/**
 * Colour scheme as a `wa-light`/`wa-dark` class on `<html>`, which the inline
 * script in public/index.html sets before first paint. A toggle stores its
 * choice only when it differs from the system preference, and with nothing
 * stored the page follows the system. Every change dispatches `theme-change` on
 * `document` for consumers that cache resolved colours.
 */
const KEY = "theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");

export function isDark() {
  return document.documentElement.classList.contains("wa-dark");
}

/** The scheme to show: the stored override if any, else the system preference. */
function preferDark() {
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* storage blocked: follow the system */ }
  return stored ? stored === "wa-dark" : systemDark.matches;
}

function apply(dark) {
  if (dark === isDark()) return;
  const root = document.documentElement;
  root.classList.toggle("wa-dark", dark);
  root.classList.toggle("wa-light", !dark);
  document.dispatchEvent(new Event("theme-change"));
}

/** Switch to the opposite of the shown scheme, storing it only when it differs from the system. */
export function toggleTheme() {
  const dark = !isDark();
  try {
    if (dark === systemDark.matches) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, dark ? "wa-dark" : "wa-light");
  } catch { /* storage blocked: the switch lasts for this page only */ }
  apply(dark);
}

// A stored override is kept when the system preference later matches it, so
// both listeners re-derive the scheme rather than clearing storage.
systemDark.addEventListener("change", () => apply(preferDark()));
addEventListener("storage", (e) => { if (e.key === KEY || e.key === null) apply(preferDark()); });
