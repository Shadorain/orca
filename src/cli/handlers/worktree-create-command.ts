import { RuntimeClientError } from '../runtime-client'

export function readWorktreeStartupCommand(
  flags: Map<string, string | boolean>
): string | undefined {
  if (!flags.has('command')) {
    return undefined
  }
  const command = flags.get('command')
  if (typeof command !== 'string' || !command.trim()) {
    throw new RuntimeClientError('invalid_argument', '--command requires a non-empty value')
  }
  if (['agent', 'prompt', 'model', 'effort', 'retry-launch'].some((key) => flags.has(key))) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--command cannot be combined with agent launch flags'
    )
  }
  return command
}
