import { expect, mock, test } from 'claude-code/testing'

import { avgBuyPrice, basisOf, currentRound, medianPrice, pnl, swapPriceUsd, transfersIn } from './lib'
import type { RawTx } from './lib'

const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const POOL = 'Pool111111111111111111111111111111111111111'
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const WSOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const bal = (accountIndex: number, mint: string, amount: number, owner = W, decimals = 6) =>
  ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(Math.round(amount * 10 ** decimals)), decimals } })
// Account 0 is the signer W, account 1 the pool; lamports given as [pre, post] per account.
const tx = (lamports: [number, number][], pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[], extra: Partial<RawTx> = {}, err: unknown = null): RawTx => ({
  transaction: { message: { accountKeys: [W, POOL] } },
  meta: { err, preBalances: lamports.map(l => l[0] * 1e9), postBalances: lamports.map(l => l[1] * 1e9), preTokenBalances: pre, postTokenBalances: post },
  ...extra,
})
const round = (n: number) => Math.round(n * 1e6) / 1e6

test('USD cost basis: SOL buy at $100, wSOL buy at $200, USDC buy, full exit closing the account, transfer, failed tx', () => {
  const txs = [
    { ...tx([[10, 9], [0, 0]], [], [bal(2, MINT, 1000)]), blockTime: 1 }, // 1 SOL @ $100 = $100
    { ...tx([[9, 9], [0, 0]], [bal(2, MINT, 1000), bal(3, WSOL, 2)], [bal(2, MINT, 2000), bal(3, WSOL, 0)]), blockTime: 2 }, // 2 wSOL @ $200 = $400
    { ...tx([[9, 9], [0, 0]], [bal(2, MINT, 2000), bal(4, USDC, 50)], [bal(2, MINT, 2500), bal(4, USDC, 0)]), blockTime: 2 }, // $50
    { ...tx([[9, 9], [0, 0]], [bal(2, MINT, 2500)], [bal(2, MINT, 2400)]), blockTime: 2 }, // transfer: ignored
    { ...tx([[9, 5], [0, 0]], [bal(2, MINT, 2400)], [bal(2, MINT, 1400)], {}, { InstructionError: [] }), blockTime: 2 }, // failed
    { ...tx([[9, 12], [0, 0]], [bal(2, MINT, 2400)], [bal(2, MINT, 1400)]), blockTime: 2 }, // sell for 3 SOL @ $200 = $600
    { ...tx([[12, 13], [0, 0]], [bal(2, MINT, 1400)], []), blockTime: 2 }, // exit, account closed: 1 SOL = $200
  ]
  const b = basisOf(txs, W, MINT, t => (t.blockTime === 1 ? 100 : 200))
  expect(round(b.buyUsd)).toBe(550)
  expect(round(b.sellUsd)).toBe(800)
  expect(b.trades).toBe(5)
  // sold $800 + held $50 − bought $550 = +$300
  const r = pnl({ mint: MINT, sym: 'BONK', amount: 100, priceUsd: 0.5, valueUsd: 50, basis: b })!
  expect(round(r.usd)).toBe(300)
  expect(round(r.pct)).toBe(round((300 / 550) * 100))
})

test('swap price off the pool side: pump.fun curve (native lamports), wSOL pool, SOL/USDC pool', () => {
  // Signer buys 1,000 tokens; the curve (POOL) receives 2 SOL in lamports. SOL $150 → $0.30.
  const curve = tx([[10, 8], [50, 52]], [bal(2, MINT, 0), bal(3, MINT, 9000, POOL)], [bal(2, MINT, 1000), bal(3, MINT, 8000, POOL)])
  expect(round(swapPriceUsd(curve, MINT, 150)!)).toBe(0.3)
  // Signer sells 500 tokens into a wSOL vault pool that pays out 0.5 wSOL. SOL $150 → $0.15.
  const amm = tx([[10, 10], [0, 0]],
    [bal(2, MINT, 1000), bal(3, MINT, 5000, POOL), bal(4, WSOL, 100, POOL)],
    [bal(2, MINT, 500), bal(3, MINT, 5500, POOL), bal(4, WSOL, 99.5, POOL)])
  expect(round(swapPriceUsd(amm, MINT, 150)!)).toBe(0.15)
  // SOL/USDC: pool gives 2 wSOL for 300 USDC → $150/SOL; native lamports ignored for SOL itself.
  const solPool = tx([[10, 12], [5, 1]],
    [bal(3, WSOL, 100, POOL), bal(4, USDC, 1000, POOL)],
    [bal(3, WSOL, 98, POOL), bal(4, USDC, 1300, POOL)])
  expect(round(swapPriceUsd(solPool, WSOL, 0)!)).toBe(150)
  // A transfer moves no pool money: no price. Median ignores it.
  const transfer = tx([[10, 10], [0, 0]], [bal(3, MINT, 10, POOL)], [bal(3, MINT, 5, POOL)])
  expect(swapPriceUsd(transfer, MINT, 150)).toBeUndefined()
  expect(round(medianPrice([curve, amm, transfer, curve], MINT, 150)!)).toBe(0.3)
})

test('/memes without HELIUS_API_KEY explains how to set it', async ($, on) => {
  mock.store(on)
  mock.env(on, {})
  mock.clock(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const run = (args: string) => $.command.run({ command: 'memes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect((await run(W)).text).toMatch(/HELIUS_API_KEY/)
  expect((await run('nope')).text).toMatch(/\/memes <wallet>/)
})

test('one hop: a transfer in names its sender, and the sender buys price it', () => {
  const S = 'Sender11111111111111111111111111111111111111'
  const sent = tx([[9, 9], [0, 0]], [bal(2, MINT, 0), bal(5, MINT, 3000, S)], [bal(2, MINT, 1000), bal(5, MINT, 2000, S)])
  const minted = tx([[9, 9], [0, 0]], [bal(2, MINT, 0)], [bal(2, MINT, 1000)]) // no sender: a mint or airdrop
  const ins = transfersIn([sent], W, MINT, () => 150)
  expect(ins.length).toBe(1)
  expect(ins[0]!.from).toBe(S)
  expect(round(ins[0]!.amount)).toBe(1000)
  expect(transfersIn([minted], W, MINT, () => 150)[0]!.from).toBeUndefined()
  // Sender bought 2,000 for $100 USDC and 1,000 for 1 SOL @ $200: $300 / 3,000 = $0.10 each.
  const usdcBuy = tx([[0, 0], [0, 0]], [bal(5, MINT, 0, S), bal(6, USDC, 100, S)], [bal(5, MINT, 2000, S), bal(6, USDC, 0, S)])
  const solBuy = tx([[0, 0], [0, 0]], [bal(5, MINT, 2000, S), bal(6, WSOL, 1, S)], [bal(5, MINT, 3000, S), bal(6, WSOL, 0, S)])
  expect(round(avgBuyPrice([usdcBuy, solBuy, sent], S, MINT, () => 200)!)).toBe(0.1)
})

test('current round: walks back from the balance held now to the last full exit, dust counting as exited', () => {
  const buy = (pre: number, post: number) => tx([[0, 0], [0, 0]], [bal(2, MINT, pre), bal(4, USDC, 100)], [bal(2, MINT, post), bal(4, USDC, 0)])
  const sell = (pre: number, post: number) => tx([[0, 0], [0, 0]], [bal(2, MINT, pre), bal(4, USDC, 0)], [bal(2, MINT, post), bal(4, USDC, 90)])
  const round1 = [buy(0, 1000), sell(1000, 0.5)] // exits leaving 0.05% dust
  const round2 = [buy(0.5, 2000), sell(2000, 1500)]
  const newestFirst = [...round1, ...round2].reverse()
  expect(currentRound(newestFirst, W, MINT, 1500)).toEqual({ txs: round2, complete: true })
  // History cut short of the round's start: what was read, flagged incomplete.
  expect(currentRound(newestFirst.slice(0, 1), W, MINT, 1500)).toEqual({ txs: round2.slice(1), complete: false })
})

test('/memes <wallet> takes the API key from userConfig', { options: { heliusApiKey: 'k' } }, async ($, on) => {
  mock.store(on)
  mock.env(on, {})
  mock.clock(on)
  // Helius is never answered, so the polling this starts stops at its first call.
  let fetched: (key: string | null) => void
  const auth = new Promise<string | null>(r => (fetched = r))
  on('http.fetch', (_$, e) => {
    fetched(new URL(e.url).searchParams.get('api-key'))
    return new Promise<never>(() => {})
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'memes', args: W, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(r.text).toMatch(/^Watching/)
  expect(await auth).toBe('k')
})
