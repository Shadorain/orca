// `agentSession.reveal` — republishing the tab for a chat that still exists on disk.
//
// A surface can hold nothing but a session id: an Agent Session History row names a chat this
// process may never have published, because `close` keeps the record and the journal but not the
// tab, and a client drops every unpublished `agent-session` tab on each session-tabs sync. Without
// this the row is unreachable, and the client's "retry in a moment" is advice that never comes true.
//
// Distinct from `agentSession.ensure`, which attaches a location the CLIENT supplies. Here the host
// reads its own record and answers with that record's workspace and provider, so a client knowing
// only a session id cannot aim the publication somewhere else.

import {
  agentSessionRefusalFromReference,
  isAgentSessionRefusalError,
  isAgentSessionWireRefusalCode
} from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionReveal } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import {
  isStructuredSessionIdentity,
  assertSessionIdentityMatch,
  structuredSessionIdentity,
  type StructuredSessionIdentity,
  type StructuredSessionIdentityOmission
} from '../../structured-session-identity'
import { refuseAgentSessionMutation } from '../../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredAgentAudience,
  requireStructuredHost
} from './structured-agent-session-gate'
import { OptionsParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_REVEAL_METHODS = [
  defineMethod({
    name: 'agentSession.reveal',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureStructuredHostInstalled(ctx)
      let revealed: StructuredAgentSessionReveal
      let identity: StructuredSessionIdentity | StructuredSessionIdentityOmission | null = null
      try {
        const host = requireStructuredHost(ctx)
        requireStructuredAgentAudience(ctx, host.sessionAgent(params.sessionId) ?? '')
        if (
          params.executionHostId !== undefined ||
          params.worktreeId !== undefined ||
          params.incarnation !== undefined
        ) {
          const record = host.deps.store.getRecord(params.sessionId)
          identity = record
            ? structuredSessionIdentity(
                record,
                await ctx.runtime.listRegisteredWorkspacePaths(),
                host.sessionLiveness(params.sessionId)
              )
            : null
          if (!identity || !isStructuredSessionIdentity(identity)) {
            throw new Error('worktree_path_unresolved')
          }
          assertSessionIdentityMatch(identity, params)
        }
        revealed = await host.revealSession(params.sessionId)
      } catch (error) {
        if (error instanceof Error && error.message === 'worktree_path_unresolved') {
          throw error
        }
        // The host raises its refusal as the code itself; anything else is a genuine fault and
        // must not be laundered into a tidy "no such chat".
        const code = error instanceof Error ? error.message : ''
        if (!isAgentSessionWireRefusalCode(code)) {
          throw error
        }
        return refuseAgentSessionMutation(
          agentSessionRefusalFromReference(
            isAgentSessionRefusalError(error) ? error.refusal : { code },
            code === 'structured_agent_session_unsupported'
              ? 'This host cannot open that chat.'
              : 'This chat is no longer on this host.'
          )
        )
      }
      await ctx.runtime.publishStructuredAgentSessionTab({
        workspaceId: revealed.workspaceId,
        sessionId: revealed.sessionId,
        agent: revealed.agent,
        activate: true
      })
      return { ok: true as const, ...revealed, ...identity }
    }
  })
]
