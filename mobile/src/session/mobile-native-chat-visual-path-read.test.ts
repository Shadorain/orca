import { afterEach, describe, expect, it, vi } from 'vitest'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../src/shared/local-file-access'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  cachedMobileNativeChatVisual,
  readMobileNativeChatVisual,
  resetMobileNativeChatVisualCacheForTest,
  type MobileNativeChatVisualSource
} from './mobile-native-chat-visual-read'

const HEX = '0123456789abcdef0123456789abcdef'
const POSIX_FOLDER = `/home/me/.orca/scratch/${HEX}`
const WINDOWS_FOLDER = `C:\\Users\\me\\AppData\\Roaming\\orca\\scratch\\${HEX}`
const REVISION_A = 'a'.repeat(32)

function success(result: unknown): RpcResponse {
  return { id: '1', ok: true, result }
}

function failure(code: string, message: string = code): RpcResponse {
  return { id: '1', ok: false, error: { code, message } }
}

function fileReply(content: string, extra: Record<string, unknown> = {}): RpcResponse {
  return success({
    path: `${POSIX_FOLDER}/chart.html`,
    content,
    truncated: false,
    byteLength: content.length,
    ...extra
  })
}

function sourceWith(
  sendRequest: ReturnType<typeof vi.fn>,
  scratchDirectory: string | null = POSIX_FOLDER
): MobileNativeChatVisualSource {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader calls only sendRequest; the rest of RpcClient is connection lifecycle it never touches.
  const client = { sendRequest } as unknown as RpcClient
  return { client, sessionId: 'session-1', scratchDirectory }
}

afterEach(() => {
  resetMobileNativeChatVisualCacheForTest()
})

describe('readMobileNativeChatVisual on a host that reads files by path', () => {
  it('reads the file in the chat folder with the read-only visual access, then caches it', async () => {
    const sendRequest = vi.fn().mockResolvedValue(fileReply('<p>'))
    const source = sourceWith(sendRequest)

    await expect(readMobileNativeChatVisual(source, 'chart.html')).resolves.toEqual({
      kind: 'ready',
      html: '<p>'
    })
    expect(sendRequest).toHaveBeenCalledOnce()
    expect(sendRequest).toHaveBeenCalledWith(
      'files.read',
      { path: `${POSIX_FOLDER}/chart.html`, access: { kind: 'chat-visual' } },
      expect.objectContaining({ timeoutMs: expect.any(Number), budgetSpansConnect: true })
    )
    expect(cachedMobileNativeChatVisual(source, 'chart.html')).toEqual({
      html: '<p>',
      revision: null
    })
  })

  it("builds a Windows host's path in that host's syntax", async () => {
    const sendRequest = vi.fn().mockResolvedValue(fileReply('<p>'))
    await readMobileNativeChatVisual(sourceWith(sendRequest, WINDOWS_FOLDER), 'chart.html')
    expect(sendRequest.mock.calls[0]?.[1]).toEqual({
      path: `${WINDOWS_FOLDER}\\chart.html`,
      access: { kind: 'chat-visual' }
    })
  })

  it("takes a page down on the host's file refusals", async () => {
    for (const response of [
      failure('runtime_error', 'ENOENT: no such file or directory'),
      failure('runtime_error', `${PATH_OUTSIDE_ALLOWED_DIRECTORIES}. If this blocks...`),
      failure('runtime_error', 'Not a regular file'),
      failure('runtime_error', 'file_too_large'),
      failure('runtime_error', 'binary_file'),
      failure('invalid_argument', 'A file named by path is served only by the host that owns it'),
      failure('forbidden'),
      fileReply('<p', { truncated: true })
    ]) {
      resetMobileNativeChatVisualCacheForTest()
      const source = sourceWith(
        vi.fn().mockResolvedValueOnce(fileReply('<p>')).mockResolvedValueOnce(response)
      )
      await readMobileNativeChatVisual(source, 'chart.html')
      await expect(readMobileNativeChatVisual(source, 'chart.html')).resolves.toEqual({
        kind: 'refused'
      })
      expect(cachedMobileNativeChatVisual(source, 'chart.html')).toBeNull()
    }
  })

  it('reads a host fault, a timeout or an unreadable answer as no verdict, keeping the page', async () => {
    for (const response of [
      failure('runtime_error', 'visual_read_failed:EIO'),
      failure('timeout'),
      failure('runtime_unavailable'),
      success({ content: 42 }),
      success('<html>')
    ]) {
      resetMobileNativeChatVisualCacheForTest()
      const source = sourceWith(
        vi.fn().mockResolvedValueOnce(fileReply('<p>')).mockResolvedValueOnce(response)
      )
      await readMobileNativeChatVisual(source, 'chart.html')
      await expect(readMobileNativeChatVisual(source, 'chart.html')).resolves.toEqual({
        kind: 'unreachable'
      })
      expect(cachedMobileNativeChatVisual(source, 'chart.html')?.html).toBe('<p>')
    }
  })

  it('reads a transport failure as unreachable', async () => {
    const source = sourceWith(vi.fn().mockRejectedValue(new Error('socket closed')))
    await expect(readMobileNativeChatVisual(source, 'chart.html')).resolves.toEqual({
      kind: 'unreachable'
    })
  })

  it('never builds a path from a name that is not a bare visual file', async () => {
    const sendRequest = vi.fn()
    await expect(
      readMobileNativeChatVisual(sourceWith(sendRequest), '../secret.html')
    ).resolves.toEqual({ kind: 'refused' })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('paints what an earlier session-scoped read cached, then reads it fresh by path', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' }))
      .mockResolvedValueOnce(fileReply('<hr>'))
    const source = sourceWith(sendRequest)
    await readMobileNativeChatVisual({ ...source, scratchDirectory: null }, 'chart.html')
    expect(cachedMobileNativeChatVisual(source, 'chart.html')?.html).toBe('<p>')

    await expect(readMobileNativeChatVisual(source, 'chart.html')).resolves.toEqual({
      kind: 'ready',
      html: '<hr>'
    })
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'agentSession.readVisual',
      'files.read'
    ])
  })

  it('sends no revision to the session reader for bytes a path read cached', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(fileReply('<p>'))
      .mockResolvedValueOnce(success({ ok: true, revision: REVISION_A, sizeBytes: 3, html: '<p>' }))
    const source = sourceWith(sendRequest)
    await readMobileNativeChatVisual(source, 'chart.html')
    await readMobileNativeChatVisual({ ...source, scratchDirectory: null }, 'chart.html')
    expect(sendRequest.mock.calls[1]).toEqual([
      'agentSession.readVisual',
      { sessionId: 'session-1', file: 'chart.html' },
      expect.anything()
    ])
  })
})
