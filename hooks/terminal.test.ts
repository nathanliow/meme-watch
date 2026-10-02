import { expect, mock, test } from 'claude-code/testing'

import { fmtAxis, rasterChart, toBase64 } from './raster'
import { applyTrade, candlesFrom, changeSince, flowSince, fmtPrice, marketTrades, tradeOf } from './lib'
import type { RawTx } from './lib'

const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const POOL = 'Pool111111111111111111111111111111111111111'
const MINT = 'DvNcJZTiSMD1RBCtZ2J31mh7s42CVCwrzGapv1Lypump'
const WSOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const bal = (accountIndex: number, mint: string, amount: number, owner = W, decimals = 6) =>
  ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(Math.round(amount * 10 ** decimals)), decimals } })
// Account 0 is the signer W, account 1 the pool; lamports [pre, post] per account, in SOL.
const tx = (lamports: [number, number][], pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[], extra: Partial<RawTx> = {}): RawTx => ({
  transaction: { message: { accountKeys: [W, POOL] } },
  meta: { err: null, preBalances: lamports.map(l => l[0] * 1e9), postBalances: lamports.map(l => l[1] * 1e9), preTokenBalances: pre, postTokenBalances: post },
  ...extra,
})
const round = (n: number) => Math.round(n * 1e6) / 1e6

// Buys 1,000 tokens from a pump.fun-style curve that takes 2 SOL in lamports.
const curveBuy = tx([[10, 8], [50, 52]], [bal(2, MINT, 0), bal(3, MINT, 9000, POOL)], [bal(2, MINT, 1000), bal(3, MINT, 8000, POOL)])

test('a swap reads off the pool side: side, price, size and maker', () => {
  const buy = tradeOf(curveBuy, MINT, 150, 'sig1', 100)!
  expect(buy.side).toBe('buy')
  expect(round(buy.price)).toBe(0.3) // 2 SOL × $150 / 1,000
  expect(round(buy.usd)).toBe(300)
  expect(buy.tokens).toBe(1000)
  expect(buy.maker).toBe(W)
  const sell = tradeOf(tx([[10, 10], [0, 0]],
    [bal(2, MINT, 1000), bal(3, MINT, 5000, POOL), bal(4, WSOL, 100, POOL, 9)],
    [bal(2, MINT, 500), bal(3, MINT, 5500, POOL), bal(4, WSOL, 99.5, POOL, 9)]), MINT, 150, 'sig2', 100)!
  expect(sell.side).toBe('sell')
  expect(round(sell.price)).toBe(0.15)
  expect(tradeOf(tx([[10, 10], [0, 0]], [bal(3, MINT, 10, POOL)], [bal(3, MINT, 5, POOL)]), MINT, 150, 's', 1)).toBeUndefined()
  expect(tradeOf(curveBuy, MINT, 0, 's', 1)).toBeUndefined()
})

test('trades fold into candles: extend, roll over, skip outliers, widen late bars', () => {
  const t = (ts: number, price: number, usd = 10) => ({ sig: String(ts), t: ts, side: 'buy' as const, price, usd, tokens: 1, maker: W })
  let cs = applyTrade([], t(61, 1), 60)
  expect(cs).toEqual([{ t: 60, o: 1, h: 1, l: 1, c: 1, v: 10 }])
  cs = applyTrade(cs, t(90, 1.2), 60)
  expect(cs[0]).toEqual({ t: 60, o: 1, h: 1.2, l: 1, c: 1.2, v: 20 })
  cs = applyTrade(cs, t(125, 0.9), 60)
  expect(cs[1]).toEqual({ t: 120, o: 1.2, h: 1.2, l: 0.9, c: 0.9, v: 10 })
  // The same trades re-bucketed for another timeframe.
  expect(candlesFrom([t(61, 1), t(90, 1.2), t(125, 0.9)], 300)).toEqual([{ t: 0, o: 1, h: 1.2, l: 0.9, c: 0.9, v: 30 }])
})

test('outliers: a lone mispriced swap is dropped, a real move that holds is kept', () => {
  const t = (ts: number, price: number) => ({ sig: String(ts), t: ts, side: 'buy' as const, price, usd: 10, tokens: 1, maker: W })
  const steady = [1, 1.02, 0.99, 1.01, 1, 1.03, 0.98].map((p, i) => t(i, p))
  // A 10x print and a 1/10 print between normal ones: both dropped.
  const spiky = [...steady, t(7, 10), t(8, 1.01), t(9, 0.1), t(10, 1)]
  expect(marketTrades(spiky).map(x => x.price)).toEqual([...steady.map(x => x.price), 1.01, 1])
  // The first swap itself being off is caught too.
  expect(marketTrades([t(0, 50), ...steady]).map(x => x.price)).toEqual(steady.map(x => x.price))
  // A pump to ~2x that keeps trading there: accepted once three swaps agree.
  const pump = [...steady, t(7, 2), t(8, 2.05), t(9, 1.98), t(10, 2.02)]
  expect(marketTrades(pump).map(x => x.price)).toEqual(pump.map(x => x.price))
  // And the chart's candles skip the spike.
  expect(Math.max(...candlesFrom(spiky, 60).map(c => c.h))).toBe(1.03)
})

test('window stats: flow since a time, change only when history reaches back', () => {
  const t = (ts: number, side: 'buy' | 'sell', price: number, usd: number, maker = W) => ({ sig: String(ts), t: ts, side, price, usd, tokens: 1, maker })
  const all = [t(100, 'buy', 1, 10), t(200, 'sell', 2, 5, POOL), t(300, 'buy', 3, 20)]
  expect(flowSince(all, 150)).toEqual({ buys: 1, sells: 1, buyUsd: 20, sellUsd: 5, volUsd: 25, makers: 2 })
  expect(changeSince(all, 250, 3)).toBe(50) // from $2 to $3
  expect(changeSince(all, 50, 3)).toBeUndefined()
})

test('tiny prices count their zeros the way trading frontends do', () => {
  expect(fmtPrice(0.0000123456)).toBe('$0.0₄1235')
  expect(fmtPrice(0.001175)).toBe('$0.001175')
  expect(fmtPrice(0)).toBe('$0')
})

test('the chart is terminal cells: every cell a printable width-1 character, any size, empty and flat included', () => {
  const candles = Array.from({ length: 300 }, (_, i) => ({ t: i * 60, o: 1 + i / 1000, h: 1.01 + i / 1000, l: 0.99 + i / 1000, c: 1 + (i + 1) / 1000, v: i }))
  for (const [cols, rows, cs] of [[80, 22, candles], [160, 50, candles], [20, 8, candles], [60, 10, []], [60, 10, [{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 }]]] as const) {
    const cells = rasterChart([...cs], cols, rows)
    expect(cells.length).toBe(cols * rows * 3)
    for (let k = 0; k < cells.length; k += 3) {
      const cp = cells[k]!
      expect(cp >= 0x20 && cp <= 0xffff && cp !== 0x7f).toBe(true)
    }
  }
  // Up candles draw green bodies.
  const up = rasterChart([{ t: 0, o: 1, h: 2, l: 0.5, c: 1.8, v: 1 }], 40, 12)
  expect([...up].some((v, k) => k % 3 === 1 && v === 0x0ecb81)).toBe(true)
  expect(toBase64(Uint8Array.of(1, 2, 3, 4))).toBe('AQIDBA==')
  // Market-cap axis labels: unit from the top of the axis, decimals from the step.
  expect(fmtAxis(1_300_000, 1_400_000, 50_000)).toBe('$1.30M')
  expect(fmtAxis(850_000, 900_000, 50_000)).toBe('$850K')
  expect(fmtAxis(1_272_600, 1_400_000, 2_500)).toBe('$1.273M')
})

// ---- The whole flow: /token → Helius RPC history → the bridge's stream → the pane ----

const ok = (result: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) })
// SOL/USDC pool: 2 wSOL out for 300 USDC in → $150/SOL.
const solSwap = tx([[0, 0], [0, 0]], [bal(3, WSOL, 100, POOL, 9), bal(4, USDC, 1000, POOL)], [bal(3, WSOL, 98, POOL, 9), bal(4, USDC, 1300, POOL)])
const urls: string[] = []
function helius(body: string) {
  const { method, params } = JSON.parse(body)
  if (method === 'getAsset') return ok({ content: { metadata: { name: 'Microcat', symbol: 'MICRO' }, files: [] }, token_info: { supply: 1_000_000_000_000, decimals: 6 } })
  if (method === 'getTokenLargestAccounts') return ok({ value: [{ uiAmount: 100_000 }, { uiAmount: 50_000 }] })
  if (method === 'getTransactionsForAddress' && params[0] === MINT) {
    const blockTime = Math.floor(Date.now() / 1000) - 30
    if (params[1].transactionDetails === 'signatures') return ok({ data: [{ signature: 'hist1', slot: 100, blockTime }], paginationToken: null })
    return ok({ data: [{ ...curveBuy, blockTime, transaction: { ...curveBuy.transaction, signatures: ['hist1'] } }], paginationToken: null })
  }
  if (method === 'getTransactionsForAddress') return ok({ data: [solSwap], paginationToken: null })
  return { status: 404, ok: false, headers: {}, text: '' }
}

test('/token charts a token from Helius alone and streams a live trade into the pane', async ($, on) => {
  mock.store(on)
  mock.env(on, { HELIUS_API_KEY: 'test-key' })
  const clock = mock.clock(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('fs.exists', () => ({ value: true }))
  on('http.fetch', (_$, e) => {
    urls.push(e.url)
    return { value: helius(String(e.init?.body ?? '')) }
  })
  let spawned: Record<string, string> | undefined
  on('process.spawn', async function* (_$, e) {
    spawned = e.env
    const line = JSON.stringify({ type: 'tx', sig: 'live1', slot: 9, at: clock.now(), tx: curveBuy })
    yield { stream: 'stdout' as const, text: JSON.stringify({ type: 'slot', slot: 452464195, at: 1000, createdAt: 988 }) + '\n' + line.slice(0, 40) }
    yield { stream: 'stdout' as const, text: line.slice(40) + '\n' }
    yield { stream: 'stderr' as const, text: 'broadcast:8472016\n' }
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const run = (args: string) => $.command.run({ command: 'token', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect((await run('not-a-mint')).text).toMatch(/\/token <mint>/)
  expect((await run('3')).text).toMatch(/No position 3/)
  expect((await run(MINT)).text).toMatch(/^Chart:/)
  await clock.advance(1500)

  expect(spawned?.MINT).toBe(MINT)
  expect(spawned?.LASERSTREAM_ENDPOINT).toBe('https://laserstream-mainnet-ewr.helius-rpc.com')
  // Helius only.
  expect(urls.length).toBeGreaterThan(0)
  expect(urls.every(u => u.startsWith('https://mainnet.helius-rpc.com/'))).toBe(true)

  const ui = await $.ui.mount({
    plugin: 'meme-watch', surface: 'terminal', component: 'Pane', requestId: 'token-terminal',
    props: { title: 'Chart', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 44 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /MICRO/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /MCAP/ })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'chart' })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'mint' })).toBeDefined()
  // The history buy and the live buy: 1,000 tokens for 2 SOL at $150 → $0.3000, $300.
  expect(await ui.find({ type: 'Text', text: /▲ BUY/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$300/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /POLLING · Helius RPC/ })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  // The SDK's own log lines never reach the pane.
  expect(await ui.find({ type: 'Text', text: /broadcast/ })).toBeUndefined()
  await ui.unmount()
})

test('the Memes pane charts the highlighted token under the list, all in one pane', async ($, on) => {
  mock.store(on)
  mock.env(on, { HELIUS_API_KEY: 'test-key' })
  const clock = mock.clock(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const opened: string[] = []
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true, plugin: 'meme-watch' })) }))
  on('ui.open', (_$, e) => { opened.push(e.id); return { value: { isPlaced: true as const } } })
  on('fs.exists', () => ({ value: true }))
  on('process.spawn', async function* () { return { value: { code: 0, signal: null } } })
  on('http.fetch', (_$, e) => {
    const { method, params } = JSON.parse(String(e.init?.body ?? ''))
    if (method === 'searchAssets') return { value: ok({ items: [{ id: MINT, content: { metadata: { symbol: 'MICRO' } }, token_info: { balance: 1000e6, decimals: 6, price_info: { price_per_token: 0.3 } } }] }) }
    // The cost-basis scan never answers, so the position stays listed as scanning.
    if (method === 'getTransactionsForAddress' && params[1]?.filters?.tokenTransfer) return new Promise<never>(() => {})
    if (method === 'getTransactionsForAddress' && params[0] === W) return { value: ok({ data: [], paginationToken: null }) }
    return { value: helius(String(e.init?.body ?? '')) }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const memes = (args: string) => $.command.run({ command: 'memes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await memes(W)
  await memes('')
  await clock.advance(50)

  const ui = await $.ui.mount({
    plugin: 'meme-watch', surface: 'terminal', component: 'Pane', requestId: 'meme-watch',
    props: { title: 'Memes', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ type: 'Button', key: `chart-${MINT}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /chart 1/ })).toBeUndefined()
  // The top position is charted under the list straight away, no key needed.
  expect(await ui.find({ type: 'Raster', key: 'chart' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /MICRO/ })).toBeDefined()
  // Enter on a token keeps everything in this pane.
  await ui.press({ key: `chart-${MINT}` })
  expect(opened).not.toContain('token-terminal')
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await ui.unmount()
})

test('history loads 1,000 swaps a chunk until a 30s chart is full (60 candles = 30 min), then stops', async ($, on) => {
  mock.store(on)
  mock.env(on, { HELIUS_API_KEY: 'test-key' })
  const clock = mock.clock(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('fs.exists', () => ({ value: true }))
  on('process.spawn', async function* () { return { value: { code: 0, signal: null } } })
  // Each 1,000-swap chunk is one swap 2,000s older than the last; the chain goes back far.
  let chunks = 0
  on('http.fetch', (_$, e) => {
    const body = String(e.init?.body ?? '')
    const { method, params } = JSON.parse(body)
    if (method === 'getTransactionsForAddress' && params[0] === MINT) {
      const now = Math.floor(Date.now() / 1000)
      if (params[1].transactionDetails === 'signatures') {
        const page = Number(params[1].paginationToken ?? 0)
        chunks += 1
        return { value: ok({ data: [{ signature: `h${page}`, slot: 1000 - page, blockTime: now - 2000 * page }], paginationToken: String(page + 1) }) }
      }
      const page = 1000 - params[1].filters.slot.lte
      return { value: ok({ data: [{ ...curveBuy, blockTime: now - 2000 * page, transaction: { ...curveBuy.transaction, signatures: [`h${page}`] } }], paginationToken: null }) }
    }
    return { value: helius(body) }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'token', args: MINT, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  await clock.advance(1500)
  // 30 minutes back: chunk 0 (now) and chunk 1 (−2,000s) cover it, so it stops there.
  expect(chunks).toBe(2)
})
