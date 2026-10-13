import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { readJournalSessionLastActivityAt } from './journal-row-table'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    openTestJournalHostDatabase(dir).close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-journal-rows-'))
  scratch.push(dir)
  return openTestJournalHostDatabase(dir).db
}

describe('a chat journal last activity', () => {
  it('is the newest row save time across every epoch, and null for a chat with no rows', () => {
    const db = database()
    const insert = db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    insert.run('chat-a', 'epoch-1', 1, 1_000, '{}')
    insert.run('chat-a', 'epoch-1', 2, 3_000, '{}')
    insert.run('chat-a', 'epoch-2', 1, 2_000, '{}')
    insert.run('chat-b', 'epoch-1', 1, 9_000, '{}')

    expect(readJournalSessionLastActivityAt(db, 'chat-a')).toBe(3_000)
    expect(readJournalSessionLastActivityAt(db, 'chat-none')).toBeNull()
  })
})
