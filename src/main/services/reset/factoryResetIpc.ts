/**
 * طرح ۱۴۰۵ · مرحلهٔ ۸ — کانال‌های «صفر کردن برنامه» (همه از راه `handle()` مشترک `ipc/index.ts`، پس بافت
 * فراخوانی و owner همان پنجره است و دروازه در خود سرویس سنجیده می‌شود):
 *   - پیش‌نمایش: فقط خواندن (شمارش‌ها، بکاپ‌های محافظت‌شده، جای خالی، آخرین رسید)؛
 *   - اجرا: تأیید تایپی «صفر» و تیک، سپس قفل کار `system.factory-reset`؛ پیام ⚠️ پیام‌رسان پیش از کار؛
 *   - باز شدن دوباره: فقط پس از صفر کردن موفق.
 */
import { messengerEngine } from '../cloud/messenger/messengerRuntime'
import { createFactoryResetService, type FactoryResetService } from './FactoryResetService'

type Handle = (channel: string, fn: (payload: any) => Promise<unknown> | unknown) => void

let service: FactoryResetService | null = null

export function registerFactoryResetHandlers(
  handle: Handle,
  channels: { preview: string; run: string; relaunch: string },
  actor: (payload: Record<string, unknown>) => Promise<{ userId?: number | null }>
): void {
  service = service ?? createFactoryResetService({
    // پیام ⚠️ «صفر کردن آغاز شد» فقط اگر پیام‌رسان روشن است (خود موتور می‌سنجد)
    beforeFactoryReset: () => messengerEngine().beforeFactoryReset()
  })
  const s = service
  handle(channels.preview, () => s.preview())
  handle(channels.run, async (p) => {
    const input = (p ?? {}) as Record<string, unknown>
    const { userId } = await actor(input)
    return s.run({
      mode: input.mode,
      confirmText: input.confirmText,
      acknowledged: input.acknowledged,
      managerPassword: typeof input.managerPassword === 'string' ? input.managerPassword : null,
      userId: userId ?? null
    })
  })
  handle(channels.relaunch, () => s.relaunchNow())
}
