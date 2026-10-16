import type { TerminalSplitOptions } from './terminal-split-surface'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from '../../session-tabs/explicit-terminal-close-stops'
import type { TerminalPaneSplitSource } from '../../../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { WindowLayoutCommand } from '../../runtime-layout-apply'
import { splitWindowLeafThroughLayoutOwner } from './terminal-split-layout-owner'
import type { Worktree } from '../../../../shared/worktree/types'

export abstract class OrcaRuntimeWithSplitTerminal extends OrcaRuntimeWithStopExplicitlyClosedTabPtys {
  protected abstract splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts?: TerminalSplitOptions,
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit>

  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>

  protected abstract waitForLeafInTab(
    tabId: string,
    leafId: string,
    timeoutMs?: number
  ): Promise<string>

  async splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty) {
      return await this.splitPtyBackedTerminal(livePty.pty, opts, createdWorktree)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    const direction = opts.direction ?? 'horizontal'
    // Switch point: main writes the split first; the window then mounts main's pane.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const split = await splitWindowLeafThroughLayoutOwner(leaf, direction, {
        apply: (command) => this.applyLayoutCommand(command),
        mintLeafId: randomUUID,
        mount: (newLeafId) => {
          this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
            direction,
            command: opts.command,
            worktreeId: leaf.worktreeId,
            sourceLeafId: leaf.leafId,
            telemetrySource: opts.telemetrySource,
            newLeafId
          })
          return this.waitForLeafInTab(leaf.tabId, newLeafId)
        },
        isMounted: (newLeafId) => this.leaves.has(this.getLeafKey(leaf.tabId, newLeafId))
      })
      return {
        handle: split.handle,
        tabId: leaf.tabId,
        paneRuntimeId: leaf.paneRuntimeId,
        leafId: split.leafId
      }
    }

    const newLeafId = randomUUID()

    this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command,
      worktreeId: leaf.worktreeId,
      sourceLeafId: leaf.leafId,
      telemetrySource: opts.telemetrySource,
      newLeafId
    })

    const newHandle = await this.waitForLeafInTab(leaf.tabId, newLeafId)
    return {
      handle: newHandle,
      tabId: leaf.tabId,
      paneRuntimeId: leaf.paneRuntimeId,
      leafId: newLeafId
    }
  }
}
