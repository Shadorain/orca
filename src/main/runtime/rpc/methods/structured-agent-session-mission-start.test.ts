import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { commitStructuredAgentSessionCreate } from './structured-agent-session-create'
import {
  partitionStructuredSessionIdentities,
  type RegisteredWorkspacePaths
} from '../../structured-session-identity'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'

// Isolated recipe, no live host or user profile:
// orca agent launch --agent omp --worktree path:<checkout> --strict --env OMP_MISSION_AUTOSTART=1 --json
// No --prompt and no --focus. The host must spawn the ACP child before the JSON returns.

describe('mission launch starts the provider without a chat view', () => {
  it('starts the child when tab publication fails and focus is off', async () => {
    const startProviderChild = vi.fn(async () => ({ ok: true as const }))
    const host = {
      attach: vi.fn(async () => ({ ok: true as const, value: { sessionId: 's1', fence: 1 } })),
      startProviderChild,
      deps: { logger: { warn: vi.fn() } },
      getSessionTabId: () => undefined
    } as unknown as StructuredAgentSessionHost
    const runtime = {
      publishStructuredAgentSessionTab: vi.fn(async () => {
        throw new Error('no window')
      })
    }
    const result = await commitStructuredAgentSessionCreate({
      runtime: runtime as never,
      caller: { callerKey: 'cli' },
      activate: false,
      startProvider: true,
      prepared: {
        host,
        tab: { workspaceId: 'wt', agent: 'omp' },
        attachParams: {
          envelope: { sessionId: 's1' }
        } as AgentSessionAttachParams
      }
    })
    expect(startProviderChild).toHaveBeenCalledWith('s1')
    expect(result.ok).toBe(true)
  })
})

describe('session inventory fail-closed', () => {
  const registered: RegisteredWorkspacePaths = {
    worktrees: [{ id: 'wt', path: '/repo/wt' }],
    folders: []
  }
  const record = (sessionId: string, wslDistro: string | null = null): AgentSessionRecord =>
    ({
      sessionId,
      provider: 'omp',
      location: {
        workspaceKind: 'git-worktree',
        workspaceId: 'missing',
        executionHostId: 'local',
        wslDistro
      },
      lease: { runtimeFence: 2 }
    }) as AgentSessionRecord

  it('omits an exited unresolved session and fails a booting one', () => {
    expect(
      partitionStructuredSessionIdentities([record('old')], registered, () => 'exited')
    ).toEqual({
      sessions: [],
      omitted: [{ sessionId: 'old', liveness: 'exited', reason: 'worktree_path_unresolved' }]
    })
    expect(() =>
      partitionStructuredSessionIdentities([record('boot')], registered, () => 'starting')
    ).toThrow('worktree_path_unresolved')
  })

  it('does not apply a local path to a WSL session', () => {
    expect(() =>
      partitionStructuredSessionIdentities([record('wsl', 'Ubuntu')], registered, () => 'alive')
    ).toThrow('wsl_path_unsupported')
  })
})
