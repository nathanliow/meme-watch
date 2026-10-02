import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, Timer } from 'claude-code'

import type { Basis, Feed, Position, Trade } from '../types'
import { rasterChart, toBase64 } from './raster'
import { NOT_MEMES, TIMEFRAMES, TOP_N, WSOL, avgBuyPrice, bar, basisOf, candlesFrom, changeSince, currentRound, flowSince, fmtNum, fmtPct, fmtPrice, fmtSpan, fmtUsd, formatPct, formatPrice, formatUsd, hhmmss, isWallet, medianPrice, pnl, short, solDelta, tfOf, tokenDelta, tradeOf, transfersIn } from './lib'
import type { RawTx } from './lib'

// Memes: the watched wallet and its positions.
export const wallet = atom({ plugin: 'meme-watch', key: 'wallet' } as const, '')
export const positions = atom({ plugin: 'meme-watch', key: 'positions' } as const, [])
export const solUsd = atom({ plugin: 'meme-watch', key: 'solUsd' } as const, 0)
export const error = atom({ plugin: 'meme-watch', key: 'error' } as const, '')

// Token terminal: the token on the chart.
export const tokenA = atom({ plugin: 'meme-watch', key: 'token' } as const, '')
export const infoA = atom({ plugin: 'meme-watch', key: 'tokenInfo' } as const, null)
export const tfA = atom({ plugin: 'meme-watch', key: 'tf' } as const, '30s')
export const candlesA = atom({ plugin: 'meme-watch', key: 'candles' } as const, [])
export const tradesA = atom({ plugin: 'meme-watch', key: 'trades' } as const, [])
export const feedA = atom({ plugin: 'meme-watch', key: 'feed' } as const, { mode: 'off', slot: 0, lagMs: 0, msg: '' })
export const historyA = atom({ plugin: 'meme-watch', key: 'history' } as const, { from: 0, count: 0, more: false, loading: false })
export const tokenErrorA = atom({ plugin: 'meme-watch', key: 'tokenError' } as const, '')

// ---- Helius ----

// userConfig, set by register. The key falls back to the HELIUS_API_KEY environment variable.
const config = { heliusApiKey: '', priceSeconds: 60, region: 'ewr' }

const heliusKey = async ($: EngineInterface) => config.heliusApiKey || (await $.env.get('HELIUS_API_KEY')) || ''
const NO_KEY = 'Set your Helius API key: /config → meme-watch, or the HELIUS_API_KEY environment variable.'

async function rpc<T>($: EngineInterface, method: string, params: unknown): Promise<T> {
  const key = await heliusKey($)
  if (!key) throw new Error(NO_KEY)
  const res = await $.http.fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  // Never echo the URL: it carries the key.
  if (!res.ok) throw new Error(`Helius ${method} HTTP ${res.status}`)
  let body: { result?: T; error?: { message: string } }
  try {
    body = JSON.parse(res.text)
  } catch {
    throw new Error(`Helius ${method}: response cut off at ${(res.text.length / 1e6).toFixed(2)} MB`)
  }
  if (body.error) throw new Error(`Helius ${method}: ${body.error.message}`)
  return body.result as T
}

type Page = { data: RawTx[]; paginationToken?: string | null }
// Positional params: Helius rejects the object form.
const txsFor = ($: EngineInterface, address: string, opts: Record<string, unknown>) =>
  rpc<Page>($, 'getTransactionsForAddress', [address, { transactionDetails: 'full', maxSupportedTransactionVersion: 1, ...opts }])

// Raydium AMM v4 SOL/USDC: SOL's USD price now and at any past time, off its swaps.
const SOL_USDC_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'
const SOL_BUCKET_S = 300 // historical SOL price resolution
const SOL_SWAPS = 80 // pool txs read per SOL price (~1.3 MB); most aren't swaps
const SOL_PAGES = 5 // pool pages read back before giving up on a SOL price
const SOL_FRESH_MS = 50_000 // the memes poll and the chart both refresh SOL; one call serves both

// SOL's USD price at a unix time (or now), cached across sessions per 5-minute bucket.
async function solAt($: EngineInterface, t?: number): Promise<number> {
  const bucket = t ? Math.floor(t / SOL_BUCKET_S) : undefined
  if (bucket !== undefined) {
    const hit = await $.store.get(`sol:${bucket}`)
    if (typeof hit === 'number') return hit
  }
  // Most pool txs aren't swaps; page further back until one prices SOL.
  let p: number | undefined
  let paginationToken: string | undefined
  for (let page = 0; !p && page < SOL_PAGES; page++) {
    const r = await txsFor($, SOL_USDC_POOL, {
      sortOrder: 'desc', limit: SOL_SWAPS,
      filters: { status: 'succeeded', ...(bucket !== undefined ? { blockTime: { lte: (bucket + 1) * SOL_BUCKET_S } } : {}) },
      ...(paginationToken ? { paginationToken } : {}),
    })
    p = medianPrice(r.data, WSOL, 0)
    paginationToken = r.paginationToken ?? undefined
    if (!paginationToken) break
  }
  if (!p) throw new Error('no SOL/USDC swaps to price SOL')
  if (bucket !== undefined) await $.store.set(`sol:${bucket}`, p)
  return p
}

let solJob: Promise<void> | undefined
let solFetchedAt = 0

// SOL's price now into `solUsd`; a call while one runs, or within SOL_FRESH_MS of the last, joins it.
function refreshSol($: EngineInterface): Promise<void> {
  if (solJob) return solJob
  if (Date.now() - solFetchedAt < SOL_FRESH_MS) return Promise.resolve()
  solJob = (async () => {
    try {
      const p = await solAt($)
      solFetchedAt = Date.now()
      await update($, solUsd, () => p)
    } catch (err) {
      await update($, error, () => (err as Error).message)
    }
  })().finally(() => (solJob = undefined))
  return solJob
}

// ---- Memes ----

const PANE = 'meme-watch'

const USAGE = [
  '/memes <wallet>   watch a Solana wallet (top 5 positions by value)',
  '/memes            open/close the pane',
  '/memes off | on   stop/start polling',
  '/memes rescan     recompute cost basis from chain history',
  '/token <mint>     live chart of any token · /token 1-5 chart of position 1-5',
].join('\n')

// Helius credits: getTransactionsForAddress and DAS are 10 per call. Prices: one call per
// position per refresh (5 per minute at the default 60s ≈ 3k credits/hour). Holdings: ~3–12 calls
// per 2 min; a cost-basis scan, a few calls per position when its balance changes.
const HOLDINGS_MS = 120_000
const SOL_MS = 60_000
const SWAPS = 20 // recent swaps a price is the median of
const SCAN_PAGE = 50 // full txs per history page (~1 MB)
const MAX_PAGES = 100 // up to 5,000 txs read back per token for cost basis
const MAX_UNPRICED = 10 // recently traded tokens DAS has no price for, priced off swaps when ranking
const MIN_SOL = 0.01 // SOL moved below this is fees/rent, not payment

let timers: Timer[] = []
// Cost basis per mint, keyed by the amount held when it was computed: a changed amount
// means a new buy/sell landed, so the basis is rescanned. Resets on reload (one rescan).
const basisCache = new Map<string, { amount: number; basis: Basis }>()
const scanning = new Set<string>()

// ponytail: the mint is in the account list of pump.fun, PumpSwap, Meteora, Raydium CPMM/CLMM and
// transferChecked swaps, so its own history is its trades. Raydium AMM v4 swaps omit it; a token
// trading only there prices stale. Upgrade: poll the pool vault seen in the wallet's own buy.
async function swapPrice($: EngineInterface, mint: string, sol: number): Promise<number | undefined> {
  const r = await txsFor($, mint, { sortOrder: 'desc', limit: SWAPS, filters: { status: 'succeeded' } })
  return medianPrice(r.data, mint, sol)
}

// SOL's USD price at each tx that moved `owner`'s `mint` and real SOL: a trade paid in stables
// needs none, and fees and rent below MIN_SOL count as $0.
async function solPrices($: EngineInterface, txs: RawTx[], owner: string, mint: string) {
  const prices = new Map<RawTx, number>()
  for (const tx of txs) {
    if (tokenDelta(tx, owner, mint) !== 0 && Math.abs(solDelta(tx, owner)) >= MIN_SOL) prices.set(tx, await solAt($, tx.blockTime ?? undefined))
  }
  return (tx: RawTx) => prices.get(tx) ?? 0
}

// An address's successful txs that changed its token balances and match `filters`, newest first,
// until `enough` holds of them or MAX_PAGES. Pages are small enough for $.http.fetch (full txs
// run ~20 KB; a 3 MB body arrives cut). `truncated`: older txs were left unread.
async function txsBack($: EngineInterface, address: string, filters: Record<string, unknown>, enough = (_: RawTx[]) => false) {
  const txs: RawTx[] = []
  let paginationToken: string | undefined
  let pages = 0
  do {
    const r = await txsFor($, address, {
      sortOrder: 'desc', limit: SCAN_PAGE,
      filters: { status: 'succeeded', tokenAccounts: 'balanceChanged', ...filters },
      ...(paginationToken ? { paginationToken } : {}),
    })
    txs.push(...r.data)
    paginationToken = r.paginationToken ?? undefined
    pages += 1
  } while (paginationToken && pages < MAX_PAGES && !enough(txs))
  return { txs, truncated: Boolean(paginationToken) && !enough(txs) }
}

async function scanBasis($: EngineInterface, owner: string, mint: string, amount: number) {
  if (scanning.has(mint)) return
  scanning.add(mint)
  try {
    // Read back only as far as the current position's first tx.
    const history = await txsBack($, owner, { tokenTransfer: { mint } }, txs => currentRound(txs, owner, mint, amount).complete)
    const { txs } = currentRound(history.txs, owner, mint, amount)
    const solUsdAt = await solPrices($, txs, owner, mint)
    const basis = basisOf(txs, owner, mint, solUsdAt, history.truncated)

    // One hop: tokens another wallet sent in cost what that wallet paid for them on average.
    const senders = new Map<string, { amount: number; lastAt: number }>()
    for (const t of transfersIn(txs, owner, mint, solUsdAt)) {
      if (!t.from) continue
      const s = senders.get(t.from)
      senders.set(t.from, { amount: (s?.amount ?? 0) + t.amount, lastAt: Math.max(s?.lastAt ?? 0, t.tx.blockTime ?? 0) })
    }
    for (const [from, s] of senders) {
      const r = await txsBack($, from, { tokenTransfer: { mint, direction: 'in' }, blockTime: { lte: s.lastAt } })
      const avg = avgBuyPrice(r.txs, from, mint, await solPrices($, r.txs, from, mint))
      if (avg) basis.buyUsd += s.amount * avg
      if (r.truncated) basis.truncated = true
    }

    basisCache.set(mint, { amount, basis })
    // Never paid for (airdrops, rewards): not a position. The next holdings refresh fills the slot.
    await update($, positions, list => basis.buyUsd > 0 ? list.map(p => (p.mint === mint ? { ...p, basis } : p)) : list.filter(p => p.mint !== mint))
  } catch (err) {
    await update($, error, () => `cost basis for ${mint.slice(0, 4)}…: ${(err as Error).message}`)
  } finally {
    scanning.delete(mint)
  }
}

type Asset = {
  id: string
  content?: { metadata?: { symbol?: string } }
  token_info?: { balance?: number; decimals?: number; price_info?: { price_per_token?: number } }
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) <= b * 1e-6
// Scanned at this amount and nothing was ever paid for it.
function isUnpaid(mint: string, amount: number) {
  const cached = basisCache.get(mint)
  return Boolean(cached && cached.basis.buyUsd <= 0 && sameAmount(cached.amount, amount))
}

async function refreshHoldings($: EngineInterface) {
  const owner = await read($, wallet)
  if (!owner) return
  try {
    let sol = await read($, solUsd)
    if (!sol) { await refreshSol($); sol = await read($, solUsd) }

    const das = await rpc<{ items: Asset[] }>($, 'searchAssets', { ownerAddress: owner, tokenType: 'fungible', limit: 1000 })
    const held = das.items.flatMap(a => {
      const amount = Number(a.token_info?.balance ?? 0) / 10 ** (a.token_info?.decimals ?? 0)
      if (amount <= 0 || NOT_MEMES.has(a.id)) return []
      const priceUsd = a.token_info?.price_info?.price_per_token ?? 0
      return [{ mint: a.id, sym: a.content?.metadata?.symbol || a.id.slice(0, 4), amount, priceUsd, valueUsd: amount * priceUsd }]
    })

    // DAS prices only established tokens; fresh memecoins come back unpriced. Price the ones
    // this wallet traded in its last SCAN_PAGE txs off their swaps, so new positions still rank.
    const recent = await txsFor($, owner, { sortOrder: 'desc', limit: SCAN_PAGE, filters: { status: 'succeeded', tokenAccounts: 'balanceChanged' } })
    const touched = new Set(recent.data.flatMap(tx => (tx.meta?.postTokenBalances ?? []).filter(b => b.owner === owner).map(b => b.mint)))
    for (const p of held.filter(h => !h.priceUsd && touched.has(h.mint)).slice(0, MAX_UNPRICED)) {
      p.priceUsd = (await swapPrice($, p.mint, sol)) ?? 0
      p.valueUsd = p.amount * p.priceUsd
    }

    const top: Position[] = held
      .filter(p => p.valueUsd >= 1 && !isUnpaid(p.mint, p.amount))
      .sort((a, b) => b.valueUsd - a.valueUsd)
      .slice(0, TOP_N)
      .map(p => ({ ...p, basis: basisCache.get(p.mint)?.basis }))
    // Rows keep their place across refreshes so the highlight doesn't move under the person.
    const was = (await read($, positions)).map(p => p.mint)
    const at = (m: string) => (was.includes(m) ? was.indexOf(m) : Infinity)
    top.sort((a, b) => at(a.mint) - at(b.mint))
    await update($, positions, () => top)
    void chartTop($)
    await update($, error, () => '')
    for (const p of top) {
      const cached = basisCache.get(p.mint)
      if (!cached || !sameAmount(cached.amount, p.amount)) void scanBasis($, owner, p.mint, p.amount)
    }
  } catch (err) {
    await update($, error, () => (err as Error).message)
  }
}

async function refreshPrices($: EngineInterface) {
  const list = await read($, positions)
  const sol = await read($, solUsd)
  if (!list.length || !sol) return
  try {
    const fresh = new Map<string, number>()
    for (const p of list) {
      const price = await swapPrice($, p.mint, sol)
      if (price) fresh.set(p.mint, price)
    }
    await update($, positions, l => l.map(p => {
      const price = fresh.get(p.mint)
      return price ? { ...p, priceUsd: price, valueUsd: p.amount * price } : p
    }))
  } catch (err) {
    await update($, error, () => (err as Error).message)
  }
}

function start($: EngineInterface) {
  stop($)
  void refreshHoldings($)
  timers = [
    $.clock.every(HOLDINGS_MS, () => void refreshHoldings($)),
    $.clock.every(config.priceSeconds * 1000, () => void refreshPrices($)),
    $.clock.every(SOL_MS, () => void refreshSol($)),
  ]
}

function stop($: EngineInterface) {
  for (const t of timers) t.cancel()
  timers = []
}

// ---- Token terminal ----

// A read-only chart terminal for one token, all Helius: history and polling over RPC
// (getTransactionsForAddress), live trades over LaserStream, name/supply/logo from DAS.

const TPANE = 'token-terminal'
const TUSAGE = [
  '/token <mint>   live chart of any Solana token',
  '/token 1-5      chart of your meme-watch position 1-5',
  '/token          open/close the chart (last token)',
  '/token off      close it and stop the feed',
].join('\n')

const C = { up: '#0ecb81', down: '#f6465d', dim: '#5e6673', text: '#848e9c', bright: '#eaecef', warn: '#f0b90b', line: '#2b3139' }
const MAX_TRADES = 120 // tape rows kept
const MAX_HISTORY = 50_000 // trades kept for candles
// History comes 1,000 swaps at a time: one call lists CHUNK signatures (Helius's cap), then their
// full txs (capped near 100 a call, and a big body arrives cut) are read in SLICE-signature slot
// ranges, PARALLEL calls at once. Helius credits: getTransactionsForAddress and DAS are 10 per
// call, so ~260 per 1,000 swaps. Opening a token (or a wider timeframe) reads back until
// FILL_CANDLES candles' worth of time is loaded, at most FILL_CHUNKS chunks; `o` reads one more.
// Polling, only when LaserStream can't run, is one call per POLL_MS (~2.4k credits/hour).
// Top-10 share: 1 credit per 5 min.
const PAGE = 50
const CHUNK = 1000
const SLICE = 40
const SLICE_LIMIT = 80
const PARALLEL = 8
const FILL_CANDLES = 60
const FILL_CHUNKS = 3
const POLL_MS = 15_000
const HOLDERS_MS = 300_000

// Each startToken() bumps `gen`; async work from an older feed sees the change and drops its result.
let gen = 0
let tTimers: Timer[] = []
let bridge: AsyncGenerator<unknown, unknown> | undefined
let pending: Trade[] = []
const seen = new Set<string>()
// Every trade read back or streamed, oldest first: the candles of any timeframe come from it.
let all: Trade[] = []
let older: string | undefined
let chartCache = { key: '', b64: '' }

async function fail($: EngineInterface, g: number, err: unknown) {
  if (g === gen) await update($, tokenErrorA, () => (err as Error).message)
}

async function setFeed($: EngineInterface, g: number, patch: Partial<Feed>) {
  if (g === gen) await update($, feedA, f => ({ ...f, ...patch }))
}

type TokenAsset = {
  content?: { metadata?: { name?: string; symbol?: string }; files?: { cdn_uri?: string }[] }
  token_info?: { supply?: number; decimals?: number }
}

// Name, symbol and supply from DAS; the logo off Helius's own CDN.
async function loadInfo($: EngineInterface, mint: string, g: number) {
  const a = await rpc<TokenAsset>($, 'getAsset', { id: mint })
  if (g !== gen) return
  const supply = Number(a.token_info?.supply ?? 0) / 10 ** (a.token_info?.decimals ?? 0)
  await update($, infoA, () => ({ mint, name: a.content?.metadata?.name ?? '', symbol: a.content?.metadata?.symbol || short(mint), supply, top10Pct: null }))
  void loadTop10($, mint, g)
}

// Share of supply in the 10 largest token accounts (pools and bonding curves included).
async function loadTop10($: EngineInterface, mint: string, g: number) {
  try {
    const r = await rpc<{ value: { uiAmount: number | null }[] }>($, 'getTokenLargestAccounts', [mint])
    const top = r.value.slice(0, 10).reduce((s, x) => s + (x.uiAmount ?? 0), 0)
    if (g === gen) await update($, infoA, i => (i && i.mint === mint && i.supply ? { ...i, top10Pct: (top / i.supply) * 100 } : i))
  } catch {
    // Optional: the panel draws without it.
  }
}


// A page of the mint's txs as trades not seen before, newest first.
// ponytail: history prices SOL legs at SOL's price now (off by SOL's move over the window).
// Upgrade: solAt(blockTime) per 5-minute bucket, as meme-watch's cost basis does.
async function tradesPage($: EngineInterface, mint: string, opts: Record<string, unknown>) {
  const sol = await read($, solUsd)
  const r = await txsFor($, mint, { sortOrder: 'desc', limit: PAGE, filters: { status: 'succeeded' }, ...opts })
  const trades = r.data.flatMap((tx: RawTx) => {
    const sig = tx.transaction.signatures?.[0]
    const t = sig && !seen.has(sig) ? tradeOf(tx, mint, sol, sig, tx.blockTime ?? 0) : undefined
    return t ? [t] : []
  })
  return { trades, next: r.paginationToken ?? undefined }
}

// The next CHUNK swaps older than what's loaded, newest first.
async function historyChunk($: EngineInterface, mint: string) {
  const sol = await read($, solUsd)
  const r = await rpc<{ data: { signature: string; slot: number }[]; paginationToken?: string | null }>($, 'getTransactionsForAddress', [
    mint,
    { transactionDetails: 'signatures', sortOrder: 'desc', limit: CHUNK, filters: { status: 'succeeded' }, ...(older ? { paginationToken: older } : {}) },
  ])
  const slices: { lo: number; hi: number }[] = []
  for (let i = 0; i < r.data.length; i += SLICE) {
    const s = r.data.slice(i, i + SLICE)
    slices.push({ hi: s[0]!.slot, lo: s[s.length - 1]!.slot })
  }
  const bySig = new Map<string, RawTx>()
  for (let i = 0; i < slices.length; i += PARALLEL) {
    const got = await Promise.all(slices.slice(i, i + PARALLEL).map(s => sliceTxs($, mint, s.lo, s.hi)))
    for (const tx of got.flat()) {
      const sig = tx.transaction.signatures?.[0]
      if (sig) bySig.set(sig, tx)
    }
  }
  const trades = r.data.flatMap(({ signature }) => {
    const tx = bySig.get(signature)
    const t = tx && !seen.has(signature) ? tradeOf(tx, mint, sol, signature, tx.blockTime ?? 0) : undefined
    return t ? [t] : []
  })
  return { trades, next: r.paginationToken ?? undefined }
}

// The mint's full txs in slots lo..hi; neighbouring slices share their edge slots (deduped by
// signature), and a busy slot range pages on.
async function sliceTxs($: EngineInterface, mint: string, lo: number, hi: number): Promise<RawTx[]> {
  const out: RawTx[] = []
  let paginationToken: string | undefined
  do {
    const r = await txsFor($, mint, { sortOrder: 'desc', limit: SLICE_LIMIT, filters: { status: 'succeeded', slot: { gte: lo, lte: hi } }, ...(paginationToken ? { paginationToken } : {}) })
    out.push(...r.data)
    paginationToken = r.data.length === SLICE_LIMIT ? r.paginationToken ?? undefined : undefined
  } while (paginationToken)
  return out
}

async function rebuildCandles($: EngineInterface) {
  const tf = tfOf(await read($, tfA))
  chartCache = { key: '', b64: '' }
  await update($, candlesA, () => candlesFrom(all, tf.sec))
}

// Reads `pages` pages further back than what's loaded, redrawing after each.
let loading = false

// Reads up to `pages` pages further back than what's loaded, redrawing after each, stopping early
// once `enough` holds.
async function loadHistory($: EngineInterface, mint: string, g: number, pages: number, enough = () => false) {
  if (loading) return
  loading = true
  await update($, historyA, h => ({ ...h, loading: true }))
  try {
    for (let p = 0; p < pages && !(p > 0 && enough()); p++) {
      const { trades, next } = await historyChunk($, mint)
      if (g !== gen) return
      for (const t of trades) seen.add(t.sig)
      all = [...trades.reverse(), ...all]
      older = next
      await rebuildCandles($)
      await update($, tradesA, ts => (ts.length >= MAX_TRADES ? ts : all.slice(-MAX_TRADES).reverse()))
      await update($, historyA, () => ({ from: all[0]?.t ?? 0, count: all.length, more: Boolean(older), loading: Boolean(older) && p < pages - 1 }))
      if (!older) break
    }
  } catch (err) {
    await fail($, g, err)
  } finally {
    loading = false
    if (g === gen) await update($, historyA, h => ({ ...h, loading: false }))
  }
}

// Loads history until the chart's timeframe has FILL_CANDLES candles of time to draw.
async function fillHistory($: EngineInterface, mint: string, g: number) {
  const from = Date.now() / 1000 - FILL_CANDLES * tfOf(await read($, tfA)).sec
  await loadHistory($, mint, g, FILL_CHUNKS, () => (all[0]?.t ?? Infinity) <= from)
}

function queue(t: Trade) {
  if (seen.size > 200_000) seen.clear()
  seen.add(t.sig)
  pending.push(t)
}

// Trades land in `pending` as they come; once a second they fold into candles and the tape,
// so a busy token redraws the pane once a second, not once a trade.
async function flush($: EngineInterface, g: number) {
  if (!pending.length || g !== gen) return
  const batch = pending.sort((a, b) => a.t - b.t)
  pending = []
  all.push(...batch)
  if (all.length > MAX_HISTORY) all = all.slice(-MAX_HISTORY)
  // Rebuilt rather than extended: a swap's outlier check needs the swaps around it.
  await rebuildCandles($)
  await update($, tradesA, ts => [...[...batch].reverse(), ...ts].slice(0, MAX_TRADES))
}

function startPolling($: EngineInterface, mint: string, g: number, msg: string) {
  if (g !== gen) return
  void setFeed($, g, { mode: 'polling', msg })
  tTimers.push($.clock.every(POLL_MS, async () => {
    try {
      const { trades } = await tradesPage($, mint, { limit: 25 })
      if (g === gen) trades.reverse().forEach(queue)
    } catch (err) {
      await fail($, g, err)
    }
  }))
}

// One line of the bridge's stdout. Returns a fatal error's message.
async function onLine($: EngineInterface, line: string, mint: string, g: number): Promise<string | undefined> {
  let ev: any
  try { ev = JSON.parse(line) } catch { return undefined }
  if (ev.type === 'slot') await setFeed($, g, { mode: 'live', slot: ev.slot, lagMs: ev.createdAt ? Math.max(0, ev.at - ev.createdAt) : 0, msg: '' })
  else if (ev.type === 'tx' && !seen.has(ev.sig)) {
    const t = tradeOf(ev.tx as RawTx, mint, await read($, solUsd), ev.sig, ev.at / 1000)
    if (t) queue(t)
  } else if (ev.type === 'error') return String(ev.message)
  return undefined
}

// LaserStream through the Node bridge (a mod can't hold a gRPC stream); Helius RPC polling if it
// can't run or dies.
async function runBridge($: EngineInterface, mint: string, g: number) {
  const key = await heliusKey($)
  const dir = `${$.plugin.root}/bridge`
  try {
    if (!(await $.fs.exists(`${dir}/node_modules/helius-laserstream/package.json`))) {
      await setFeed($, g, { mode: 'connecting', msg: 'installing the LaserStream SDK (first run)…' })
      const r = await $.process.run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, timeoutMs: 300_000 })
      if (r.exitCode !== 0) throw new Error(`npm ci failed: ${r.stderr.trim().split('\n').pop()}`)
    }
    if (g !== gen) return
    await setFeed($, g, { mode: 'connecting', msg: `LaserStream ${config.region}` })
    const endpoint = `https://laserstream-mainnet-${config.region}.helius-rpc.com`
    const stream = $.process.spawn({ argv: ['node', 'bridge.mjs'], cwd: dir, env: { HELIUS_API_KEY: key, LASERSTREAM_ENDPOINT: endpoint, MINT: mint } })
    bridge = stream
    let buf = ''
    let why = 'stream ended'
    for await (const { stream: which, text } of stream) {
      if (g !== gen) break
      // The SDK's own debug logs (stderr) are noise: never shown.
      if (which === 'stderr') continue
      buf += text
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const fatal = await onLine($, buf.slice(0, i), mint, g)
        buf = buf.slice(i + 1)
        if (fatal) why = fatal
      }
    }
    if (g === gen) startPolling($, mint, g, `LaserStream: ${why}`)
  } catch (err) {
    if (g === gen) startPolling($, mint, g, `LaserStream: ${(err as Error).message}`)
  }
}

function stopFeed() {
  gen += 1
  loading = false
  wanted = ''
  for (const t of tTimers) t.cancel()
  tTimers = []
  // Ending the loop kills the child.
  void bridge?.return(undefined)
  bridge = undefined
  pending = []
  seen.clear()
  all = []
  older = undefined
}

async function startToken($: EngineInterface, mint: string) {
  stopFeed()
  wanted = mint
  const g = gen
  chartCache = { key: '', b64: '' }
  await update($, tokenA, () => mint)
  await update($, infoA, () => null)
  await update($, candlesA, () => [])
  await update($, tradesA, () => [])
  await update($, historyA, () => ({ from: 0, count: 0, more: false, loading: true }))
  await update($, tokenErrorA, () => '')
  await update($, feedA, () => ({ mode: 'connecting', slot: 0, lagMs: 0, msg: '' }))
  await $.store.set('token', mint)

  void (async () => {
    try {
      await refreshSol($)
      await loadInfo($, mint, g)
      if (!(await read($, solUsd))) throw new Error("Couldn't price SOL yet, so SOL-paired swaps can't be priced; retrying each minute")
    } catch (err) {
      await fail($, g, err)
    }
    // The stream first, so no trade lands between the history read and the subscription.
    void runBridge($, mint, g)
    await fillHistory($, mint, g)
  })()

  tTimers.push($.clock.every(1000, () => flush($, g)))
  tTimers.push($.clock.every(SOL_MS, () => void refreshSol($)))
  tTimers.push($.clock.every(HOLDERS_MS, () => void loadTop10($, mint, g)))
}

const openPane = ($: EngineInterface) => $.ui.open({ id: TPANE, title: 'Chart', focus: true, columns: 124, rows: 46 })

// Opens the chart on `mint`; what the memes pane's buttons and address box call.
async function openToken($: EngineInterface, mint: string): Promise<string> {
  if (!isWallet(mint)) {
    await $.ui.toast('Not a Solana token address')
    return TUSAGE
  }
  if (!(await heliusKey($))) return 'Set your Helius API key: /config → meme-watch, or the HELIUS_API_KEY environment variable.'
  await startToken($, mint)
  await openPane($)
  return `Chart: ${short(mint)}. Keys (Tab to refocus the pane): 1-7 timeframe, o older history, c copy address, Esc back to the prompt.`
}

// The token on the chart; '' once the feed stops. The Memes chart changes only on Enter.
let wanted = ''

// Nothing charted yet and the Memes pane is open: chart the top position, or before positions
// load, the token charted last.
async function chartTop($: EngineInterface) {
  const mint = (await read($, positions))[0]?.mint || String((await $.store.get('token')) ?? '')
  if (!wanted && mint && (await $.ui.panes()).some(p => p.id === PANE)) await chartInMemes($, mint)
}
async function chartInMemes($: EngineInterface, mint: string) {
  if (!isWallet(mint)) return void (await $.ui.toast('Not a Solana token address'))
  if (!(await heliusKey($))) return void (await $.ui.toast('Set your Helius API key: /config → meme-watch'))
  if (mint !== wanted) await startToken($, mint)
}

async function setTimeframe($: EngineInterface, label: string) {
  if ((await read($, tfA)) === label) return
  await update($, tfA, () => label)
  await $.store.set('tf', label)
  await rebuildCandles($)
  const mint = await read($, tokenA)
  if (mint && older) await fillHistory($, mint, gen)
}

// Run from the mod's one session.start hook.
async function terminalSessionStart($: EngineInterface) {
  await $.command.register({
    name: 'token',
    description: 'Live chart of a Solana token (any address, or 1-5 for your meme-watch positions)',
    argumentHint: '[<mint> | 1-5 | off]',
  })
  const tf = await $.store.get('tf')
  if (typeof tf === 'string' && TIMEFRAMES.some(t => t.label === tf)) await update($, tfA, () => tf)
  // A reload with the pane still open picks the feed back up.
  const mint = await read($, tokenA)
  if (mint && (await $.ui.panes()).some(p => p.id === TPANE)) await startToken($, mint)
}


export const register: Register = (on, options) => {
  Object.assign(config, { heliusApiKey: String(options.heliusApiKey ?? ''), priceSeconds: Number(options.priceSeconds ?? 60), region: String(options.region ?? 'ewr') })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'memes',
      description: 'Watch the top 5 memecoin positions of a Solana wallet, with live USD PnL',
      argumentHint: '[<wallet> | off | on | rescan]',
    })
    await terminalSessionStart($)
    const saved = await $.store.get('wallet')
    if (typeof saved === 'string' && saved) {
      await update($, wallet, () => saved)
      if ((await $.store.get('enabled')) !== false) start($)
    }
    // A reload with the Memes pane open charts again.
    void chartTop($)
    return next(e)
  })

  on('command.run', { command: 'memes' }, async ($, e) => {
    const arg = e.args.trim()

    if (!arg) {
      if ((await $.ui.panes()).some(p => p.id === PANE)) {
        await $.ui.close({ id: PANE })
        return { text: 'Memes pane closed.' }
      }
      await $.ui.open({ id: PANE, title: 'Memes', focus: true, columns: 124, rows: 48 })
      void chartTop($)
      return { text: 'Memes pane opened.' }
    }
    if (arg === 'off') {
      stop($)
      await update($, positions, () => [])
      await $.store.set('enabled', false)
      return { text: 'Meme watch off. /memes on to resume.' }
    }
    if (arg === 'on' || arg === 'rescan') {
      if (!(await read($, wallet))) return { text: USAGE }
      if (arg === 'rescan') basisCache.clear()
      start($)
      await $.store.set('enabled', true)
      return { text: arg === 'on' ? 'Meme watch on.' : 'Rescanning cost basis.' }
    }
    if (isWallet(arg)) {
      if (!(await heliusKey($))) return { text: NO_KEY }
      basisCache.clear()
      await update($, wallet, () => arg)
      await update($, positions, () => [])
      await $.store.set('wallet', arg)
      await $.store.set('enabled', true)
      start($)
      return { text: `Watching ${arg.slice(0, 4)}…${arg.slice(-4)}. /memes to open the pane.` }
    }
    return { text: USAGE }
  })

  // One row above the prompt: each position's value and PnL, green up, red down.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Only positions with a PnL: still-scanning ones join once their basis is in.
    const list = (await read($, positions)).flatMap(p => {
      const r = pnl(p)
      return r ? [{ ...p, r }] : []
    })
    if (e.props.hasSurvey || !list.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>
          🐸{' '}
          {list.map(({ sym, valueUsd, r }, i) => (
            <Text>
              {i ? ' · ' : ''}<Text bold>{sym}</Text> {formatUsd(valueUsd)}{' '}
              <Text color={r.usd >= 0 ? 'green' : 'red'}>{formatUsd(r.usd, true)} ({formatPct(r.pct)})</Text>
            </Text>
          ))}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const owner = await read($, wallet)
    const list = await read($, positions)
    const sol = await read($, solUsd)
    const err = await read($, error)
    const color = (n: number) => (n >= 0 ? 'green' : 'red')
    const chartRows = (e.props.scroll.bodyRows || 40) - list.length - 7

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{await chartView($, e, true, chartRows)}</Box>
        <Text dimColor>{'TOKEN'.padEnd(9)}{'PRICE'.padStart(11)}{'VALUE'.padStart(10)}{'INVESTED'.padStart(10)}{'PnL'.padStart(11)}{'%'.padStart(9)}</Text>
        {!owner && <Text dimColor>/memes &lt;wallet&gt; to start.</Text>}
        {owner && list.length === 0 && !err && <Text dimColor>Loading positions…</Text>}
        {list.map((p, i) => {
          const r = pnl(p)
          return (
            <Box flexDirection="row">
            <Box width={9}>
              <Button key={`chart-${p.mint}`} label={p.sym.slice(0, 8)} plain autoFocus={i === 0 ? true : undefined} onPress={() => void chartInMemes($, p.mint)} />
            </Box>
            <Text>
              {formatPrice(p.priceUsd).padStart(11)}
              {formatUsd(p.valueUsd).padStart(10)}
              {(p.basis ? formatUsd(p.basis.buyUsd) : '…').padStart(10)}
              {r ? <Text color={color(r.usd)}>{formatUsd(r.usd, true).padStart(11)}{formatPct(r.pct).padStart(9)}</Text> : <Text dimColor>{'scanning'.padStart(11)}</Text>}
            </Text>
            </Box>
          )
        })}
        {err !== '' && <Text color="yellow">{err}</Text>}
        {'Input' in els && <els.Input key="token" label="chart any token: " placeholder="paste a token address, Enter" submitLabel="chart" onSubmit={v => void chartInMemes($, v.trim())} />}
        <Text dimColor>Tab to focus · ↑↓ highlight a token · Enter charts it · 1-7 timeframe · Esc back to the prompt</Text>
        <Text dimColor>
          {owner ? `${owner.slice(0, 4)}…${owner.slice(-4)} · ` : ''}SOL {formatPrice(sol)}
        </Text>
      </Box>
    )
  })

  // ---- Token terminal ----

  on('command.run', { command: 'token' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      await $.ui.close({ id: TPANE })
      stopFeed()
      await update($, feedA, f => ({ ...f, mode: 'off' as const, msg: '' }))
      return { text: 'Chart closed; feed stopped.' }
    }
    if (!arg) {
      if ((await $.ui.panes()).some(p => p.id === TPANE)) {
        await $.ui.close({ id: TPANE })
        return { text: 'Chart closed.' }
      }
      const last = (await read($, tokenA)) || String((await $.store.get('token')) ?? '')
      return { text: last ? await openToken($, last) : TUSAGE }
    }
    if (/^[1-5]$/.test(arg)) {
      const p = (await read($, positions))[Number(arg) - 1]
      return { text: p ? await openToken($, p.mint) : `No position ${arg}: /memes <wallet> first, or it's still loading.` }
    }
    return { text: isWallet(arg) ? await openToken($, arg) : TUSAGE }
  })

  // The feed runs only while the pane is open: it spends LaserStream bandwidth and Helius credits.
  on('ui.close', async ($, e, next) => {
    const other = e.id === PANE ? TPANE : PANE
    if ((e.id === PANE || e.id === TPANE) && e.origin.kind !== 'unload' && !(await $.ui.panes()).some(p => p.id === other)) {
      stopFeed()
      await update($, feedA, f => ({ ...f, mode: 'off' as const, msg: '' }))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: TPANE }, ($, e) => chartView($, e, false, e.props.scroll.bodyRows || 40))
}

// The chart: the /token pane's whole body, or the lower part of the Memes pane (`rows` tall).
async function chartView($: EngineInterface, e: Extract<RenderInput, { component: 'Pane' }>, inMemes: boolean, rows: number) {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const mint = await read($, tokenA)
    const info = await read($, infoA)
    const tf = tfOf(await read($, tfA))
    const candles = await read($, candlesA)
    const trades = await read($, tradesA)
    const feed = await read($, feedA)
    const hist = await read($, historyA)
    const sol = await read($, solUsd)
    const err = await read($, tokenErrorA)
    const addressBox = 'Input' in els ? <els.Input key="mint" label="token: " placeholder="paste a token address, Enter" submitLabel="chart" onSubmit={v => void openToken($, v.trim())} /> : null
    if (!mint) return inMemes ? <Text dimColor>Highlight a token below to chart it.</Text> : <Box flexDirection="column">{addressBox}<Text dimColor>Tab to focus, paste an address, Enter.</Text></Box>

    const W = e.props.bodyColumns
    const now = Date.now() / 1000
    const price = candles[candles.length - 1]?.c ?? trades[0]?.price ?? 0
    // A window's numbers only once the history reaches back that far (or holds the token's whole life).
    const covers = (sec: number) => !hist.more || (hist.count > 0 && hist.from <= now - sec)
    const change = (sec: number) => (covers(sec) ? changeSince(all, now - sec, price) : undefined)
    const ch24 = change(86400)
    const tick = trades[0]?.side === 'sell' ? C.down : C.up
    const sym = info?.symbol ?? short(mint)
    const color = (n: number) => (n >= 0 ? C.up : C.down)

    // Layout over `rows`: header 2, stats 1, timeframe bar 2, chart, tape header 1, tape, footer 2-3.
    const rest = Math.max(10, rows - (inMemes ? 9 : 10))
    const tapeRows = inMemes ? 3 : Math.max(3, Math.min(40, Math.round(rest * 0.36)))
    const chartRows = Math.max(6, Math.min(120, rest - tapeRows))
    const side = W >= 100 ? 30 : 0
    const chartCols = Math.max(20, Math.min(255, W - side - (side ? 1 : 0)))

    const stat = (label: string, value: string, valueColor = C.bright) => (
      <Text>
        <Text color={C.dim}>{label} </Text>
        <Text color={valueColor} bold>{value}</Text>
        <Text>{'   '}</Text>
      </Text>
    )
    const feedBadge =
      feed.mode === 'live' ? <Text color={C.up} bold>● LIVE · LaserStream</Text>
      : feed.mode === 'polling' ? <Text color={C.warn} bold>◐ POLLING · Helius RPC</Text>
      : feed.mode === 'connecting' ? <Text color={C.warn} bold>◌ CONNECTING</Text>
      : <Text color={C.dim} bold>○ OFF</Text>

    let chart
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const key = `${sym}|${info?.supply}|${tf.label}|${chartCols}x${chartRows}|${candles.length}|${candles[0]?.t}|${JSON.stringify(candles[candles.length - 1] ?? null)}`
      if (chartCache.key !== key) chartCache = { key, b64: toBase64(new Uint8Array(rasterChart(candles, chartCols, chartRows, info?.supply ?? 0).buffer)) }
      chart = <Raster key="chart" columns={chartCols} rows={chartRows} cells={chartCache.b64} />
    } else {
      chart = <Box width={chartCols} height={chartRows}><Text color={C.dim}>The chart draws in the terminal.</Text></Box>
    }

    // Flow bars for the side panel: green buys against red sells.
    const bw = side - 4
    const flowBar = (a: number, b: number) => {
      const n = a + b ? Math.round((a / (a + b)) * bw) : Math.round(bw / 2)
      return <Text><Text color={C.up}>{'█'.repeat(n)}</Text><Text color={C.down}>{'█'.repeat(bw - n)}</Text></Text>
    }
    const flowBlock = (title: string, sec: number) => {
      const f = flowSince(all, now - sec)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text><Text color={C.text} bold>{title}</Text><Text color={C.dim}>  vol </Text><Text color={C.bright}>{fmtUsd(f.volUsd)}</Text></Text>
          <Text><Text color={C.up}>{fmtNum(f.buys)} buys</Text><Text color={C.dim}> / </Text><Text color={C.down}>{fmtNum(f.sells)} sells</Text><Text color={C.dim}> · {fmtNum(f.makers)} wallets</Text></Text>
          {flowBar(f.buyUsd, f.sellUsd)}
        </Box>
      )
    }
    const span = hist.count ? now - hist.from : 0
    const panel = side ? (
      <Box flexDirection="column" width={side} height={chartRows} borderStyle="round" borderColor={C.line} paddingX={1}>
        {flowBlock('LAST 60s', 60)}
        {covers(3600) && flowBlock('1H', 3600)}
        {covers(86400) ? flowBlock('24H', 86400) : hist.count > 0 && flowBlock(`LOADED ${fmtSpan(span)}`, span + 1)}
        {info?.top10Pct != null && <Text color={C.text} bold>TOP 10 ACCOUNTS</Text>}
        {info?.top10Pct != null && <Text><Text color={C.dim}>hold </Text><Text color={info.top10Pct > 30 ? C.warn : C.bright}>{info.top10Pct.toFixed(1)}%</Text><Text color={C.dim}> (incl. pools)</Text></Text>}
        {info?.top10Pct != null && <Text color={info.top10Pct > 30 ? C.warn : C.text}>{bar(info.top10Pct / 100, bw)}</Text>}
      </Box>
    ) : null

    // Time & sales, sized against the biggest print on screen.
    const shown = trades.slice(0, tapeRows)
    const maxUsd = Math.max(1, ...shown.map(t => t.usd))
    const wide = W >= 96
    const tape = shown.map(t => {
      const c = t.side === 'buy' ? C.up : C.down
      const big = t.usd >= 1000
      return (
        <Text wrap="truncate">
          <Text color={C.dim}>{hhmmss(t.t).padEnd(10)}</Text>
          <Text color={c} bold>{(t.side === 'buy' ? '▲ BUY ' : '▼ SELL').padEnd(8)}</Text>
          <Text color={C.bright}>{fmtPrice(t.price).padEnd(14)}</Text>
          <Text color={c} bold={big}>{fmtUsd(t.usd).padStart(9)}{big ? (t.usd >= 10_000 ? ' ◆◆' : ' ◆ ') : '   '}</Text>
          {wide && <Text color={c}>{' ' + '▮'.repeat(Math.max(1, Math.round((t.usd / maxUsd) * 12))).padEnd(13)}</Text>}
          <Text color={C.text}>{fmtNum(t.tokens).padStart(10)}  </Text>
          <Text color={C.dim}>{short(t.maker)}</Text>
        </Text>
      )
    })

    const histText = hist.loading ? `loading history… ${fmtNum(hist.count)} swaps` : hist.count ? `${fmtNum(hist.count)} swaps over ${fmtSpan(span)}${hist.more ? '' : ' (all)'}` : 'no swaps yet'

    return (
      <Box flexDirection="column" width={W}>
        {/* Header: identity and price on the left, the feed on the right. */}
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1}>
            <Box flexDirection="column">
              <Text wrap="truncate">
                <Text color={C.bright} bold>{sym}</Text>
                <Text color={C.dim}>{info?.name ? `  ${info.name} · ${short(mint)}` : `  ${short(mint)}`}</Text>
              </Text>
              <Text>
                <Text color={tick} bold>{fmtPrice(price)}</Text>
                {ch24 != null && <Text color={color(ch24)} bold>{'  ' + fmtPct(ch24)}</Text>}
                {ch24 != null && <Text color={C.dim}> 24h</Text>}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="column" alignItems="flex-end">
            {feedBadge}
            <Text color={C.dim} wrap="truncate">
              {feed.msg || (feed.slot ? `slot ${feed.slot.toLocaleString('en-US')} · Δ${feed.lagMs}ms · SOL ${fmtPrice(sol)}` : `SOL ${fmtPrice(sol)}`)}
            </Text>
          </Box>
        </Box>

        {/* Stats strip. */}
        <Text wrap="truncate">
          {info?.supply ? stat('MCAP', fmtUsd(price * info.supply)) : null}
          {info?.supply ? stat('SUPPLY', fmtNum(info.supply)) : null}
          {stat('HISTORY', histText, C.text)}
        </Text>

        {/* Timeframes (hotkeys 1-7) and change over each window the history covers. */}
        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            {TIMEFRAMES.map((t, i) => (
              <Button key={`tf-${t.label}`} label={t.label} hotkey={String(i + 1)} variant={t.label === tf.label ? 'primary' : 'secondary'} onPress={() => setTimeframe($, t.label)} />
            ))}
          </Box>
          <Text wrap="truncate">
            {([['5M', 300], ['1H', 3600], ['6H', 21600], ['24H', 86400]] as const).map(([k, sec]) => {
              const c = change(sec)
              return c == null ? null : <Text><Text color={C.dim}>{k} </Text><Text color={color(c)}>{fmtPct(c)}</Text><Text>{'  '}</Text></Text>
            })}
          </Text>
        </Box>

        {/* Chart and side panel. */}
        <Box flexDirection="row" gap={side ? 1 : 0}>
          {chart}
          {panel}
        </Box>

        {/* Time & sales. */}
        <Text color={C.dim} wrap="truncate">
          {'TIME'.padEnd(10)}{'SIDE'.padEnd(8)}{'PRICE'.padEnd(14)}{'SIZE'.padStart(9)}{'   '}{wide ? ' ' + 'FLOW'.padEnd(13) : ''}{'AMOUNT'.padStart(10)}{'  '}MAKER
        </Text>
        {tape.length ? tape : <Text color={C.dim}>waiting for trades…</Text>}

        {/* Footer: another token, older history, copy, keys. */}
        <Box flexDirection="column" marginTop={1}>
          {!inMemes && addressBox}
          <Box flexDirection="row" gap={2}>
            {hist.more && !hist.loading && <Button key="older" label="older history" hotkey="o" plain onPress={() => void loadHistory($, mint, gen, 1)} />}
            <Button key="copy" label={`copy ${short(mint)}`} hotkey="c" plain onPress={press => void $.ui.copy({ text: mint, surface: press.surface }).then(r => r.isCopied && $.ui.toast('Address copied'))} />
            <Text color={C.dim}>1-7 timeframe · Esc to the prompt</Text>
          </Box>
        </Box>
        {err !== '' && <Text color={C.warn} wrap="truncate">{err}</Text>}
      </Box>
    )
}
