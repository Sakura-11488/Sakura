"use client";

import Header from "@/components/Header";
import Link from "next/link";

const lastUpdated = "March 26, 2026";
const supportEmail = "sakuramanga162@gmail.com";

export default function PrivacyPage() {
    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40, maxWidth: 860, margin: "0 auto", paddingBottom: 120 }}>
                    <div className="section-header" style={{ marginBottom: 24 }}>
                        <h2 className="section-title">Privacy Policy</h2>
                        <p className="section-subtitle">How Sakura collects, uses, and stores information</p>
                    </div>

                    <div style={{
                        background: "var(--card-bg)",
                        border: "1px solid var(--card-border)",
                        borderRadius: "var(--radius-lg)",
                        padding: 24,
                        lineHeight: 1.7,
                        color: "var(--text-secondary)",
                    }}>
                        <p><strong>Last updated:</strong> {lastUpdated}</p>
                        <p>
                            Sakura ("Sakura", "we", "us", or "our") provides a wallet-connected reading and creator
                            platform for manga, anime, novels, creator support, premium access, and optional Solana-based
                            features such as token swaps, fiat on-ramp services, and perpetuals trading.
                        </p>
                        <p>
                            This Privacy Policy explains what information we collect, how we use it, when we share it,
                            and the choices you have when using Sakura.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>1. Information We Collect</h3>
                        <p>Depending on how you use Sakura, we may collect and process:</p>
                        <ul style={{ paddingLeft: 20 }}>
                            <li>your Solana wallet address</li>
                            <li>profile details such as display name and bio</li>
                            <li>optional email address saved in settings</li>
                            <li>comments, reactions, creator submissions, novel content, and other user-submitted text</li>
                            <li>favorites, reading history, chapter progress, anime history, searches, bookmarks, notes, and downloads metadata</li>
                            <li>settings and preferences, including reading mode, TTS settings, and notification preferences</li>
                            <li>tips, highlighted comment records, premium/pass purchase status, and other wallet-linked app activity</li>
                            <li>trade, balance, deposit, withdrawal, and authentication records if you use Sakura perps features</li>
                        </ul>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>2. Blockchain Information</h3>
                        <p>
                            Sakura uses Solana-based features. Public blockchain data such as wallet addresses,
                            transaction signatures, token transfers, and payment verification records may be processed
                            by the app or backend in order to unlock features, verify payments, or operate trading and
                            creator support flows.
                        </p>
                        <p>
                            Blockchain data is generally public and may remain visible permanently on-chain.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>3. Local Device Storage</h3>
                        <p>Sakura stores certain information on your device to provide app functionality, including:</p>
                        <ul style={{ paddingLeft: 20 }}>
                            <li>cached content and downloaded chapter data</li>
                            <li>local reading settings and app preferences</li>
                            <li>local premium/pass receipt information</li>
                            <li>embedded wallet information stored locally on device</li>
                        </ul>
                        <p>
                            On supported devices, Sakura may use biometric-secured device storage for the embedded wallet.
                            On unsupported devices, Sakura may fall back to device-local storage mechanisms.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>4. Cloud Sync</h3>
                        <p>
                            If you connect a wallet and use Sakura cloud sync, Sakura may back up and restore your
                            library, settings, history, progress, searches, bookmarks, and related account-linked data
                            using our database infrastructure.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>5. How We Use Information</h3>
                        <p>We use information to:</p>
                        <ul style={{ paddingLeft: 20 }}>
                            <li>provide and maintain Sakura features</li>
                            <li>sync your library, settings, and progress across devices</li>
                            <li>enable comments, profiles, creator tools, and community features</li>
                            <li>verify on-chain payments and wallet-based entitlements</li>
                            <li>operate premium access, tipping, token, swap, on-ramp, and perps features</li>
                            <li>prevent abuse, fraud, spam, and misuse</li>
                            <li>debug, improve, and secure the service</li>
                            <li>comply with law and enforce our terms</li>
                        </ul>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>6. Third-Party Services</h3>
                        <p>Depending on which Sakura features you use, Sakura may interact with third-party services such as:</p>
                        <ul style={{ paddingLeft: 20 }}>
                            <li>Supabase</li>
                            <li>Solana network infrastructure and RPC providers</li>
                            <li>Third-party content and metadata providers</li>
                            <li>Google Books or similar metadata services</li>
                            <li>Transak</li>
                            <li>Jupiter</li>
                            <li>Phoenix Perps</li>
                        </ul>
                        <p>
                            Your use of those services may also be governed by their own privacy policies and terms.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>7. Comments, Profiles, and Creator Content</h3>
                        <p>
                            If you post comments, create a profile, submit creator information, or publish novels or other
                            content through Sakura, that information may be visible to other users and associated with
                            your wallet address.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>8. Sharing of Information</h3>
                        <p>We may share information:</p>
                        <ul style={{ paddingLeft: 20 }}>
                            <li>with infrastructure and service providers that help operate Sakura</li>
                            <li>with blockchain networks and integrated protocols when you use on-chain features</li>
                            <li>when required by law, legal process, or regulatory request</li>
                            <li>to protect Sakura, our users, or others from fraud, abuse, or security issues</li>
                            <li>in connection with a merger, acquisition, financing, or sale of assets</li>
                        </ul>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>9. Data Retention</h3>
                        <p>
                            We retain information for as long as reasonably necessary to operate the service, maintain
                            synced experiences, enforce our agreements, resolve disputes, meet legal obligations, and
                            secure the platform.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>10. Your Choices</h3>
                        <p>You may choose to:</p>
                        <ul style={{ paddingLeft: 20 }}>
                            <li>disconnect your wallet</li>
                            <li>avoid providing optional information such as email, display name, or bio</li>
                            <li>clear local app data from your device</li>
                            <li>remove locally stored wallet information from your device</li>
                            <li>avoid optional cloud sync, token, or trading features</li>
                        </ul>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>11. Children&apos;s Privacy</h3>
                        <p>
                            Sakura is not intended for children under 13. Certain blockchain, payment, and trading
                            features are intended only for users who are legally permitted to use them in their jurisdiction.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>12. Changes to This Policy</h3>
                        <p>
                            We may update this Privacy Policy from time to time. If we do, we will update the
                            &quot;Last updated&quot; date above. Continued use of Sakura after changes become effective
                            means you accept the updated policy.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>13. Contact</h3>
                        <p>
                            If you have questions about this Privacy Policy, contact us at{" "}
                            <a href={`mailto:${supportEmail}`} style={{ color: "var(--sakura-pink)" }}>{supportEmail}</a>.
                        </p>
                    </div>

                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 20 }}>
                        <Link href="/terms" className="btn-secondary" style={{ textDecoration: "none" }}>
                            View Terms of Service
                        </Link>
                        <Link href="/settings" className="btn-secondary" style={{ textDecoration: "none" }}>
                            Back to Settings
                        </Link>
                    </div>
                </section>
            </main>
        </>
    );
}
