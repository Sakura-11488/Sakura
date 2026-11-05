# Contributing to Sakura

Start with the [repository map](docs/REPOSITORIES.md). Application, hosting, and Perps changes have different source trees and verification requirements.

## Choose the right source

The public default branch of this repository contains a historical Next.js/Capacitor snapshot. It is suitable for project documentation and historical investigation, but its root build commands do not reproduce the live Expo website.

Before starting current application code changes, agree on the public source branch and relevant acceptance checks with a maintainer. The [source reconciliation milestone](docs/ROADMAP.md#1-reconcile-public-source-and-release-evidence) tracks the work needed to make a fresh public checkout a reliable starting point. Do not recreate the retired UI to make it match a new screenshot.

Private Studio code and release integrations must remain outside public branches. Do not merge a local release snapshot into a public contribution branch.

## Report a bug or propose a feature

For an ordinary bug, include the affected product, route or screen, platform/browser, reproduction steps, expected behavior, and observed behavior. Include a source commit or app build identifier when available. State whether the problem occurred in the live application or a local build.

For a feature, describe who needs it, the problem it solves, and how we could determine whether it helped. For Rooms proposals, preserve each member's independent decision and clearly separate simulated outcomes from real trading.

Use synthetic examples and redact screenshots and logs. Never publish wallet secrets, tokens, invitation codes, personal records, private service addresses, or exploit instructions. Suspected vulnerabilities follow [SECURITY.md](SECURITY.md), not the normal bug template.

## Prepare a pull request

1. Work on a focused branch from the agreed public base. Keep unrelated changes out of the diff.
2. Explain the user-visible behavior or documentation problem and the resulting change.
3. Run the checks appropriate to the files changed. Report exact commands, results, and any checks not run.
4. Inspect `git diff --check` and the complete staged diff before committing. Stage intended paths explicitly rather than an entire shared working directory.
5. Link the issue or roadmap milestone when one exists. Include screenshots only when they help review a UI change.

Documentation-only changes need link and accuracy checks; they do not establish application build or runtime correctness. Code changes need evidence from the relevant source and actual application path. Do not claim that CI passed because a different branch or earlier commit passed.

## Current application conventions

When working on the current Expo source line, screens live in `sakura-mobile/app/`, UI components in `sakura-mobile/components/`, and shared logic in `sakura-mobile/lib/`. Preserve `.web.tsx` and native variants. The browser export is built through `web/` and verified at its `/app/` base path.

These paths describe the current application architecture; they are not present in this public historical default snapshot. Follow the selected source branch's instructions once public source reconciliation makes them available here.

Website releases must preserve Studio, ATSU integrations, community service routes, existing reading data, and required packaging guards. A source PR is not a deployment. See the [release process](docs/RELEASES.md).

## Rights and dependency changes

The [existing copyright terms](COPYRIGHT.md) remain in effect. Only submit material you have permission to contribute. Do not introduce an application-wide license, new dependency license obligations, or copied third-party code without explicit review. Security fixes should include focused regression coverage when it meaningfully demonstrates the failure being fixed.
