<div align="center">

<img src="sakurapic.png" width="300" />

# 桜 Sakura

**読む。観る。集める。所有する。**

*Read. Watch. Collect. Own.*

---

A manga & anime platform that lives on **Solana** — because your entertainment deserves more than a tab you close and forget.

</div>

<br>

## what is this?

Sakura is a love letter to manga readers and anime watchers who want something *different*.

Instead of ads, tracking, and chapters that disappear — Sakura gives you a clean, beautiful experience with a twist: **on-chain milestone tracking via the [Ino Registry](https://github.com/millw14/ino-sakura-registry)**. Every chapter unlock, every completion, every tip — recorded as a verifiable, portable milestone on Solana.

No accounts. No emails. Just your wallet and your content.

<br>

## the vibe

- **Bilingual UI** — Japanese + English throughout, because aesthetics matter
- **Vertical scroll reader** — the way manga was meant to be read on screens
- **Native anime streaming** — browse, search, and watch anime with a built-in player
- **On-chain milestones** — chapter unlocks, completions, and early reader badges via Ino
- **Creator support** — tip creators with $SAKURA, recorded on-chain as `record_support`
- **Dark mode** — obviously. your eyes deserve it

<br>

## architecture

```
┌──────────────────────────────────────────────────┐
│                   Client App                      │
│          (Next.js / Capacitor / Android)          │
└──────────────────┬───────────────────────────────┘
                   │
         ┌─────────┴──────────┐
         │                    │
         v                    v
┌─────────────────┐  ┌─────────────────────────────┐
│ Content Pipeline │  │  Ino Registry (Solana)       │
│                  │  │  E9ju12He2mnBR...Hpf         │
│ Proprietary      │  │                              │
│ scraping +       │  │  unlock_chapter  → PDA       │
│ aggregation      │  │  complete_chapter → bitmap   │
│ layer with CDN   │  │  claim_milestone → badge     │
│ edge caching     │  │  record_support  → tier      │
└─────────────────┘  └─────────────────────────────┘
```

### Content Pipeline

Sakura uses a **proprietary content aggregation pipeline** that scrapes, normalizes, and caches manga metadata and chapter data through a multi-layer CDN. The pipeline handles:

- Source aggregation from licensed and public domain manga APIs
- Cover image optimization and CDN-edge caching
- Chapter page delivery with data saver quality tiers
- Rate limiting and request batching for upstream source protection
- Bilibili takedown detection and graceful fallback routing

The content source adapter pattern (`src/lib/sources/`) allows plugging in additional scrapers without touching the UI layer.

### Payment & Milestone System

All $SAKURA token transactions are routed through the **[Ino on-chain registry](https://github.com/millw14/ino-sakura-registry)** for verifiable milestone tracking:

| Action | Ino Instruction | On-Chain Record |
|--------|----------------|-----------------|
| Chapter unlock | `unlock_chapter` | `UserChapterPDA` with timestamp |
| Chapter completion | `complete_chapter` | Bitmap in `UserSeriesProgressPDA` |
| Early reader badge | `claim_milestone` | `UserBadgePDA` if counter < cap |
| Creator tip | `record_support` | `UserSupportPDA` with tier level |
| Monthly pass | `process_payment` | Split via `FeeRouter` to vault + burn |

The Ino program ID: `E9ju12He2mnBRaneM4xdtUXECDPXdpQQbU6HtSKb6Hpf`

Every payment creates a dual record: the SPL token transfer *and* the Ino milestone PDA. This means reader progress is **portable** — any app that reads the Ino program can verify your history.

<br>

## android app

Sakura runs as a native Android app via Capacitor, with custom Kotlin plugins for:

- **Anime playback** — native ExoPlayer for smooth HLS streaming, Cloudflare bypass, and multi-server fallback
- **Offline downloads** — save chapters for reading without internet
- **Biometric auth** — fingerprint/face unlock for your wallet

<br>

## tech stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js, React, TypeScript |
| Mobile | Capacitor, Kotlin, ExoPlayer |
| Content | Proprietary scraping pipeline + CDN |
| Blockchain | Solana, Ino Registry, Token-2022 |
| Payments | $SAKURA via Ino program instructions |
| Styling | Custom CSS with Japanese design language |

<br>

## the dream

The big idea is simple: *what if reading manga and watching anime felt like it belonged in web3?*

Not in a loud, "gm ser" kind of way — but quietly. Elegantly. A platform where your reading milestones live on-chain, where creators get tipped directly and verifiably, where the experience is gorgeous, and where fans feel at home.

Sakura is still growing. More series, more features, more petals.

<br>

<div align="center">

*built with care and too much caffeine*

**ソラナで動く — Powered by Solana**

</div>
