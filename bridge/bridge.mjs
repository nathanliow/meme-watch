// LaserStream → stdout bridge. A mod can't hold a gRPC stream, so the mod spawns this and reads
// one JSON line per event: {type:'status'|'tx'|'error'}. Every successful tx touching MINT is
// passed on in the RPC JSON shape (base58 keys, balances as numbers) the mod's parser reads.
import bs58 from 'bs58'
import { subscribe, CommitmentLevel } from 'helius-laserstream'

const { HELIUS_API_KEY: apiKey, LASERSTREAM_ENDPOINT: endpoint, MINT: mint } = process.env
const out = obj => process.stdout.write(JSON.stringify(obj) + '\n')
const b58 = bytes => bs58.encode(bytes)
const balance = b => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, uiTokenAmount: { amount: b.uiTokenAmount.amount, decimals: b.uiTokenAmount.decimals } })

if (!apiKey || !endpoint || !mint) {
  out({ type: 'error', message: 'bridge needs HELIUS_API_KEY, LASERSTREAM_ENDPOINT and MINT', fatal: true })
  process.exit(1)
}

// Slots tick every ~400ms: one heartbeat a second tells the pane the stream is alive (and how
// far behind it runs) even while the token itself is quiet.
let lastBeat = 0
function onSlot(u) {
  const now = Date.now()
  if (now - lastBeat < 1000) return
  lastBeat = now
  out({ type: 'slot', slot: Number(u.slot.slot), at: now, createdAt: u.createdAt ? new Date(u.createdAt).getTime() : undefined })
}

function onUpdate(u) {
  if (u.slot) return onSlot(u)
  const info = u.transaction?.transaction
  if (!info?.meta || !info.transaction?.message) return
  const { meta, transaction } = info
  out({
    type: 'tx',
    sig: b58(info.signature),
    slot: Number(u.transaction.slot),
    at: Date.now(),
    createdAt: u.createdAt ? new Date(u.createdAt).getTime() : undefined,
    tx: {
      transaction: { message: { accountKeys: transaction.message.accountKeys.map(b58) } },
      meta: {
        err: null,
        preBalances: meta.preBalances.map(Number),
        postBalances: meta.postBalances.map(Number),
        preTokenBalances: meta.preTokenBalances.map(balance),
        postTokenBalances: meta.postTokenBalances.map(balance),
        loadedAddresses: { writable: meta.loadedWritableAddresses.map(b58), readonly: meta.loadedReadonlyAddresses.map(b58) },
      },
    },
  })
}

try {
  await subscribe(
    { apiKey, endpoint, maxReconnectAttempts: 5 },
    {
      slots: { beat: {} },
      transactions: { mint: { accountInclude: [mint], accountExclude: [], accountRequired: [], vote: false, failed: false } },
      commitment: CommitmentLevel.PROCESSED,
    },
    async u => onUpdate(u),
    async err => {
      out({ type: 'error', message: String(err?.message ?? err), fatal: true })
      process.exit(1)
    },
  )
  out({ type: 'status', state: 'subscribed' })
} catch (err) {
  out({ type: 'error', message: String(err?.message ?? err), fatal: true })
  process.exit(1)
}
// The engine kills this child when the mod ends the feed, the module reloads or the session ends.
