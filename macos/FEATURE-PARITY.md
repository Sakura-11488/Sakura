# Mac candidate verification status

Prepared 1 November 2026. This is a development handoff, not a verified public release.

## Verified locally

- Universal Apple Silicon/Intel packaging and packaged framework-loading smoke check.
- 23 core URL-policy/file-preservation tests and 17 packaging/signature-fixture tests.
- Native launch, persistent account session after restart, command palette and keyboard navigation.
- Live anime playback with resumed progress and subtitles; entering/exiting fullscreen.
- Existing cloud reading-state display and a native save-panel JSON export.

These observations are limited tests. They are not an exhaustive feature-parity or two-client synchronization test.

## Open work

- Developer ID signing, Apple notarization, Gatekeeper verification on returned artifacts, and an actual signed update/relaunch cycle.
- Picture-in-picture returned an unavailable error in the tested embedded-browser configuration.
- Full manga/novel/media provider, Studio, agent, creator/social, permission, file import, offline and download lifecycle coverage.
- Broader metadata synchronization: collections, preferences and AI transcripts do not become cloud-synced merely by using this shell. A preparatory merge core exists separately, but the new backend/adapters are unfinished.
- Two-client conflict/deletion, wallet-switching and offline reconciliation tests for existing synchronization.
- Measured performance comparisons; no speed, memory or battery improvement is promised.

The app uses the same live services and content identifiers as the website. Its own persistent WebKit store does not automatically import another browser's wallet/session or downloaded files. Use the app's existing account restore flow. Preserve intentional adult/private-reading exclusions and device-local media; never clear user storage as an update strategy.

Private web/server components are released through their separate existing process. They are not implemented or deployed by the Mac handoff. Do not publish an installer until the remaining release gates have been completed.
