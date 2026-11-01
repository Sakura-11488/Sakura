#!/bin/bash
# Shared helpers for macOS packaging. Never enable shell tracing: release inputs
# can include private signing/notarization configuration.
set -euo pipefail

MACOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$MACOS_DIR/.." && pwd)"
export SAKURA_APP_URL="${SAKURA_APP_URL:-https://sakuraonseeker.com/app/}"
export SAKURA_VERSION="${SAKURA_VERSION:-0.1.0}"
export SAKURA_BUILD_NUMBER="${SAKURA_BUILD_NUMBER:-1}"

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
require_macos() {
    [[ "$(uname -s)" == Darwin ]] || fail "Build Sakura on macOS with Xcode command line tools installed."
    xcrun --find swift >/dev/null
    command -v python3 >/dev/null || fail "Python 3 is required for plist configuration."
}

# Sign nested code before its containing bundle. Do not sign with --deep:
# Sparkle's Downloader can have its own entitlements.
sign_app() {
    local app="$1" identity="$2" framework version
    local options=(--force --sign "$identity")
    if [[ "$identity" == - ]]; then
        options+=(--timestamp=none)
    else
        options+=(--options runtime --timestamp)
    fi
    framework="$app/Contents/Frameworks/Sparkle.framework"
    version="$framework/Versions/Current"
    [[ -d "$version" ]] || fail "Missing Sparkle framework version."
    codesign "${options[@]}" "$version/XPCServices/Installer.xpc"
    codesign "${options[@]}" --preserve-metadata=entitlements "$version/XPCServices/Downloader.xpc"
    codesign "${options[@]}" "$version/Autoupdate"
    codesign "${options[@]}" "$version/Updater.app"
    codesign "${options[@]}" "$framework"
    codesign "${options[@]}" --entitlements "$MACOS_DIR/Config/Sakura.entitlements" "$app"
    codesign --verify --deep --strict "$app"
}
