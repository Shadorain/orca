import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  hostStub,
  installStructuredHostStub,
  runtimeCalls,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('fenced native sessions', () => {
  it.each([
    {
      method: 'agentSession.close',
      executionHostId: 'local',
      incarnation: 3,
      reason: 'fence_mismatch'
    },
    {
      method: 'agentSession.reveal',
      executionHostId: 'local',
      incarnation: 3,
      reason: 'fence_mismatch'
    },
    {
      method: 'agentSession.close',
      executionHostId: 'ssh:other',
      incarnation: 4,
      reason: 'execution_host_mismatch'
    },
    {
      method: 'agentSession.reveal',
      executionHostId: 'ssh:other',
      incarnation: 4,
      reason: 'execution_host_mismatch'
    }
  ])(
    'refuses $method on $reason before changing the pane',
    async ({ method, executionHostId, incarnation, reason }) => {
      const host = Object.assign(hostStub(), {
        deps: {
          store: {
            getRecord: () => ({
              sessionId: SESSION,
              provider: 'claude',
              location: {
                workspaceKind: 'worktree',
                workspaceId: 'opaque',
                executionHostId: 'local',
                wslDistro: null
              },
              lease: { runtimeFence: 4 }
            })
          }
        },
        sessionLiveness: () => 'alive'
      })
      setStructuredAgentSessionHost(host)
      const response = await call(
        method,
        { sessionId: SESSION, executionHostId, worktreeId: 'opaque', incarnation },
        STRUCTURED_CLIENT,
        {
          listRegisteredWorkspacePaths: async () => ({
            worktrees: [{ id: 'opaque', path: '/registered' }],
            folders: []
          })
        }
      )
      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(reason) }
      })
      expect(hostCalls.close).not.toHaveBeenCalled()
      expect(hostCalls.revealSession).not.toHaveBeenCalled()
      expect(hostCalls.setSessionTabVisibility).not.toHaveBeenCalled()
      expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
    }
  )
})
