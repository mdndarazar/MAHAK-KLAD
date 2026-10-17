/**
 * جلسه ۳۵ · هارنس §۲۳ — جایگزین `@prisma/client`.
 * `new PrismaClient()` یک *نمونه‌ی مشترک* روی همان فایل SQLite برمی‌گرداند
 * (singleton)، چون `db/client.ts` در همه‌ی سرویس‌ها یک `prisma` می‌سازد و تست
 * باید دقیقاً همان اتصال را ببیند.
 */
import { createClient } from '../prismaLite.mjs'

const FILE = process.env.HARNESS_DB
if (!FILE) throw new Error('HARNESS_DB تعیین نشده است')

let shared = null
export function harnessClient() {
  // A multi-process race probe opens the SAME already-migrated SQLite file;
  // it must never rebuild/delete the other worker's database. Ordinary tests
  // keep their fresh isolated fixture by default.
  if (!shared) shared = createClient(FILE, { fresh: process.env.HARNESS_DB_EXISTING !== '1' })
  return shared
}

export class PrismaClient {
  constructor(options = {}) {
    /**
     * سرویس ادغام برای فایل backup یک PrismaClient با datasource موقت می‌سازد.
     * هارنس قبلاً آن URL را نادیده می‌گرفت و در نتیجه هر تست merge ناخواسته
     * دیتابیس مقصد را به‌عنوان مبدأ هم می‌خواند. URL صریح باید واقعاً یک اتصال
     * مستقل به همان فایل SQLite بسازد؛ سایر مسیرهای محصول همچنان shared هستند.
     */
    const url = options?.datasources?.db?.url
    if (typeof url === 'string' && url.startsWith('file:')) {
      const path = decodeURIComponent(url.slice('file:'.length).split('?')[0])
      return createClient(path, { fresh: false })
    }
    return harnessClient()
  }
}
export const Prisma = {
  TransactionIsolationLevel: { Serializable: 'Serializable' },
  sql: () => {
    throw new Error('HARNESS: Prisma.sql پشتیبانی نمی‌شود')
  }
}
export default { PrismaClient, Prisma }
