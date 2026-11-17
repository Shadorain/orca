/**
 * How the CLI starts an agent: through `agent.launch`, the host's one launch point that the desktop
 * and phone use too. The user's Chat UI setting picks a chat or a terminal, and the receipt says
 * which ran and why; the CLI never picks the surface itself.
 */

import { randomUUID } from 'node:crypto'
import type { AgentLaunchPrompt, AgentLaunchResult } from '../shared/agent-launch-intent'
import { checkAgentLaunchModelPreferences } from '../shared/agent-launch-model-preferences'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_MISSION_LIFECYCLE_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
} from '../shared/agent-launch-runtime-capability'
import { createStructuredAgentSessionOperationId } from '../shared/structured-agent-session-mutation'
import { parseAgentSessionOperationTimestamp } from '../shared/agent-session-host-authority'
import type { RuntimeStatus } from '../shared/runtime-types'
import type { TuiAgent } from '../shared/tui-agent'
import { isTuiAgent } from '../shared/tui-agent-config'
import {
  getOptionalStringFlag,
  getRequiredStringFlagAllowingEmpty,
  rejectValuelessFlag
} from './flags'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from './runtime-client'
import { withCliAgentLaunchRecovery } from './agent-launch-recovery'
import { REPEATED_FLAG_SEPARATOR } from './args'
import { ompProviderStartup, parseRepeatedLaunchEnv } from '../shared/agent-session-launch-args'

type Flags = Map<string, string | boolean>

/** `create` is the `worktree.create` request the CLI already builds; the host strips agent fields. */
export type CliAgentLaunchTarget =
  | { kind: 'existing'; worktree: string }
  | { kind: 'create-worktree'; create: Record<string, unknown> }

export type CliAgentLaunch = {
  agent: TuiAgent
  prompt?: AgentLaunchPrompt
  sessionOptions?: Record<string, string>
  operationId?: string
  env?: Record<string, string>
  /** Refuses rather than downgrading to a terminal when structured creation fails. */
  strict?: true
  launchArgs?: readonly string[]
}

export function parseCliAgent(value: string): TuiAgent {
  if (!isTuiAgent(value)) {
    throw new RuntimeClientError('invalid_argument', `Unknown TUI agent "${value}"`)
  }
  return value
}

/** The agent, prompt, model and effort a CLI start asks for; refuses a model or effort the launch
 *  could not apply, by the same rule as `orchestration worker-start`. */
export function readCliAgentLaunch(
  flags: Flags,
  agent: TuiAgent,
  target: { createsWorktree: boolean }
): CliAgentLaunch {
  const checked = checkAgentLaunchModelPreferences({
    agent,
    model: getOptionalStringFlag(flags, 'model'),
    effort: getOptionalStringFlag(flags, 'effort'),
    createsWorktree: target.createsWorktree,
    // The execution host verifies an OpenCode model itself before it starts one.
    openCodeModelLaunchSupported: true
  })
  if ('refusal' in checked) {
    throw new RuntimeClientError(checked.refusal.code, checked.refusal.message)
  }
  const prompt = flags.get('prompt')
  rejectValuelessFlag(prompt, 'prompt')
  const operationId = flags.has('retry-launch')
    ? getRequiredStringFlagAllowingEmpty(flags, 'retry-launch')
    : undefined
  if (operationId !== undefined && parseAgentSessionOperationTimestamp(operationId) === null) {
    throw new RuntimeClientError('invalid_argument', 'Malformed --retry-launch operation ID')
  }
  const envFlag = flags.get('env')
  let env: Record<string, string> | undefined
  if (typeof envFlag === 'string') {
    try {
      env = parseRepeatedLaunchEnv(envFlag, REPEATED_FLAG_SEPARATOR)
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        error instanceof Error ? error.message : 'Malformed --env'
      )
    }
  }
  const targetKind = flags.get('target-kind')
  if (typeof targetKind === 'string' && targetKind !== 'structured-session') {
    throw new RuntimeClientError('invalid_argument', '--target-kind must be structured-session')
  }
  const mode = flags.get('mode')
  const startup = ompProviderStartup({
    ...(typeof flags.get('config') === 'string' ? { config: flags.get('config') as string } : {}),
    ...(typeof flags.get('append-system-prompt') === 'string'
      ? { appendSystemPrompt: flags.get('append-system-prompt') as string }
      : {}),
    ...(typeof flags.get('session-dir') === 'string'
      ? { sessionDir: flags.get('session-dir') as string }
      : {}),
    ...(typeof mode === 'string' ? { mode } : {})
  })
  return {
    agent,
    ...(operationId ? { operationId } : {}),
    ...(typeof prompt === 'string' && prompt.trim()
      ? { prompt: { text: prompt, delivery: 'submit' as const } }
      : {}),
    ...(checked.preferences || startup.options.mode
      ? { sessionOptions: { ...checked.preferences, ...startup.options } }
      : {}),
    ...(env ? { env } : {}),
    ...(startup.launchArgs.length > 0 ? { launchArgs: startup.launchArgs } : {}),
    ...(flags.has('strict') || targetKind === 'structured-session' ? { strict: true as const } : {})
  }
}

export function hasLaunchModelFlags(flags: Flags): boolean {
  return flags.has('model') || flags.has('effort')
}

export async function getAgentLaunchCapabilities(
  client: RuntimeClient
): Promise<readonly string[] | null> {
  const status = await client.call<RuntimeStatus>('status.get')
  const capabilities = status.result.capabilities ?? []
  return capabilities.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY) ? capabilities : null
}

export async function callAgentLaunch(
  client: RuntimeClient,
  launch: CliAgentLaunch,
  request: { target: CliAgentLaunchTarget; presentation?: 'focused' | 'background' },
  capabilities: readonly string[],
  rawArgs?: readonly string[]
): Promise<RuntimeRpcSuccess<AgentLaunchResult & { operationId?: string }>> {
  const replaySupported = capabilities.includes(AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY)
  if (launch.operationId && !replaySupported) {
    throw new RuntimeClientError(
      'agent_session_operation_unknown',
      'This host cannot replay the earlier launch. Return to the original execution host; do not retry without --retry-launch.'
    )
  }
  if (launch.prompt && !capabilities.includes(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot safely carry launch prompts. Update Orca on the execution host.'
    )
  }
  if (!capabilities.includes(AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot honor CLI launch focus or background behavior. Update Orca on the execution host.'
    )
  }
  if (
    (launch.strict || launch.env || launch.launchArgs) &&
    !capabilities.includes(AGENT_MISSION_LIFECYCLE_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host does not advertise agent.mission-lifecycle.v1. Refusing the launch so mission scope is not silently dropped. Update Orca on the execution host.'
    )
  }
  const operationId = replaySupported
    ? (launch.operationId ?? createStructuredAgentSessionOperationId(randomUUID))
    : undefined
  const params = {
    ...request,
    ...launch,
    ...(operationId ? { operationId } : {}),
    launchSource: 'cli'
  }
  const result = await withCliAgentLaunchRecovery(
    client.call<AgentLaunchResult>(operationId ? 'agent.launchReplay' : 'agent.launch', params),
    { operationId, replayed: launch.operationId !== undefined, rawArgs, params }
  )
  return { ...result, result: { ...result.result, ...(operationId ? { operationId } : {}) } }
}

export function formatAgentLaunch(result: AgentLaunchResult & { operationId?: string }): string {
  const { outcome, receipt } = result
  return [
    `agent: ${outcome.kind === 'structured' ? 'chat session' : 'terminal'}`,
    `handle: ${outcome.handle}`,
    ...(outcome.kind === 'structured' ? [`sessionId: ${outcome.sessionId}`] : []),
    `worktreeId: ${result.worktreeId}`,
    ...(result.operationId ? [`operationId: ${result.operationId}`] : []),
    `why: ${receipt.detail}`,
    ...(result.prompt ? [`prompt: ${result.prompt.outcome}`] : []),
    ...(result.warning ? [`warning: ${result.warning}`] : [])
  ].join('\n')
}
