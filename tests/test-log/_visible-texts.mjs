/**
 * کمک‌کار آزمون‌های دفتر آزمون (۴-۶۷، ۴-۱۲۱): متن‌های دیدنی یک پروندهٔ TS/TSX را بیرون می‌کشد.
 * رشته‌های دارای حرف فارسی و متن JSX (حرف فارسی بیرون از رشته و توضیح) برمی‌گردند؛ توضیح‌ها (comment) و
 * regexها کنار می‌روند. اجرای مستقیم همین پرونده فقط یک خودآزمایی کوچک است.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export function visibleTexts(src) {
  const out = []
  let i = 0
  let line = 1
  let code = ''
  let codeLine = 1
  let prevSig = ''
  const n = src.length
  const push = (text, l) => {
    if (/[\u0600-\u06FF]/.test(text)) out.push({ text, line: l })
  }
  const flushCode = () => {
    code.split('\n').forEach((seg, k) => {
      for (const m of seg.matchAll(/[^<>{}]*[\u0600-\u06FF][^<>{}]*/g)) push(m[0].trim(), codeLine + k)
    })
    code = ''
    codeLine = line
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '\n') {
      line++
      code += c
      i++
      continue
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++
          code += '\n'
        }
        i++
      }
      i += 2
      continue
    }
    if (c === '/' && /^[(,=:[!&|?{};]?$/.test(prevSig)) {
      let j = i + 1
      let cls = false
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        else if (src[j] === '/' && !cls) break
        j++
      }
      code += ' '
      i = j + 1
      prevSig = 'r'
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      flushCode()
      const l0 = line
      let j = i + 1
      let s = ''
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          s += src[j + 1] === 'n' ? '\n' : src[j + 1]
          j += 2
          continue
        }
        if (src[j] === '\n') {
          if (c !== '`') break
          line++
        }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1
          j += 2
          while (j < n && depth) {
            const ch = src[j]
            if (ch === '{') depth++
            else if (ch === '}') depth--
            else if (ch === '\n') line++
            else if (ch === "'" || ch === '"' || ch === '`') {
              const q = ch
              j++
              while (j < n && src[j] !== q) {
                if (src[j] === '\\') j++
                j++
              }
            }
            j++
          }
          s += ' … '
          continue
        }
        s += src[j]
        j++
      }
      push(s, l0)
      codeLine = line
      i = src[j] === '\n' ? j : j + 1
      prevSig = 's'
      continue
    }
    code += c
    if (!/\s/.test(c)) prevSig = c
    i++
  }
  flushCode()
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sample = "// override\n/* snapshot */\nconst a = 'متن override'\nconst r = /'x'/\nconst b = <div>نوشتهٔ بند ۲ {x}</div>\n"
  assert.deepEqual(visibleTexts(sample).map((x) => x.text), ['متن override', 'نوشتهٔ بند ۲'])
  console.log('ok visible-texts self-check')
}
