import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { events } = vi.hoisted(() => ({ events: new Map<string, (...args: unknown[]) => void>() }))
vi.mock('electron', () => ({
  app: {
    prependOnceListener: (name: string, listener: (...args: unknown[]) => void) =>
      events.set(name, listener),
    off: (name: string, listener: (...args: unknown[]) => void) => {
      if (events.get(name) === listener) {
        events.delete(name)
      }
    }
  }
}))

import {
  allowNativeBrowserPopup,
  isNativeBrowserPopupRequest,
  prepareNativeBrowserPopup
} from './browser-popup-native-window'

afterEach(() => {
  events.clear()
  vi.unstubAllEnvs()
})

function nativeWindow() {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    setWindowOpenHandler: vi.fn()
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    setTitle: vi.fn(),
    destroy: vi.fn()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements every BrowserWindow member exercised by popup preparation.
  const browserWindow = window as unknown as Electron.BrowserWindow
  return { window, contents, browserWindow }
}

describe('native popup admission', () => {
  it('uses the native path only for the observed unnamed, featureless OpenURL disposition', () => {
    expect(
      isNativeBrowserPopupRequest({ disposition: 'new-window', features: '', frameName: '' })
    ).toBe(true)
    for (const details of [
      { disposition: 'foreground-tab', features: '', frameName: '' },
      { disposition: 'background-tab', features: '', frameName: '' },
      { disposition: 'new-window', features: 'width=500', frameName: '' },
      { disposition: 'new-window', features: '', frameName: 'oauth' },
      {}
    ]) {
      expect(isNativeBrowserPopupRequest(details)).toBe(false)
    }
  })

  it('leaves request continuation to Electron and expires an unused admission before the next turn', async () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Admission only reads this stub's session and destruction state.
    const opener = { session: {}, isDestroyed: () => false } as unknown as Electron.WebContents
    const onCreated = vi.fn()
    const response = allowNativeBrowserPopup({
      opener,
      targetUrl: 'https://example.com/post?code=synthetic',
      options: { show: true, frame: true },
      onCreated
    })
    expect(response.createWindow).toBeUndefined()
    expect(response.overrideBrowserWindowOptions).toMatchObject({
      show: false,
      fullscreenable: false,
      title: 'https://example.com',
      webPreferences: { session: opener.session }
    })
    expect(events.has('browser-window-created')).toBe(true)
    await Promise.resolve()
    expect(events.has('browser-window-created')).toBe(false)
    expect(onCreated).not.toHaveBeenCalled()
  })

  it.each([
    () => false,
    () => {
      throw new Error('Synthetic failed authority')
    }
  ])('blocks native navigation and descendants when preparation fails', (prepare) => {
    const { browserWindow, contents, window } = nativeWindow()
    const popup = prepareNativeBrowserPopup(browserWindow, 'https://example.com/', prepare)
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn()
      contents.emit(event, { preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    expect(contents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    expect(contents.close).toHaveBeenCalledOnce()
    window.emit('closed')
    const closed = vi.fn()
    popup.onClosed(closed)
    expect(closed).toHaveBeenCalledOnce()
  })

  it('protects the title and updates only main-frame origins, including redirects', () => {
    const { browserWindow, contents, window } = nativeWindow()
    prepareNativeBrowserPopup(browserWindow, 'https://example.com/post?code=synthetic', () => true)
    const preventDefault = vi.fn()
    window.emit('page-title-updated', { preventDefault }, 'Spoofed title')
    expect(preventDefault).toHaveBeenCalledOnce()
    contents.emit('did-start-navigation', {}, 'https://iframe.example.net/secret', false, false)
    expect(window.setTitle).toHaveBeenCalledTimes(1)
    contents.emit(
      'will-redirect',
      {},
      'https://destination.example.net/callback?token=synthetic',
      false,
      true
    )
    expect(window.setTitle).toHaveBeenCalledTimes(1)
    contents.emit('did-navigate', {}, 'https://destination.example.net/other')
    expect(window.setTitle).toHaveBeenLastCalledWith('https://destination.example.net')
  })
})
