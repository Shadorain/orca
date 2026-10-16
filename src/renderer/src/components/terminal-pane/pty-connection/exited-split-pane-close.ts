import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'

/**
 * A split pane whose terminal ended, in a layout-owner build: main closes it first, then the
 * window removes it. False when a paired server owns the workspace; the caller closes as today.
 */
export function closeExitedSplitPaneThroughLayoutOwner(args: {
  worktreeId: string
  tabId: string
  manager: PaneManager
  paneId: number
  /** The tab-level exit, for a pane that became the tab's last while main answered. */
  closeTab: () => void
}): boolean {
  const { manager, paneId } = args
  const leafId = manager.getLeafId(paneId)
  if (!leafId) {
    return false
  }
  const close = (): void => {
    // Why the leaf check: main's answer can land after the pane already went.
    if (manager.getLeafId(paneId) !== leafId) {
      return
    }
    // A sibling went while main answered: this pane is now the tab's last.
    if (manager.getPanes().length <= 1) {
      args.closeTab()
      return
    }
    manager.closePane(paneId)
  }
  return sendLayoutCommandToOwner(
    args.worktreeId,
    { type: 'closePane', tabId: args.tabId, leafId, automatic: true },
    {
      apply: close,
      asToday: close,
      // Main holds this pane alone while the window has more: its copy lags, so close as today.
      refused: (code) => code === 'last_pane' && close()
    }
  )
}
