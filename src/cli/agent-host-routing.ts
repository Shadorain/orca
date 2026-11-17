import { LOCAL_EXECUTION_HOST_ID, type ParsedExecutionHost } from '../shared/execution-host'
import type { RuntimeWorktreeRecord } from '../shared/runtime-types'
import { hostFilterMatchesHostId, resolveHostFlagTarget } from './execution-host-flag'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'
import { getRequiredWorktreeSelector } from './selectors'

export type AgentHostSelection = ParsedExecutionHost | undefined

export async function resolveAgentHost(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): Promise<AgentHostSelection> {
  const host = await resolveHostFlagTarget(flags, client)
  if (host?.kind === 'runtime' && !client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--host ${host.id} did not route to its paired Orca server.`
    )
  }
  if (host?.kind === 'local' && client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--host local cannot be used with a remote Orca server selection.'
    )
  }
  return host
}

export function projectAgentSessionList<
  T extends {
    sessions: { executionHostId: string }[]
    omitted: unknown[]
  }
>(result: T, host: ParsedExecutionHost | undefined): T {
  if (!host) {
    return result
  }
  return {
    ...result,
    sessions: result.sessions
      .filter((session) => hostFilterMatchesHostId(host, session.executionHostId))
      .map((session) => ({
        ...session,
        ...(host.kind === 'runtime' && session.executionHostId === LOCAL_EXECUTION_HOST_ID
          ? { executionHostId: host.id }
          : {})
      })),
    // Omitted rows carry no host identity and cannot be safely attributed to this selection.
    omitted: []
  }
}

export function resolveSessionFenceHost(
  requestedHostId: string,
  host: ParsedExecutionHost | undefined,
  client: RuntimeClient
): string {
  if (!host) {
    return requestedHostId
  }
  if (requestedHostId !== host.id) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Session execution host ${requestedHostId} does not match selected --host ${host.id}.`
    )
  }
  return host.kind === 'runtime' && client.isRemote ? LOCAL_EXECUTION_HOST_ID : host.id
}

export function projectAgentLaunchResult<T extends { session?: { executionHostId: string } }>(
  result: T,
  host: ParsedExecutionHost | undefined
): T {
  if (!host || !result.session) {
    return result
  }
  if (!hostFilterMatchesHostId(host, result.session.executionHostId)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Agent launch returned a session on ${result.session.executionHostId}, not selected host ${host.id}.`
    )
  }
  return {
    ...result,
    session: {
      ...result.session,
      ...(host.kind === 'runtime' && result.session.executionHostId === LOCAL_EXECUTION_HOST_ID
        ? { executionHostId: host.id }
        : {})
    }
  }
}

export async function resolveAgentLaunchWorktree(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<{ selector: string; host: ParsedExecutionHost | undefined }> {
  const selector = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
  const host = await resolveAgentHost(flags, client)
  if (!host) {
    return { selector, host }
  }
  const list = await client.call<{ worktrees: RuntimeWorktreeRecord[] }>('worktree.list', {
    limit: 10_000
  })
  const scoped = list.result.worktrees.filter((worktree) =>
    hostFilterMatchesHostId(host, worktree.hostId)
  )
  let matches: RuntimeWorktreeRecord[]
  if (selector.startsWith('path:')) {
    const path = selector.slice('path:'.length)
    matches = scoped.filter((worktree) => worktree.path === path)
  } else if (selector.startsWith('id:')) {
    const id = selector.slice('id:'.length)
    matches = scoped.filter((worktree) => worktree.id === id)
  } else {
    const resolved = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: selector
    })
    matches = scoped.filter((worktree) => worktree.id === resolved.result.worktree.id)
  }
  if (matches.length !== 1) {
    throw new RuntimeClientError(
      matches.length === 0 ? 'selector_not_found' : 'selector_ambiguous',
      matches.length === 0
        ? `Worktree ${selector} does not belong to selected host ${host.id}.`
        : `Worktree ${selector} is ambiguous on selected host ${host.id}.`
    )
  }
  return { selector: `id:${matches[0]!.id}`, host }
}
