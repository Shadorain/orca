import { basename, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeChatVisualHostPath } from '../../shared/native-chat-visual-host-path'
import {
  nativeChatScratchFolderFor,
  nativeChatScratchFolderName,
  nativeChatScratchRootFor
} from './native-chat-scratch-folder'
import { nativeChatVisualPathParts } from './native-chat-visual-file-read'

// A client builds the path from the host's published folder; the host's reader refuses any
// spelling it would not build itself, so the two must agree on every host path syntax.
describe('nativeChatVisualHostPath against the host reader', () => {
  const sessionId = 'session-alpha'
  const folderName = nativeChatScratchFolderName(sessionId)

  it('builds a path the reader accepts on a POSIX host', () => {
    const state = '/home/me/.config/orca'
    const scratchDirectory = nativeChatScratchFolderFor(state, sessionId)
    const filePath = nativeChatVisualHostPath(scratchDirectory, 'chart.html')
    expect(filePath).not.toBeNull()
    expect(nativeChatVisualPathParts(nativeChatScratchRootFor(state), filePath ?? '')).toEqual({
      folderName,
      file: 'chart.html'
    })
  })

  it('builds a path the reader accepts on a Windows host', () => {
    const rootName = basename(nativeChatScratchRootFor(posix.sep))
    const root = win32.join('C:\\Users\\me\\AppData\\Roaming\\orca', rootName)
    const scratchDirectory = win32.join(root, folderName)
    const filePath = nativeChatVisualHostPath(scratchDirectory, 'chart.html')
    expect(filePath).not.toBeNull()
    expect(nativeChatVisualPathParts(root, filePath ?? '')).toEqual({
      folderName,
      file: 'chart.html'
    })
  })
})
