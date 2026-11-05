# Repository map

Sakura spans an application, a hosting package, platform work, and Perps research. Each repository has a specific responsibility; combining them into one public branch would blur release and privacy boundaries.

## Core repositories

| Repository | Responsibility | Source and release boundary |
| --- | --- | --- |
| [Sakura-11488/Sakura](https://github.com/Sakura-11488/Sakura) | Application source history and project documentation. | Public default source is the historical Next.js/Capacitor app. The current live Expo source still needs a reviewed public reconciliation. |
| [Sakura-11488/sakura-perps](https://github.com/Sakura-11488/sakura-perps) | Perps research, risk logic, paper Rooms, and the invite-only community service. | Follow its README and security policy for the exact status of simulation, deployed services, and experimental trading code. A passing source test is not deployment evidence. |
| [millw14/sakura-web](https://github.com/millw14/sakura-web) | Website hosting, export packaging, and server-side routes. | Consumes an application export; it is not the source of the current UI. A public branch alone may not match the live release. |
| [Sakura-11488/ino-sakura-registry](https://github.com/Sakura-11488/ino-sakura-registry) | Registry program and integration reference. | Verify the relevant program, deployment, and integration before making claims about on-chain records. Repository existence does not establish that every app action is recorded on-chain. |

## Platform repositories

| Repository | Current public scope |
| --- | --- |
| [Sakura-11488/Sakura-pc](https://github.com/Sakura-11488/Sakura-pc) | Documentation and legal notices. The public default tree does not contain desktop application source. |
| [Sakura-11488/Sakura-ios](https://github.com/Sakura-11488/Sakura-ios) | Historical Next.js/Capacitor source. Its presence does not establish an up-to-date native iOS release. |

The current website uses Expo Router and React Native Web. Current authoring conventions place shared screens, components, and logic under `sakura-mobile/`, with web-specific module variants and a `web/` export shell. The complete exported application runs under `/app/`.

The historical default branch in this repository still contains `src/`, the root Capacitor `android/` project, and Next.js build scripts. Those directories do not describe the current live website or current native Android application. Do not use a successful historical build as verification of a modern application change.

Platform packages and release artifacts need their own build, signing, and device verification. A web export does not produce a signed native release, and a native package does not deploy the website. Preserve existing application identifiers and users' stored data when preparing updates.

## Private components

Studio and associated private operations source remain outside public contribution branches. A local release can integrate private and public components for verification and deployment without publishing private source history. Private release evidence can contain operational details that must be removed before publishing a summary.

Never copy a private release branch, service credentials, identity material, invitations, or live databases into a public repository to make a checkout appear complete.

## How a web change reaches users

1. A reviewed application change produces an Expo web export.
2. The hosting package combines that export with its server-side integrations and release guards.
3. Community API routes reach a separate persistent service; exporting the UI does not install or migrate that service.
4. The assembled release is verified in preview before promotion, preserving the private components and existing integrations required by the live application.

See the [release process](RELEASES.md) and [source reconciliation milestone](ROADMAP.md#1-reconcile-public-source-and-release-evidence) for the evidence required at those boundaries.
