#!/usr/bin/env python3
"""Exercise release verification with a published Ed25519 vector; no private key needed."""
import base64
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "verify-update.swift"
# RFC 8032 section 7.1, test 1: public key/signature for an empty message.
# https://www.rfc-editor.org/rfc/rfc8032#section-7.1
PUBLIC_KEY = base64.b64encode(bytes.fromhex(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
)).decode()
SIGNATURE = base64.b64encode(bytes.fromhex(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555"
    "fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
)).decode()


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "Requires Swift and CryptoKit on macOS")
class UpdateVerificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix="sakura-verifier-test-")
        cls.directory = Path(cls.workspace.name)
        cls.binary = cls.directory / "verify-update"
        subprocess.run(["swiftc", str(SCRIPT), "-o", str(cls.binary)], check=True, capture_output=True, text=True)

    @classmethod
    def tearDownClass(cls):
        cls.workspace.cleanup()

    def verify(self, *, data=b"", url="https://updates.example.com/releases/Sakura.zip", version="1", signature=SIGNATURE, public_key=PUBLIC_KEY):
        app = self.directory / "Sakura.app"
        (app / "Contents").mkdir(parents=True, exist_ok=True)
        (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
            "SUPublicEDKey": public_key,
            "CFBundleVersion": "1",
            "CFBundleShortVersionString": "0.1.0",
        }))
        archive = self.directory / "Sakura.zip"
        archive.write_bytes(data)
        feed = self.directory / "appcast.xml"
        feed.write_text(f'''<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
<sparkle:version>{version}</sparkle:version><sparkle:shortVersionString>0.1.0</sparkle:shortVersionString>
<enclosure url="{url}" length="{len(data)}" sparkle:edSignature="{signature}"/>
</item></channel></rss>''')
        return subprocess.run([str(self.binary), str(feed), str(archive), str(app), "https://updates.example.com/releases/"], capture_output=True, text=True)

    def test_accepts_published_signature_vector(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_tampered_archive_even_with_correct_length(self):
        result = self.verify(data=b"x")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("signature does not match", result.stderr)

    def test_rejects_different_host_with_same_archive_name(self):
        result = self.verify(url="https://other.example.com/releases/Sakura.zip")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("configured download URL", result.stderr)

    def test_rejects_incorrect_build_number(self):
        result = self.verify(version="2")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("application's build", result.stderr)

    def test_rejects_missing_signature(self):
        self.assertNotEqual(self.verify(signature="").returncode, 0)

    def test_rejects_different_public_key(self):
        key = base64.b64encode(bytes(range(32))).decode()
        self.assertNotEqual(self.verify(public_key=key).returncode, 0)


if __name__ == "__main__":
    unittest.main()
