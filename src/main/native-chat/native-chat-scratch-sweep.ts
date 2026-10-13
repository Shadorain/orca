// How a chat's scratch folder dies. The host never deletes a chat record, so no deletion event
// exists to hang cleanup on; instead each folder's life is re-derived from the records every run:
//   1. a folder no chat record (readable or not) maps to is removed, so any future record
//      deletion cleans up for free;
//   2. a folder whose chat went unused for the retention window is removed: its newest journal row
//      and its newest file are both older than that, and the host holds no execution for the chat.
// Rule 2 decides again under the chat's lifecycle lock, so a start accepted after the first look
// keeps the folder. Anything else directly under a root (a file written there, a folder not named
// for a chat) belongs to no chat and goes once it is older than the window. Folders under the
// pre-rename root follow the same rules, so they still die once nothing reads them. Anything
// unproven is kept. A failure is logged and never blocks anything else.

import type { Dirent } from 'node:fs'
import { lstat, opendir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import {
  legacyNativeChatVisualsRootFor,
  nativeChatScratchFolderName,
  nativeChatScratchRootFor
} from './native-chat-scratch-folder'

/** How long a chat's scratch files outlive its last use. */
export const NATIVE_CHAT_SCRATCH_RETENTION_MS = 30 * 24 * 60 * 60_000

export type NativeChatScratchSweepDeps = {
  stateDirectory: string
  /** Every chat this host holds a row for, readable or not; null when that can't be trusted. */
  listHeldSessionIds: () => readonly string[] | null
  /** When the chat's newest journal row was saved; null when it has none. */
  lastJournalActivityAt: (sessionId: string) => number | null
  /** Runs `task` under the chat's lifecycle lock unless the host still holds execution for it;
   *  null when it does. */
  runWhileExecutionIdle: <T>(sessionId: string, task: () => Promise<T>) => Promise<T | null>
  logger: StructuredAgentSessionLogger
  remove?: (path: string) => Promise<void>
  now?: () => number
}

export type NativeChatScratchSweepResult = { removed: number; failed: number }

// The names this host mints for a chat's folder.
const FOLDER_NAME = /^[0-9a-f]{32}$/
// An expired folder is renamed under the chat's lock and deleted after it, so the lock is held for
// one rename; a deletion that fails or is cut short leaves this name for a later run.
const EXPIRED_SUFFIX = '.expired'
const EXPIRED_NAME = /^[0-9a-f]{32}\.expired$/
// Bounds one run's disk work; whatever is left goes in a later run.
const MAX_REMOVALS_PER_RUN = 200
// Bounds the entries one folder's age is read from; see `newestEntryTime`.
const MAX_ENTRIES_PER_FOLDER = 256
const YIELD_EVERY = 32

type RemovalReason = 'no-record' | 'expired' | 'inactive' | 'stray'

type SweepRun = {
  deps: NativeChatScratchSweepDeps
  cutoff: number
  remove: (path: string) => Promise<void>
  result: NativeChatScratchSweepResult
}

async function listFolders(root: string): Promise<Dirent[]> {
  try {
    // A root that is not a real directory is not one this host made; nothing under it is touched.
    if (!(await lstat(root)).isDirectory()) {
      return []
    }
    return await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

export async function sweepNativeChatScratchFolders(
  deps: NativeChatScratchSweepDeps,
  isStopped: () => boolean = () => false
): Promise<NativeChatScratchSweepResult> {
  const result = { removed: 0, failed: 0 }
  // Listed before the records are read: a folder is created only after its chat's record, so
  // every folder seen here already has its record in the snapshot below.
  const entries: { root: string; entry: Dirent }[] = []
  for (const root of [
    nativeChatScratchRootFor(deps.stateDirectory),
    legacyNativeChatVisualsRootFor(deps.stateDirectory)
  ]) {
    try {
      for (const entry of await listFolders(root)) {
        entries.push({ root, entry })
      }
    } catch (error) {
      // One unreadable root leaves the other's cleanup running.
      deps.logger.warn('native-chat scratch root could not be listed', {
        scope: 'nativeChatScratch.sweep',
        root,
        error
      })
    }
  }
  const held = deps.listHeldSessionIds()
  if (!held || entries.length === 0) {
    return result
  }
  const sessionByFolder = new Map(
    held.map((sessionId) => [nativeChatScratchFolderName(sessionId), sessionId])
  )
  const run: SweepRun = {
    deps,
    cutoff: (deps.now?.() ?? Date.now()) - NATIVE_CHAT_SCRATCH_RETENTION_MS,
    remove: deps.remove ?? ((path: string) => rm(path, { recursive: true, force: true })),
    result
  }
  let visited = 0
  for (const { root, entry } of entries) {
    if (isStopped() || result.removed + result.failed >= MAX_REMOVALS_PER_RUN) {
      break
    }
    if (++visited % YIELD_EVERY === 0) {
      await yieldToEventLoop()
    }
    const path = join(root, entry.name)
    // A Dirent describes the entry itself, so a symlink is never taken for a chat's folder.
    if (entry.isDirectory() && EXPIRED_NAME.test(entry.name)) {
      await removeEntry(run, path, 'expired')
    } else if (entry.isDirectory() && FOLDER_NAME.test(entry.name)) {
      const sessionId = sessionByFolder.get(entry.name)
      await (sessionId === undefined
        ? removeEntry(run, path, 'no-record')
        : expireUnusedFolder(run, path, sessionId))
    } else {
      await removeStrayEntry(run, path)
    }
  }
  return result
}

/** `rm` takes a symlink for the link itself, so a removal never reaches past the root. */
async function removeEntry(
  run: SweepRun,
  path: string,
  reason: RemovalReason,
  sessionId?: string
): Promise<void> {
  try {
    await run.remove(path)
    run.result.removed += 1
  } catch (error) {
    reportFailure(run, reason, sessionId, error)
  }
}

async function expireUnusedFolder(run: SweepRun, folder: string, sessionId: string): Promise<void> {
  try {
    if (!(await isUnused(run, folder, sessionId))) {
      return
    }
    const parked = await run.deps.runWhileExecutionIdle(sessionId, async () => {
      if (!(await isUnused(run, folder, sessionId))) {
        return false
      }
      await rename(folder, folder + EXPIRED_SUFFIX)
      return true
    })
    if (!parked) {
      return
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      reportFailure(run, 'inactive', sessionId, error)
    }
    return
  }
  await removeEntry(run, folder + EXPIRED_SUFFIX, 'inactive', sessionId)
}

/** An entry no chat owns: removed once it, or for a folder its newest entry, is past the window. */
async function removeStrayEntry(run: SweepRun, path: string): Promise<void> {
  try {
    const self = await lstat(path)
    const newest = self.isDirectory() ? await newestEntryTime(path) : self.mtimeMs
    if (newest >= run.cutoff) {
      return
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      reportFailure(run, 'stray', undefined, error)
    }
    return
  }
  await removeEntry(run, path, 'stray')
}

/** Files first: the journal is asked only about a folder whose files already look unused. */
async function isUnused(run: SweepRun, folder: string, sessionId: string): Promise<boolean> {
  if ((await newestEntryTime(folder)) >= run.cutoff) {
    return false
  }
  const lastActivityAt = run.deps.lastJournalActivityAt(sessionId)
  return lastActivityAt === null || lastActivityAt < run.cutoff
}

/** The newest mtime among the folder and its entries, none of them followed. Past the entry bound
 *  the folder's own mtime and the entries already read stand in for the rest: adding, removing or
 *  replacing an entry moves the folder's mtime, and the journal covers a turn that rewrote one. */
async function newestEntryTime(folder: string): Promise<number> {
  const self = await lstat(folder)
  if (!self.isDirectory()) {
    return Infinity
  }
  let newest = self.mtimeMs
  let seen = 0
  // Closed by the loop, including on an early return.
  for await (const entry of await opendir(folder)) {
    if (++seen > MAX_ENTRIES_PER_FOLDER) {
      return newest
    }
    try {
      newest = Math.max(newest, (await lstat(join(folder, entry.name))).mtimeMs)
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
      // Something is changing the folder right now.
      return Infinity
    }
  }
  return newest
}

function reportFailure(
  run: SweepRun,
  reason: RemovalReason,
  sessionId: string | undefined,
  error: unknown
): void {
  run.result.failed += 1
  run.deps.logger.warn('native-chat scratch entry could not be removed', {
    scope: 'nativeChatScratch.sweep',
    reason,
    ...(sessionId ? { sessionId } : {}),
    error
  })
}

// Why minutes, not at boot: the first sweep must not compete with session restore; after that, a
// few runs a day is enough for files nothing reads.
const FIRST_SWEEP_DELAY_MS = 2 * 60_000
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000

/** Runs the sweep after startup and then periodically; the returned stop ends both. */
export function scheduleNativeChatScratchSweep(deps: NativeChatScratchSweepDeps): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = async (): Promise<void> => {
    try {
      await sweepNativeChatScratchFolders(deps, () => stopped)
    } catch (error) {
      deps.logger.warn('native-chat scratch sweep failed', {
        scope: 'nativeChatScratch.sweep',
        error
      })
    }
    arm(SWEEP_INTERVAL_MS)
  }
  const arm = (delayMs: number): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => void run(), delayMs)
    timer.unref?.()
  }
  arm(FIRST_SWEEP_DELAY_MS)
  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
  }
}
