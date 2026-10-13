import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredSessionStatusValue } from './use-mobile-structured-session-status-value'

/**
 * Whether the host says a person's Stop is ending session `sessionId`'s turn: the same status
 * stream and field the desktop chat reads. `enabled` carries the host's status-feed capability
 * and a live connection; off it, nothing is opened and nothing reads as stopping.
 */
export function useMobileStructuredSessionHostStopping(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
}): boolean {
  return useMobileStructuredSessionStatusValue(
    args,
    (summary) => summary?.status === 'working' && summary.stopping === true
  )
}
