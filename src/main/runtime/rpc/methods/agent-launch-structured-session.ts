import type { AgentLaunchIntent, AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import { isBoardMissionEnv } from '../../../../shared/omp-mission-lifecycle'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredSessionIdentity } from '../../structured-session-identity'
import type { RpcContext } from '../core'
import { clientRendersStructuredAgent } from './structured-agent-session-policy'

export async function withStructuredLaunchSession(
  result: AgentLaunchResult,
  intent: AgentLaunchIntent,
  context: RpcContext
): Promise<AgentLaunchResult> {
  if (result.outcome.kind !== 'structured' || (!intent.strict && !isBoardMissionEnv(intent.env))) {
    return result
  }
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getRecord(result.outcome.sessionId)
  if (!host || !record) {
    throw new Error('worktree_path_unresolved')
  }
  const knownPath =
    intent.target.kind === 'existing' && record.location.workspaceId === result.worktreeId
      ? intent.target.workspacePath
      : undefined
  const identity = structuredSessionIdentity(
    record,
    knownPath
      ? {
          worktrees: [{ id: record.location.workspaceId, path: knownPath }],
          folders: [{ id: record.location.workspaceId, folderPath: knownPath }]
        }
      : await context.runtime.listRegisteredWorkspacePaths(),
    host.sessionLiveness(record.sessionId)
  )

  if (!identity || !('worktreePath' in identity)) {
    throw new Error(identity?.reason ?? 'worktree_path_unresolved')
  }
  return { ...result, session: identity }
}

/**
 * `agent.launch.v2` predates support for agents beyond Claude and Codex. Other chats require an
 * explicit client capability; otherwise the caller must receive a terminal it can render.
 */
export function callerRendersLaunchedChat(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>,
  agent: string
): boolean {
  return (
    context.clientKind === undefined ||
    agent === 'claude' ||
    agent === 'codex' ||
    clientRendersStructuredAgent(context.clientCapabilities, agent)
  )
}
