// Why: native popups are the only BrowserWindows that host a web page instead of Orca's renderer,
// so window-wide routing (menu IPC, renderer targets) must be able to tell them apart.
const nativeBrowserPopupWindows = new WeakSet<object>()

export function markNativeBrowserPopupWindow(window: object): void {
  nativeBrowserPopupWindows.add(window)
}

export function isNativeBrowserPopupWindow(window: object | null | undefined): boolean {
  return window != null && nativeBrowserPopupWindows.has(window)
}
