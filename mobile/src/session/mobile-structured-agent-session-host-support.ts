import {
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { FILES_HOST_PATH_RUNTIME_CAPABILITY } from '../../../src/shared/runtime-file-contracts'
import type { RpcClient } from '../transport/rpc-client'

/** Structured-session features the connected host advertised; null until the status probe answers. */
export type StructuredAgentSessionHostSupport = {
  promptCancel: boolean
  questionAnswers: boolean
  /** Mid-turn sends queue as host-held drafts; an older host keeps today's immediate path. */
  queuedMessages: boolean
  /** A /compact sent while the agent works waits as a card; an older host refuses it. */
  queuedCommands: boolean
  /** The host publishes every session's status on one stream. A host from before phones could
   *  read it refuses the call, which reads the same as its absence. */
  statusFeed: boolean
  /** A Stop that stopped nothing adds no row, so a repeated Stop is quiet. */
  quietRepeatedStop: boolean
  /** The host reads a file by its own path, a chat's visuals included; an older host reads a
   *  visual only through the session-scoped reader. */
  hostPathFiles: boolean
}

export function structuredAgentSessionHostSupport(
  capabilities: readonly string[]
): StructuredAgentSessionHostSupport {
  return {
    promptCancel: capabilities.includes(AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY),
    questionAnswers: capabilities.includes(AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY),
    queuedMessages: capabilities.includes(AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY),
    queuedCommands: capabilities.includes(AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY),
    statusFeed: capabilities.includes(AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY),
    quietRepeatedStop: capabilities.includes(AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY),
    hostPathFiles: capabilities.includes(FILES_HOST_PATH_RUNTIME_CAPABILITY)
  }
}

// Why kept per client across lost contact: the route forgets support on every disconnect, but the
// host behind a client keeps its features, and a reader that flipped back to an older call on each
// reconnect would re-fetch everything on screen. In memory only; the next probe answer replaces it.
const lastAnsweredSupport = new WeakMap<RpcClient, StructuredAgentSessionHostSupport>()

/** Records what the host behind `client` answered to the capability probe. */
export function rememberStructuredAgentSessionHostSupport(
  client: RpcClient,
  support: StructuredAgentSessionHostSupport
): void {
  lastAnsweredSupport.set(client, support)
}

/** The last probe answer for the host behind `client`, or null before it has ever answered. */
export function lastStructuredAgentSessionHostSupport(
  client: RpcClient
): StructuredAgentSessionHostSupport | null {
  return lastAnsweredSupport.get(client) ?? null
}
