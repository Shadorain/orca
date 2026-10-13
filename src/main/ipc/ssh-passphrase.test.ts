import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerCredentialHandler, requestCredential } from './ssh-passphrase'
import { SSH_CREDENTIAL_TIMEOUT_MS } from '../ssh/ssh-connection-utils'
import {
  isSshCredentialDeclined,
  resetSshCredentialDeclinesForTests
} from '../ssh/ssh-credential-decline'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

function submitCredential(requestId: string, value: string | null): void {
  registerCredentialHandler()
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.findLast(([channel]) => channel === 'ssh:submitCredential')?.[1]
  if (!handler) {
    throw new Error('ssh:submitCredential was not registered')
  }
  void Reflect.apply(handler, undefined, [{}, { requestId, value }])
}

function lastRequestId(window: BrowserWindow): string {
  const payload: unknown = vi.mocked(window.webContents.send).mock.calls.at(-1)?.[1]
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('requestId' in payload) ||
    typeof payload.requestId !== 'string'
  ) {
    throw new Error('no credential request was sent')
  }
  return payload.requestId
}

function credentialWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

describe('SSH credential requests', () => {
  beforeEach(() => {
    resetSshCredentialDeclinesForTests()
  })

  it('records a user cancel as a decline for that host', async () => {
    const window = credentialWindow()
    const pending = requestCredential(() => window, 'target-1', 'password', 'host')
    submitCredential(lastRequestId(window), null)

    await expect(pending).resolves.toBeNull()
    expect(isSshCredentialDeclined('target-1')).toBe(true)
    expect(isSshCredentialDeclined('target-2')).toBe(false)
  })

  it('records an unanswered prompt as a decline', async () => {
    vi.useFakeTimers()
    try {
      const pending = requestCredential(() => credentialWindow(), 'target-1', 'passphrase', 'key')
      await vi.advanceTimersByTimeAsync(SSH_CREDENTIAL_TIMEOUT_MS)
      await expect(pending).resolves.toBeNull()
      expect(isSshCredentialDeclined('target-1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not record a decline for an answered, aborted, or windowless request', async () => {
    const window = credentialWindow()
    const answered = requestCredential(() => window, 'target-1', 'password', 'host')
    submitCredential(lastRequestId(window), 'secret')
    await expect(answered).resolves.toBe('secret')

    const controller = new AbortController()
    const aborted = requestCredential(
      () => window,
      'target-1',
      'password',
      'host',
      undefined,
      controller.signal
    )
    controller.abort()
    await aborted

    await requestCredential(() => null, 'target-1', 'password', 'host')

    expect(isSshCredentialDeclined('target-1')).toBe(false)
  })

  it('resolves and removes the renderer prompt when its connection aborts', async () => {
    const window = credentialWindow()
    const controller = new AbortController()
    const pending = requestCredential(
      () => window,
      'target-1',
      'keyboard-interactive',
      'Duo response',
      undefined,
      controller.signal
    )
    const request = vi.mocked(window.webContents.send).mock.calls[0][1] as { requestId: string }

    controller.abort()

    await expect(pending).resolves.toBeNull()
    expect(window.webContents.send).toHaveBeenLastCalledWith('ssh:credential-resolved', {
      requestId: request.requestId
    })
  })
})
