import type { Candle } from '../types'

// A candle chart in terminal cells (a Raster), so it draws in any terminal. Kept plain: candle
// bodies only (no wicks), each cell two pixels tall, scaled to the candles on screen, and the
// right axis in market cap (price × `supply`; price when the supply is unknown). Volume runs
// along the bottom, times along the last row.

const DEFAULT = 0x01000000 // the terminal's own color
const UP = 0x0ecb81
const DOWN = 0xf6465d
const DIM = 0x3a404a
const AXIS = 0x848e9c
const WHITE = 0xffffff
const BARS = ' ▁▂▃▄▅▆▇█'

// $ with a K/M/B unit picked by `top` (the axis's largest value) and as many decimals as `step`
// needs, so neighbouring labels never read the same.
export function fmtAxis(v: number, top: number, step: number): string {
  const [unit, sym] = top >= 1e9 ? [1e9, 'B'] : top >= 1e6 ? [1e6, 'M'] : top >= 1e3 ? [1e3, 'K'] : [1, '']
  const decimals = Math.max(0, Math.min(sym ? 3 : 10, Math.ceil(-Math.log10(step / unit))))
  return '$' + (v / unit).toFixed(decimals) + sym
}

// A 1-2-5 step giving about `n` ticks over `range`.
function niceStep(range: number, n: number): number {
  const raw = range / n
  const mag = 10 ** Math.floor(Math.log10(raw))
  const f = raw / mag
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag
}

const hhmm = (t: number) => {
  const d = new Date(t * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function rasterChart(candles: Candle[], cols: number, rows: number, supply = 0): Uint32Array {
  const cells = new Uint32Array(cols * rows * 3)
  const put = (x: number, y: number, ch: string, fg: number, bg = DEFAULT) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return
    const i = (y * cols + x) * 3
    cells[i] = ch.codePointAt(0)!
    cells[i + 1] = fg
    cells[i + 2] = bg
  }
  const text = (x: number, y: number, s: string, fg: number, bg = DEFAULT) => [...s].forEach((ch, i) => put(x + i, y, ch, fg, bg))
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) put(x, y, ' ', DEFAULT)

  if (!candles.length) {
    const msg = 'waiting for swaps…'
    text(Math.max(0, Math.floor((cols - msg.length) / 2)), Math.floor(rows / 2), msg, AXIS)
    return cells
  }

  const axisW = 11
  const plotW = Math.max(4, cols - axisW)
  const timeRow = rows - 1
  const volRows = rows >= 14 ? 2 : 1
  const priceRows = Math.max(2, timeRow - volRows)
  // One column per candle and one gap, newest at the right edge.
  const n = Math.max(1, Math.floor(plotW / 2))
  const vis = candles.slice(-n)
  const x = (i: number) => plotW - 2 * (vis.length - i)

  // Market cap (or price); the range is the bodies', padded a little.
  const cap = (p: number) => p * (supply || 1)
  let hi = Math.max(...vis.map(c => cap(Math.max(c.o, c.c))))
  let lo = Math.min(...vis.map(c => cap(Math.min(c.o, c.c))))
  if (hi - lo < hi * 0.005) { hi *= 1.0025; lo *= 0.9975 }
  const pad = (hi - lo) * 0.06
  hi += pad
  lo = Math.max(0, lo - pad)
  const px = priceRows * 2
  // % to half-cell row, 0 at the top.
  const yOf = (v: number) => Math.max(0, Math.min(px - 1, Math.round(((hi - v) / (hi - lo)) * (px - 1))))

  // Gridlines and labels on round steps.
  const last = vis[vis.length - 1]!
  const lastRow = Math.floor(yOf(cap(last.c)) / 2)
  const step = niceStep(hi - lo, Math.max(2, Math.min(5, Math.floor(priceRows / 3))))
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = Math.floor(yOf(v) / 2)
    for (let xx = 0; xx < plotW; xx += 2) put(xx, y, '─', DIM)
    if (y !== lastRow) text(plotW + 1, y, fmtAxis(v, hi, step), AXIS)
  }

  // Candle bodies: full blocks, half blocks at the ends, at least half a cell.
  vis.forEach((c, i) => {
    const color = c.c >= c.o ? UP : DOWN
    const top = yOf(cap(Math.max(c.o, c.c)))
    const bot = Math.max(top, yOf(cap(Math.min(c.o, c.c))))
    for (let r = Math.floor(top / 2); r <= Math.floor(bot / 2); r++) {
      const upper = 2 * r >= top && 2 * r <= bot
      const lower = 2 * r + 1 >= top && 2 * r + 1 <= bot
      put(x(i), r, upper && lower ? '█' : upper ? '▀' : '▄', color)
    }
  })

  // Volume bars under the candles, eighths of a cell.
  const maxV = Math.max(...vis.map(c => c.v)) || 1
  vis.forEach((c, i) => {
    let eighths = Math.max(1, Math.round((c.v / maxV) * volRows * 8))
    const color = c.c >= c.o ? UP : DOWN
    for (let r = timeRow - 1; r >= priceRows && eighths > 0; r--, eighths -= 8) put(x(i), r, BARS[Math.min(8, eighths)]!, color)
  })

  // The latest value, tagged on the axis.
  const lastColor = last.c >= last.o ? UP : DOWN
  text(plotW, lastRow, (' ' + fmtAxis(cap(last.c), hi, step / 10)).slice(0, axisW).padEnd(axisW), WHITE, lastColor)

  // Times along the last row, one label every ~12 columns.
  for (let i = vis.length - 1; i >= 0; i -= 6) {
    const label = hhmm(vis[i]!.t)
    const lx = x(i) - 2
    if (lx >= 0 && lx + label.length <= plotW) text(lx, timeRow, label, AXIS)
  }
  return cells
}

// Bytes as standard base64 (native where the runtime has Uint8Array.prototype.toBase64).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function toBase64(b: Uint8Array): string {
  const native = (b as Uint8Array & { toBase64?: () => string }).toBase64
  if (native) return native.call(b)
  const out: string[] = []
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out.push(B64[n >> 18]! + B64[(n >> 12) & 63]! + (i + 1 < b.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < b.length ? B64[n & 63]! : '='))
  }
  return out.join('')
}
