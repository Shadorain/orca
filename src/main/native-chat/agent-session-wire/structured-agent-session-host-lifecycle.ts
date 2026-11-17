import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'

type HostLifetimeContext = StructuredAgentSessionLifetimeContext &
  Pick<StructuredAgentSessionAttachContext, 'publishStatus'>

export function structuredAgentSessionHostLifetimeContext(
  deps: StructuredAgentSessionHostDeps,
  runtimeState: StructuredAgentSessionHostRuntimeState,
  sessions: StructuredAgentSessionLifetimeContext['sessions'],
  now: () => number,
  publishStatus: NonNullable<StructuredAgentSessionLifetimeContext['publishStatus']>,
  wakeDelivery: NonNullable<StructuredAgentSessionLifetimeContext['wakeDelivery']>,
  endExitedChild: StructuredAgentSessionLifetimeContext['endExitedChild']
): HostLifetimeContext {
  return { deps, runtimeState, sessions, now, publishStatus, wakeDelivery, endExitedChild }
}

export function structuredAgentSessionHostAttachContext(
  lifetime: HostLifetimeContext,
  subscribers: StructuredAgentSessionAttachContext['subscribers'],
  tasks: StructuredAgentSessionAttachContext['tasks'],
  reconcileLeases: StructuredAgentSessionAttachContext['reconcileLeases'],
  serialize: StructuredAgentSessionAttachContext['serialize'],
  openConversation: StructuredAgentSessionAttachContext['openConversation']
): StructuredAgentSessionAttachContext {
  return { ...lifetime, subscribers, tasks, reconcileLeases, serialize, openConversation }
}

export function structuredAgentSessionHostSessionLiveness(
  sessions: StructuredAgentSessionLifetimeContext['sessions'],
  sessionId: string
): 'alive' | 'starting' | 'exited' {
  const child = sessions.get(sessionId)?.child
  if (!child) {
    return 'exited'
  }
  return child.phase === 'ready' ? 'alive' : 'starting'
}

export function hasLoadedProviders(
  sessions: StructuredAgentSessionLifetimeContext['sessions']
): boolean {
  for (const session of sessions.values()) {
    if (session.child !== null) {
      return true
    }
  }
  return false
}
