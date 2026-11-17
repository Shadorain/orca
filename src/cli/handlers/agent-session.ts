import type { CommandHandler } from '../dispatch'
import { AGENT_MISSION_LIFECYCLE_RUNTIME_CAPABILITY } from '../../shared/agent-launch-runtime-capability'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { type RuntimeClient, RuntimeClientError } from '../runtime-client'

import {
  projectAgentSessionList,
  resolveAgentHost,
  resolveSessionFenceHost,
  type AgentHostSelection
} from '../agent-host-routing'

type AgentSessionInventory = {
  ok: true
  sessions: { executionHostId: string }[]
  omitted: unknown[]
}

async function requireMissionLifecycle(client: RuntimeClient): Promise<void> {
  const status = await client.call<{ capabilities?: readonly string[] }>('status.get')
  if (!status.result.capabilities?.includes(AGENT_MISSION_LIFECYCLE_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host does not advertise agent.mission-lifecycle.v1. Session inventory is refused rather than guessed.'
    )
  }
}

function sessionCall(
  flags: Map<string, string | boolean>,
  sessionId: string,
  host: AgentHostSelection,
  client: RuntimeClient
) {
  const requestedHostId = getRequiredStringFlag(flags, 'execution-host')
  const executionHostId = resolveSessionFenceHost(requestedHostId, host, client)
  const worktreeId = getRequiredStringFlag(flags, 'worktree')
  const fence = getRequiredStringFlag(flags, 'fence')
  const incarnation = Number(fence)
  if (!Number.isSafeInteger(incarnation)) {
    throw new RuntimeClientError('invalid_argument', '--fence must be an integer')
  }
  return {
    sessionId,
    executionHostId,
    worktreeId,
    incarnation
  }
}

export const AGENT_SESSION_HANDLERS: Record<string, CommandHandler> = {
  'session list': async ({ flags, client, json }) => {
    const host = await resolveAgentHost(flags, client)
    await requireMissionLifecycle(client)
    const result = await client.call<AgentSessionInventory>('agentSession.list', {})
    printResult(
      { ...result, result: projectAgentSessionList(result.result, host) },
      json,
      (value) => JSON.stringify(value)
    )
  },
  'session focus': async ({ flags, client, json }) => {
    const host = await resolveAgentHost(flags, client)
    await requireMissionLifecycle(client)
    const result = await client.call(
      'agentSession.reveal',
      sessionCall(flags, getRequiredStringFlag(flags, 'session'), host, client)
    )
    printResult(result, json, (value) => JSON.stringify(value))
  },
  'session close': async ({ flags, client, json }) => {
    const host = await resolveAgentHost(flags, client)
    await requireMissionLifecycle(client)
    const result = await client.call(
      'agentSession.close',
      sessionCall(flags, getRequiredStringFlag(flags, 'session'), host, client)
    )
    printResult(result, json, (value) => JSON.stringify(value))
  }
}
