import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_SESSION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'list'],
    summary: 'List structured sessions with resolved checkout identity',
    usage: 'orca session list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Readonly. Requires host capability agent.mission-lifecycle.v1. An older host fails closed.',
      'Exited sessions whose checkout path cannot be resolved are omitted with liveness. A live or booting session without a path fails the call.',
      'WSL sessions are not matched against the local filesystem.'
    ]
  },
  {
    path: ['session', 'focus'],
    summary: 'Show a structured session and return its identity',
    usage:
      'orca session focus <sessionId> --execution-host <id> --worktree <id> --fence <n> [--json]',
    positionalArgs: ['session'],
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'execution-host', 'worktree', 'fence'],
    notes: [
      'Requires agent.mission-lifecycle.v1. Fails if the host, checkout, or fence does not match.'
    ]
  },
  {
    path: ['session', 'close'],
    summary: 'Close a structured session and return its identity',
    usage:
      'orca session close <sessionId> --execution-host <id> --worktree <id> --fence <n> [--json]',
    positionalArgs: ['session'],
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'execution-host', 'worktree', 'fence'],
    notes: [
      'Requires agent.mission-lifecycle.v1. Fails closed if the host, checkout, or fence does not match.'
    ]
  }
]
