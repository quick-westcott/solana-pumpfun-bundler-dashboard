# pump.fun launcher on the TrenchyTools API

A small, complete pump.fun launcher you can clone and run with your own API key: create a coin with a dev buy and up
to 16 bundled buyers in one Jito bundle, optional holder wallets, auto-sell, per-wallet selling, creator-fee claims,
live trades and vanity `…pump` mints. Every chain call goes through the **TrenchyTools API**
(`https://api.trenchy.tools`); there is no RPC node, Jito client or IPFS key in this app. The backend keeps your
wallet keys on your machine, asks the API for unsigned transactions, signs them locally and hands them back to be sent.
It is also the reference for calling the API from your own bot: the one client file is `backend/src/services/trenchy.ts`.

## 5-minute start

```bash
git clone <this repo> && cd pumpfun-launcher
npm run install:all
cp backend/.env.example backend/.env      # then paste your key into TRENCHY_API_KEY
npm run dev
```

Open http://localhost:5183. Get a key with one call, `GET https://api.trenchy.tools/api/create-api-key` (free,
shown once), or paste it on the Settings page instead of in `.env`. Then on **Wallets** create a funding wallet, send it
SOL, and launch. Backend on port 3101, Vite on 5183 proxying `/api`; works on Windows, macOS and Linux.

## Where your keys are

The rule this app enforces (rule 3 of the API's [AGENTS.md](https://api.trenchy.tools/AGENTS.md)): **every wallet
is written to disk, in a place you can find, before it can hold anything.** The API never sees a key and cannot give
one back.

- Backup folder: `WALLET_BACKUP_DIR` if set, else `~/Desktop/trenchytools-wallets` (or `~/trenchytools-wallets` when
  there is no Desktop). The backend prints it at startup (`[backup] wallet backups → …`), the status strip and the
  Wallets page show it permanently.
- Every wallet the app creates or imports (funding, dev, bundle, holder, manual) is written there **first**, as
  `<date>-<label>-<publicKey>.json` with the plaintext base58 `privateKey`, plus one line in `wallets.csv`. If that
  write fails, the wallet is not created and the request fails.
- **The app refuses to fund a wallet with no backup file**: direct fund, fund via exchange, every wallet in a launch,
  gathers and sweeps all check the folder and answer `409 { code: "not_backed_up" }`. Deleted the file? Click
  **Export backup** on the Wallets page (`POST /api/wallets/export-backup`): it rewrites every vault wallet into the
  folder and returns `{ dir, count }`.
- The app's working store is an encrypted vault, `backend/keys/wallets.json`. `ENCRYPTION_KEY` is optional: without it
  a key is generated into `backend/keys/.encryption-key`. The backup folder is your real backup; keep it somewhere safe
  and never paste it into a chat or a public repo.
- Vanity mint keypairs are not wallets (they hold no funds); they live in `backend/data/vanity-pool.json`.

## How a launch works

1. The mint keypair (random, or the next `…pump` key from the vanity pool), a dev wallet and the bundle/holder wallets
   are created, backed up and stored in the vault.
2. Every wallet's backup file is checked; then the funding wallet sends each wallet its SOL
   (`GET /api/sol/blockhash` → signed here → `POST /api/sol/send`; the first send is simulated, so an empty funding
   wallet fails at once with a clear message).
3. Image + metadata are pinned: `POST /api/ipfs`.
4. With 5–16 buyers, a lookup table is created first: `POST /api/sol/lut` → sign → send, `GET /api/sol/lut/:address`.
5. One request builds the bundle: `POST /api/sol/trade-local?format=json` with an array (the create + dev buy carrying
   the Jito tip, then the buys, priced on the curve as it will be inside the bundle). The app signs each transaction
   with its wallet and submits `POST /api/sol/bundle`; `GET /api/sol/bundle/:id` and `GET /api/sol/tx/:signature`
   follow it until it lands. Without Jito (or when strict mode is off and the bundle does not land) the create and buys
   go out one by one through `POST /api/sol/send`.
6. Optional: auto-sell (every wallet sells 100 % with `action: "sell"`, `pool: "auto"` the moment the coin is on chain),
   holder auto-buys, and the lookup table is closed to refund its rent.

Afterwards: balances with `GET /api/sol/balances?wallets=…&mint=…` (100 wallets a call), selling with
`POST /api/sol/trade-local` → sign → `POST /api/sol/send`, creator fees with `GET /api/sol/creator-fees` and
`action: "collectCreatorFee"`, live trades over `wss …/api/sol/data` (`subscribeTokenTrade`), vanity mints with
`POST /api/sol/vanity` → `GET /api/sol/vanity/:jobId`, exchange-routed funding with `POST /api/transfer/batch` →
sign each deposit → `POST /api/sol/send` → `POST /api/transfer/:id/sent` → `GET /api/transfer/:id` (reduces
on-chain linkability between your funding wallet and the funded wallets). **Simulate** on the Launch page runs the
checks and a `POST /api/sol/simulate` of the create without moving anything. The API takes 0.5 % of the SOL side of
each buy and sell, inside the same transaction.

## The one file to copy into your own bot

`backend/src/services/trenchy.ts`: one class, one method per endpoint, typed responses, retries on 429 and on an
unreachable host, every error as `TrenchyError { status, code, hint, docs }` so you can match on `code`.

| Method | Endpoint |
|---|---|
| `tradeLocal(body)` | `POST /api/sol/trade-local?format=json` (buy, sell, create, collectCreatorFee) |
| `bundleLocal(bodies)` | same, array → up to 5 transactions for one Jito bundle |
| `lutCreate`, `lutInfo`, `lutStep` | `POST /api/sol/lut`, `GET /api/sol/lut/:a`, `POST /api/sol/lut/:a/{deactivate,close}` |
| `send(tx)`, `simulate(tx)`, `bundle(txs)` | `POST /api/sol/send`, `POST /api/sol/simulate`, `POST /api/sol/bundle` |
| `bundleStatus(id)`, `txStatus(sig)`, `waitConfirmed(sig)`, `execute(tx, signers)` | `GET /api/sol/bundle/:id`, `GET /api/sol/tx/:sig` |
| `blockhash()`, `sendInstructions(payer, ixs)`, `transferSol(from, to, sol)` | `GET /api/sol/blockhash` + `POST /api/sol/send` (same signed bytes re-sent until they land; never paid twice) |
| `balances(wallets, mint?)`, `solBalance`, `tokenAccounts`, `creatorFees`, `quote`, `token`, `priorityFee`, `me` | `GET /api/sol/balances`, `/creator-fees`, `/quote`, `/token/:mint`, `/priority-fee`, `GET /api/me` |
| `vanityStart`, `vanityJob`, `vanityGrind` | `POST /api/sol/vanity`, `GET /api/sol/vanity/:jobId` |
| `transferRoutes`, `transferVenues`, `createTransfer`, `createTransferBatch`, `transferStatus`, `transferSent`, `transfers`, `Trenchy.depositTx` | `/api/transfer/*` |
| `uploadMetadata({ image, name, symbol, … })` | `POST /api/ipfs` → metadata uri |
| `wsUrl()` | the live-trades websocket URL |

`backend/src/routes/wallets.ts` (`fund-via-exchange`) and `backend/src/services/vanity.ts` are the smallest complete
examples of the pattern: ask for an unsigned transaction, check it, sign with a key that is already on disk, send,
poll.

## Build it with AI

Paste this into your assistant:

> Here is a working pump.fun launcher on the TrenchyTools API: <path or URL of this repo>. Read
> `backend/src/services/trenchy.ts` (the API client, the only place that talks to the chain) and
> https://api.trenchy.tools/AGENTS.md (the API's rules, including rule 3: every wallet is written to disk before it
> is funded; see `backend/src/services/backup.ts` for how this app does it). Then build me <what you want>, keeping
> the same pattern: unsigned transaction from the API, signed locally with a key that is already backed up, sent back
> through the API, polled until it lands. Never print or commit keys.

## Host it

The `Dockerfile` builds the frontend into the backend and runs one Node process on port 3101. Set three variables:
`TRENCHY_API_KEY`, `ENCRYPTION_KEY` (any long random string) and `WALLET_BACKUP_DIR=/data/backups` (already in the
image's `ENV`). Mount a volume at `/data` (Railway: a volume at `/data`): the vault and settings live in `/data/keys`,
launches/uploads/vanity pool in `/data/data`, the wallet backups in `/data/backups`. Download that folder; it is your
only copy of the keys. This is a single-user app with no login: put it behind your own access control if it is
reachable from the internet.

## Credits

Based on [TrenchyDev](https://github.com/TrenchyDev)'s open-source pump.fun bundler UI; the chain layer is rebuilt on
the TrenchyTools API. MIT licensed.
