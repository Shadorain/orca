// How far this window has read main's layout stream (design phase E): a `layout.apply` reply names
// the stream position holding its effect, and its outcome is shown once that frame is in, not
// after a timer. Fed only by the window's one local stream, which subscribes to every workspace.

type Waiter = { seq: number; run: () => void }

/** Null while no sequenced stream is open: nothing is coming to wait for. */
let position: number | null = null
let waiters: Waiter[] = []

function release(ready: (waiter: Waiter) => boolean): void {
  const due = waiters.filter(ready)
  if (due.length === 0) {
    return
  }
  waiters = waiters.filter((waiter) => !ready(waiter))
  for (const waiter of due) {
    try {
      waiter.run()
    } catch (error) {
      console.warn('[layout-owner] frame waiter threw:', error)
    }
  }
}

/** A frame came in; `seq` is absent from a host older than frame positions. */
export function noteLayoutFramePosition(seq: number | undefined): void {
  if (seq === undefined) {
    return
  }
  position = position === null ? seq : Math.max(position, seq)
  const reached = position
  release((waiter) => waiter.seq <= reached)
}

/** The stream ended: no frame will come, so every waiter runs now. */
export function endLayoutFramePositions(): void {
  position = null
  release(() => true)
}

/**
 * Runs `run` once this window holds the frame at `seq`: at once when it already does, when the
 * reply names no position (an older host), or when no sequenced stream is open.
 */
export function afterLayoutFrame(seq: number | undefined, run: () => void): void {
  if (seq === undefined || position === null || position >= seq) {
    run()
    return
  }
  waiters.push({ seq, run })
}
