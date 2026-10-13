import { useMemo } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  lastStructuredAgentSessionHostSupport,
  type StructuredAgentSessionHostSupport
} from './mobile-structured-agent-session-host-support'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import { useMobileStructuredSessionStatusValue } from './use-mobile-structured-session-status-value'

/**
 * Where this structured chat's visuals are read: as ordinary files in the folder its host
 * publishes for it when the host reads files by path, otherwise through the session-scoped
 * reader. The folder is the host's word, never derived here; null without a client or chat.
 */
export function useMobileNativeChatVisualSource(args: {
  client: RpcClient | null
  sessionId: string | null
  hostSupport: StructuredAgentSessionHostSupport | null
}): MobileNativeChatVisualSource | null {
  const { client, sessionId } = args
  // Support is unknown while reconnecting; the host's last answer holds until the probe answers
  // again, so a shown visual is not read again through the session-scoped reader.
  const hostSupport =
    args.hostSupport ?? (client ? lastStructuredAgentSessionHostSupport(client) : null)
  const scratchDirectory = useMobileStructuredSessionStatusValue(
    {
      client,
      sessionId,
      enabled: hostSupport?.statusFeed === true && hostSupport.hostPathFiles
    },
    (summary) => summary?.scratchDirectory ?? null
  )
  return useMemo(
    () => (client && sessionId ? { client, sessionId, scratchDirectory } : null),
    [client, sessionId, scratchDirectory]
  )
}
