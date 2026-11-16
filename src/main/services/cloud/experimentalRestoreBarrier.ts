/**
 * Experimental in-process exclusion primitive, not wired to BackupService or
 * Electron. It is only effective if ALL reads, sync operations and every restore
 * use the same instance, and if a timed-out database query is still awaited by
 * its operation. A failed restore leaves the barrier permanently closed.
 * Does not provide cross-process exclusion or coordinate a real shop restore.
 */
export function createExperimentalRestoreBarrier() {
  let state: 'OPEN' | 'DRAINING' | 'FAILED' = 'OPEN'
  let active = 0
  const waiters = new Set<() => void>()
  const drained = () => active === 0 ? Promise.resolve() : new Promise<void>(resolve => waiters.add(resolve))
  return {
    status: () => ({ state, active }),
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (state !== 'OPEN' || typeof operation !== 'function') throw new Error('Restore barrier closed')
      active++
      try { return await operation() }
      finally {
        active--
        if (active === 0) { for (const resolve of waiters) resolve(); waiters.clear() }
      }
    },
    async restore(operation: () => Promise<void>, onClosing?: () => Promise<void>): Promise<void> {
      if (state !== 'OPEN' || typeof operation !== 'function' || (onClosing !== undefined && typeof onClosing !== 'function')) throw new Error('Restore barrier closed')
      state = 'DRAINING'
      try {
        if (onClosing) await onClosing()
        await drained()
        await operation()
        state = 'OPEN'
      } catch (error) {
        state = 'FAILED'
        throw error
      }
    }
  }
}
