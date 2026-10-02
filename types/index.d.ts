export type Basis = { buyUsd: number; sellUsd: number; trades: number; truncated: boolean }
export type Position = {
  mint: string
  sym: string
  amount: number
  priceUsd: number
  valueUsd: number
  basis?: Basis
}

// One OHLCV bar: `t` its open (unix seconds), prices in USD, `v` volume in USD.
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number }

// One swap of the token, from the trader's side: `buy` took the token out of a pool.
export type Trade = { sig: string; t: number; side: 'buy' | 'sell'; price: number; usd: number; tokens: number; maker: string }

// The chart's token, from Helius DAS (and getTokenLargestAccounts for the top-10 share).
export type TokenInfo = { mint: string; name: string; symbol: string; supply: number; top10Pct: number | null }

// Where live trades come from: LaserStream, or Helius RPC polling when the stream can't run.
export type Feed = { mode: 'off' | 'connecting' | 'live' | 'polling'; slot: number; lagMs: number; msg: string }

// The swaps read back so far: `from` the oldest one's time, `more` while older ones remain.
export type History = { from: number; count: number; more: boolean; loading: boolean }

declare module 'claude-code' {
  interface PluginState {
    'meme-watch': {
      wallet: string
      positions: Position[]
      solUsd: number
      error: string
      token: string
      tokenInfo: TokenInfo | null
      tf: string
      candles: Candle[]
      trades: Trade[]
      feed: Feed
      history: History
      tokenError: string
    }
  }
}
