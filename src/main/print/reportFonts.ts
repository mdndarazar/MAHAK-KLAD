import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BusinessError } from '../errors'

/**
 * The hidden print window is NOT the renderer: it does not load styles.css or
 * its locally bundled Vazirmatn. With the system sans-serif font, the A4
 * report's Persian rows can wrap differently (150 rows became five pages
 * instead of four). Embed the same OFL-licensed font in this *one* report,
 * regardless of the PC's installed fonts. The small extraResources copies
 * live at resources/print/fonts in development and resources/print/fonts
 * under process.resourcesPath in the packaged app. Do not fetch fonts online.
 */
const fontFiles = [
  ['Arabic', 400, 'U+0600-06FF,U+0750-077F,U+0870-08FF,U+200C-200E,U+FB50-FDFF,U+FE70-FEFC'],
  ['Latin', 400, 'U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
  ['Arabic', 700, 'U+0600-06FF,U+0750-077F,U+0870-08FF,U+200C-200E,U+FB50-FDFF,U+FE70-FEFC'],
  ['Latin', 700, 'U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD']
] as const

let cached: string | null = null
export function reportFontCss(): string {
  if (cached) return cached
  const roots = [
    ...(process.resourcesPath ? [join(process.resourcesPath, 'print', 'fonts')] : []),
    join(process.cwd(), 'resources', 'print', 'fonts')
  ]
  const root = roots.find((dir) => fontFiles.every(([subset, weight]) =>
    existsSync(join(dir, `Vazirmatn-${subset}-${weight}.woff2`))))
  if (!root) throw new BusinessError('فونت فارسیِ همراه گزارش چاپی پیدا نشد؛ چاپ شروع نشد. فایل‌های بستهٔ برنامه را بازبینی یا برنامه را دوباره نصب کنید.')

  // Cache the bytes, not a URL to an app.asar or a temp file: both data: URLs
  // and temporary print documents then use the *same* offline, portable font.
  cached = fontFiles.map(([subset, weight, range]) =>
    `@font-face { font-family: Vazirmatn; font-style: normal; font-weight: ${weight}; ` +
    `font-display: swap; unicode-range: ${range}; ` +
    `src: url(data:font/woff2;base64,${readFileSync(join(root, `Vazirmatn-${subset}-${weight}.woff2`)).toString('base64')}) format('woff2'); }`
  ).join('\n')
  return cached
}
