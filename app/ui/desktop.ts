// The window is an app, not a web page: no browser context menu (Reload, Inspect…) outside text fields, where
// right-click keeps copy and paste (shell/electron/menu.ts), and a file dropped on it never replaces the page.

document.addEventListener("contextmenu", (e) => {
  if (!(e.target as Element).closest?.("input, textarea, [contenteditable], .selectable")) e.preventDefault();
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());
