import { open } from 'node:fs/promises'
import { assertLocalTerminalArtifactPathStillCanonical } from './runtime-file-commands-terminal-file-paths'
import { localTerminalArtifactContentDigest } from './runtime-terminal-artifact-integrity'
import type { RuntimeFileStatLike } from './runtime-terminal-file-grants'

/** Stat and content digest come from one handle to retain the existing swap protection. */
export async function statLocalTerminalArtifact(absolutePath: string): Promise<{
  stats: RuntimeFileStatLike & { isDirectory: () => boolean }
  contentDigest: string | null
}> {
  await assertLocalTerminalArtifactPathStillCanonical(absolutePath)
  const handle = await open(absolutePath, 'r')
  try {
    const stats = await handle.stat()
    const contentDigest = stats.isDirectory()
      ? null
      : await localTerminalArtifactContentDigest(handle, stats.size)
    return { stats, contentDigest }
  } finally {
    await handle.close()
  }
}
