import { z } from 'zod'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../src/shared/local-file-access'
import { NATIVE_CHAT_VISUAL_MAX_BYTES } from '../../../src/shared/native-chat-visual-directive'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure } from '../transport/types'

export type MobileNativeChatVisualFileRead =
  | { kind: 'ready'; html: string }
  /** The host answered about the file: missing, refused, not a page, too large. */
  | { kind: 'refused' }
  /** No verdict: no answer, a host fault, an unreadable answer. Worth asking again. */
  | { kind: 'unreachable' }

const visualFileReplySchema = z.looseObject({
  content: z.string().max(NATIVE_CHAT_VISUAL_MAX_BYTES),
  truncated: z.boolean().optional()
})

/** `files.read` by host path with the read-only `chat-visual` access; an error reply stays raw. */
const nativeChatVisualFileRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.chat-visual-read',
    method: 'files.read',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('native-chat-visual-file', visualFileReplySchema)
  })
)

const READ_TIMEOUT_MS = 15_000

// The host's ordinary read refusals for this access, as the phone's file preview matches them;
// a thrown host fault (`visual_read_failed:<code>`) or a timeout is no verdict on the file.
const REFUSAL_MESSAGES = [
  'enoent',
  PATH_OUTSIDE_ALLOWED_DIRECTORIES.toLowerCase(),
  'not a regular file',
  'file_too_large',
  'binary_file'
] as const

function isVisualFileRefusal(error: RpcFailure['error']): boolean {
  if (isMobileMethodUnavailableError(error.code, error.message)) {
    return true
  }
  // The host's schema or owner check refused the request itself; asking again will not help.
  if (error.code === 'invalid_argument') {
    return true
  }
  const message = error.message.toLowerCase()
  return REFUSAL_MESSAGES.some((refusal) => message.includes(refusal))
}

/** Reads one visual as an ordinary file at `path` on the host `client` reaches. */
export async function readMobileNativeChatVisualFile(
  client: RpcClient,
  path: string
): Promise<MobileNativeChatVisualFileRead> {
  let response
  try {
    response = await nativeChatVisualFileRead.request(
      client,
      { path, access: { kind: 'chat-visual' } },
      { timeoutMs: READ_TIMEOUT_MS, budgetSpansConnect: true }
    )
  } catch {
    return { kind: 'unreachable' }
  }
  if (!response.ok) {
    return isVisualFileRefusal(response.error) ? { kind: 'refused' } : { kind: 'unreachable' }
  }
  const reply = nativeChatVisualFileRead.interpret(response)
  if (reply === null) {
    return { kind: 'unreachable' }
  }
  // A cut page is not the page; the host's cap equals the visual cap, so this means it grew.
  if (reply.truncated === true) {
    return { kind: 'refused' }
  }
  return { kind: 'ready', html: reply.content }
}
