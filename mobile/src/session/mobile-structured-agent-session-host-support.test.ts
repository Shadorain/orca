import { describe, expect, it } from 'vitest'
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
import {
  lastStructuredAgentSessionHostSupport,
  rememberStructuredAgentSessionHostSupport,
  structuredAgentSessionHostSupport
} from './mobile-structured-agent-session-host-support'

describe('structuredAgentSessionHostSupport', () => {
  it('reads each structured-session feature from the host capability list', () => {
    const none = {
      promptCancel: false,
      questionAnswers: false,
      queuedMessages: false,
      queuedCommands: false,
      quietRepeatedStop: false,
      statusFeed: false,
      hostPathFiles: false
    }
    expect(structuredAgentSessionHostSupport([])).toEqual(none)
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, questionAnswers: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, promptCancel: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, queuedMessages: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, queuedCommands: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, quietRepeatedStop: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, statusFeed: true })
    expect(structuredAgentSessionHostSupport([FILES_HOST_PATH_RUNTIME_CAPABILITY])).toEqual({
      ...none,
      hostPathFiles: true
    })
  })

  it("keeps each client's last probe answer until the next one replaces it", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the client's identity is read.
    const client = {} as RpcClient
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the client's identity is read.
    const otherClient = {} as RpcClient
    expect(lastStructuredAgentSessionHostSupport(client)).toBeNull()
    const capable = structuredAgentSessionHostSupport([FILES_HOST_PATH_RUNTIME_CAPABILITY])
    rememberStructuredAgentSessionHostSupport(client, capable)
    expect(lastStructuredAgentSessionHostSupport(client)).toBe(capable)
    expect(lastStructuredAgentSessionHostSupport(otherClient)).toBeNull()
    const older = structuredAgentSessionHostSupport([])
    rememberStructuredAgentSessionHostSupport(client, older)
    expect(lastStructuredAgentSessionHostSupport(client)).toBe(older)
  })
})
