import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeRecord } from '../../../../shared/runtime-types'
import { WorktreeExecParams } from '../../../../shared/rpc-contract/worktree-params'
import type { SshConnection } from '../../../ssh/ssh-connection'
import { executeWorktreeCommand } from './worktree-exec'

const { getManager } = vi.hoisted(() => ({ getManager: vi.fn() }))
vi.mock('../../../ssh/ssh-target-registry', () => ({
  getSshConnectionManager: () => getManager()
}))

function worktree(hostId = 'local'): RuntimeWorktreeRecord {
  return {
    path: process.cwd(),
    hostId
  } as RuntimeWorktreeRecord
}

function request(overrides: Partial<Parameters<typeof executeWorktreeCommand>[1]> = {}) {
  return {
    hostId: 'local',
    worktree: `path:${process.cwd()}`,
    argv: [process.execPath, '-e', ''],
    env: {},
    timeoutMs: 1_000,
    maxOutputBytes: 1024,
    ...overrides
  }
}

describe('worktree.exec request contract', () => {
  it('applies bounded defaults and rejects invalid scope and limits', () => {
    const base = {
      hostId: 'local',
      worktree: 'path:/repo',
      argv: ['git', 'status']
    }

    expect(WorktreeExecParams.parse(base)).toMatchObject({
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      env: {}
    })
    expect(WorktreeExecParams.safeParse({ ...base, worktree: 'active' }).success).toBe(false)
    expect(WorktreeExecParams.safeParse({ ...base, hostId: 'hostile' }).success).toBe(false)
    expect(WorktreeExecParams.safeParse({ ...base, timeoutMs: 180_001 }).success).toBe(false)
    expect(
      WorktreeExecParams.safeParse({ ...base, maxOutputBytes: 4 * 1024 * 1024 + 1 }).success
    ).toBe(false)
  })
})

describe('worktree.exec', () => {
  it('runs argv without a shell and returns exact streams and the child exit code', async () => {
    const result = await executeWorktreeCommand(
      { showManagedWorktree: async () => worktree() },
      request({
        argv: [
          process.execPath,
          '-e',
          'process.stdout.write(process.env.VALUE); process.stderr.write("err"); process.exitCode = 7'
        ],
        env: { VALUE: "quote' ; $HOME" }
      })
    )

    expect(result).toEqual({
      hostId: 'local',
      worktree: process.cwd(),
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write(process.env.VALUE); process.stderr.write("err"); process.exitCode = 7'
      ],
      stdout: "quote' ; $HOME",
      stderr: 'err',
      exitCode: 7
    })
  })

  it('rejects a worktree registered to a different host before executing', async () => {
    await expect(
      executeWorktreeCommand({ showManagedWorktree: async () => worktree('ssh:other') }, request())
    ).rejects.toThrow('worktree_exec_wrong_host')
  })

  it('fails rather than returning truncated output', async () => {
    await expect(
      executeWorktreeCommand(
        { showManagedWorktree: async () => worktree() },
        request({
          argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(100))'],
          maxOutputBytes: 16
        })
      )
    ).rejects.toThrow('worktree_exec_output_limit_exceeded')
  })

  // Exercise the real child-process timeout and verify it kills the still-running process.
  it('stops a command at its timeout', async () => {
    await expect(
      executeWorktreeCommand(
        { showManagedWorktree: async () => worktree() },
        request({
          argv: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'],
          timeoutMs: 25
        })
      )
    ).rejects.toThrow('worktree_exec_timeout')
  })

  it('quotes SSH argv and environment as distinct shell arguments without requesting a PTY', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      close: vi.fn()
    })
    const exec = vi.fn(async () => channel)
    const connection = {
      getState: () => ({ status: 'connected' }),
      exec
    } as unknown as SshConnection
    getManager.mockReturnValue({ getConnection: () => connection })
    const pending = executeWorktreeCommand(
      { showManagedWorktree: async () => worktree('ssh:target') },
      request({
        hostId: 'ssh:target',
        argv: ['printf', '%s', "arg' ; $HOME"],
        env: { VALUE: "env' ; $HOME" }
      })
    )
    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce())
    channel.emit('data', Buffer.from('stdout'))
    channel.stderr.emit('data', Buffer.from('stderr'))
    channel.emit('close', 0)

    await expect(pending).resolves.toMatchObject({
      hostId: 'ssh:target',
      stdout: 'stdout',
      stderr: 'stderr',
      exitCode: 0
    })
    expect(exec).toHaveBeenCalledWith(
      `cd '${process.cwd()}' && exec env 'VALUE=env'\\'' ; $HOME' 'printf' '%s' 'arg'\\'' ; $HOME'`
    )
  })

  it('refuses a disconnected SSH host', async () => {
    getManager.mockReturnValue({ getConnection: () => undefined })

    await expect(
      executeWorktreeCommand(
        { showManagedWorktree: async () => worktree('ssh:target') },
        request({ hostId: 'ssh:target' })
      )
    ).rejects.toThrow('worktree_exec_host_disconnected')
  })
})
