import type { Basis, Candle, Position, Trade } from '../types'

export const WSOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const QUOTES = [WSOL, USDC, USDT]
// Held but not a position worth watching.
export const NOT_MEMES = new Set(QUOTES)

export const TOP_N = 5

export function isWallet(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)
}

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
export type RawTx = {
  slot?: number
  blockTime?: number | null
  transaction: { signatures?: string[]; message: { accountKeys: (string | { pubkey: string })[] } }
  meta: {
    err: unknown
    preBalances: number[]
    postBalances: number[]
    preTokenBalances?: TokenBalance[]
    postTokenBalances?: TokenBalance[]
    loadedAddresses?: { writable: string[]; readonly: string[] }
  } | null
}

const ui = (b: TokenBalance) => Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals

// Balances are indexed over the static keys, then the lookup-table writables, then readonlys.
function keysOf(tx: RawTx): string[] {
  const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey))
  return [...keys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])]
}

function lamportDelta(tx: RawTx, owner: string): number {
  const i = keysOf(tx).indexOf(owner)
  return i < 0 ? 0 : ((tx.meta?.postBalances[i] ?? 0) - (tx.meta?.preBalances[i] ?? 0)) / 1e9
}

// An owner's balance change of `mint` in one tx, counting accounts the tx closed
// (how a full exit usually looks: the account vanishes from postTokenBalances).
export function tokenDelta(tx: RawTx, owner: string, mint: string): number {
  const pre = tx.meta?.preTokenBalances ?? []
  const post = tx.meta?.postTokenBalances ?? []
  let d = 0
  for (const a of post) {
    if (a.owner !== owner || a.mint !== mint) continue
    const b = pre.find(x => x.accountIndex === a.accountIndex)
    d += ui(a) - (b ? ui(b) : 0)
  }
  for (const b of pre) {
    if (b.owner !== owner || b.mint !== mint) continue
    if (!post.some(a => a.accountIndex === b.accountIndex)) d -= ui(b)
  }
  return d
}

// SOL an owner received (+) or paid (−) in one tx, native and wrapped.
export function solDelta(tx: RawTx, owner: string): number {
  return lamportDelta(tx, owner) + tokenDelta(tx, owner, WSOL)
}

// USD an owner received (+) or paid (−) in one tx: native SOL and wSOL at `solUsd`, stables at $1.
export function usdDelta(tx: RawTx, owner: string, solUsd: number): number {
  return solDelta(tx, owner) * solUsd + tokenDelta(tx, owner, USDC) + tokenDelta(tx, owner, USDT)
}

// The txs of the position held now (oldest first), so PnL skips every round before it. Walks
// `newestFirst` back from the balance `held` now: the round starts at the tx before which the
// balance was dust (under 0.1% of the round's peak). `complete` is false if it never got there.
export function currentRound(newestFirst: RawTx[], owner: string, mint: string, held: number) {
  let peak = held
  for (let i = 0; i < newestFirst.length; i++) {
    held -= tokenDelta(newestFirst[i]!, owner, mint)
    peak = Math.max(peak, held)
    if (held <= peak * 1e-3) return { txs: newestFirst.slice(0, i + 1).reverse(), complete: true }
  }
  return { txs: [...newestFirst].reverse(), complete: false }
}

// Buys = token in, money out; sells = token out, money in. Transfers and airdrops move no money
// beyond the fee, so they count toward neither. `solUsdAt` is SOL's price when the tx landed.
export function basisOf(txs: RawTx[], wallet: string, mint: string, solUsdAt: (tx: RawTx) => number, truncated = false): Basis {
  const basis: Basis = { buyUsd: 0, sellUsd: 0, trades: 0, truncated }
  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue
    const tok = tokenDelta(tx, wallet, mint)
    const usd = usdDelta(tx, wallet, solUsdAt(tx))
    if (tok > 0 && usd < 0) basis.buyUsd -= usd
    else if (tok < 0 && usd > 0) basis.sellUsd += usd
    else continue
    basis.trades += 1
  }
  return basis
}

// Tokens that reached `owner` with no money leaving (what basisOf skips), each with the
// address that sent the most of `mint` in that tx, if one did.
export function transfersIn(txs: RawTx[], owner: string, mint: string, solUsdAt: (tx: RawTx) => number) {
  const ins: { tx: RawTx; amount: number; from?: string }[] = []
  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue
    const amount = tokenDelta(tx, owner, mint)
    if (amount <= 0 || usdDelta(tx, owner, solUsdAt(tx)) < 0) continue
    let from: string | undefined
    let most = 0
    for (const b of tx.meta.preTokenBalances ?? []) {
      if (b.mint !== mint || !b.owner || b.owner === owner) continue
      const d = tokenDelta(tx, b.owner, mint)
      if (d < most) { most = d; from = b.owner }
    }
    ins.push({ tx, amount, from })
  }
  return ins
}

// Average USD an owner paid per token of `mint` over its buys.
export function avgBuyPrice(txs: RawTx[], owner: string, mint: string, solUsdAt: (tx: RawTx) => number): number | undefined {
  let usd = 0
  let tokens = 0
  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue
    const tok = tokenDelta(tx, owner, mint)
    const paid = -usdDelta(tx, owner, solUsdAt(tx))
    if (tok > 0 && paid > 0) { usd += paid; tokens += tok }
  }
  return tokens ? usd / tokens : undefined
}

// One swap read off the POOL's side: the non-signer owner whose `mint` balance moved (`d`),
// against the USD it moved the other way (`q`). A pump.fun bonding curve holds native lamports,
// not wSOL, so those count when no quote token moved. For `mint` = wSOL (SOL's own price) only
// stablecoin legs count.
function poolLeg(tx: RawTx, mint: string, solUsd: number) {
  if (!tx.meta || tx.meta.err) return undefined
  const signer = keysOf(tx)[0] ?? ''
  const owners = new Set([...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
    .filter(b => b.mint === mint && b.owner && b.owner !== signer)
    .map(b => b.owner!))
  for (const owner of owners) {
    const d = tokenDelta(tx, owner, mint)
    if (d === 0) continue
    let q = 0
    for (const m of QUOTES) if (m !== mint) q += tokenDelta(tx, owner, m) * (m === WSOL ? solUsd : 1)
    if (q === 0 && mint !== WSOL) q = lamportDelta(tx, owner) * solUsd
    if (q !== 0 && Math.sign(q) !== Math.sign(d)) return { d, q, signer }
  }
  return undefined
}

// USD per token at one swap.
export function swapPriceUsd(tx: RawTx, mint: string, solUsd: number): number | undefined {
  const leg = poolLeg(tx, mint, solUsd)
  return leg && Math.abs(leg.q / leg.d)
}

// The swap in one tx as a trade at time `t`. The pool paying out tokens means the trader bought.
export function tradeOf(tx: RawTx, mint: string, solUsd: number, sig: string, t: number): Trade | undefined {
  const leg = poolLeg(tx, mint, solUsd)
  if (!leg) return undefined
  return { sig, t, side: leg.d < 0 ? 'buy' : 'sell', price: Math.abs(leg.q / leg.d), usd: Math.abs(leg.q), tokens: Math.abs(leg.d), maker: leg.signer }
}

// Median over recent swaps: robust to one sandwich or a dust trade.
export function medianPrice(txs: RawTx[], mint: string, solUsd: number): number | undefined {
  const ps = txs.flatMap(tx => swapPriceUsd(tx, mint, solUsd) ?? []).sort((a, b) => a - b)
  return ps.length ? ps[Math.floor(ps.length / 2)] : undefined
}

// PnL in USD = what came out + what's still held − what went in.
export function pnl(p: Position): { usd: number; pct: number } | undefined {
  if (!p.basis || p.basis.buyUsd <= 0) return undefined
  const usd = p.basis.sellUsd + p.valueUsd - p.basis.buyUsd
  return { usd, pct: (usd / p.basis.buyUsd) * 100 }
}

export function formatUsd(n: number, signed = false): string {
  const a = Math.abs(n)
  const s = a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : a.toFixed(2)
  return (n < 0 ? '−' : signed ? '+' : '') + '$' + s
}

export function formatPrice(n: number): string {
  if (n >= 1) return '$' + n.toFixed(2)
  if (n === 0) return '$0'
  return '$' + n.toPrecision(3)
}

export function formatPct(n: number): string {
  return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1) + '%'
}

// ---- Token terminal ----

export const TIMEFRAMES = [
  { label: '30s', sec: 30 },
  { label: '1m', sec: 60 },
  { label: '5m', sec: 300 },
  { label: '15m', sec: 900 },
  { label: '1h', sec: 3600 },
  { label: '4h', sec: 14400 },
  { label: '1D', sec: 86400 },
] as const
export const tfOf = (label: string) => TIMEFRAMES.find(t => t.label === label) ?? TIMEFRAMES[0]

const MAX_CANDLES = 500
// A swap priced more than this factor off the median of the swaps before it is a mispriced tx
// (an odd route, a sandwich leg, a dust trade), not the market.
const OUTLIER = 1.5
const WINDOW = 21
// Rejected swaps that agree with each other this many times in a row are a real move: accepted.
const CONFIRM = 3

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const far = (p: number, m: number) => p > m * OUTLIER || p < m / OUTLIER

// The trades (oldest first) that priced the market: outliers against their neighbours dropped.
export function marketTrades(trades: Trade[]): Trade[] {
  const out: Trade[] = []
  let recent = trades.slice(0, WINDOW).map(t => t.price)
  let held: Trade[] = []
  for (const t of trades) {
    if (!far(t.price, median(recent))) {
      out.push(t)
      recent = [...recent, t.price].slice(-WINDOW)
      held = []
      continue
    }
    held.push(t)
    const m = median(held.map(h => h.price))
    if (held.length >= CONFIRM && held.every(h => !far(h.price, m))) {
      out.push(...held)
      recent = held.map(h => h.price)
      held = []
    }
  }
  return out
}

// Folds one trade into the candles of `tfSec`: extends the current bar, opens the next one at
// the last close, or (late arrival) widens an earlier bar.
export function applyTrade(candles: Candle[], tr: Trade, tfSec: number): Candle[] {
  const t = Math.floor(tr.t / tfSec) * tfSec
  const last = candles[candles.length - 1]
  if (!last) return [{ t, o: tr.price, h: tr.price, l: tr.price, c: tr.price, v: tr.usd }]
  if (t > last.t) return [...candles, { t, o: last.c, h: Math.max(last.c, tr.price), l: Math.min(last.c, tr.price), c: tr.price, v: tr.usd }].slice(-MAX_CANDLES)
  const i = candles.findIndex(c => c.t === t)
  if (i < 0) return candles
  const c = candles[i]!
  const next = { ...c, h: Math.max(c.h, tr.price), l: Math.min(c.l, tr.price), v: c.v + tr.usd, c: i === candles.length - 1 ? tr.price : c.c }
  return [...candles.slice(0, i), next, ...candles.slice(i + 1)]
}

// Candles of `tfSec` from trades oldest first.
export const candlesFrom = (trades: Trade[], tfSec: number) => marketTrades(trades).reduce<Candle[]>((cs, t) => applyTrade(cs, t, tfSec), [])

// Buys, sells and wallets over the trades since `from` (unix seconds).
export function flowSince(trades: Trade[], from: number) {
  const f = { buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, volUsd: 0, makers: 0 }
  const makers = new Set<string>()
  for (let i = trades.length - 1; i >= 0 && trades[i]!.t >= from; i--) {
    const t = trades[i]!
    if (t.side === 'buy') { f.buys += 1; f.buyUsd += t.usd } else { f.sells += 1; f.sellUsd += t.usd }
    makers.add(t.maker)
  }
  f.volUsd = f.buyUsd + f.sellUsd
  f.makers = makers.size
  return f
}

// % change from the last trade at or before `from` to `price`; undefined when none goes back that far.
export function changeSince(trades: Trade[], from: number, price: number): number | undefined {
  let at: number | undefined
  for (const t of trades) {
    if (t.t > from) break
    at = t.price
  }
  return at ? (price / at - 1) * 100 : undefined
}

const SUB = '₀₁₂₃₄₅₆₇₈₉'
// $0.0₄1234 for tiny prices (the leading zeros counted), as trading frontends show them.
export function fmtPrice(p: number): string {
  if (!(p > 0)) return '$0'
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (p >= 1) return '$' + p.toFixed(4)
  if (p >= 0.0001) return '$' + p.toPrecision(4)
  const zeros = -Math.floor(Math.log10(p)) - 1
  const digits = Math.round(p * 10 ** (zeros + 4)).toString().slice(0, 4)
  return '$0.0' + [...String(zeros)].map(d => SUB[Number(d)]).join('') + digits
}

export function fmtUsd(n: number): string {
  const a = Math.abs(n)
  const s = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(a >= 100 ? 0 : 2)
  return (n < 0 ? '-$' : '$') + s
}

export function fmtNum(n: number): string {
  const a = Math.abs(n)
  return a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(a >= 10 ? 0 : 2)
}

export const fmtPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%'

export function fmtSpan(s: number): string {
  return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

export function hhmmss(t: number): string {
  const d = new Date(t * 1000)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// A bar of `width` cells, `frac` of it filled.
export function bar(frac: number, width: number): string {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}
