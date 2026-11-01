# Sakura for Mac — developer handoff

This branch provides the Mac client and signing instructions. Start with [START-HERE.txt](START-HERE.txt). It is a candidate for development and verification; no public Mac release is announced by this branch.

Sakura uses a native AppKit window and controls around the existing live Sakura interface in WKWebView. Web screens and server-backed features come from `https://sakuraonseeker.com/app/`. The shell includes persistent web storage, native menus and command navigation, file open/save dialogs, safe URL handling, and a Sparkle updater that becomes available when its signing key and feed are configured.

## Get the handoff

```sh
git clone --branch codex/mac-developer-handoff --single-branch https://github.com/Sakura-11488/Sakura.git Sakura-Mac
cd Sakura-Mac
shasum -a 256 -c macos/SOURCE-SHA256SUMS
```

All commands below run from the repository root. The Mac build needs only `macos/` and `sakura-mobile/assets/images/icon.png`. No Node installation or web export is needed.

## Local verification

Requires macOS 14+, current initialized/selected Xcode with Swift 5.10 or newer, Python 3.9+, and internet access for the pinned Sparkle dependency.

```sh
swift test --package-path macos
python3 -m unittest discover -s macos/scripts/tests
env -u SAKURA_UPDATE_FEED_URL -u SAKURA_UPDATE_PUBLIC_KEY -u SAKURA_OUTPUT_DIR bash macos/scripts/build-app.sh --arch universal
open macos/dist/Sakura.app
```

This creates an ad-hoc local test build. The universal executable includes Apple Silicon and Intel slices. Production signing uses Developer ID and hardened runtime; the local build omits hardened runtime because ad-hoc framework signatures have no shared Developer Team ID.

## Signing and return artifacts

Follow [START-HERE.txt](START-HERE.txt) to configure Developer ID, a notarization Keychain profile and a durable Sparkle Ed25519 key, then run:

```sh
bash macos/scripts/release.sh
```

The script signs nested code, submits to Apple, staples the ticket, checks Gatekeeper, and generates and verifies the signed ZIP and appcast. It publishes nothing. Return the completed release folder, public update key, Team ID, version/build and test results to the owner. Keep private keys and Apple credentials out of Git and chat. Future updates must use the retained signing identity and update key, or a coordinated migration.

Bundle ID: `com.sakura.mac`. Stable update feed: `https://sakuraonseeker.com/mac/updates/appcast.xml`. Archive URLs use `/mac/releases/VERSION-BUILD/`.

## Release status

The source has passed 40 Mac core/packaging tests and a universal bundle build. Signed notarization and update installation still require the release credentials. See [FEATURE-PARITY.md](FEATURE-PARITY.md) for scope and known gaps. Sharing web screens does not establish full feature parity, complete cross-device synchronization, or a measured performance improvement.

The production website is released separately. Do not build or deploy the website from this handoff branch.

References: [Apple Developer ID](https://developer.apple.com/developer-id/), [Apple notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), [Sparkle setup and keys](https://sparkle-project.org/documentation/).
