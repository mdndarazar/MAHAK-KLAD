import { useEffect, useRef, useState } from 'react'
import { REMOTE_AUTH_CHANNELS, type RemoteAuthRequestResult, type RemoteAuthStatusResult } from '@shared/remoteAuthChannels'
import { call } from '../lib/api'

/** Experimental UI only. The readiness gate must remain closed until the entire
 * approval and session lifecycle is integrated and independently tested. */
export function RemoteRequestBox({ panel }: { panel: string }) {
  const [request, setRequest] = useState<RemoteAuthRequestResult | null>(null)
  const [state, setState] = useState<RemoteAuthStatusResult['state']>('PENDING')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    // Ignore late responses after a panel change or unmount. A request already
    // sent to Main may still expire there; never cancel a newer request here.
    generation.current++
    setRequest(null)
    setState('PENDING')
    setBusy(false)
    setError(null)
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
              {state === 'APPROVED' && <div>درخواست تأیید شده است. کد مجوز را در کادر رمز همین پنجره وارد کنید: <b>{current.gt}</b></div>}
              {state === 'CLAIMED' && <div>مجوز استفاده شده است.</div>}
            </>
          )}
          <button className="btn btn-ghost" disabled={busy} onClick={() => void cancel()}>لغو درخواست</button>
        </div>
      )}
    </div>
  )
}
