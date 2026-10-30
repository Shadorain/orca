import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { resolveTitleDerivedAgentType } from './title-derived-pane-agent-identity'

const LEAF_ID_1 = '77777777-7777-4777-8777-777777777777'

function makeTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function makeSingleLayout(leafId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null
  }
}

describe('resolveTitleDerivedAgentType', () => {
  it('rejects a free-text name that differs from the pane owner (#24854)', () => {
    expect(resolveTitleDerivedAgentType('⠋ Review Codex behavior', 'Codex', 'omp')).toBeNull()
  })

  it('accepts an anchored or marker-backed name over a different-family owner', () => {
    expect(resolveTitleDerivedAgentType('⠋ fix the parser - Codex', 'Codex', 'omp')).toBe('codex')
    expect(resolveTitleDerivedAgentType('✦ Gemini CLI', 'Gemini CLI', 'claude')).toBe('gemini')
  })

  it('maps a bare label on an ownerless pane', () => {
    expect(resolveTitleDerivedAgentType('Codex', 'Codex', null)).toBe('codex')
  })

  it('keeps same-group title agents under an OMP owner', () => {
    expect(resolveTitleDerivedAgentType('π > ~/x', 'Pi', 'omp')).toBe('pi')
  })

  it('reads a Jcode owner suffix as identity, not a mention', () => {
    expect(resolveTitleDerivedAgentType('⠋ fix - Jcode', 'Jcode', 'omp')).toBe('jcode')
  })
})

describe('owner identity with foreign task names', () => {
  it('preserves the unknown-label fallback for an admitted identity', () => {
    expect(resolveTitleDerivedAgentType('MiMo Code', 'MiMo Code')).toBe('unknown')
  })

  it.each([
    '⠋ Fix the codex plugin launcher',
    '⠋ fix the grok launcher',
    '⠋ port the gemini status parser',
    '⠋ fix the mimo launcher'
  ])('keeps the existing Claude row for %j', (title) => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-1', { launchAgent: 'claude' })],
      entries: [],
      retained: [],
      runtimePaneTitlesByTabId: { 'tab-1': { 1: title } },
      ptyIdsByTabId: { 'tab-1': ['pty-claude'] },
      terminalLayoutsByTabId: { 'tab-1': makeSingleLayout(LEAF_ID_1) },
      now: 2000
    })
    expect(rows.map((row) => [row.agentType, row.entry.prompt])).toEqual([['claude', 'Claude']])
  })
})
