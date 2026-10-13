import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  connect: vi.fn(),
  toastError: vi.fn(),
  state: {
    editorDrafts: {},
    orcaProfileAuthStatus: { state: 'connected' },
    connectCurrentOrcaProfile: vi.fn()
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))

import {
  ArtifactPublishPreparationError,
  publishArtifactFromSurface
} from '@/components/artifacts/artifact-publish-flow'
import { editorArtifactSourceKey } from '@/components/editor/editor-artifact-upload'
import {
  browserTabKey,
  editorTab,
  localRoute,
  pairedOwner,
  pairedRoute,
  previewKey
} from '@/lib/file-artifact-source-key.test-support'
import { nativeChatVisualHostPath } from '../../../../shared/native-chat-visual-host-path'
import {
  clearNativeChatVisualFileCacheForTests,
  markNativeChatVisualReads,
  readNativeChatVisualFile,
  type NativeChatVisualFile
} from './native-chat-visual-path-read-client'
import {
  nativeChatVisualArtifactSourceKey,
  readNativeChatVisualArtifactRequest
} from './native-chat-visual-share'

const HEX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const LOCAL: NativeChatVisualFile = {
  target: { kind: 'local' },
  path: `/state/chat-scratch/${HEX}/usage.html`
}
const PAIRED: NativeChatVisualFile = {
  target: { kind: 'environment', environmentId: 'server-1' },
  path: `/srv/state/chat-scratch/${HEX}/usage.html`
}

function visualAt(target: NativeChatVisualFile['target'], scratchDirectory: string) {
  const path = nativeChatVisualHostPath(scratchDirectory, 'usage.html')
  if (!path) {
    throw new Error('no path')
  }
  return { target, path }
}

const readFile = vi.fn()

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const published = {
  change: 'created' as const,
  item: { artifact: { slug: 'a' }, shareUrl: 'https://share.onorca.dev/a/a' }
}

beforeEach(() => {
  vi.clearAllMocks()
  readFile.mockReset()
  clearNativeChatVisualFileCacheForTests()
  mocks.state.orcaProfileAuthStatus = { state: 'connected' }
  mocks.state.connectCurrentOrcaProfile = mocks.connect
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubLocalReads(): void {
  vi.stubGlobal('window', { api: { fs: { readFile } } })
}

describe('chat visual share key', () => {
  it("is the same link as the file's editor tab and browser tab on this computer", async () => {
    const key = nativeChatVisualArtifactSourceKey(LOCAL)
    expect(key).toBe(LOCAL.path)
    expect(editorArtifactSourceKey(editorTab(LOCAL.path, localRoute))).toBe(key)
    expect(await browserTabKey(`file://${LOCAL.path}`)).toBe(key)
  })

  it("is the same link as the file's editor tab and preview on a paired or SSH host", () => {
    const key = nativeChatVisualArtifactSourceKey(PAIRED)
    expect(JSON.parse(key)).toEqual(['editor', 'server-1', 'runtime:server-1', PAIRED.path])
    expect(editorArtifactSourceKey(editorTab(PAIRED.path, pairedRoute))).toBe(key)
    expect(previewKey(pairedOwner, PAIRED.path)).toBe(key)
  })

  it('spells a Windows path one way, whichever slashes another surface used', async () => {
    const local = nativeChatVisualArtifactSourceKey(
      visualAt({ kind: 'local' }, `C:\\Users\\me\\orca\\chat-scratch\\${HEX}`)
    )
    expect(local).toBe(`C:\\Users\\me\\orca\\chat-scratch\\${HEX}\\usage.html`)
    expect(await browserTabKey(`file:///C:/Users/me/orca/chat-scratch/${HEX}/usage.html`)).toBe(
      local
    )
    expect(
      editorArtifactSourceKey(
        editorTab(`C:/Users/me/orca/chat-scratch/${HEX}/usage.html`, localRoute)
      )
    ).toBe(local)

    const paired = nativeChatVisualArtifactSourceKey(
      visualAt(PAIRED.target, `D:\\orca\\chat-scratch\\${HEX}`)
    )
    const forward = `D:/orca/chat-scratch/${HEX}/usage.html`
    expect(previewKey(pairedOwner, forward)).toBe(paired)
    expect(editorArtifactSourceKey(editorTab(forward, pairedRoute))).toBe(paired)
  })

  it('names two hosts holding the same path as two links', () => {
    expect(nativeChatVisualArtifactSourceKey({ ...PAIRED, target: { kind: 'local' } })).not.toBe(
      nativeChatVisualArtifactSourceKey(PAIRED)
    )
  })
})

describe('chat visual share request', () => {
  it('reads the saved file at the click, not by joining a read begun before it', async () => {
    stubLocalReads()
    const older = deferred<{ content: string; isBinary: boolean }>()
    readFile.mockReturnValueOnce(older.promise)
    readFile.mockResolvedValueOnce({ content: '<p>rewritten</p>', isBinary: false })
    const before = readNativeChatVisualFile(LOCAL)
    const onReadStarted = vi.fn()

    await expect(readNativeChatVisualArtifactRequest(LOCAL, onReadStarted)).resolves.toEqual({
      sourceKey: LOCAL.path,
      content: '<p>rewritten</p>',
      contentType: 'text/html',
      fileName: 'usage.html'
    })
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(readFile).toHaveBeenLastCalledWith({
      filePath: LOCAL.path,
      access: { kind: 'chat-visual' }
    })
    // The frame asks with the same mark and is handed this read rather than starting another.
    const mark = onReadStarted.mock.calls[0]?.[0]
    expect(mark).toBeLessThan(markNativeChatVisualReads())
    older.resolve({ content: '<p>old</p>', isBinary: false })
    await before
  })

  it("reads a host chat's visual on that host, never on this computer", async () => {
    stubLocalReads()
    mocks.callRuntimeRpc.mockResolvedValue({ path: PAIRED.path, content: '<p>h</p>' })
    const request = await readNativeChatVisualArtifactRequest(PAIRED, vi.fn())
    expect(request.content).toBe('<p>h</p>')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      PAIRED.target,
      'files.read',
      { path: PAIRED.path, access: { kind: 'chat-visual' } },
      { timeoutMs: 15_000 }
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it.each([
    ['gone', new Error('ENOENT: no such file or directory')],
    ['on a host out of reach', new Error('Runtime environment is not connected')],
    ['refused', new Error('binary_file')]
  ])('fails visibly when the file is %s', async (_name, error) => {
    stubLocalReads()
    readFile.mockRejectedValue(error)
    const createRequest = (): ReturnType<typeof readNativeChatVisualArtifactRequest> =>
      readNativeChatVisualArtifactRequest(LOCAL, vi.fn())
    await expect(createRequest()).rejects.toEqual(
      new ArtifactPublishPreparationError('visual-unreadable')
    )

    await expect(publishArtifactFromSurface(createRequest)).resolves.toBeNull()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not share artifact', {
      description: "Couldn't read this visual to share it."
    })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('publishes the text read at the click again after sign-in, without reading again', async () => {
    stubLocalReads()
    readFile
      .mockResolvedValueOnce({ content: '<p>clicked</p>', isBinary: false })
      .mockResolvedValue({ content: '<p>later</p>', isBinary: false })
    mocks.connect.mockResolvedValue({ status: 'connected' })
    mocks.callRuntimeRpc
      .mockResolvedValueOnce({ status: 'reconnect-required' })
      .mockResolvedValueOnce({ status: 'ok', value: published })

    await expect(
      publishArtifactFromSurface(() => readNativeChatVisualArtifactRequest(LOCAL, vi.fn()))
    ).resolves.toBe(published)
    expect(readFile).toHaveBeenCalledOnce()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2)
    for (const call of mocks.callRuntimeRpc.mock.calls) {
      expect(call[1]).toBe('artifacts.publish')
      expect(call[2]).toMatchObject({ sourceKey: LOCAL.path, content: '<p>clicked</p>' })
    }
  })
})
