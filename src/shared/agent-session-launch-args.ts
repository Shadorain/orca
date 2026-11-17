import type { AgentSessionLaunchArgs } from './agent-session-record'

const MAX_LAUNCH_ARGS = 256
const MAX_LAUNCH_ARGS_BYTES = 16 * 1024

/** Arguments pinned on a record's first reservation, bounded before they are persisted. */
export function isAgentSessionLaunchArgs(value: unknown): value is AgentSessionLaunchArgs {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LAUNCH_ARGS &&
    value.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_LAUNCH_ARGS_BYTES
  )
}

export type OmpProviderStartup = {
  config?: string
  appendSystemPrompt?: string
  sessionDir?: string
  mode?: string
}

/** Args the OMP child is spawned with, and the mode option restored on the next acquire. */
export function ompProviderStartup(input: OmpProviderStartup): {
  launchArgs: string[]
  options: Record<string, string>
} {
  const launchArgs: string[] = []
  if (input.config) {
    launchArgs.push('--config', input.config)
  }
  if (input.appendSystemPrompt) {
    launchArgs.push('--append-system-prompt', input.appendSystemPrompt)
  }
  if (input.sessionDir) {
    launchArgs.push('--session-dir', input.sessionDir)
  }
  return {
    launchArgs,
    ...(input.mode ? { options: { mode: input.mode } } : { options: {} })
  }
}

/** Repeated `--env` entries. The first `=` separates the key; commas, newlines and later `=` stay in the value. */
export function parseRepeatedLaunchEnv(
  value: string,
  separator = '\u0000'
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of value.split(separator)) {
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      throw new Error(`Malformed env entry: ${pair}`)
    }
    const key = pair.slice(0, eq)
    if (Object.hasOwn(env, key)) {
      throw new Error(`Duplicate env key: ${key}`)
    }
    env[key] = pair.slice(eq + 1)
  }
  return env
}
