#!/usr/bin/env python3
"""Configuration boundaries for build and release packaging; no signing keys created."""
import base64
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "configure.py"
SPEC = importlib.util.spec_from_file_location("sakura_configure", SCRIPT)
configure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(configure)

# A fixed public-key-shaped fixture is sufficient for format validation. This
# never creates or installs a private signing key or accesses the Keychain.
PUBLIC_KEY = base64.b64encode(bytes(range(32))).decode("ascii")
LOCAL = {"SAKURA_APP_URL": "https://sakuraonseeker.com/app/"}
RELEASE = {
    **LOCAL,
    "SAKURA_UPDATE_FEED_URL": "https://updates.example.com/appcast.xml",
    "SAKURA_UPDATE_PUBLIC_KEY": PUBLIC_KEY,
    "SAKURA_UPDATE_DOWNLOAD_BASE_URL": "https://updates.example.com/releases/1",
    "SAKURA_SIGNING_IDENTITY": "Developer ID Application: Example (TEST123)",
    "SAKURA_NOTARY_PROFILE": "test-profile",
    "SAKURA_SPARKLE_KEYCHAIN_ACCOUNT": "test-account",
}


class ConfigurationTests(unittest.TestCase):
    def validate(self, settings, release=False):
        with patch.dict(os.environ, settings, clear=True):
            return configure.settings(release)

    def assert_rejected(self, settings, release=False):
        with self.assertRaises(SystemExit):
            self.validate(settings, release)

    def test_local_build_without_updater(self):
        self.assertEqual(self.validate(LOCAL), ("0.1.0", "1", LOCAL["SAKURA_APP_URL"], "", ""))

    def test_complete_release_settings(self):
        self.assertEqual(self.validate(RELEASE, True)[3:], (RELEASE["SAKURA_UPDATE_FEED_URL"], PUBLIC_KEY))

    def test_rejects_app_query_including_empty_query(self):
        for suffix in ("?token=value", "?", "#anchor", "#"):
            with self.subTest(suffix=suffix):
                self.assert_rejected({**LOCAL, "SAKURA_APP_URL": LOCAL["SAKURA_APP_URL"] + suffix})

    def test_app_must_be_https_at_exact_export_base(self):
        for url in ("http://sakuraonseeker.com/app/", "https://sakuraonseeker.com/", "https://sakuraonseeker.com/app/studio", "https://sakuraonseeker.com/app//", "https:///app/"):
            with self.subTest(url=url):
                self.assert_rejected({**LOCAL, "SAKURA_APP_URL": url})

    def test_rejects_feed_without_key_and_key_without_feed(self):
        self.assert_rejected({**LOCAL, "SAKURA_UPDATE_FEED_URL": RELEASE["SAKURA_UPDATE_FEED_URL"]})
        self.assert_rejected({**LOCAL, "SAKURA_UPDATE_PUBLIC_KEY": PUBLIC_KEY})

    def test_rejects_invalid_feed(self):
        for url in ("http://updates.example.com/appcast.xml", "https:///appcast.xml", "https://updates.example.com:70000/appcast.xml", "https://updates.example.com/appcast.xml#", "https://updates.example.com/feed file.xml"):
            with self.subTest(url=url):
                self.assert_rejected({**RELEASE, "SAKURA_UPDATE_FEED_URL": url})

    def test_rejects_invalid_public_key(self):
        for key in ("not-base64", base64.b64encode(b"short").decode(), PUBLIC_KEY + "\n", ""):
            with self.subTest(key=key):
                self.assert_rejected({**RELEASE, "SAKURA_UPDATE_PUBLIC_KEY": key})

    def test_rejects_credentials_in_all_urls(self):
        for setting in ("SAKURA_APP_URL", "SAKURA_UPDATE_FEED_URL", "SAKURA_UPDATE_DOWNLOAD_BASE_URL"):
            for credentials in ("user:password@", "user@", "@"):
                with self.subTest(setting=setting, credentials=credentials):
                    url = RELEASE[setting].replace("https://", "https://" + credentials)
                    self.assert_rejected({**RELEASE, setting: url}, True)

    def test_rejects_each_missing_release_input(self):
        for setting in RELEASE:
            with self.subTest(setting=setting):
                values = RELEASE.copy()
                values.pop(setting)
                self.assert_rejected(values, True)

    def test_rejects_invalid_release_identity_or_empty_profiles(self):
        for setting, value in (("SAKURA_SIGNING_IDENTITY", "-"), ("SAKURA_SIGNING_IDENTITY", "Developer ID Application: "), ("SAKURA_NOTARY_PROFILE", "  "), ("SAKURA_SPARKLE_KEYCHAIN_ACCOUNT", "\n")):
            with self.subTest(setting=setting):
                self.assert_rejected({**RELEASE, setting: value}, True)

    def test_download_base_cannot_have_query(self):
        for suffix in ("?token=value", "?"):
            self.assert_rejected({**RELEASE, "SAKURA_UPDATE_DOWNLOAD_BASE_URL": RELEASE["SAKURA_UPDATE_DOWNLOAD_BASE_URL"] + suffix}, True)


if __name__ == "__main__":
    unittest.main()
