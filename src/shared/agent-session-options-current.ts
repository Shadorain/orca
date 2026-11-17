import type { AgentSessionFastModeState } from './agent-session-wire'

export type AgentSessionOptionsCurrent = {
  model?: string
  effort?: string
  /** Canonical preference for the next turn. Explicit false is meaningful. */
  fastMode?: boolean
  /** Next-turn service tier id where the model lists `serviceTiers`; `default` is standard. */
  serviceTier?: string
  /** The permission mode a start runs now; absent from a host or agent with no picker. */
  permissionMode?: string
  /** The agent's own mode (OMP's default/plan); absent from an agent that offers none. */
  mode?: string
  /** Provider-reported effective routing, distinct from the next-turn preference. */
  fastModeState?: AgentSessionFastModeState
  /**
   * Option ids whose value the provider reported back, not merely accepted.
   * Absent from older hosts, where the client must keep the value unconfirmed.
   */
  confirmed?: readonly string[]
}
