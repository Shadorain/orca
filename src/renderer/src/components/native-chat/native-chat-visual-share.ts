// Share on a chat visual. The visual is an ordinary file on the chat's host, so it publishes under
// that file's key: sharing from the visual, its editor, preview or browser tab updates one link.

import type { ArtifactWriteRequest } from '../../../../shared/artifacts'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import { fileArtifactSourceKey } from '@/lib/file-artifact-source-key'
import { getRuntimeTargetHostId, runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import {
  markNativeChatVisualReads,
  readNativeChatVisualFile,
  type NativeChatVisualFile
} from './native-chat-visual-path-read-client'

export function nativeChatVisualArtifactSourceKey(file: NativeChatVisualFile): string {
  return fileArtifactSourceKey(
    {
      executionHostId: getRuntimeTargetHostId(file.target),
      runtimeEnvironmentId: runtimeTargetEnvironmentId(file.target)
    },
    file.path
  )
}

/**
 * Reads the saved file once, begun after the click, and publishes that text. `onReadStarted` gets
 * the read mark taken just before, so the frame can show the same read instead of starting its own.
 */
export async function readNativeChatVisualArtifactRequest(
  file: NativeChatVisualFile,
  onReadStarted: (startedAfter: number) => void
): Promise<ArtifactWriteRequest> {
  const startedAfter = markNativeChatVisualReads()
  const read = readNativeChatVisualFile(file, { startedAfter })
  onReadStarted(startedAfter)
  const outcome = await read
  if (!outcome.ok) {
    throw new ArtifactPublishPreparationError('visual-unreadable')
  }
  return {
    sourceKey: nativeChatVisualArtifactSourceKey(file),
    content: outcome.page.html,
    contentType: 'text/html',
    fileName: getRuntimePathBasename(file.path)
  }
}
