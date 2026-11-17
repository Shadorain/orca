import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ExecutionHostFlagModule from './execution-host-flag'

const { resolveHostFlagTargetMock } = vi.hoisted(() => ({
  resolveHostFlagTargetMock: vi.fn()
}))

vi.mock('./execution-host-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecutionHostFlagModule>()),
  resolveHostFlagTarget: resolveHostFlagTargetMock
}))

import { AGENT_MISSION_LIFECYCLE_RUNTIME_CAPABILITY } from '../shared/agent-launch-runtime-capability'
import { parseExecutionHostId } from '../shared/execution-host'
import type { RuntimeWorktreeRecord } from '../shared/runtime-types'
import { AGENT_SESSION_HANDLERS } from './handlers/agent-session'
import {
  projectAgentLaunchResult,
  projectAgentSessionList,
  resolveAgentLaunchWorktree,
  resolveSessionFenceHost
} from './agent-host-routing'
import type { RuntimeClient } from './runtime-client'

const runtimeHost = parseExecutionHostId('runtime:env-1')!
const sshHost = parseExecutionHostId('ssh:build-1')!

function createClient(
  remote: boolean,
  worktrees: RuntimeWorktreeRecord[] = [],
  mutationCalls: unknown[][] = []
): RuntimeClient {
  return {
    isRemote: remote,
    call: vi.fn(async (method: string, params: unknown) => {
      if (method === 'status.get') {
        return {
          ok: true,
          result: { capabilities: [AGENT_MISSION_LIFECYCLE_RUNTIME_CAPABILITY] }
        }
      }
      if (method === 'worktree.list') {
        return { ok: true, result: { worktrees } }
      }
      mutationCalls.push([method, params])
      return { ok: true, result: { ok: true } }
    })
  } as unknown as RuntimeClient
}

function row(id: string, hostId: string, path = '/same/path'): RuntimeWorktreeRecord {
  return { id, hostId, path } as RuntimeWorktreeRecord
}

function executionHostIdFromCall(call: unknown[]): string {
  const params = call[1]
  if (
    typeof params !== 'object' ||
    params === null ||
    !('executionHostId' in params) ||
    typeof params.executionHostId !== 'string'
  ) {
    throw new Error('expected a fenced agent-session RPC call')
  }
  return params.executionHostId
}

describe('agent CLI host routing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resolveHostFlagTargetMock.mockReset()
  })

  it('projects remote-runtime local sessions to the selected runtime and excludes foreign hosts', () => {
    const projected = projectAgentSessionList(
      {
        ok: true,
        sessions: [
          { sessionId: 'local-row', executionHostId: 'local' },
          { sessionId: 'foreign-row', executionHostId: 'runtime:env-2' }
        ],
        omitted: [{ sessionId: 'unknown-row' }]
      },
      runtimeHost
    )
    expect(projected.sessions).toEqual([
      { sessionId: 'local-row', executionHostId: 'runtime:env-1' }
    ])
    expect(projected.omitted).toEqual([])
  })

  it('returns remote-runtime local rows with the canonical selected host identity', async () => {
    resolveHostFlagTargetMock.mockResolvedValue(runtimeHost)
    const client = {
      isRemote: true,
      call: vi.fn(async (method: string) =>
        method === 'status.get'
          ? {
              ok: true,
              result: { capabilities: [AGENT_MISSION_LIFECYCLE_RUNTIME_CAPABILITY] }
            }
          : {
              ok: true,
              result: {
                ok: true,
                sessions: [
                  { sessionId: 'local-row', executionHostId: 'local' },
                  { sessionId: 'foreign-row', executionHostId: 'runtime:env-2' }
                ],
                omitted: []
              }
            }
      )
    } as unknown as RuntimeClient
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_SESSION_HANDLERS['session list']!({
      flags: new Map([['host', runtimeHost.id]]),
      client,
      cwd: '/tmp',
      json: true,
      rawArgs: []
    })
    const printed = log.mock.calls[0]?.[0]
    if (typeof printed !== 'string') {
      throw new Error('expected JSON CLI output')
    }
    const output = JSON.parse(printed) as { result: { sessions: unknown[] } }
    expect(output.result.sessions).toEqual([
      { sessionId: 'local-row', executionHostId: runtimeHost.id }
    ])
    log.mockRestore()
  })

  it('translates only the selected remote-runtime session fence to provider local', () => {
    expect(
      resolveSessionFenceHost(runtimeHost.id, runtimeHost, { isRemote: true } as RuntimeClient)
    ).toBe('local')
    expect(() =>
      resolveSessionFenceHost('ssh:foreign', runtimeHost, { isRemote: true } as RuntimeClient)
    ).toThrow(/does not match selected --host/)
  })

  it.each(['session focus', 'session close'])(
    'refuses a foreign %s fence before mutation',
    async (command) => {
      resolveHostFlagTargetMock.mockResolvedValue(runtimeHost)
      const mutationCalls: unknown[][] = []
      const client = createClient(true, [], mutationCalls)
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      await expect(
        AGENT_SESSION_HANDLERS[command]!({
          flags: new Map([
            ['host', runtimeHost.id],
            ['session', 'session-1'],
            ['execution-host', 'ssh:foreign'],
            ['worktree', 'repo::/worktree'],
            ['fence', '7']
          ]),
          client,
          cwd: '/tmp',
          json: true,
          rawArgs: []
        })
      ).rejects.toThrow(/does not match selected --host/)
      expect(mutationCalls).toEqual([])
      log.mockRestore()
    }
  )

  it('sends translated provider-local fences for focus and close on the selected runtime', async () => {
    resolveHostFlagTargetMock.mockResolvedValue(runtimeHost)
    const mutationCalls: unknown[][] = []
    const client = createClient(true, [], mutationCalls)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const command of ['session focus', 'session close']) {
      await AGENT_SESSION_HANDLERS[command]!({
        flags: new Map([
          ['host', runtimeHost.id],
          ['session', 'session-1'],
          ['execution-host', runtimeHost.id],
          ['worktree', 'repo::/worktree'],
          ['fence', '7']
        ]),
        client,
        cwd: '/tmp',
        json: true,
        rawArgs: []
      })
    }
    expect(mutationCalls.map(executionHostIdFromCall)).toEqual(['local', 'local'])
    log.mockRestore()
  })

  it('projects the atomic launch session identity to its selected runtime', () => {
    const result = projectAgentLaunchResult(
      { outcome: { kind: 'structured' }, session: { executionHostId: 'local' } },
      runtimeHost
    )
    expect(result.session?.executionHostId).toBe(runtimeHost.id)
  })

  it('scopes duplicate path and opaque worktree selectors to the exact SSH host', async () => {
    resolveHostFlagTargetMock.mockResolvedValue(sshHost)
    const client = createClient(false, [
      row('ssh-repo::/same/path', sshHost.id),
      row('local-repo::/same/path', 'local')
    ])
    const path = await resolveAgentLaunchWorktree(
      new Map([
        ['host', sshHost.id],
        ['worktree', 'path:/same/path']
      ]),
      '/tmp',
      client
    )
    expect(path.selector).toBe('id:ssh-repo::/same/path')
    const opaque = await resolveAgentLaunchWorktree(
      new Map([
        ['host', sshHost.id],
        ['worktree', 'id:ssh-repo::/same/path']
      ]),
      '/tmp',
      client
    )
    expect(opaque.selector).toBe('id:ssh-repo::/same/path')
  })
})
