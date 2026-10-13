import { BrowserWindow, Menu, webContents } from 'electron'
import { isNativeBrowserPopupWindow } from '../browser/native-browser-popup-windows'

export type AppMenuSelectionAction = 'copy' | 'select-all'

export function createAppMenuSelectionItem({
  action,
  label,
  isMac
}: {
  action: AppMenuSelectionAction
  label: string
  isMac: boolean
}): Electron.MenuItemConstructorOptions {
  return {
    label,
    ...(isMac ? { accelerator: action === 'copy' ? 'Command+C' : 'Command+A' } : {}),
    click: () => {
      const focusedWindow = BrowserWindow.getFocusedWindow()
      // Why: a native browser popup hosts a web page with no Orca renderer to receive the IPC.
      if (focusedWindow && !isNativeBrowserPopupWindow(focusedWindow)) {
        const focusedContents = webContents.getFocusedWebContents()
        if (focusedContents && focusedContents !== focusedWindow.webContents) {
          if (action === 'copy') {
            focusedContents.copy()
          } else {
            focusedContents.selectAll()
          }
          return
        }
        focusedWindow.webContents.send('ui:appMenuSelectionAction', action)
        return
      }
      if (isMac) {
        Menu.sendActionToFirstResponder(action === 'copy' ? 'copy:' : 'selectAll:')
      }
    }
  }
}
