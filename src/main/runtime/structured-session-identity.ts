import type { ExecutionHostId } from '../../shared/execution-host'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { folderWorkspaceKey } from '../../shared/workspace-scope'

export type StructuredSessionLiveness = 'alive' | 'starting' | 'exited'

export type StructuredSessionIdentity = {
  sessionId: string
  executionHostId: ExecutionHostId
  worktreeId: string
  worktreePath: string
  incarnation: number
  liveness: StructuredSessionLiveness
  agent: string
  wslDistro: null
}

export type StructuredSessionIdentityOmission = {
  sessionId: string
  liveness: StructuredSessionLiveness
  reason: 'worktree_path_unresolved' | 'wsl_path_unsupported'
}

export type RegisteredWorkspacePaths = {
  worktrees: readonly { id: string; path: string }[]
  folders: readonly { id: string; folderPath: string }[]
}

/** Exact id match against the runtime's registered worktrees and folders. Never parses the id. */
export function registeredWorkspacePath(
  record: Pick<AgentSessionRecord, 'location'>,
  registered: RegisteredWorkspacePaths
): string | null {
  if (record.location.workspaceKind === 'folder') {
    const folder = registered.folders.find(
      (entry) =>
        entry.id === record.location.workspaceId ||
        folderWorkspaceKey(entry.id) === record.location.workspaceId
    )
    return folder?.folderPath || null
  }
  const worktree = registered.worktrees.find((entry) => entry.id === record.location.workspaceId)
  return worktree?.path || null
}

export function structuredSessionIdentity(
  record: AgentSessionRecord,
  registered: RegisteredWorkspacePaths,
  liveness: StructuredSessionLiveness
): StructuredSessionIdentity | StructuredSessionIdentityOmission {
  if (record.location.wslDistro) {
    return { sessionId: record.sessionId, liveness, reason: 'wsl_path_unsupported' }
  }
  const worktreePath = registeredWorkspacePath(record, registered)
  if (!worktreePath) {
    return { sessionId: record.sessionId, liveness, reason: 'worktree_path_unresolved' }
  }
  return {
    sessionId: record.sessionId,
    executionHostId: record.location.executionHostId,
    worktreeId: record.location.workspaceId,
    worktreePath,
    incarnation: record.lease.runtimeFence,
    liveness,
    agent: record.provider,
    wslDistro: null
  }
}

/** Fails before a focus or close when the caller names a different host, checkout, or fence. */
export function assertSessionIdentityMatch(
  identity: StructuredSessionIdentity,
  expected: { executionHostId?: string; worktreeId?: string; incarnation?: number }
): void {
  if (
    expected.executionHostId !== undefined &&
    identity.executionHostId !== expected.executionHostId
  ) {
    throw new Error('execution_host_mismatch')
  }
  if (expected.worktreeId !== undefined && identity.worktreeId !== expected.worktreeId) {
    throw new Error('worktree_mismatch')
  }
  if (expected.incarnation !== undefined && identity.incarnation !== expected.incarnation) {
    throw new Error('fence_mismatch')
  }
}

/** Exited gaps are omitted. A live or booting session with no board path fails the inventory. */
export function partitionStructuredSessionIdentities(
  records: readonly AgentSessionRecord[],
  registered: RegisteredWorkspacePaths,
  liveness: (sessionId: string) => StructuredSessionLiveness
): {
  sessions: StructuredSessionIdentity[]
  omitted: StructuredSessionIdentityOmission[]
} {
  const sessions: StructuredSessionIdentity[] = []
  const omitted: StructuredSessionIdentityOmission[] = []
  for (const record of records) {
    const identity = structuredSessionIdentity(record, registered, liveness(record.sessionId))
    if (isStructuredSessionIdentity(identity)) {
      sessions.push(identity)
      continue
    }
    if (identity.liveness !== 'exited') {
      throw new Error(identity.reason)
    }
    omitted.push(identity)
  }
  return { sessions, omitted }
}

export function isStructuredSessionIdentity(
  value: StructuredSessionIdentity | StructuredSessionIdentityOmission
): value is StructuredSessionIdentity {
  return 'worktreePath' in value
}
