"use client";

import { useState, useEffect, type ReactNode } from "react";
import { getLocal, setLocal, STORAGE_KEYS } from "@/lib/storage";
import { useI18n } from "@/lib/i18n/I18nProvider";

const CURRENT_VERSION = "v1";

const supportEmail = "sakuramanga162@gmail.com";

export default function TermsGate({ children }: { children: ReactNode }) {
    const { t } = useI18n();
    const [accepted, setAccepted] = useState<boolean | null>(null);
    const [checked, setChecked] = useState(false);
    const [tab, setTab] = useState<"terms" | "privacy">("terms");

    useEffect(() => {
        const stored = getLocal<string>(STORAGE_KEYS.TERMS_ACCEPTED, "");
        setAccepted(stored === CURRENT_VERSION);
    }, []);

    const handleAccept = () => {
        setLocal(STORAGE_KEYS.TERMS_ACCEPTED, CURRENT_VERSION);
        setAccepted(true);
    };

    if (accepted === null) return null;
    if (accepted) return <>{children}</>;

    return (
        <>
            <div className="tg-overlay">
                <div className="tg-container">
                    <div className="tg-header">
                        <div className="tg-logo">桜</div>
                        <h1 className="tg-title">{t("terms.welcome")}</h1>
                        <p className="tg-subtitle">{t("terms.subtitle")}</p>
                    </div>

                    <div className="tg-tabs">
                        <button
                            className={`tg-tab ${tab === "terms" ? "active" : ""}`}
                            onClick={() => setTab("terms")}
                        >
                            {t("terms.termsTab")}
                        </button>
                        <button
                            className={`tg-tab ${tab === "privacy" ? "active" : ""}`}
                            onClick={() => setTab("privacy")}
                        >
                            {t("terms.privacyTab")}
                        </button>
                    </div>

                    <div className="tg-scroll">
                        {tab === "terms" ? <TermsContent /> : <PrivacyContent />}
                    </div>

                    <div className="tg-footer">
                        <label className="tg-checkbox-label">
                            <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => setChecked(e.target.checked)}
                                className="tg-checkbox"
                            />
                            <span>{t("terms.agree")}</span>
                        </label>

                        <button
                            className="tg-accept-btn"
                            disabled={!checked}
                            onClick={handleAccept}
                        >
                            {t("terms.continue")}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}

function TermsContent() {
    return (
        <div className="tg-legal-text">
            <p><strong>Last updated:</strong> March 26, 2026</p>
            <p>
                These Terms of Service (&quot;Terms&quot;) govern your access to and use of Sakura,
                including the Sakura app, website, and related services (collectively, the &quot;Service&quot;).
                By accessing or using Sakura, you agree to these Terms. If you do not agree, do not use the Service.
            </p>

            <h4>1. Eligibility</h4>
            <p>
                You must be legally capable of entering into a binding agreement to use Sakura. If you use
                blockchain, token, payment, swap, or perpetuals features, you are responsible for making
                sure those activities are lawful where you live.
            </p>

            <h4>2. Description of the Service</h4>
            <p>Sakura may include features such as:</p>
            <ul>
                <li>Manga, anime, and novel browsing and reading</li>
                <li>Comments, reactions, profiles, and creator tools</li>
                <li>Premium/pass access tied to wallet activity or token features</li>
                <li>Creator tipping and token-paid highlights</li>
                <li>Fiat on-ramp, token swap, and perpetuals trading integrations</li>
                <li>Local storage and cloud sync for reading progress and preferences</li>
            </ul>
            <p>Some features may be changed, limited, or removed at any time.</p>

            <h4>3. Wallet Responsibility</h4>
            <p>
                Sakura may allow you to connect or create a Solana wallet. You are solely responsible for
                your wallet, private key, seed phrase, backups, biometric/device security, and every
                transaction you approve or sign. Blockchain transactions are generally irreversible.
                Sakura is not responsible for recovering lost assets, reversing mistaken transfers,
                or restoring access to compromised wallets.
            </p>

            <h4>4. No Financial Advice</h4>
            <p>
                Sakura is not a broker, bank, exchange, investment adviser, or financial adviser.
                Nothing in Sakura constitutes financial, investment, legal, or tax advice.
            </p>

            <h4>5. Blockchain, Token, and Trading Risk</h4>
            <p>By using Sakura&apos;s blockchain-related features, you acknowledge and accept that:</p>
            <ul>
                <li>Digital assets are volatile and may lose value</li>
                <li>Swaps, purchases, and token transfers may fail, delay, or settle unexpectedly</li>
                <li>Perpetuals trading may involve leverage, liquidation, funding, slippage, oracle risk, and total loss</li>
                <li>Third-party infrastructure may become unavailable or change without notice</li>
                <li>Blockchain transactions are public and generally irreversible</li>
            </ul>

            <h4>6. Third-Party Services</h4>
            <p>
                Sakura may rely on or integrate third-party services and protocols, including but not
                limited to Supabase, Solana network infrastructure, third-party content providers, Transak, Jupiter, Phoenix,
                and similar providers. We do not control those services and are not responsible for their
                availability, content, policies, security, or performance.
            </p>

            <h4>7. User Content</h4>
            <p>
                You may submit comments, profile details, creator information, novel content, and other
                material through Sakura. You keep ownership of content you lawfully own, but you grant
                Sakura a non-exclusive, worldwide, royalty-free license to host, store, display, moderate,
                and use that content as needed to operate and improve the Service.
                You agree not to submit content that is unlawful, abusive, infringing, fraudulent, or harmful.
            </p>

            <h4>8. Prohibited Conduct</h4>
            <p>You agree not to:</p>
            <ul>
                <li>Violate any law or regulation</li>
                <li>Infringe intellectual property or privacy rights</li>
                <li>Harass, threaten, impersonate, or defraud others</li>
                <li>Upload malicious code or interfere with Sakura&apos;s systems</li>
                <li>Circumvent payment, entitlement, moderation, or access controls</li>
                <li>Use Sakura in a way that harms the service, users, or creators</li>
            </ul>

            <h4>9. Premium Access, Tips, and Token Features</h4>
            <p>
                Sakura may offer premium/pass access, creator tipping, highlighted comments, swaps,
                on-ramp services, and token-gated features. Token prices, fees, rules, and eligibility
                requirements may change at any time. Blockchain payments are generally irreversible, and
                Sakura does not guarantee uninterrupted access to token-based or wallet-linked features.
            </p>

            <h4>10. Suspension and Termination</h4>
            <p>
                We may suspend, restrict, or terminate access to Sakura if we believe you violated these
                Terms, created security or legal risk, abused the platform, or if suspension is required
                to protect Sakura, users, or third-party providers.
            </p>

            <h4>11. No Warranty</h4>
            <p>
                Sakura is provided on an &quot;as is&quot; and &quot;as available&quot; basis. To the maximum extent
                permitted by law, Sakura disclaims all warranties, express or implied, including warranties
                of availability, merchantability, fitness for a particular purpose, non-infringement,
                accuracy, and uninterrupted operation.
            </p>

            <h4>12. Limitation of Liability</h4>
            <p>
                To the maximum extent permitted by law, Sakura and its operators will not be liable for any
                indirect, incidental, consequential, special, or punitive damages, or for loss of profits,
                data, digital assets, goodwill, or business opportunities arising from or related to your use
                of the Service.
            </p>

            <h4>13. Changes to These Terms</h4>
            <p>
                We may update these Terms from time to time. If we do, we will update the
                &quot;Last updated&quot; date above. Continued use of Sakura after changes become effective
                means you accept the updated Terms.
            </p>

            <h4>14. Contact</h4>
            <p>
                If you have questions about these Terms, contact us at{" "}
                <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
            </p>
        </div>
    );
}

function PrivacyContent() {
    return (
        <div className="tg-legal-text">
            <p><strong>Last updated:</strong> March 26, 2026</p>
            <p>
                Sakura (&quot;Sakura&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) provides a wallet-connected reading and creator
                platform for manga, anime, novels, creator support, premium access, and optional Solana-based
                features such as token swaps, fiat on-ramp services, and perpetuals trading. This Privacy Policy
                explains what information we collect, how we use it, when we share it, and the choices you have.
            </p>

            <h4>1. Information We Collect</h4>
            <p>Depending on how you use Sakura, we may collect and process:</p>
            <ul>
                <li>Your Solana wallet address</li>
                <li>Profile details such as display name and bio</li>
                <li>Optional email address saved in settings</li>
                <li>Comments, reactions, creator submissions, novel content, and other user-submitted text</li>
                <li>Favorites, reading history, chapter progress, anime history, searches, bookmarks, notes, and downloads metadata</li>
                <li>Settings and preferences, including reading mode, TTS settings, and notification preferences</li>
                <li>Tips, highlighted comment records, premium/pass purchase status, and other wallet-linked app activity</li>
                <li>Trade, balance, deposit, withdrawal, and authentication records if you use Sakura perps features</li>
            </ul>

            <h4>2. Blockchain Information</h4>
            <p>
                Sakura uses Solana-based features. Public blockchain data such as wallet addresses,
                transaction signatures, token transfers, and payment verification records may be processed
                by the app or backend in order to unlock features, verify payments, or operate trading and
                creator support flows. Blockchain data is generally public and may remain visible permanently on-chain.
            </p>

            <h4>3. Local Device Storage</h4>
            <p>Sakura stores certain information on your device to provide app functionality, including:</p>
            <ul>
                <li>Cached content and downloaded chapter data</li>
                <li>Local reading settings and app preferences</li>
                <li>Local premium/pass receipt information</li>
                <li>Embedded wallet information stored locally on device</li>
            </ul>
            <p>
                On supported devices, Sakura may use biometric-secured device storage for the embedded wallet.
                On unsupported devices, Sakura may fall back to device-local storage mechanisms.
            </p>

            <h4>4. Cloud Sync</h4>
            <p>
                If you connect a wallet and use Sakura cloud sync, Sakura may back up and restore your
                library, settings, history, progress, searches, bookmarks, and related account-linked data
                using our database infrastructure.
            </p>

            <h4>5. How We Use Information</h4>
            <p>We use information to:</p>
            <ul>
                <li>Provide and maintain Sakura features</li>
                <li>Sync your library, settings, and progress across devices</li>
                <li>Enable comments, profiles, creator tools, and community features</li>
                <li>Verify on-chain payments and wallet-based entitlements</li>
                <li>Operate premium access, tipping, token, swap, on-ramp, and perps features</li>
                <li>Prevent abuse, fraud, spam, and misuse</li>
                <li>Debug, improve, and secure the service</li>
                <li>Comply with law and enforce our terms</li>
            </ul>

            <h4>6. Third-Party Services</h4>
            <p>Depending on which Sakura features you use, Sakura may interact with third-party services such as:</p>
            <ul>
                <li>Supabase</li>
                <li>Solana network infrastructure and RPC providers</li>
                <li>Third-party content and metadata providers</li>
                <li>Google Books or similar metadata services</li>
                <li>Transak, Jupiter, Phoenix Perps</li>
            </ul>
            <p>Your use of those services may also be governed by their own privacy policies and terms.</p>

            <h4>7. Comments, Profiles, and Creator Content</h4>
            <p>
                If you post comments, create a profile, submit creator information, or publish novels or other
                content through Sakura, that information may be visible to other users and associated with
                your wallet address.
            </p>

            <h4>8. Sharing of Information</h4>
            <p>We may share information:</p>
            <ul>
                <li>With infrastructure and service providers that help operate Sakura</li>
                <li>With blockchain networks and integrated protocols when you use on-chain features</li>
                <li>When required by law, legal process, or regulatory request</li>
                <li>To protect Sakura, our users, or others from fraud, abuse, or security issues</li>
                <li>In connection with a merger, acquisition, financing, or sale of assets</li>
            </ul>

            <h4>9. Data Retention</h4>
            <p>
                We retain information for as long as reasonably necessary to operate the service, maintain
                synced experiences, enforce our agreements, resolve disputes, meet legal obligations, and
                secure the platform.
            </p>

            <h4>10. Your Choices</h4>
            <p>You may choose to:</p>
            <ul>
                <li>Disconnect your wallet</li>
                <li>Avoid providing optional information such as email, display name, or bio</li>
                <li>Clear local app data from your device</li>
                <li>Remove locally stored wallet information from your device</li>
                <li>Avoid optional cloud sync, token, or trading features</li>
            </ul>

            <h4>11. Children&apos;s Privacy</h4>
            <p>
                Sakura is not intended for children under 13. Certain blockchain, payment, and trading
                features are intended only for users who are legally permitted to use them in their jurisdiction.
            </p>

            <h4>12. Changes to This Policy</h4>
            <p>
                We may update this Privacy Policy from time to time. If we do, we will update the
                &quot;Last updated&quot; date above. Continued use of Sakura after changes become effective
                means you accept the updated policy.
            </p>

            <h4>13. Contact</h4>
            <p>
                If you have questions about this Privacy Policy, contact us at{" "}
                <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
            </p>
        </div>
    );
}
