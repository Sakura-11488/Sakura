# Sakura

A home for manga, anime, novels, and community experiences built around Solana.

[Open Sakura](https://sakuraonseeker.com/app/) · [Try Sakura Rooms](https://sakuraonseeker.com/app/perps/community/) · [Roadmap](docs/ROADMAP.md) · [Security](SECURITY.md)

## What we are building

Sakura brings reading, watching, and community participation into one application. Sakura Rooms explores a related idea: people can plan a paper trading strategy together while each participant chooses their own allocation and reviews the outcome.

| Product | Current scope |
| --- | --- |
| Sakura app | The live website uses Expo Router and React Native Web, with shared mobile source and a pink reading-room interface. |
| Sakura Rooms | An invite-only paper beta with separate identities, shared history, and Plan, My allocation, and Review screens. Scenarios are fixed simulations; there are no deposits or real-money trades. |
| Sakura Perps | The research and engineering behind the paper experience and a future derivatives system. Real-money trading is a separate milestone with substantial security and operational work remaining. |

## Source status

**This repository's public default branch is a historical Next.js/Capacitor snapshot. It does not reproduce the current live Expo application.** Reconciling the current public application source, its checks, and its build instructions is a tracked [next-phase milestone](docs/ROADMAP.md#1-reconcile-public-source-and-release-evidence).

The historical `src/` and root `android/` directories are not the current website or Android application entry points. Private components are maintained separately and will not be included in a public source reconciliation. See the [repository map](docs/REPOSITORIES.md) before choosing a component or development branch.

## Explore the project

| Repository | Responsibility |
| --- | --- |
| [Sakura](https://github.com/Sakura-11488/Sakura) | Application source history, project navigation, and the public source reconciliation. |
| [sakura-perps](https://github.com/Sakura-11488/sakura-perps) | Perps research, risk logic, the Rooms paper model, and community service code. |
| [sakura-web](https://github.com/millw14/sakura-web) | Website hosting, export packaging, and server-side integration routes. |

The [full repository map](docs/REPOSITORIES.md) explains platform work, registry code, private components, and how these repositories fit together.

## Follow or contribute

- Read the [documentation index](docs/README.md) for the project structure and release process.
- Follow the [roadmap](docs/ROADMAP.md) for milestones and the evidence needed to complete them.
- Use the [contribution guide](CONTRIBUTING.md) to report bugs, propose a change, or prepare a pull request.
- Read the [security policy](SECURITY.md) before sharing a vulnerability. Keep exploit details and credentials out of public issues.

The public paper beta is an early product test. Shipping it does not establish that a real-money system is ready or independently audited.

## Rights

The existing [copyright notice](COPYRIGHT.md) applies. Public repository access does not change those terms. Third-party dependencies and content retain their respective rights and licenses.
