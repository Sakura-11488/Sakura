"use client";

import Header from "@/components/Header";
import Link from "next/link";

const lastUpdated = "March 26, 2026";
const supportEmail = "sakuramanga162@gmail.com";

export default function TermsPage() {
    return (
        <>
            <Header />
            <main className="main-content">
                <section className="section" style={{ paddingTop: 40, maxWidth: 860, margin: "0 auto", paddingBottom: 120 }}>
                    <div className="section-header" style={{ marginBottom: 24 }}>
                        <h2 className="section-title">Terms of Service</h2>
                        <p className="section-subtitle">Rules and responsibilities for using Sakura</p>
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
                            These Terms of Service (&quot;Terms&quot;) govern your access to and use of Sakura,
                            including the Sakura app, website, and related services (collectively, the &quot;Service&quot;).
                        </p>
                        <p>
                            By accessing or using Sakura, you agree to these Terms. If you do not agree,
                            do not use the Service.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>1. Eligibility</h3>
                        <p>
                            You must be legally capable of entering into a binding agreement to use Sakura. If you use
                            blockchain, token, payment, swap, or perpetuals features, you are responsible for making
                            sure those activities are lawful where you live.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>2. Description of the Service</h3>
                        <p>Sakura may include features such as:</p>
                        <ul style={{ paddingLeft: 20 }}>
                            <li>manga, anime, and novel browsing and reading</li>
                            <li>comments, reactions, profiles, and creator tools</li>
                            <li>premium/pass access tied to wallet activity or token features</li>
                            <li>creator tipping and token-paid highlights</li>
                            <li>fiat on-ramp, token swap, and perpetuals trading integrations</li>
                            <li>local storage and cloud sync for reading progress and preferences</li>
                        </ul>
                        <p>
                            Some features may be changed, limited, or removed at any time.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>3. Wallet Responsibility</h3>
                        <p>
                            Sakura may allow you to connect or create a Solana wallet. You are solely responsible for
                            your wallet, private key, seed phrase, backups, biometric/device security, and every
                            transaction you approve or sign.
                        </p>
                        <p>
                            Blockchain transactions are generally irreversible. Sakura is not responsible for recovering
                            lost assets, reversing mistaken transfers, or restoring access to compromised wallets.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>4. No Financial Advice</h3>
                        <p>
                            Sakura is not a broker, bank, exchange, investment adviser, or financial adviser.
                            Nothing in Sakura constitutes financial, investment, legal, or tax advice.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>5. Blockchain, Token, and Trading Risk</h3>
                        <p>
                            By using Sakura&apos;s blockchain-related features, you acknowledge and accept that:
                        </p>
                        <ul style={{ paddingLeft: 20 }}>
                            <li>digital assets are volatile and may lose value</li>
                            <li>swaps, purchases, and token transfers may fail, delay, or settle unexpectedly</li>
                            <li>perpetuals trading may involve leverage, liquidation, funding, slippage, oracle risk, and total loss</li>
                            <li>third-party infrastructure may become unavailable or change without notice</li>
                            <li>blockchain transactions are public and generally irreversible</li>
                        </ul>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>6. Third-Party Services</h3>
                        <p>
                            Sakura may rely on or integrate third-party services and protocols, including but not
                            limited to Supabase, Solana network infrastructure, third-party content providers, Transak, Jupiter, Phoenix,
                            and similar providers.
                        </p>
                        <p>
                            We do not control those services and are not responsible for their availability, content,
                            policies, security, or performance.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>7. User Content</h3>
                        <p>
                            You may submit comments, profile details, creator information, novel content, and other
                            material through Sakura. You keep ownership of content you lawfully own, but you grant
                            Sakura a non-exclusive, worldwide, royalty-free license to host, store, display, moderate,
                            and use that content as needed to operate and improve the Service.
                        </p>
                        <p>You agree not to submit content that is unlawful, abusive, infringing, fraudulent, or harmful.</p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>8. Prohibited Conduct</h3>
                        <p>You agree not to:</p>
                        <ul style={{ paddingLeft: 20 }}>
                            <li>violate any law or regulation</li>
                            <li>infringe intellectual property or privacy rights</li>
                            <li>harass, threaten, impersonate, or defraud others</li>
                            <li>upload malicious code or interfere with Sakura&apos;s systems</li>
                            <li>circumvent payment, entitlement, moderation, or access controls</li>
                            <li>use Sakura in a way that harms the service, users, or creators</li>
                        </ul>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>9. Premium Access, Tips, and Token Features</h3>
                        <p>
                            Sakura may offer premium/pass access, creator tipping, highlighted comments, swaps,
                            on-ramp services, and token-gated features. Token prices, fees, rules, and eligibility
                            requirements may change at any time.
                        </p>
                        <p>
                            Blockchain payments are generally irreversible, and Sakura does not guarantee uninterrupted
                            access to token-based or wallet-linked features.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>10. Suspension and Termination</h3>
                        <p>
                            We may suspend, restrict, or terminate access to Sakura if we believe you violated these
                            Terms, created security or legal risk, abused the platform, or if suspension is required
                            to protect Sakura, users, or third-party providers.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>11. No Warranty</h3>
                        <p>
                            Sakura is provided on an &quot;as is&quot; and &quot;as available&quot; basis. To the maximum extent
                            permitted by law, Sakura disclaims all warranties, express or implied, including warranties
                            of availability, merchantability, fitness for a particular purpose, non-infringement,
                            accuracy, and uninterrupted operation.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>12. Limitation of Liability</h3>
                        <p>
                            To the maximum extent permitted by law, Sakura and its operators will not be liable for any
                            indirect, incidental, consequential, special, or punitive damages, or for loss of profits,
                            data, digital assets, goodwill, or business opportunities arising from or related to your use
                            of the Service.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>13. Changes to These Terms</h3>
                        <p>
                            We may update these Terms from time to time. If we do, we will update the
                            &quot;Last updated&quot; date above. Continued use of Sakura after changes become effective
                            means you accept the updated Terms.
                        </p>

                        <h3 style={{ color: "var(--text-primary)", marginTop: 28 }}>14. Contact</h3>
                        <p>
                            If you have questions about these Terms, contact us at{" "}
                            <a href={`mailto:${supportEmail}`} style={{ color: "var(--sakura-pink)" }}>{supportEmail}</a>.
                        </p>
                    </div>

                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 20 }}>
                        <Link href="/privacy" className="btn-secondary" style={{ textDecoration: "none" }}>
                            View Privacy Policy
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
