import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import {
  rememberStructuredAgentSessionHostSupport,
  structuredAgentSessionHostSupport,
  type StructuredAgentSessionHostSupport
} from './mobile-structured-agent-session-host-support'
import { resetMobileNativeChatVisualCacheForTest } from './mobile-native-chat-visual-read'
import {
  useMobileNativeChatVisual,
  type MobileNativeChatVisualState
} from './use-mobile-native-chat-visual'
import { useMobileNativeChatVisualSource } from './use-mobile-native-chat-visual-source'

const CAPABLE: StructuredAgentSessionHostSupport = {
  ...structuredAgentSessionHostSupport([]),
  statusFeed: true,
  hostPathFiles: true
}
const NOT_CAPABLE: StructuredAgentSessionHostSupport = { ...CAPABLE, hostPathFiles: false }
const FOLDER = '/home/me/.orca/scratch/0123456789abcdef0123456789abcdef'

const SUMMARY: AgentSessionStatusSummary = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  agent: 'claude',
  status: 'idle',
  latestPrompt: 'draw it',
  updatedAt: 1,
  scratchDirectory: FOLDER
}

function reply(method: string): RpcResponse {
  return method === 'files.read'
    ? {
        id: '1',
        ok: true,
        result: { path: `${FOLDER}/chart.html`, content: '<p>', truncated: false, byteLength: 3 }
      }
    : {
        id: '1',
        ok: true,
        result: { ok: true, revision: 'a'.repeat(32), sizeBytes: 3, html: '<p>' }
      }
}

// The route nulls its capability answer on every disconnect and until the probe answers again.
describe('a shown chat visual across a reconnect', () => {
  let frames: ((value: unknown) => void)[]
  let client: RpcClient
  let sendRequest: ReturnType<typeof vi.fn>
  let renderer: ReactTestRenderer | null = null
  let latest: MobileNativeChatVisualState | null = null

  beforeEach(() => {
    frames = []
    sendRequest = vi.fn(async (method: string) => reply(method))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the visual reaches the client only through sendRequest, subscribe and onStateChange.
    client = {
      sendRequest,
      subscribe: vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
        frames.push(onData)
        return () => {}
      }),
      onStateChange: (_listener: (state: ConnectionState) => void) => () => {}
    } as unknown as RpcClient
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    latest = null
    resetMobileNativeChatVisualCacheForTest()
  })

  function Visual({ hostSupport }: { hostSupport: StructuredAgentSessionHostSupport | null }) {
    const source = useMobileNativeChatVisualSource({ client, sessionId: 'session-1', hostSupport })
    return source ? createElement(Reader, { source }) : null
  }

  function Reader({
    source
  }: {
    source: NonNullable<ReturnType<typeof useMobileNativeChatVisualSource>>
  }) {
    latest = useMobileNativeChatVisual(source, 'chart.html').state
    return null
  }

  // What the route does when the probe answers: remember it for the client, then publish it.
  async function probeAnswers(support: StructuredAgentSessionHostSupport): Promise<void> {
    rememberStructuredAgentSessionHostSupport(client, support)
    await render(support)
  }

  async function render(hostSupport: StructuredAgentSessionHostSupport | null): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Visual, { hostSupport }))
      } else {
        renderer = create(createElement(Visual, { hostSupport }))
      }
    })
  }

  async function shownByPath(): Promise<void> {
    await probeAnswers(CAPABLE)
    await act(async () => {
      for (const onData of frames) {
        onData({ type: 'snapshot', sessions: [SUMMARY] })
      }
    })
    expect(latest).toEqual({ kind: 'ready', html: '<p>' })
    sendRequest.mockClear()
  }

  it('keeps reading by path, and reads nothing again, while the probe is unanswered', async () => {
    await shownByPath()
    await render(null) // disconnected, then reconnected before the probe answers
    await render(CAPABLE) // the probe answers the same
    expect(sendRequest).not.toHaveBeenCalled()
    expect(latest).toEqual({ kind: 'ready', html: '<p>' })
  })

  it('switches to the session reader when the reconnected host is no longer capable', async () => {
    await shownByPath()
    await render(null)
    await probeAnswers(NOT_CAPABLE)
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual(['agentSession.readVisual'])
    expect(latest).toEqual({ kind: 'ready', html: '<p>' })
  })
})
