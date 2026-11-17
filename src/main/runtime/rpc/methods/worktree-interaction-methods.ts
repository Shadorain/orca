import {
  WorktreeExecParams,
  WorktreeSelector
} from '../../../../shared/rpc-contract/worktree-params'
import { defineMethod } from '../core'

export const WORKTREE_INTERACTION_METHODS = [
  defineMethod({
    name: 'worktree.lineageList',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({
      lineage: await runtime.listWorktreeLineage(),
      workspaceLineage: await runtime.listWorkspaceLineage()
    })
  }),
  defineMethod({
    name: 'worktree.show',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => ({
      worktree: await runtime.showManagedWorktree(params.worktree)
    })
  }),
  defineMethod({
    name: 'worktree.exec',
    permission: 'workspace',
    params: WorktreeExecParams,
    handler: async (params, { worktreeExec }) => {
      if (!worktreeExec) {
        throw new Error('worktree_exec_unavailable')
      }
      return worktreeExec(params)
    }
  }),
  defineMethod({
    name: 'worktree.sleep',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.sleepManagedWorktree(params.worktree)
  })
]
