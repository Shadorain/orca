import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import {
  legacyNativeChatVisualsRootFor,
  nativeChatScratchFolderFor,
  nativeChatScratchFolderName,
  nativeChatScratchRootFor
} from './native-chat-scratch-folder'
import {
  NATIVE_CHAT_SCRATCH_RETENTION_MS,
  scheduleNativeChatScratchSweep,
  sweepNativeChatScratchFolders,
  type NativeChatScratchSweepDeps
} from './native-chat-scratch-sweep'

// Paths whose listing fails, for a root this host cannot read.
const unlistable = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const readdir = async (...args: Parameters<typeof actual.readdir>) => {
    if (unlistable.has(String(args[0]))) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
    return actual.readdir(...args)
  }
  return { ...actual, readdir, default: { ...actual, readdir } }
})

const NOW = Date.UTC(2026, 9, 12)
const OLD = NOW - NATIVE_CHAT_SCRATCH_RETENTION_MS - 60_000
const RECENT = NOW - 60_000

const scratch: string[] = []
afterEach(() => {
  vi.useRealTimers()
  unlistable.clear()
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-visuals-sweep-'))
  scratch.push(dir)
  return dir
}

function setTime(path: string, at: number): void {
  utimesSync(path, at / 1000, at / 1000)
}

/** Whether the entry itself exists; a symlink counts whatever it points at. */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function oldSymlink(target: string, path: string): void {
  symlinkSync(target, path)
  lutimesSync(path, OLD / 1000, OLD / 1000)
}

/** A chat folder whose file and folder were last changed at `at`. */
function visualsFor(
  state: string,
  sessionId: string,
  at = RECENT,
  root = nativeChatScratchRootFor(state)
): string {
  const folder = join(root, nativeChatScratchFolderName(sessionId))
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'chart.html')
  writeFileSync(file, '<p>chart</p>')
  setTime(file, at)
  setTime(folder, at)
  return folder
}

type TestDeps = NativeChatScratchSweepDeps & {
  logger: { warn: ReturnType<typeof vi.fn<StructuredAgentSessionLogger['warn']>> }
  lastJournalActivityAt: ReturnType<typeof vi.fn<(sessionId: string) => number | null>>
}

/** Every chat in `held` is at rest unless listed in `executing`; journal times default to none. */
function deps(
  state: string,
  held: readonly string[] | null,
  options: { journal?: Record<string, number>; executing?: readonly string[] } = {}
): TestDeps {
  return {
    stateDirectory: state,
    listHeldSessionIds: () => held,
    lastJournalActivityAt: vi.fn((sessionId: string) => options.journal?.[sessionId] ?? null),
    runWhileExecutionIdle: async (sessionId, task) =>
      options.executing?.includes(sessionId) ? null : await task(),
    logger: { warn: vi.fn<StructuredAgentSessionLogger['warn']>(), error: vi.fn() },
    now: () => NOW
  }
}

describe('the chat scratch folder sweep', () => {
  it('removes a folder no chat record maps to and keeps every recently used held chat', async () => {
    const state = stateDirectory()
    const live = visualsFor(state, 'chat-live')
    const unreadable = visualsFor(state, 'chat-unreadable-row')
    const orphan = visualsFor(state, 'chat-deleted')
    const result = await sweepNativeChatScratchFolders(
      deps(state, ['chat-live', 'chat-unreadable-row'])
    )
    expect(result).toEqual({ removed: 1, failed: 0 })
    expect(existsSync(live)).toBe(true)
    expect(existsSync(unreadable)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  it('removes a chat folder whose files and journal are both past the retention window', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    const result = await sweepNativeChatScratchFolders(
      deps(state, ['chat-a'], { journal: { 'chat-a': OLD } })
    )
    expect(result).toEqual({ removed: 1, failed: 0 })
    expect(existsSync(folder)).toBe(false)
    expect(readdirSync(nativeChatScratchRootFor(state))).toEqual([])
  })

  it('removes an old folder whose chat has no journal rows', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    await sweepNativeChatScratchFolders(deps(state, ['chat-a']))
    expect(existsSync(folder)).toBe(false)
  })

  it('keeps old files while the chat journal is recent', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    await sweepNativeChatScratchFolders(deps(state, ['chat-a'], { journal: { 'chat-a': RECENT } }))
    expect(existsSync(folder)).toBe(true)
  })

  it('keeps recent files with an old journal, and never asks the journal about them', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    // One file rewritten in place: the folder's own mtime stays old.
    const rewritten = join(folder, 'chart.html')
    setTime(rewritten, RECENT)
    const sweep = deps(state, ['chat-a'], { journal: { 'chat-a': OLD } })
    await sweepNativeChatScratchFolders(sweep)
    expect(existsSync(folder)).toBe(true)
    expect(sweep.lastJournalActivityAt).not.toHaveBeenCalled()
  })

  it('keeps an unused folder while the host holds execution for its chat', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    await sweepNativeChatScratchFolders(deps(state, ['chat-a'], { executing: ['chat-a'] }))
    expect(existsSync(folder)).toBe(true)
  })

  it('decides again under the chat lock, so activity accepted after the first look keeps it', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    const journal: Record<string, number> = { 'chat-a': OLD }
    const sweep = deps(state, ['chat-a'], { journal })
    await sweepNativeChatScratchFolders({
      ...sweep,
      runWhileExecutionIdle: async (_sessionId, task) => {
        // A send accepted ahead of the lock writes its journal row first.
        journal['chat-a'] = RECENT
        return await task()
      }
    })
    expect(existsSync(folder)).toBe(true)
    expect(sweep.lastJournalActivityAt).toHaveBeenCalledTimes(2)
  })

  it('keeps a folder whose journal cannot be read and reports it', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    const sweep = deps(state, ['chat-a'])
    sweep.lastJournalActivityAt.mockImplementation(() => {
      throw new Error('the chat journal database is closed')
    })
    await expect(sweepNativeChatScratchFolders(sweep)).resolves.toEqual({ removed: 0, failed: 1 })
    expect(existsSync(folder)).toBe(true)
    expect(sweep.logger.warn).toHaveBeenCalledWith(
      'native-chat scratch entry could not be removed',
      expect.objectContaining({ reason: 'inactive', sessionId: 'chat-a' })
    )
  })

  it('removes nothing when the held chats cannot be read', async () => {
    const state = stateDirectory()
    const orphan = visualsFor(state, 'chat-a', OLD)
    await expect(sweepNativeChatScratchFolders(deps(state, null))).resolves.toEqual({
      removed: 0,
      failed: 0
    })
    expect(existsSync(orphan)).toBe(true)
  })

  it('keeps recent entries no chat owns, symlinks included', async () => {
    const state = stateDirectory()
    const root = nativeChatScratchRootFor(state)
    mkdirSync(join(root, 'notes'), { recursive: true })
    writeFileSync(join(root, 'f'.repeat(32)), 'a file, not a folder')
    writeFileSync(join(root, 'saved.html'), '<p>saved</p>')
    const target = mkdtempSync(join(tmpdir(), 'orca-visuals-target-'))
    scratch.push(target)
    symlinkSync(target, join(root, 'e'.repeat(32)))
    symlinkSync(target, join(root, `${'d'.repeat(32)}.expired`))
    await expect(sweepNativeChatScratchFolders(deps(state, []))).resolves.toEqual({
      removed: 0,
      failed: 0
    })
    for (const name of ['notes', 'f'.repeat(32), 'saved.html', 'e'.repeat(32)]) {
      expect(present(join(root, name))).toBe(true)
    }
    expect(present(join(root, `${'d'.repeat(32)}.expired`))).toBe(true)
  })

  it('removes entries no chat owns once past the window, and symlinks only as links', async () => {
    const state = stateDirectory()
    const root = nativeChatScratchRootFor(state)
    const notes = join(root, 'notes')
    mkdirSync(notes, { recursive: true })
    setTime(join(notes), OLD)
    const file = join(root, 'saved.html')
    writeFileSync(file, '<p>saved</p>')
    setTime(file, OLD)
    const hexFile = join(root, 'f'.repeat(32))
    writeFileSync(hexFile, 'a file, not a folder')
    setTime(hexFile, OLD)
    const target = mkdtempSync(join(tmpdir(), 'orca-visuals-target-'))
    scratch.push(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    oldSymlink(target, join(root, 'e'.repeat(32)))
    oldSymlink(target, join(root, `${'d'.repeat(32)}.expired`))
    // A folder nothing names, still being written to: its own mtime is old, a file in it is not.
    const busy = join(root, 'drafts')
    mkdirSync(busy)
    writeFileSync(join(busy, 'draft.html'), '')
    setTime(busy, OLD)

    await expect(sweepNativeChatScratchFolders(deps(state, []))).resolves.toEqual({
      removed: 5,
      failed: 0
    })
    expect(readdirSync(root)).toEqual(['drafts'])
    expect(existsSync(join(target, 'keep.txt'))).toBe(true)
  })

  it('reports a stray entry it cannot remove and counts it against the run cap', async () => {
    const state = stateDirectory()
    const root = nativeChatScratchRootFor(state)
    mkdirSync(root, { recursive: true })
    for (let index = 0; index < 201; index += 1) {
      const file = join(root, `stray-${index}.html`)
      writeFileSync(file, '')
      setTime(file, OLD)
    }
    const sweep = deps(state, [])
    const remove = vi.fn(async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    await expect(sweepNativeChatScratchFolders({ ...sweep, remove })).resolves.toEqual({
      removed: 0,
      failed: 200
    })
    expect(sweep.logger.warn).toHaveBeenCalledWith(
      'native-chat scratch entry could not be removed',
      expect.objectContaining({ reason: 'stray' })
    )
    await expect(sweepNativeChatScratchFolders(sweep)).resolves.toEqual({
      removed: 200,
      failed: 0
    })
    await expect(sweepNativeChatScratchFolders(sweep)).resolves.toEqual({ removed: 1, failed: 0 })
  })

  it('never follows a symlink inside an expiring folder, for its age or its removal', async () => {
    const state = stateDirectory()
    const target = mkdtempSync(join(tmpdir(), 'orca-visuals-target-'))
    scratch.push(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    const folder = visualsFor(state, 'chat-a', OLD)
    const link = join(folder, 'linked')
    symlinkSync(target, link)
    lutimesSync(link, OLD / 1000, OLD / 1000)
    setTime(folder, OLD)
    // The target itself is recent; only the link's own time counts.
    await sweepNativeChatScratchFolders(deps(state, ['chat-a']))
    expect(existsSync(folder)).toBe(false)
    expect(existsSync(join(target, 'keep.txt'))).toBe(true)
  })

  it('dates a folder past its entry bound by the folder itself and the journal', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    for (let index = 0; index < 300; index += 1) {
      const file = join(folder, `v${index}.html`)
      writeFileSync(file, '')
      setTime(file, OLD)
    }
    setTime(folder, OLD)
    const journal: Record<string, number> = { 'chat-a': RECENT }
    const sweep = deps(state, ['chat-a'], { journal })
    await sweepNativeChatScratchFolders(sweep)
    expect(existsSync(folder)).toBe(true)
    expect(sweep.lastJournalActivityAt).toHaveBeenCalledWith('chat-a')

    journal['chat-a'] = OLD
    await expect(sweepNativeChatScratchFolders(sweep)).resolves.toEqual({ removed: 1, failed: 0 })
    expect(existsSync(folder)).toBe(false)
  })

  it('keeps a folder past its entry bound whose own mtime is recent', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    for (let index = 0; index < 300; index += 1) {
      const file = join(folder, `v${index}.html`)
      writeFileSync(file, '')
      setTime(file, OLD)
    }
    setTime(folder, RECENT)
    const sweep = deps(state, ['chat-a'])
    await sweepNativeChatScratchFolders(sweep)
    expect(existsSync(folder)).toBe(true)
    expect(sweep.lastJournalActivityAt).not.toHaveBeenCalled()
  })

  it('reports a removal that fails, and a later run finishes it', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a', OLD)
    const sweep = deps(state, ['chat-a'])
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' })
    const first = await sweepNativeChatScratchFolders({
      ...sweep,
      remove: vi.fn().mockRejectedValueOnce(busy)
    })
    expect(first).toEqual({ removed: 0, failed: 1 })
    expect(sweep.logger.warn).toHaveBeenCalledWith(
      'native-chat scratch entry could not be removed',
      expect.objectContaining({ scope: 'nativeChatScratch.sweep', reason: 'inactive' })
    )
    // Already gone for every reader; only its disk space is left.
    expect(existsSync(folder)).toBe(false)
    expect(existsSync(`${folder}.expired`)).toBe(true)

    await expect(sweepNativeChatScratchFolders(sweep)).resolves.toEqual({ removed: 1, failed: 0 })
    expect(readdirSync(nativeChatScratchRootFor(state))).toEqual([])
  })

  it('reports a no-record removal that fails and carries on', async () => {
    const state = stateDirectory()
    visualsFor(state, 'chat-x')
    visualsFor(state, 'chat-y')
    const sweep = deps(state, [])
    const result = await sweepNativeChatScratchFolders({
      ...sweep,
      remove: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        .mockResolvedValueOnce(undefined)
    })
    expect(result).toEqual({ removed: 1, failed: 1 })
    expect(sweep.logger.warn).toHaveBeenCalledWith(
      'native-chat scratch entry could not be removed',
      expect.objectContaining({ scope: 'nativeChatScratch.sweep', reason: 'no-record' })
    )
  })

  it('stops each run at its removal cap and leaves the rest for the next', async () => {
    const state = stateDirectory()
    for (let index = 0; index < 205; index += 1) {
      visualsFor(state, `chat-${index}`)
    }
    const sweep = deps(state, [])
    await expect(sweepNativeChatScratchFolders(sweep)).resolves.toEqual({
      removed: 200,
      failed: 0
    })
    await expect(sweepNativeChatScratchFolders(sweep)).resolves.toEqual({ removed: 5, failed: 0 })
  })

  it('does nothing on a host with no visuals yet', async () => {
    await expect(
      sweepNativeChatScratchFolders(deps(stateDirectory(), ['chat-a']))
    ).resolves.toEqual({ removed: 0, failed: 0 })
  })

  it('runs after startup and again later, and stops for good', async () => {
    const state = stateDirectory()
    const orphan = visualsFor(state, 'chat-z')
    vi.useFakeTimers()
    const listHeldSessionIds = vi.fn((): string[] => [])
    const stop = scheduleNativeChatScratchSweep({ ...deps(state, []), listHeldSessionIds })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listHeldSessionIds).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(existsSync(orphan)).toBe(false))
    expect(listHeldSessionIds).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
    await vi.waitFor(() => expect(listHeldSessionIds).toHaveBeenCalledTimes(2))
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs a failed run and runs again on schedule', async () => {
    const state = stateDirectory()
    visualsFor(state, 'chat-z')
    vi.useFakeTimers()
    const listHeldSessionIds = vi
      .fn((): string[] => [])
      .mockImplementationOnce(() => {
        throw new Error('store unavailable')
      })
    const sweep = deps(state, [])
    const stop = scheduleNativeChatScratchSweep({ ...sweep, listHeldSessionIds })
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    await vi.waitFor(() =>
      expect(sweep.logger.warn).toHaveBeenCalledWith(
        'native-chat scratch sweep failed',
        expect.objectContaining({ scope: 'nativeChatScratch.sweep' })
      )
    )
    expect(existsSync(nativeChatScratchFolderFor(state, 'chat-z'))).toBe(true)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
    await vi.waitFor(() =>
      expect(existsSync(nativeChatScratchFolderFor(state, 'chat-z'))).toBe(false)
    )
    stop()
  })

  it('applies the same rules to folders under the pre-rename root', async () => {
    const state = stateDirectory()
    const legacy = legacyNativeChatVisualsRootFor(state)
    const recent = visualsFor(state, 'chat-recent', RECENT, legacy)
    const unused = visualsFor(state, 'chat-unused', OLD, legacy)
    const orphan = visualsFor(state, 'chat-deleted', RECENT, legacy)
    const executing = visualsFor(state, 'chat-executing', OLD, legacy)
    const stray = join(legacy, 'saved.html')
    writeFileSync(stray, '')
    setTime(stray, OLD)
    const current = visualsFor(state, 'chat-recent')
    const result = await sweepNativeChatScratchFolders(
      deps(state, ['chat-recent', 'chat-unused', 'chat-executing'], {
        executing: ['chat-executing']
      })
    )
    expect(result).toEqual({ removed: 3, failed: 0 })
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(current)).toBe(true)
    expect(existsSync(executing)).toBe(true)
    expect(existsSync(unused)).toBe(false)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(stray)).toBe(false)
    expect(readdirSync(legacy).sort()).toEqual(
      [
        nativeChatScratchFolderName('chat-executing'),
        nativeChatScratchFolderName('chat-recent')
      ].sort()
    )
  })

  it.each([
    ['the pre-rename root', legacyNativeChatVisualsRootFor, nativeChatScratchRootFor],
    ['the current root', nativeChatScratchRootFor, legacyNativeChatVisualsRootFor]
  ])('logs %s when it cannot be listed and still sweeps the other', async (_, broken, other) => {
    const state = stateDirectory()
    const brokenRoot = broken(state)
    const kept = visualsFor(state, 'chat-old-deleted', RECENT, brokenRoot)
    const orphan = visualsFor(state, 'chat-deleted', RECENT, other(state))
    const sweep = deps(state, [])
    unlistable.add(brokenRoot)
    await expect(sweepNativeChatScratchFolders(sweep)).resolves.toEqual({ removed: 1, failed: 0 })
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(kept)).toBe(true)
    expect(sweep.logger.warn).toHaveBeenCalledWith(
      'native-chat scratch root could not be listed',
      expect.objectContaining({ scope: 'nativeChatScratch.sweep', root: brokenRoot })
    )
  })

  it('sweeps the pre-rename root when the current one does not exist yet', async () => {
    const state = stateDirectory()
    const orphan = visualsFor(state, 'chat-deleted', RECENT, legacyNativeChatVisualsRootFor(state))
    await expect(sweepNativeChatScratchFolders(deps(state, []))).resolves.toEqual({
      removed: 1,
      failed: 0
    })
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(nativeChatScratchRootFor(state))).toBe(false)
  })

  it('touches nothing under a pre-rename root that is a symlink', async () => {
    const state = stateDirectory()
    const elsewhere = mkdtempSync(join(tmpdir(), 'orca-visuals-elsewhere-'))
    scratch.push(elsewhere)
    mkdirSync(join(elsewhere, 'a'.repeat(32)))
    symlinkSync(elsewhere, legacyNativeChatVisualsRootFor(state))
    await sweepNativeChatScratchFolders(deps(state, []))
    expect(existsSync(join(elsewhere, 'a'.repeat(32)))).toBe(true)
  })

  it('touches nothing under a scratch root that is a symlink', async () => {
    const state = stateDirectory()
    const elsewhere = mkdtempSync(join(tmpdir(), 'orca-visuals-elsewhere-'))
    scratch.push(elsewhere)
    mkdirSync(join(elsewhere, 'a'.repeat(32)))
    symlinkSync(elsewhere, nativeChatScratchRootFor(state))
    await sweepNativeChatScratchFolders(deps(state, []))
    expect(existsSync(join(elsewhere, 'a'.repeat(32)))).toBe(true)
  })
})
