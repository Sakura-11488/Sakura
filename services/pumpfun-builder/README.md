# pump.fun builder

Builds an **unsigned** pump.fun `create_v2` transaction with a mint address
ending in `sakura`, and partially signs it as that mint. The creator
counter-signs on their device.

Mainnet only. It holds mint keys. Deploy it somewhere you control.

## Why it exists as a separate service

`creator-coin-launch` already expects a builder at `PUMPFUN_UNSIGNED_TX_URL` —
this is that service. It is not an edge function because `@solana/spl-token`'s
esm.sh build exceeds the Supabase edge worker boot budget; `process-xp-redemptions`
died with `WORKER_RESOURCE_LIMIT` on every request until its SPL calls were
hand-rolled, and assembling a whole transaction is worse. Node with the real
`@solana/web3.js` avoids the problem entirely.

Railway suits it: request-driven, stateless apart from its encryption key,
tiny. **Do not put the vanity grinder here** — that is a batch job with no
uptime requirement (see `sakura-mobile/scripts/grind-vanity-mints.mjs`).

## Where the pieces sit

```
creator-coin-launch (edge)  --x-builder-secret-->  THIS SERVICE
                                                     |
                              reserve_vanity_mint()  v
                                              vanity_mints (Supabase)
                                                     |
   unsigned tx + mintAddress  <----- partial-sign as the mint
            |
            v
   creator's device signs as fee payer, submits, then calls creator-coin-verify
```

## Deploy

Root directory `services/pumpfun-builder`, start command `npm start`.
Set every variable in `.env.example`; there are no optional secrets.

`VANITY_MINT_ENCRYPTION_KEY` **must be the same key the grinder used**, and must
not be stored in Supabase — the whole point is that the database holds only
ciphertext, so a database compromise on its own yields no mint keys.

Then set `PUMPFUN_UNSIGNED_TX_URL` and `PUMPFUN_BUILDER_SECRET` on the Supabase
side to this service's `/build` URL and the same shared secret.

## Endpoints

`GET /healthz` — liveness, no auth. Deliberately says nothing about the pool or
the database, because it is reachable without the secret.

`POST /build` — requires `x-builder-secret`.

```json
{ "creatorWallet": "...", "name": "...", "symbol": "...", "metadataUri": "https://..." }
```
```json
{ "unsignedTransaction": "<base64>", "mintAddress": "...sakura",
  "lastValidBlockHeight": 0, "expiresInSeconds": 60 }
```

## The parts that are load-bearing

**Authentication is not optional.** This service reserves a vanity mint on every
successful call. An unauthenticated endpoint could be drained one request at a
time — a denial of service on something that costs hours of grinding to refill.
The secret is compared with `timingSafeEqual`.

**The creator is the fee payer.** That is what routes pump.fun's creator fees to
them natively. Sakura takes no cut and holds no custody, and this service never
holds or signs with a creator's key.

**The transaction is only partially signed.** The mint's signature is present,
the creator's slot is empty. Anyone who intercepts it cannot submit it.

**The mint address is returned so the server can bind it.** `creator-coin-launch`
writes it to `creator_coins.mint_address` immediately. Without that, the only
record of which mint was issued lives on the caller's device, and verify has to
trust a client-supplied value — and since that column is `UNIQUE`, a false claim
would also permanently lock out the mint's real owner.

**A failed build returns its reservation** via `release_vanity_mint`, which
targets one row. Note that `release_stale_vanity_reservations(0)` would release
*every* reservation, including other creators' in-flight launches; that is why
there is a separate single-row function.

**Metadata is checked before the launch, not after.** pump.fun stores the URI
and never validates it, so a broken link produces a permanent token with no name
or image and no way to repair it. The builder requires https, real JSON, and at
least `name` and `image`. A 200 response carrying HTML is the normal shape of a
broken host, not an exception — the comics scraper learned that the expensive
way.

**Blockhashes live 60-90 seconds.** The response says so. Callers must rebuild
rather than store a transaction against the 30-minute stale window that
`creator_coins` uses for reclaim.

## Not built

Metadata hosting. The builder requires a `metadataUri` and validates it, but
does not create or pin one. Supabase Storage is the natural home — the
`creator-covers` bucket is already public and already used by
`upload-work-media` — and that belongs on the Sakura side, not here.

A dev buy. `create_v2` alone launches the coin with no initial purchase.

## Tests

```bash
npm test
```

Offline, no network, no signatures. They pin the constants against real mainnet
observations, reproduce a confirmed launch's PDAs, and assert the two mistakes
that actually cost time: that `global_params` derives under the **mayhem**
program rather than pump.fun, and that the discriminator is `create_v2` and
explicitly **not** `create`. If pump.fun changes the layout again, these fail —
which is the point of pinning them.

The derivation and its evidence are in `sakura-mobile/docs/pumpfun-create-v2.md`.
