import { Keypair } from "@solana/web3.js";
import { NativeBiometric } from "capacitor-native-biometric";
import { Preferences } from "@capacitor/preferences";
import bs58 from "bs58";

const WALLET_STORAGE_KEY = "sakura_embedded_wallet_secret";
const WALLET_BACKED_UP_KEY = "sakura_embedded_wallet_backed_up_v1";

export function generateWallet(): Keypair {
    return Keypair.generate();
}

export async function storeWalletSecurely(keypair: Keypair): Promise<void> {
    const secretKeyBase58 = bs58.encode(keypair.secretKey);

    // Setup biometric credentials
    try {
        const isAvailable = await NativeBiometric.isAvailable();
        if (isAvailable.isAvailable) {
            await NativeBiometric.setCredentials({
                username: "SakuraWallet",
                password: secretKeyBase58,
                server: "com.millw14.sakura"
            });
            // We also save public key to preferences just to know we are "logged in" 
            // without prompting biometrics
            await Preferences.set({
                key: WALLET_STORAGE_KEY + "_pubkey",
                value: keypair.publicKey.toBase58()
            });
            return;
        }
    } catch (e) {
        console.warn("Biometrics not available for saving credentials, falling back to preferences", e);
    }

    // Fallback: If no biometrics, we have to store it in Preferences
    await Preferences.set({
        key: WALLET_STORAGE_KEY,
        value: secretKeyBase58
    });
    await Preferences.set({
        key: WALLET_STORAGE_KEY + "_pubkey",
        value: keypair.publicKey.toBase58()
    });
}

/**
 * Gets the securely stored Keypair.
 * This WILL prompt the user for Biometrics (Face ID/Fingerprint/PIN) if available!
 */
export async function getWalletAccountWithBiometrics(): Promise<Keypair | null> {
    // Try biometrics first
    try {
        const isAvailable = await NativeBiometric.isAvailable();
        if (isAvailable.isAvailable) {
            const credentials = await NativeBiometric.getCredentials({
                server: "com.millw14.sakura"
            });
            if (credentials && credentials.password) {
                const secretKey = bs58.decode(credentials.password);
                return Keypair.fromSecretKey(secretKey);
            }
        }
    } catch (e) {
        console.warn("Failed to get biometric credentials or user cancelled", e);
        // If biometrics throws, it means user likely cancelled or failed. Do not fallback to plain text if it exists but failed auth.
        // We only fallback if NativeBiometric is functionally unsupported on device.
        if (e && typeof e === 'object' && 'message' in e && String(e.message).includes('cancel')) {
            throw new Error("User cancelled biometric authentication");
        }
    }

    // Fallback to Preferences (only if biometrics genuinely wasn't used/available to save it)
    const { value } = await Preferences.get({ key: WALLET_STORAGE_KEY });
    if (value) {
        const secretKey = bs58.decode(value);
        return Keypair.fromSecretKey(secretKey);
    }

    return null;
}

/**
 * Checks if a wallet is stored without triggering biometric auth.
 * Returns the public key if found, otherwise null.
 */
export async function getStoredPublicKey(): Promise<string | null> {
    const { value } = await Preferences.get({ key: WALLET_STORAGE_KEY + "_pubkey" });
    return value;
}

export async function removeWalletSecurely(): Promise<void> {
    try {
        await NativeBiometric.deleteCredentials({
            server: "com.millw14.sakura"
        });
    } catch (e) {
        // Ignore
    }

    await Preferences.remove({ key: WALLET_STORAGE_KEY });
    await Preferences.remove({ key: WALLET_STORAGE_KEY + "_pubkey" });
    await Preferences.remove({ key: WALLET_BACKED_UP_KEY });
}

export async function checkBiometricAvailability(): Promise<boolean> {
    try {
        const result = await NativeBiometric.isAvailable();
        return result.isAvailable;
    } catch (error) {
        return false;
    }
}

/**
 * Returns the connected wallet's secret key as Base58 — the same format
 * `Keypair.fromSecretKey` accepts back through the import flow. The
 * caller should ALWAYS call `markWalletBackedUp` once the user confirms
 * they've recorded the value somewhere safe.
 *
 * Triggers biometric/PIN auth on devices that have it (Android Keystore
 * gating). On emulators / devices without biometrics we fall back to the
 * plain Capacitor Preferences entry — caller is responsible for showing
 * a "are you sure?" warning before invoking this path.
 */
export async function revealStoredSecretKey(): Promise<string | null> {
    try {
        const isAvailable = await NativeBiometric.isAvailable();
        if (isAvailable.isAvailable) {
            try {
                await NativeBiometric.verifyIdentity({
                    reason: "Confirm to reveal your Sakura wallet secret key",
                    title: "Reveal secret key",
                    subtitle: "Used only by you, never sent off-device",
                });
            } catch (e: any) {
                // User cancelled or auth failed.
                throw new Error(e?.message || "Biometric authentication failed.");
            }
            const credentials = await NativeBiometric.getCredentials({ server: "com.millw14.sakura" });
            if (credentials?.password) return credentials.password;
        }
    } catch (e) {
        console.warn("[wallet] biometric reveal failed, falling back to preferences", e);
    }

    const { value } = await Preferences.get({ key: WALLET_STORAGE_KEY });
    return value || null;
}

export async function isWalletBackedUp(): Promise<boolean> {
    const { value } = await Preferences.get({ key: WALLET_BACKED_UP_KEY });
    return value === "1";
}

export async function markWalletBackedUp(): Promise<void> {
    await Preferences.set({ key: WALLET_BACKED_UP_KEY, value: "1" });
}

export async function clearWalletBackedUp(): Promise<void> {
    await Preferences.remove({ key: WALLET_BACKED_UP_KEY });
}
