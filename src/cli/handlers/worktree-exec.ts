import type { CommandHandler } from '../dispatch'
import { resolveHostFlagTarget } from '../execution-host-flag'
import {
  getOptionalPositiveIntegerFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

type WorktreeExecResult = {
  hostId: string
  worktree: string
  argv: string[]
  stdout: string
  stderr: string
  exitCode: number
}

export const worktreeExecHandler: CommandHandler = async ({ flags, client, json, rawArgs }) => {
  if (!json) {
    throw new RuntimeClientError('invalid_argument', 'worktree exec requires --json')
  }
  const separator = rawArgs.indexOf('--')
  const argv = separator === -1 ? [] : rawArgs.slice(separator + 1)
  if (argv.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'worktree exec requires -- <argv...>')
  }
  const host = await resolveHostFlagTarget(flags, client)
  if (!host) {
    throw new RuntimeClientError('invalid_argument', 'worktree exec requires an explicit --host')
  }
  const worktree = getRequiredStringFlag(flags, 'worktree')
  if (!worktree.startsWith('path:') || worktree.length === 5) {
    throw new RuntimeClientError(
      'invalid_argument',
      'worktree exec requires --worktree path:<exact-registered-path>'
    )
  }
  const env: Record<string, string> = {}
  for (const entry of getRepeatedStringFlag(flags, 'env')) {
    const equals = entry.indexOf('=')
    const key = entry.slice(0, equals)
    if (equals < 1 || Object.hasOwn(env, key)) {
      throw new RuntimeClientError('invalid_argument', `Invalid or duplicate --env value: ${entry}`)
    }
    env[key] = entry.slice(equals + 1)
  }
  const result = await client.call<WorktreeExecResult>('worktree.exec', {
    hostId: host.id,
    worktree,
    argv,
    env,
    timeoutMs: getOptionalPositiveIntegerFlag(flags, 'timeout-ms') ?? 10_000,
    maxOutputBytes: getOptionalPositiveIntegerFlag(flags, 'max-output-bytes') ?? 1024 * 1024
  })
  printResult(result, json, () => '')
}
