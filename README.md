# meme-watch

A Claude Code mod that shows live USD PnL for the top 5 memecoin positions in a Solana wallet,
in a row above your prompt:

```
🐸 BP $1.28M +$619.6k (+94.3%) · e/acc $107.3k −$7.5k (−6.5%) · OCTO $6.4k −$73.62 (−1.1%)
```

Gains are green, losses red. `/memes` opens a pane with price, value, amount invested and PnL per
position, and a live chart for any of them or for any token address (`/token`).

Read-only: it never asks for a private key and never signs or sends a transaction. Numbers are
estimates from on-chain data, not financial advice.

## Install

```
claude plugin marketplace add nathanliow/meme-watch
claude plugin install meme-watch@meme-watch
```

Requires Node.js 16+ with `npm` on your `PATH` for the chart's live trades (the LaserStream SDK
ships native builds for macOS and Linux only; elsewhere the chart falls back to polling).

## Setup

1. Get a Helius API key at [dashboard.helius.dev](https://dashboard.helius.dev).
2. Set it in `/config` → meme-watch → Helius API key (stored in secure storage), or export
   `HELIUS_API_KEY`.
3. Run `/memes <wallet address>`.

The wallet is remembered: the row comes back in every new session until `/memes off`.

## Commands

| Command | |
| --- | --- |
| `/memes <wallet>` | Watch a wallet |
| `/memes` | Open or close the pane |
| `/memes off` / `/memes on` | Stop or resume polling |
| `/memes rescan` | Recompute cost basis from chain history |
| `/token <mint>` | Live chart of any token |
| `/token 1`–`5` | Live chart of position 1–5 |
| `/token` / `/token off` | Show/hide the chart; `off` also stops its feed |

In the Memes pane (`/memes` focuses it; later press Tab, with `tab` bound to `abovePrompt:focus` in `~/.claude/keybindings.json`): the chart shows above the list (your last token, or the top position, to start); ↑↓ highlight another token and Enter charts it. Rows keep their order between refreshes. Or paste any address into the
box and press Enter. In the Chart pane (opens focused; Tab to refocus): `1`–`7` timeframe (30s 1m 5m 15m 1h 4h 1D), `o` older
history, `c` copy the address, the box to switch token; Esc returns to the prompt.

## The chart

All Helius:

- **History**: read back over `getTransactionsForAddress` until there are 60 candles of the chosen
  timeframe (at most 60 pages, ~600 credits), each swap priced off the pool's side (as PnL is).
  Swaps priced far off their neighbours are dropped. `o` reads ~1,000 more.
- **Reading it**: candle bodies only; the right axis is market cap (price × supply).
- **Live trades**: LaserStream (`bridge/bridge.mjs`, spawned by the mod since a mod can't hold a
  gRPC stream; the SDK installs itself into `bridge/` on first run with `npm ci` from the pinned
  lockfile, install scripts off). If it can't run, the tape polls
  Helius RPC every 15s and the badge shows `POLLING`.
- **Name, supply, logo**: DAS `getAsset`; market cap = last price × supply. Top-10 share:
  `getTokenLargestAccounts` (pools included).
- The chart is drawn in plain terminal cells (half blocks), so it shows in any terminal.
- The feed runs only while the Chart pane is open.

## How PnL is worked out

- **Current position only.** History is read back from today's balance to the last time the
  wallet fully exited the token (balance under 0.1% of that round's peak). Earlier rounds don't
  count.
- **PnL = sold + held − bought**, in USD at the time of each trade: USDC/USDT at $1, SOL at its
  price then, read off Raydium's SOL/USDC pool.
- **Tokens transferred in** are priced one hop back: at what the sending wallet paid per token
  on average before sending them.
- **Airdrops and rewards** the wallet never paid for are not positions and aren't shown.
- SOL, wSOL, USDC and USDT are never listed as positions.

## Helius credits

`getTransactionsForAddress` and DAS calls cost 10 credits each.

- **Prices:** one call per position per refresh. At the default 60s that's about 3,000 credits an
  hour while Claude Code is open. Change it in `/config` → meme-watch → Price refresh.
- **SOL price:** one call a minute.
- **Holdings:** 3–12 calls every 2 minutes.
- **Cost basis:** a few calls per position (more for long histories), only when its balance
  changes.

- **Chart**: ~200 credits to open a token (`o` another ~200), 1 every 5 min for the top-10 share;
  polling (only without LaserStream) ~2,400 an hour. LaserStream usage counts against your plan.

Memes alone: about 4,500–7,000 credits an hour at the defaults, so Helius's free plan (1M
credits/month) covers roughly 5–7 hours a day.

## Known limits

- Prices come from each token's recent on-chain swaps. A token that trades only on Raydium AMM v4
  can show a stale price.
- Transfers are followed one hop. Tokens the sender itself received by transfer count as free.
- Cost basis reads back at most 5,000 transactions per token; a position older than that shows
  PnL over what was read.

## Development

```
claude plugin validate .
claude plugin test .
```

MIT licensed.
