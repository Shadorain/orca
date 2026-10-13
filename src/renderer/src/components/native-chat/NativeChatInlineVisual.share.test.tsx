// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('@/components/artifacts/artifact-published-link-client', () => ({
  getPublishedArtifactLink: () => Promise.resolve(null)
}))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

import { NativeChatMarkdown } from './NativeChatMarkdown'
import {
  NativeChatVisualOwnerContext,
  NativeChatVisualReadingContext,
  type NativeChatVisualOwner,
  type NativeChatVisualReadRoute,
  type NativeChatVisualReading
} from './native-chat-visual-owner'
import { createNativeChatVisualRefresh } from './native-chat-visual-refresh'
import { clearNativeChatVisualCacheForTests } from './native-chat-visual-read-client'
import { clearNativeChatVisualFileCacheForTests } from './native-chat-visual-path-read-client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'

const FOLDER = '/state/chat-scratch/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PATH = `${FOLDER}/usage.html`
const LINE = '::orca-visual{file="usage.html" title="Usage"}'
const SHARE = { name: 'Share as artifact' }
const OPEN = { name: 'Open in new tab' }
const LOCAL: RuntimeClientTarget = { kind: 'local' }
const PAIRED: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-1' }

const readFile = vi.fn()
let hostRead: (params: unknown) => Promise<unknown> = () => Promise.reject(new Error('unset'))

class VisibleObserver {
  constructor(private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true }])
  }
  unobserve(): void {}
  disconnect(): void {}
}

const owners = new Map<string, NativeChatVisualOwner>()
// One owner per host, as the provider memoizes it.
function ownerFor(target: RuntimeClientTarget): NativeChatVisualOwner {
  const key = JSON.stringify(target)
  const owner = owners.get(key) ?? {
    target,
    sessionId: 'session-alpha',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID
  }
  owners.set(key, owner)
  return owner
}

function readingFor(route: NativeChatVisualReadRoute | null): NativeChatVisualReading | null {
  return route ? { route, refresh: createNativeChatVisualRefresh() } : null
}

function chat(target: RuntimeClientTarget, route: NativeChatVisualReadRoute | null): ReactNode {
  const owner = ownerFor(target)
  const reading = readingFor(route)
  return (
    <TooltipProvider>
      <NativeChatVisualOwnerContext.Provider value={owner}>
        <NativeChatVisualReadingContext.Provider value={reading}>
          <NativeChatMarkdown content={LINE} visualMessageId="m1" />
        </NativeChatVisualReadingContext.Provider>
      </NativeChatVisualOwnerContext.Provider>
    </TooltipProvider>
  )
}

const FILE_ROUTE: NativeChatVisualReadRoute = { kind: 'file', scratchDirectory: FOLDER }

function page(html: string): { content: string; isBinary: boolean } {
  return { content: html, isBinary: false }
}

function frameSource(container: HTMLElement): string {
  return container.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
}

function publishCalls(): unknown[][] {
  return callRuntimeRpc.mock.calls.filter((call) => call[1] === 'artifacts.publish')
}

async function shownVisual(target: RuntimeClientTarget): Promise<HTMLElement> {
  const { container } = render(chat(target, FILE_ROUTE))
  await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
  return container
}

async function generateLink(): Promise<void> {
  fireEvent.click(screen.getByRole('button', SHARE))
  fireEvent.click(await screen.findByRole('button', { name: 'Generate link' }))
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', VisibleObserver)
  vi.stubGlobal('api', { fs: { readFile } })
  clearNativeChatVisualCacheForTests()
  clearNativeChatVisualFileCacheForTests()
  readFile.mockReset()
  readFile.mockResolvedValue(page('<p>first</p>'))
  hostRead = () => Promise.resolve({ path: PATH, content: '<p>first</p>' })
  toastError.mockReset()
  callRuntimeRpc.mockReset()
  callRuntimeRpc.mockImplementation((_target: unknown, method: string, params: unknown) => {
    if (method === 'files.read') {
      return hostRead(params)
    }
    if (method === 'artifacts.publish') {
      return Promise.resolve({
        status: 'ok',
        value: { change: 'created', item: { shareUrl: 'https://example.test/a' } }
      })
    }
    return Promise.reject(new Error(`unexpected ${method}`))
  })
  useAppStore.setState({
    orcaProfileAuthStatus: {
      activeProfileId: 'p1',
      configured: true,
      state: 'connected',
      persistence: 'none'
    },
    settings: { ...getDefaultSettings('/tmp'), artifactSharingEnabled: true }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('inline visual Share', () => {
  it.each([
    ['this computer', LOCAL],
    ['a paired or SSH host', PAIRED]
  ])('is offered beside Open for a chat on %s, styled like Open', async (_, target) => {
    await shownVisual(target)
    const open = screen.getByRole('button', OPEN)
    const share = screen.getByRole('button', SHARE)
    expect(open).toHaveAttribute('data-variant', 'outline')
    expect(open).toHaveAttribute('data-size', 'icon-xs')
    expect(share).toHaveAttribute('data-variant', 'outline')
    expect(share).toHaveAttribute('data-size', 'icon-xs')
  })

  it.each([
    ['an older host', { kind: 'legacy' } as const],
    ['a host without a published folder', null]
  ])('is not offered for %s, which keeps Open', async (_, route) => {
    callRuntimeRpc.mockResolvedValue({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>o</p>' })
    const { container } = render(chat(PAIRED, route))
    await waitFor(() => expect(frameSource(container)).toContain('<p>o</p>'))
    expect(screen.getByRole('button', OPEN)).toBeInTheDocument()
    expect(screen.queryByRole('button', SHARE)).toBeNull()
  })

  it('publishes the file as saved after it was shown, from one read the frame also shows', async () => {
    const container = await shownVisual(LOCAL)
    let finishRead: (value: unknown) => void = () => {}
    readFile.mockReturnValue(new Promise((resolve) => (finishRead = resolve)))

    await generateLink()
    finishRead(page('<p>rewritten</p>'))

    await waitFor(() => expect(publishCalls()).toHaveLength(1))
    expect(publishCalls()[0]).toEqual([
      { kind: 'local' },
      'artifacts.publish',
      {
        sourceKey: PATH,
        content: '<p>rewritten</p>',
        contentType: 'text/html',
        fileName: 'usage.html'
      }
    ])
    await waitFor(() => expect(frameSource(container)).toContain('<p>rewritten</p>'))
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it("reads a host chat's file on its host when sharing", async () => {
    await shownVisual(PAIRED)
    hostRead = () => Promise.resolve({ path: PATH, content: '<p>host</p>' })
    await generateLink()
    await waitFor(() => expect(publishCalls()).toHaveLength(1))
    expect(publishCalls()[0]?.[2]).toMatchObject({
      sourceKey: JSON.stringify(['editor', 'env-1', 'runtime:env-1', PATH]),
      content: '<p>host</p>'
    })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('reports a host out of reach and keeps the page shown', async () => {
    const container = await shownVisual(PAIRED)
    hostRead = () => Promise.reject(new Error('Runtime environment is not connected'))
    await generateLink()
    await waitFor(() => expect(toastError).toHaveBeenCalledOnce())
    expect(toastError).toHaveBeenCalledWith('Could not share artifact', {
      description: "Couldn't read this visual to share it."
    })
    expect(publishCalls()).toHaveLength(0)
    expect(frameSource(container)).toContain('<p>first</p>')
  })

  it('reports a file that is gone without publishing anything', async () => {
    await shownVisual(LOCAL)
    readFile.mockRejectedValue(new Error('ENOENT: no such file or directory'))
    await generateLink()
    await waitFor(() => expect(toastError).toHaveBeenCalledOnce())
    expect(publishCalls()).toHaveLength(0)
  })

  it('drops an open Share when path reads stop, and does not reopen it when they return', async () => {
    const view = render(chat(PAIRED, FILE_ROUTE))
    await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', SHARE))
    await screen.findByRole('button', { name: 'Generate link' })
    const toolbar = (): Element | null =>
      screen.getByRole('button', OPEN).closest('[data-share-open]')
    expect(toolbar()).toHaveAttribute('data-share-open', 'true')

    // The host's re-probe is still running: the page stays, Share is not offered.
    view.rerender(chat(PAIRED, { kind: 'pending', scratchDirectory: FOLDER }))
    expect(screen.queryByRole('button', SHARE)).toBeNull()
    expect(toolbar()).toHaveAttribute('data-share-open', 'false')

    view.rerender(chat(PAIRED, FILE_ROUTE))
    expect(screen.getByRole('button', SHARE)).toBeInTheDocument()
    expect(toolbar()).toHaveAttribute('data-share-open', 'false')
    expect(screen.queryByRole('button', { name: 'Generate link' })).toBeNull()
  })

  it('keeps the toolbar shown while Share is open, and both buttons are reachable by keyboard', async () => {
    const user = userEvent.setup()
    await shownVisual(LOCAL)
    const toolbar = screen.getByRole('button', SHARE).closest('[data-share-open]')
    expect(toolbar).toHaveClass('focus-within:opacity-100', 'data-[share-open=true]:opacity-100')
    expect(toolbar).toHaveAttribute('data-share-open', 'false')

    await user.tab()
    expect(screen.getByRole('button', OPEN)).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', SHARE)).toHaveFocus()
    await user.keyboard('{Enter}')
    await screen.findByRole('button', { name: 'Generate link' })
    expect(toolbar).toHaveAttribute('data-share-open', 'true')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(toolbar).toHaveAttribute('data-share-open', 'false'))
  })
})
