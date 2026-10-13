import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  structuredAgentSessionHostSupport,
  type StructuredAgentSessionHostSupport
} from './mobile-structured-agent-session-host-support'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import { useMobileNativeChatVisualSource } from './use-mobile-native-chat-visual-source'
import { FLOATING_WORKSPACE_WORKTREE_ID } from './floating-workspace'

const CAPABLE: StructuredAgentSessionHostSupport = {
  ...structuredAgentSessionHostSupport([]),
  statusFeed: true,
  hostPathFiles: true
}
const FOLDER = '/home/me/.orca/scratch/0123456789abcdef0123456789abcdef'

function summary(fields: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    agent: 'claude',
    status: 'idle',
    latestPrompt: 'draw it',
    updatedAt: 1,
    ...fields
  }
}

describe('useMobileNativeChatVisualSource', () => {
  let frames: ((value: unknown) => void)[]
  let client: RpcClient
  let renderer: ReactTestRenderer | null = null
  let latest: MobileNativeChatVisualSource | null = null

  beforeEach(() => {
    frames = []
    // A fresh client per test: the status stream is one per client for its life.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the feed reaches the client only through subscribe and onStateChange.
    client = {
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
  })

  function Probe({ hostSupport }: { hostSupport: StructuredAgentSessionHostSupport | null }) {
    latest = useMobileNativeChatVisualSource({ client, sessionId: 'session-1', hostSupport })
    return null
  }

  function mount(hostSupport: StructuredAgentSessionHostSupport | null): void {
    act(() => {
      renderer = create(createElement(Probe, { hostSupport }))
    })
  }

  function publish(sessions: AgentSessionStatusSummary[]): void {
    act(() => {
      for (const onData of frames) {
        onData({ type: 'snapshot', sessions })
      }
    })
  }

  it('reads by path in the folder a capable host publishes for the chat', () => {
    mount(CAPABLE)
    expect(latest?.scratchDirectory).toBeNull()
    publish([summary({ scratchDirectory: FOLDER })])
    expect(latest).toEqual({ client, sessionId: 'session-1', scratchDirectory: FOLDER })
  })

  it('uses the scratch folder for a floating chat, not its workspace or pinned folder', () => {
    mount(CAPABLE)
    publish([
      summary({
        workspaceId: FLOATING_WORKSPACE_WORKTREE_ID,
        launchDirectory: '/home/me/notes',
        scratchDirectory: FOLDER
      })
    ])
    expect(latest?.scratchDirectory).toBe(FOLDER)
  })

  it('keeps the session reader where the host publishes no folder for the chat', () => {
    mount(CAPABLE)
    // Pi, WSL, or a host that predates the field.
    publish([summary()])
    expect(latest).toEqual({ client, sessionId: 'session-1', scratchDirectory: null })
  })

  it('keeps the session reader on a host without path reads, without opening its status stream', () => {
    mount({ ...CAPABLE, hostPathFiles: false })
    expect(client.subscribe).not.toHaveBeenCalled()
    expect(latest).toEqual({ client, sessionId: 'session-1', scratchDirectory: null })
  })

  it('keeps the session reader on a host without the status stream', () => {
    mount({ ...CAPABLE, statusFeed: false })
    expect(client.subscribe).not.toHaveBeenCalled()
    expect(latest?.scratchDirectory).toBeNull()
  })

  it('keeps the session reader until the capability probe answers', () => {
    mount(null)
    expect(client.subscribe).not.toHaveBeenCalled()
    expect(latest?.scratchDirectory).toBeNull()
  })

  it('keeps the same source object across status changes that do not move the folder', () => {
    mount(CAPABLE)
    publish([summary({ scratchDirectory: FOLDER })])
    const first = latest
    publish([summary({ scratchDirectory: FOLDER, status: 'working', updatedAt: 2 })])
    expect(latest).toBe(first)
  })
})
