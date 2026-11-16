/**
 * Experimental single-flight scheduler for the isolated hub supervisor. Not
 * started by Electron. A successful tick only means the injected components
 * returned; it is not evidence of HTTPS, Windows, mobile or production health.
 * The caller must coordinate restore, provision keys and stop the supervisor
 * after stopping this scheduler. No financial or shop database writes are made.
 */
import { performance } from 'node:perf_hooks'

type Supervisor = { refreshOnce(): Promise<void>; syncOnce(): Promise<{sent:number; lastAcked:number}> }
type Status = { running:boolean; inFlight:boolean; snapshot:'UNKNOWN'|'OK'|'ERROR'; audit:'UNKNOWN'|'OK'|'ERROR'|'PAUSED'; auditFailures:number }
type Timers = { set(fn:()=>void, ms:number): unknown; clear(id:unknown):void }
type Options = {
  intervalMs?:number; startDelayMs?:number; retryPauseMs?:number; failureLimit?:number
  now?:()=>number; timers?:Timers; onStatus?:(status:Status)=>void
}

export function createExperimentalHubScheduler(supervisor: Supervisor, options: Options = {}) {
  const interval=options.intervalMs ?? 30_000, delay=options.startDelayMs ?? 20_000
  const pause=options.retryPauseMs ?? 5*60_000, limit=options.failureLimit ?? 3
  if (!supervisor || typeof supervisor.refreshOnce !== 'function' || typeof supervisor.syncOnce !== 'function' ||
      !Number.isSafeInteger(interval) || interval < 10 || interval > 300_000 ||
      !Number.isSafeInteger(delay) || delay < 0 || delay > 300_000 ||
      !Number.isSafeInteger(pause) || pause < 10 || pause > 3_600_000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.onStatus !== undefined && typeof options.onStatus !== 'function')) throw new Error('Invalid hub scheduler configuration')
  const now=options.now ?? (() => performance.now())
  const timers=options.timers ?? {set:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clear:(id:unknown)=>clearTimeout(id as ReturnType<typeof setTimeout>)}
  if (typeof timers.set !== 'function' || typeof timers.clear !== 'function') throw new Error('Invalid hub scheduler timers')
  const emit=options.onStatus
  let started=false, stopped=false, timer:unknown, active:Promise<void> | null=null
  let lastNow=0, retryAt=0, failures=0
  let snapshot:Status['snapshot']='UNKNOWN', audit:Status['audit']='UNKNOWN'
  const status = (): Status => ({running:started && !stopped,inFlight:!!active,snapshot,audit,auditFailures:failures})
  function notify() { try { emit?.(status()) } catch { /* UI/reporting cannot stop the scheduler */ } }
  function clock(): number {
    const t=now()
    if (!Number.isFinite(t) || t < 0 || t < lastNow) throw new Error('Invalid scheduler clock')
    lastNow=t;return t
  }
  async function tick() {
    try { await supervisor.refreshOnce();snapshot='OK' } catch { snapshot='ERROR' }
    notify()
    if (stopped) return
    let time:number
    try { time=clock() } catch { audit='PAUSED';notify();return }
    if (time < retryAt) { audit='PAUSED';notify();return }
    try {
      await supervisor.syncOnce()
      failures=0;retryAt=0;audit='OK'
    } catch {
      failures=Math.min(failures+1,limit)
      audit='ERROR'
      if (failures >= limit) {
        try { retryAt=clock()+pause;audit='PAUSED' } catch { retryAt=Number.POSITIVE_INFINITY;audit='PAUSED' }
      }
    }
    notify()
  }
  function schedule(ms:number) {
    timer=timers.set(() => {
      timer=undefined
      if (stopped) return
      const task=tick();active=task
      void task.finally(() => {
        if (active===task) active=null
        notify()
        if (!stopped) schedule(interval)
      })
    },ms)
  }
  return {
    start(): void {
      if (stopped) throw new Error('Hub scheduler stopped')
      if (started) return
      started=true;schedule(delay);notify()
    },
    status,
    async stop(): Promise<void> {
      if (!stopped) {
        stopped=true
        if (timer !== undefined) { timers.clear(timer);timer=undefined }
        notify()
      }
      // An already-running operation cannot be cancelled safely; report stopped
      // only after it settles. The caller closes the supervisor afterwards.
      if (active) await active
    }
  }
}
