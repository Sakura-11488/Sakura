import { Keypair } from "@solana/web3.js";
import { NativeBiometric } from "capacitor-native-biometric";
import { Preferences } from "@capacitor/preferences";
import bs58 from "bs58";
import { isNativeMobile } from "@/lib/platform";

const WALLET_STORAGE_KEY = "sakura_embedded_wallet_secret";

export function generateWallet(): Keypair {
    return Keypair.generate();
}

export async function storeWalletSecurely(keypair: Keypair): Promise<void> {
    const secretKeyBase58 = bs58.encode(keypair.secretKey);

    // Biometrics only on real iOS/Android shells. Electron/web can hang or no-op
    // inside the plugin bridge, which blocks "Create wallet" for a long time.
    if (isNativeMobile()) {
        try {
            const isAvailable = await NativeBiometric.isAvailable();
            if (isAvailable.isAvailable) {
                await NativeBiometric.setCredentials({
                    username: "SakuraWallet",
                    password: secretKeyBase58,
                    server: "com.millw14.sakura"
                });
                await Preferences.set({
                    key: WALLET_STORAGE_KEY + "_pubkey",
                    value: keypair.publicKey.toBase58()
                });
                return;
            }
        } catch (e) {
            console.warn("Biometrics not available for saving credentials, falling back to preferences", e);
        }
    }

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
    if (isNativeMobile()) {
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
            if (e && typeof e === 'object' && 'message' in e && String(e.message).includes('cancel')) {
                throw new Error("User cancelled biometric authentication");
            }
        }
    }

    // Preferences (desktop / web / no biometric store)
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
    if (isNativeMobile()) {
        try {
            await NativeBiometric.deleteCredentials({
                server: "com.millw14.sakura"
            });
        } catch {
            // Ignore
        }
    }

    await Preferences.remove({ key: WALLET_STORAGE_KEY });
    await Preferences.remove({ key: WALLET_STORAGE_KEY + "_pubkey" });
}

export async function checkBiometricAvailability(): Promise<boolean> {
    if (!isNativeMobile()) return false;
    try {
        const result = await NativeBiometric.isAvailable();
        return result.isAvailable;
    } catch (error) {
        return false;
    }
}
