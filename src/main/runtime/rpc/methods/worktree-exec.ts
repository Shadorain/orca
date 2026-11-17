import { spawn } from 'node:child_process'
import { parseExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { RuntimeWorktreeRecord } from '../../../../shared/runtime-types'
import { getSshConnectionManager } from '../../../ssh/ssh-target-registry'
import type { SshConnection } from '../../../ssh/ssh-connection'

export type WorktreeExecRequest = {
  hostId: string
  worktree: string
  argv: string[]
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
}

export type WorktreeExecResult = {
  hostId: string
  worktree: string
  argv: string[]
  stdout: string
  stderr: string
  exitCode: number
}

export const MAX_WORKTREE_EXEC_TIMEOUT_MS = 180_000
export const MAX_WORKTREE_EXEC_OUTPUT_BYTES = 4 * 1024 * 1024

function fail(message: string): never {
  throw new Error(message)
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function validateRequest(request: WorktreeExecRequest): void {
  if (!request.worktree.startsWith('path:') || request.worktree.length === 5) {
    fail('worktree_exec_invalid_worktree_path')
  }
  if (
    !Array.isArray(request.argv) ||
    request.argv.length === 0 ||
    request.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  ) {
    fail('worktree_exec_invalid_argv')
  }
  if (
    Object.entries(request.env).some(
      ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes('\0')
    )
  ) {
    fail('worktree_exec_invalid_env')
  }
  if (
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > MAX_WORKTREE_EXEC_TIMEOUT_MS
  ) {
    fail('worktree_exec_invalid_timeout')
  }
  if (
    !Number.isInteger(request.maxOutputBytes) ||
    request.maxOutputBytes < 1 ||
    request.maxOutputBytes > MAX_WORKTREE_EXEC_OUTPUT_BYTES
  ) {
    fail('worktree_exec_invalid_output_limit')
  }
}

function outputCollector(maxBytes: number) {
  let totalBytes = 0
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  return {
    add(destination: 'stdout' | 'stderr', chunk: Buffer | string): boolean {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.byteLength
      if (totalBytes > maxBytes) {
        return false
      }
      if (destination === 'stdout') {
        stdout.push(buffer)
      } else {
        stderr.push(buffer)
      }
      return true
    },
    result() {
      return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      }
    }
  }
}

function runLocal(
  worktree: RuntimeWorktreeRecord,
  request: WorktreeExecRequest
): Promise<Omit<WorktreeExecResult, 'hostId' | 'worktree' | 'argv'>> {
  const { promise, resolve, reject } =
    Promise.withResolvers<Omit<WorktreeExecResult, 'hostId' | 'worktree' | 'argv'>>()
  const child = spawn(request.argv[0]!, request.argv.slice(1), {
    cwd: worktree.path,
    env: { ...process.env, ...request.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  })
  const output = outputCollector(request.maxOutputBytes)
  let settled = false
  const failOnce = (message: string) => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    child.kill('SIGKILL')
    reject(new Error(message))
  }
  child.stdout.on('data', (chunk: Buffer | string) => {
    if (!output.add('stdout', chunk)) {
      failOnce('worktree_exec_output_limit_exceeded')
    }
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    if (!output.add('stderr', chunk)) {
      failOnce('worktree_exec_output_limit_exceeded')
    }
  })
  const timer = setTimeout(() => failOnce('worktree_exec_timeout'), request.timeoutMs)
  child.once('error', (error) => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    reject(error)
  })
  child.once('close', (code) => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    resolve({ ...output.result(), exitCode: code ?? 128 })
  })
  return promise
}

async function runSsh(
  hostId: string,
  worktree: RuntimeWorktreeRecord,
  request: WorktreeExecRequest
): Promise<Omit<WorktreeExecResult, 'hostId' | 'worktree' | 'argv'>> {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'ssh') {
    fail('worktree_exec_wrong_host')
  }
  const connection = getSshConnectionManager()?.getConnection(host.targetId)
  if (!connection || connection.getState().status !== 'connected') {
    fail('worktree_exec_host_disconnected')
  }
  const env = Object.entries(request.env).map(([key, value]) => quotePosix(`${key}=${value}`))
  const command = `cd ${quotePosix(worktree.path)} && exec env ${env.length ? `${env.join(' ')} ` : ''}${request.argv.map(quotePosix).join(' ')}`
  return runSshChannel(connection, command, request.timeoutMs, request.maxOutputBytes)
}

function runSshChannel(
  connection: SshConnection,
  command: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<Omit<WorktreeExecResult, 'hostId' | 'worktree' | 'argv'>> {
  const { promise, resolve, reject } =
    Promise.withResolvers<Omit<WorktreeExecResult, 'hostId' | 'worktree' | 'argv'>>()
  void connection.exec(command).then((channel) => {
    const output = outputCollector(maxOutputBytes)
    let settled = false
    const timer = setTimeout(() => finishError('worktree_exec_timeout'), timeoutMs)
    const finishError = (message: string) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      channel.close()
      reject(new Error(message))
    }
    channel.on('data', (chunk: Buffer | string) => {
      if (!output.add('stdout', chunk)) {
        finishError('worktree_exec_output_limit_exceeded')
      }
    })
    channel.stderr.on('data', (chunk: Buffer | string) => {
      if (!output.add('stderr', chunk)) {
        finishError('worktree_exec_output_limit_exceeded')
      }
    })
    channel.once('error', (error) => finishError(error.message))
    channel.stderr.once('error', (error) => finishError(error.message))
    channel.once('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ ...output.result(), exitCode: code ?? 128 })
    })
  }, reject)
  return promise
}

export async function executeWorktreeCommand(
  runtime: { showManagedWorktree(selector: string): Promise<RuntimeWorktreeRecord> },
  request: WorktreeExecRequest
): Promise<WorktreeExecResult> {
  validateRequest(request)
  const requestedHost = parseExecutionHostId(request.hostId)
  if (!requestedHost) {
    fail('worktree_exec_invalid_host')
  }
  const worktree = await runtime.showManagedWorktree(request.worktree)
  const actualHost = worktree.hostId ?? LOCAL_EXECUTION_HOST_ID
  const targetHostId =
    requestedHost.kind === 'runtime' && actualHost === LOCAL_EXECUTION_HOST_ID
      ? actualHost
      : requestedHost.id
  if (actualHost !== targetHostId) {
    fail('worktree_exec_wrong_host')
  }
  const result =
    requestedHost.kind === 'ssh'
      ? await runSsh(requestedHost.id, worktree, request)
      : await runLocal(worktree, request)
  return {
    hostId: requestedHost.id,
    worktree: worktree.path,
    argv: request.argv,
    ...result
  }
}
