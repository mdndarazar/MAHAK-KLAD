import { useEffect, useState } from 'react'
import { call } from '../lib/api'

export function RemoteRequestBox({ panel }: { panel: string }) {
  const [code, setCode] = useState<string | null>(null)
  const [gt, setGt] = useState<string | null>(null)
  const [granted, setGranted] = useState(false)

  const request = async () => {
    const r: any = await call('remoteAuth:request' as any, { panel })
    if (r?.code) {
      setCode(r.code)
      setGt(r.gt)
    }
  }

  useEffect(() => {
    if (!code || granted) return
    const id = setInterval(async () => {
      const s: any = await call('remoteAuth:status' as any, { panel })
      if (s?.granted) {
        setGranted(true)
        setCode(null)
        clearInterval(id)
      }
    }, 2000)
    return () => clearInterval(id)
  }, [code, granted, panel])

  if (granted) {
    return <div className="rounded px-3 py-2 bg-emerald-50 border border-emerald-300">🔓 مجوز مدیر فعال — می‌توانید ادامه دهید</div>
  }
  if (code) {
    return (
      <div className="rounded px-3 py-2 bg-sky-50 border border-sky-300 space-y-1">
        <div>کد درخواست: <b>{code}</b> — این کد را به مدیر بدهید</div>
        {gt && <div className="kbd">کد مجوز: {gt} — در کادر رمز بزنید</div>}
        <div className="kbd">پس از تایید مدیر، این بخش خودکار باز می‌شود</div>
      </div>
    )
  }
  return (
    <button className="btn btn-ghost w-full" onClick={() => void request()}>
      درخواست مجوز از مدیر (راه دور)
    </button>
  )
}
