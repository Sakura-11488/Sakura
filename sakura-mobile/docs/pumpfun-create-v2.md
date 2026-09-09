# pump.fun `create_v2` — derived from chain, 2026-09-09

Everything here was read off mainnet, not recalled. The builder service
(`PUMPFUN_UNSIGNED_TX_URL`) needs it to construct a launch transaction.

**Re-derive before trusting this.** It describes a third-party program that has
already changed once — see the correction below. `scripts/` has no runner for
this; the derivation is reproducible from the steps in *How this was derived*.

## The correction that motivated writing it down

The obvious guess is that the instruction is called `create`, with
discriminator `sha256("global:create")[0..8]` = `181ec828051c0777`.

**That is wrong on the live path.** Real launches today use **`create_v2`**,
discriminator **`d6904cec5f8b31b4`**. Both instructions still exist in the
program, and there is even a `toggle_create_v2` admin instruction, so which one
is live is a runtime decision by pump.fun rather than a property of the program.

`buy` and `sell` *do* match their naive discriminators, which is what makes the
mistake easy to miss: the derivation method is right, the method *name* changed.

## Program

```
pump.fun   6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P   (verified executable, BPFLoaderUpgradeable)
mayhem     MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e
```

Note most *trading* volume has moved to the PumpSwap AMM
(`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`) — in a sampled block, 248
instructions against ~25 for the bonding curve. Launches still happen on the
bonding curve program above.

## Instruction data

```
[0..8]   d6904cec5f8b31b4          discriminator = sha256("global:create_v2")[0..8]
then Borsh:
  name                 string
  symbol               string
  uri                  string
  creator              pubkey (32)
  is_mayhem_mode       bool   (1)
  is_cashback_enabled  OptionBool (1)
```

The trailing two bytes are the last two args — worth stating because a naive
decoder that stops after `creator` reports "2 trailing bytes" and looks broken.

## Accounts (16, order matters)

| # | name | flags | how to build it |
|---|---|---|---|
| 0 | `mint` | **signer**, writable | the vanity keypair |
| 1 | `mint_authority` | readonly | PDA `["mint-authority"]` under pump.fun |
| 2 | `bonding_curve` | writable | PDA `["bonding-curve", mint]` under pump.fun |
| 3 | `associated_bonding_curve` | writable | ATA(`bonding_curve`, `token_program`, `mint`) |
| 4 | `global` | readonly | PDA `["global"]` under pump.fun |
| 5 | `user` | **signer**, writable | the creator — fee payer |
| 6 | `system_program` | readonly | `11111111111111111111111111111111` |
| 7 | `token_program` | readonly | **Token-2022** `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| 8 | `associated_token_program` | readonly | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| 9 | `mayhem_program_id` | writable | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` |
| 10 | `global_params` | readonly | PDA `["global-params"]` **under mayhem** |
| 11 | `sol_vault` | writable | PDA `["sol-vault"]` **under mayhem** |
| 12 | `mayhem_state` | writable | PDA `["mayhem-state", mint]` **under mayhem** |
| 13 | `mayhem_token_vault` | writable | **UNRESOLVED — see below** |
| 14 | `event_authority` | readonly | PDA `["__event_authority"]` under pump.fun |
| 15 | `program` | readonly | the pump.fun program id |

Two things that are easy to get wrong and cost real time:

- **Accounts 10-12 derive under the *mayhem* program, not pump.fun.** Anchor's
  IDL encodes this in a `pda.program` field that is easy to ignore; deriving
  them under pump.fun silently produces plausible-looking wrong addresses.
- **The token program is Token-2022.** New pump.fun mints are not classic SPL.
  This repo already treats that distinction as a recurring hazard — SAKURA
  itself is Token-2022 — so derive ATAs with the right program id.

### The one unresolved account

`mayhem_token_vault` (13) is caller-supplied and **created and closed inside the
same transaction**, so it cannot be inspected after the fact. 22 candidate
derivations were tried against two live launches — ATAs of `mayhem_state`, the
mayhem program and the user under both token programs, and PDAs over six seed
strings under both programs — none matched.

To settle it, build a `create_v2` with a candidate and call
`simulateTransaction`. That is free, needs no signature, and the program either
accepts the account or names it in the failure. Do that before the first real
launch; do not guess it.

## Verification performed

- Program id checked on chain: exists, executable, owned by BPFLoaderUpgradeable.
- Discriminators computed locally and matched against live instruction data
  (`buy` matched, `create` did **not**, `create_v2` did).
- Three live launches sampled: account count 16 in all three, and the
  constant-vs-per-launch split identical across them.
- All 12 derivable accounts re-derived from `(mint, creator)` and matched
  position-for-position against two further live launches.

## How this was derived

Scanning the program's recent signatures finds only `buy`/`sell` — launches are
a small fraction of its traffic, and 55,000 sampled transactions contained zero.
Two things worked:

1. Scan whole blocks for an inner `initializeMint` whose mint address ends in
   `pump`, then read the top-level instruction that references that mint. This
   finds the creating instruction without assuming which program or method it is.
2. Fetch the program's **on-chain Anchor IDL**, which is authoritative:

```
base      = findProgramAddress([], programId)
idlAccount = createWithSeed(base, "anchor:idl", programId)
payload   = zlib.inflate(data[44 .. 44 + u32LE(data[40])])
```

For pump.fun that account is `AYgC53tU5BbP2NAnv5nConJxAdpQZctvmZK88pu69xRs` and
holds the full instruction list, argument types, account names and PDA seeds.
Start there next time rather than reverse-engineering from transactions.
