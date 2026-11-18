import { useEffect, useRef, useState } from 'react'
import { REMOTE_AUTH_CHANNELS, remoteImplementationReady, type RemoteAuthRequestResult, type RemoteAuthStatusResult } from '@shared/remoteAuthChannels'
import { call, CH } from '../lib/api'
import { toLatinDigits } from '@shared/jalali'

/** Update an already-open renderer view after revoke, panic or expiry. This
 * only removes access, never extends idle time or creates a new session. */
export function startRemoteSessionMonitor(active:boolean, onPanels:(panels:string[])=>void, onError:()=>void):()=>void {
  if (!active || !remoteImplementationReady()) return () => {}
  let stopped=false, inFlight=false
  const check=async()=>{
    if (stopped || inFlight) return
    inFlight=true
    try {
      const status=await call<{manager?:boolean;panels?:unknown}>(CH.managerSessionStatus)
      if (stopped) return
      if (!status || typeof status.manager !== 'boolean') throw new Error('Invalid session status')
      if (status.manager) return
      if (!Array.isArray(status.panels) || status.panels.some(panel=>typeof panel!=='string')) throw new Error('Invalid panel status')
      onPanels(status.panels as string[])
    } catch { if (!stopped) onError() }
    finally { inFlight=false }
  }
  const timer=setInterval(()=>void check(),1000)
  return ()=>{stopped=true;clearInterval(timer)}
}

/** Experimental UI only. The readiness gate must remain closed until the entire
 * approval and session lifecycle is integrated and independently tested. */
export function RemoteRequestBox({ panel }: { panel: string }) {
  const [request, setRequest] = useState<RemoteAuthRequestResult | null>(null)
  const [state, setState] = useState<RemoteAuthStatusResult['state']>('PENDING')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const [recoveryOpen,setRecoveryOpen]=useState(false)
  const [recoveryPassword,setRecoveryPassword]=useState('')
  const [recoveryPin,setRecoveryPin]=useState('')
  const [recoveryMessage,setRecoveryMessage]=useState<string|null>(null)
  const [recoveryBusy,setRecoveryBusy]=useState(false)

  const recover=async()=>{
    if (recoveryBusy || !recoveryPassword || !/^[0-9]{6}$/.test(recoveryPin)) return
    setRecoveryBusy(true);setRecoveryMessage(null)
    try {
      await call(REMOTE_AUTH_CHANNELS.recover as any,{password:recoveryPassword,pin:recoveryPin})
      setRecoveryMessage('توقف اضطراری برداشته شد؛ مدیر باید دوباره وارد گوشی شود.')
    } catch {setRecoveryMessage('بازیابی تأیید نشد. رمز مدیر، PIN مالک و وضعیت اتصال را بررسی کنید.')}
    finally {setRecoveryPassword('');setRecoveryPin('');setRecoveryBusy(false)}
  }

  useEffect(() => {
    // Ignore late responses after a panel change or unmount. A request already
    // sent to Main may still expire there; never cancel a newer request here.
    generation.current++
    setRequest(null)
    setState('PENDING')
    setBusy(false)
    setError(null)
    setRecoveryPassword('');setRecoveryPin('');setRecoveryMessage(null);setRecoveryOpen(false)
    return () => { generation.current++ }
  }, [panel])

  useEffect(() => {
    if (!request || request.panel !== panel || state === 'UNAVAILABLE' || state === 'CLAIMED') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        // Remote channels are allowlisted in preload, but are not yet part of its typed IPC union.
        const status = await call<RemoteAuthStatusResult>(REMOTE_AUTH_CHANNELS.status as any, { panel, requestId: request.requestId })
        if (stopped) return
        if (!['PENDING', 'APPROVED', 'CLAIMED', 'UNAVAILABLE'].includes(status?.state)) throw new Error('Invalid status')
        setState(status.state)
        setError(null)
        if (status.state === 'CLAIMED') window.dispatchEvent(new Event('mahak-remote-sync'))
        if (status.state === 'CLAIMED' || status.state === 'UNAVAILABLE') return
      } catch {
        if (stopped) return
        // Never continue presenting a credential as approved when status is unknown.
        setState('PENDING')
        setError('بررسی وضعیت ممکن نشد؛ دوباره تلاش می‌شود.')
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000)
    }
    void poll()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [panel, request, state === 'CLAIMED', state === 'UNAVAILABLE'])

  const create = async () => {
    const current = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const result = await call<RemoteAuthRequestResult>(REMOTE_AUTH_CHANNELS.request as any, { panel })
      if (current !== generation.current) return
      if (result?.panel !== panel || !/^[0-9]{6}$/.test(result.code) ||
          !/^gt-[A-Za-z0-9_-]{43}$/.test(result.gt) || !/^[A-Za-z0-9_-]{1,128}$/.test(result.requestId)) {
        throw new Error('Invalid response')
      }
      setState('PENDING')
      setRequest(result)
    } catch {
      if (current === generation.current) setError('ثبت درخواست ممکن نشد. دوباره تلاش کنید.')
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }

  const claim = async () => {
    if (!request || request.panel !== panel || state !== 'APPROVED' || busy) return
    const current = generation.current
    setBusy(true)
    setError(null)
    try {
      await call(REMOTE_AUTH_CHANNELS.claim as any, { panel, requestId: request.requestId, gt: request.gt })
      if (current !== generation.current) return
      setState('CLAIMED')
      window.dispatchEvent(new Event('mahak-remote-sync'))
    } catch {
      if (current === generation.current) setError('فعال‌سازی مجوز تأیید نشد؛ وضعیت دوباره بررسی می‌شود.')
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }

  const cancel = async () => {
    const current = ++generation.current
    setBusy(true)
    setError(null)
    try {
      await call(REMOTE_AUTH_CHANNELS.cancel as any, { panel })
      if (current === generation.current) { setRequest(null); setState('PENDING') }
    } catch {
      if (current === generation.current) setError('لغو درخواست تأیید نشد؛ دوباره تلاش کنید.')
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }

  const current = request?.panel === panel ? request : null
  return (
    <div className="space-y-2">
      {error && <div role="alert" className="rounded px-3 py-2 bg-amber-50 border border-amber-300">{error}</div>}
      <button type="button" className="btn btn-ghost w-full" onClick={()=>{setRecoveryOpen(!recoveryOpen);setRecoveryPassword('');setRecoveryPin('');setRecoveryMessage(null)}} disabled={recoveryBusy}>بازیابی توقف اضطراری راه دور</button>
      {recoveryOpen && <div className="rounded px-3 py-2 bg-rose-50 border border-rose-300 space-y-2">
        <div>فقط روی رایانه، با رمز مدیر برنامه و PIN شش‌رقمی مالک راه دور.</div>
        <label className="block">رمز مدیر برنامه<input className="inp w-full" type="password" autoComplete="off" value={recoveryPassword} disabled={recoveryBusy} onChange={e=>setRecoveryPassword(e.target.value)} /></label>
        <label className="block">PIN مالک راه دور<input className="inp w-full" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={recoveryPin} disabled={recoveryBusy} onChange={e=>setRecoveryPin(toLatinDigits(e.target.value))} /></label>
        <button type="button" className="btn" disabled={recoveryBusy || !recoveryPassword || !/^[0-9]{6}$/.test(recoveryPin)} onClick={()=>void recover()}>تأیید بازیابی</button>
        {recoveryMessage && <div role="status">{recoveryMessage}</div>}
      </div>}
      {!current ? (
        <button className="btn btn-ghost w-full" disabled={busy} onClick={() => void create()}>
          درخواست مجوز از مدیر (راه دور)
        </button>
      ) : (
        <div className="rounded px-3 py-2 bg-sky-50 border border-sky-300 space-y-1">
          {state === 'UNAVAILABLE' ? <div>درخواست دیگر معتبر نیست؛ آن را لغو و درخواست تازه ثبت کنید.</div> : (
            <>
              <div>کد تطبیق: <b>{current.code}</b> — آن را با مدیر مقایسه کنید.</div>
              {state === 'PENDING' && <div>در انتظار تأیید مدیر.</div>}
              {state === 'APPROVED' && <button className="btn btn-primary w-full" disabled={busy} onClick={() => void claim()}>فعال‌سازی مجوز همین پنل</button>}
              {state === 'CLAIMED' && <div>مجوز استفاده شده است.</div>}
            </>
          )}
          <button className="btn btn-ghost" disabled={busy} onClick={() => void cancel()}>لغو درخواست</button>
        </div>
      )}
    </div>
  )
}
