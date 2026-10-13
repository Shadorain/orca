import { useCallback, useSyncExternalStore } from 'react'
import type { AgentSessionStatusSummary } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

const noSubscription = (): (() => void) => () => {}

/**
 * One value of what the host's status stream says about session `sessionId`, the same stream and
 * summary the desktop chat reads. `read` gets undefined while the host has said nothing; it must
 * return a primitive so an unrelated status change does not re-render. `enabled` carries the
 * host's status-feed capability; off it, nothing is opened.
 */
export function useMobileStructuredSessionStatusValue<Value extends string | boolean | null>(
  args: { client: RpcClient | null; sessionId: string | null; enabled: boolean },
  read: (summary: AgentSessionStatusSummary | undefined) => Value
): Value {
  const { client, sessionId, enabled } = args
  const feed = enabled && client && sessionId ? mobileStructuredSessionStatusFeed(client) : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const readValue = (): Value =>
    read(feed && sessionId ? feed.getSnapshot().get(sessionId) : undefined)
  return useSyncExternalStore(subscribe, readValue, readValue)
}
