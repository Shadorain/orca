import type { HandlerGroup } from './handler-group-manifest'

// Dispatch loads only the selected group; static imports eagerly load unrelated provider graphs.
export const AGENT_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'agent-launch',
    keys: ['agent launch'],
    load: async () => (await import('./handlers/agent-launch.js')).AGENT_LAUNCH_HANDLERS
  },
  {
    name: 'agent-session',
    keys: ['session list', 'session focus', 'session close'],
    load: async () => (await import('./handlers/agent-session.js')).AGENT_SESSION_HANDLERS
  }
]
