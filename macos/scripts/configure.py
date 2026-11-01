#!/usr/bin/env python3
"""Validate public bundle settings and configure Info.plist without shell substitution."""
import base64
import binascii
import os
import pathlib
import plistlib
import re
import sys
import urllib.parse


def fail(message):
    raise SystemExit(f"Error: {message}")


def https_url(name, required=False):
    value = os.environ.get(name, "")
    if not value and not required:
        return ""
    try:
        url = urllib.parse.urlsplit(value)
        valid = (url.scheme == "https" and url.hostname and url.username is None
                 and url.password is None and "#" not in value and url.port != 0)
    except ValueError:
        valid = False
    if not valid or any(char.isspace() for char in value):
        fail(f"{name} must be an HTTPS URL without credentials or a fragment.")
    return value


def settings(release):
    version = os.environ.get("SAKURA_VERSION", "0.1.0")
    build = os.environ.get("SAKURA_BUILD_NUMBER", "1")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", version):
        fail("SAKURA_VERSION must contain one to three numeric components.")
    if not re.fullmatch(r"[1-9][0-9]*", build):
        fail("SAKURA_BUILD_NUMBER must be a positive, increasing integer.")
    app_url = https_url("SAKURA_APP_URL", required=True)
    if urllib.parse.urlsplit(app_url).path not in ("/app", "/app/") or "?" in app_url:
        fail("SAKURA_APP_URL must point to the exported /app/ base path without a query.")
    feed = https_url("SAKURA_UPDATE_FEED_URL", required=release)
    key = os.environ.get("SAKURA_UPDATE_PUBLIC_KEY", "")
    if bool(feed) != bool(key):
        fail("Configure both SAKURA_UPDATE_FEED_URL and SAKURA_UPDATE_PUBLIC_KEY, or neither for a local build.")
    if key:
        try:
            if len(base64.b64decode(key, validate=True)) != 32:
                raise ValueError()
        except (ValueError, binascii.Error):
            fail("SAKURA_UPDATE_PUBLIC_KEY must be a base64 Ed25519 public key (32 bytes).")
    if release:
        download_url = https_url("SAKURA_UPDATE_DOWNLOAD_BASE_URL", required=True)
        if "?" in download_url:
            fail("SAKURA_UPDATE_DOWNLOAD_BASE_URL must be a directory URL without a query.")
        identity = os.environ.get("SAKURA_SIGNING_IDENTITY", "")
        if not identity.startswith("Developer ID Application: ") or not identity.removeprefix("Developer ID Application: ").strip():
            fail("Set SAKURA_SIGNING_IDENTITY to a Developer ID Application certificate name.")
        if not os.environ.get("SAKURA_NOTARY_PROFILE", "").strip():
            fail("Set SAKURA_NOTARY_PROFILE to an existing notarytool Keychain profile.")
        if not os.environ.get("SAKURA_SPARKLE_KEYCHAIN_ACCOUNT", "").strip():
            fail("Set SAKURA_SPARKLE_KEYCHAIN_ACCOUNT to the existing Sparkle signing-key account.")
    return version, build, app_url, feed, key


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("validate", "configure"):
        fail("Usage: configure.py validate [--release] | configure TEMPLATE OUTPUT")
    version, build, app_url, feed, key = settings("--release" in sys.argv)
    if sys.argv[1] == "configure":
        if len(sys.argv) != 4:
            fail("Usage: configure.py configure TEMPLATE OUTPUT")
        with pathlib.Path(sys.argv[2]).open("rb") as handle:
            info = plistlib.load(handle)
        info.update(CFBundleShortVersionString=version, CFBundleVersion=build, SakuraAppURL=app_url)
        info["WKAppBoundDomains"] = [urllib.parse.urlsplit(app_url).hostname]
        if feed:
            info.update(SUFeedURL=feed, SUPublicEDKey=key)
        else:
            info.pop("SUFeedURL", None)
            info.pop("SUPublicEDKey", None)
            info["SUEnableAutomaticChecks"] = False
        with pathlib.Path(sys.argv[3]).open("wb") as handle:
            plistlib.dump(info, handle, sort_keys=False)
