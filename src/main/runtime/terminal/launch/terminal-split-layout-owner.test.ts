import { describe, expect, it, vi } from 'vitest'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../../runtime-layout-apply'
import { splitWindowLeafThroughLayoutOwner } from './terminal-split-layout-owner'

const LEAF = { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' }

function deps(
  reply: LayoutApplyReply | Error,
  mount: (leafId: string) => Promise<string>,
  mounted = false
) {
  return {
    apply: vi.fn(async (_command: WindowLayoutCommand): Promise<LayoutApplyReply> => {
      if (reply instanceof Error) {
        throw reply
      }
      return reply
    }),
    mintLeafId: () => 'minted-leaf',
    mount: vi.fn(mount),
    isMounted: () => mounted
  }
}

describe('splitWindowLeafThroughLayoutOwner', () => {
  it('writes the split in main first, then has the window mount main’s pane', async () => {
    const d = deps({ ok: true, result: { leafId: 'main-leaf' } }, async () => 'term_new')

    const split = await splitWindowLeafThroughLayoutOwner(LEAF, 'vertical', d)

    expect(d.apply).toHaveBeenCalledWith({
      type: 'splitPane',
      workspace: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      direction: 'vertical'
    })
    expect(d.mount).toHaveBeenCalledWith('main-leaf')
    expect(split).toEqual({ handle: 'term_new', leafId: 'main-leaf' })
  })

  it.each([
    ['refuses', { ok: false, code: 'tab_not_found' } as const],
    ['throws', new Error('layout_store_unavailable')]
  ])('splits as today under a fresh id when main %s', async (_name, reply) => {
    const d = deps(reply, async () => 'term_new')

    const split = await splitWindowLeafThroughLayoutOwner(LEAF, 'horizontal', d)

    expect(d.mount).toHaveBeenCalledWith('minted-leaf')
    expect(split.leafId).toBe('minted-leaf')
    expect(d.apply).toHaveBeenCalledOnce()
  })

  it('takes main’s pane back when the window never mounts it', async () => {
    const d = deps({ ok: true, result: { leafId: 'main-leaf' } }, async () => {
      throw new Error('timeout')
    })

    await expect(splitWindowLeafThroughLayoutOwner(LEAF, 'vertical', d)).rejects.toThrow('timeout')

    expect(d.apply).toHaveBeenLastCalledWith({
      type: 'closePane',
      workspace: 'wt-1',
      tabId: 'tab-1',
      leafId: 'main-leaf',
      automatic: true
    })
  })

  it('keeps main’s pane when the window mounted it but its terminal is still starting', async () => {
    const d = deps(
      { ok: true, result: { leafId: 'main-leaf' } },
      async () => {
        throw new Error('timeout')
      },
      true
    )

    await expect(splitWindowLeafThroughLayoutOwner(LEAF, 'vertical', d)).rejects.toThrow('timeout')

    expect(d.apply).toHaveBeenCalledOnce()
  })
})
