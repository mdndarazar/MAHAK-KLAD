import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { isOwnRendererPage } from '../../src/main/ipc/remoteAuth.ts'

// The owner-only IPC accepts calls only from the application's own page. On an
// installed Windows app, Chromium canonicalizes the file URL that loadFile()
// produces; its percent-encoding of the install path may differ from Node's.
// Chromium itself is not run here: its URL variants (encoded or literal
// characters, drive-letter case, hash) are given explicitly and checked with
// Node's real Windows path/URL rules. No installed Windows app is involved.
const WIN = 'C:\\Users\\محمد رضا\\AppData\\Local\\Programs\\MahakPOS\\resources\\app.asar\\out\\renderer\\index.html'
const ODD = 'C:\\Users\\Ali (Shop) {1} ~&^`!\'\\AppData\\Local\\Programs\\MahakPOS\\resources\\app.asar\\out\\renderer\\index.html'
const POSIX = '/opt/Mahak POS/resources/app.asar/out/renderer/index.html'
const winUrl = path => pathToFileURL(path, { windows: true }).href
const accepted = (url, file, windows) => assert.equal(isOwnRendererPage(url, file, windows), true, url)
const rejected = (url, file, windows) => assert.equal(isOwnRendererPage(url, file, windows), false, url)

test('Windows: the own page is accepted however its install path is encoded', () => {
  const base = winUrl(WIN)
  accepted(base, WIN, true)
  accepted(base.replace('file:///C:', 'file:///c:'), WIN, true)
  accepted(`${base}#/remote-link`, WIN, true)
  accepted('file:///C:/Users/محمد رضا/AppData/Local/Programs/MahakPOS/resources/app.asar/out/renderer/index.html', WIN, true)
  accepted(base.replace('/out/renderer/index.html', '/OUT/Renderer/INDEX.html'), WIN, true)
  accepted(base.replace('/out/renderer/', '/out/main/../renderer/'), WIN, true)
  for (const url of [winUrl(ODD), 'file:///C:/Users/Ali%20%28Shop%29%20%7B1%7D%20~%26%5E%60%21%27/AppData/Local/Programs/MahakPOS/resources/app.asar/out/renderer/index.html',
    "file:///C:/Users/Ali%20(Shop)%20{1}%20~&^%60!'/AppData/Local/Programs/MahakPOS/resources/app.asar/out/renderer/index.html"]) accepted(url, ODD, true)
})

test('Windows: another file, folder, host, scheme or an undecodable URL is rejected', () => {
  const base = winUrl(WIN)
  rejected(base.replace('/index.html', '/other.html'), WIN, true)
  rejected(base.replace('%D9%85%D8%AD%D9%85%D8%AF%20%D8%B1%D8%B6%D8%A7', 'Other'), WIN, true)
  rejected(base.replace('/out/renderer/index.html', '/out/renderer/index.html/x'), WIN, true)
  rejected(base.replace('file:///C:', 'file://server/share'), WIN, true)
  rejected(base.replace('/renderer/index.html', '/renderer%2Findex.html'), WIN, true)
  rejected(base.replace('/renderer/index.html', '/renderer%5Cindex.html'), WIN, true)
  rejected('https://shop.example/out/renderer/index.html', WIN, true)
  rejected('not a url', WIN, true)
  rejected(base, 'out\\renderer\\index.html', true)
  rejected(base, WIN, false)
})

test('POSIX: exact decoded path, case-sensitive', () => {
  const url = pathToFileURL(POSIX, { windows: false }).href
  accepted(url, POSIX, false)
  accepted(`${url}#/remote-link`, POSIX, false)
  accepted('file://localhost/opt/Mahak%20POS/resources/app.asar/out/renderer/index.html', POSIX, false)
  rejected(url.replace('/renderer/', '/Renderer/'), POSIX, false)
  rejected(url.replace('/index.html', '/other.html'), POSIX, false)
  rejected(url.replace('/renderer/index.html', '/renderer%2Findex.html'), POSIX, false)
})

test('development renderer URL is compared by scheme, host and path only', () => {
  const old = process.env.ELECTRON_RENDERER_URL
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
  try {
    accepted('http://localhost:5173/#/remote-link', WIN, true)
    rejected('http://localhost:5174/', WIN, true)
    rejected('http://127.0.0.1:5173/', WIN, true)
    rejected(winUrl(WIN), WIN, true)
  } finally {
    if (old === undefined) delete process.env.ELECTRON_RENDERER_URL; else process.env.ELECTRON_RENDERER_URL = old
  }
})
