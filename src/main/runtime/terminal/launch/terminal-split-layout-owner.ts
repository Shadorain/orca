import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../../runtime-layout-apply'

type SplitLeaf = { worktreeId: string; tabId: string; leafId: string }

/**
 * A split of a pane the window draws, in a layout-owner build: main writes the new pane first
 * and the window mounts that pane. Main's copy lacking the tab, or refusing, splits as today
 * under a fresh id. A pane the window never mounted is taken back; one still binding its
 * terminal (a slow SSH start) stays.
 */
export async function splitWindowLeafThroughLayoutOwner(
  leaf: SplitLeaf,
  direction: 'horizontal' | 'vertical',
  deps: {
    apply: (command: WindowLayoutCommand) => Promise<LayoutApplyReply>
    mintLeafId: () => string
    /** Asks the window to mount the pane and waits for its terminal; the new pane's handle. */
    mount: (newLeafId: string) => Promise<string>
    /** Whether the window's graph holds the pane, bound or not. */
    isMounted: (newLeafId: string) => boolean
  }
): Promise<{ handle: string; leafId: string }> {
  const { worktreeId: workspace, tabId, leafId } = leaf
  let reply: LayoutApplyReply | null = null
  try {
    reply = await deps.apply({
      type: 'splitPane',
      workspace,
      tabId,
      leafId,
      direction
    })
  } catch (error) {
    // A thrown write is rolled back; the window splits as today.
    console.warn('[layout-owner] runtime split failed:', error)
  }
  const mainLeafId = reply?.ok ? reply.result.leafId : undefined
  const newLeafId = mainLeafId ?? deps.mintLeafId()
  try {
    return { handle: await deps.mount(newLeafId), leafId: newLeafId }
  } catch (error) {
    if (mainLeafId && !deps.isMounted(mainLeafId)) {
      await deps
        .apply({ type: 'closePane', workspace, tabId, leafId: mainLeafId, automatic: true })
        .catch((withdrawError: unknown) =>
          console.warn('[layout-owner] unmounted split not withdrawn:', withdrawError)
        )
    }
    throw error
  }
}
