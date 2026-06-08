import { Preferences } from "@capacitor/preferences";
import { Wallet } from "ethers";

/**
 * User-controlled EVM bridge wallet.
 *
 * Sakura's primary wallet is Solana-only. For EVM-origin bridges we create an
 * EVM wallet that lives on-device so the user can send funds there, then use
 * it as the EVM signer in a future native EVM bridge flow. This is NOT a
 * custodial server wallet: the private key stays in local Capacitor storage
 * and can be exported/backed up by the user.
 */

const EVM_WALLET_KEY = "sakura_evm_bridge_wallet_private_key_v1";
const EVM_WALLET_BACKED_UP_KEY = "sakura_evm_bridge_wallet_backed_up_v1";

export interface SakuraEvmBridgeWallet {
    address: string;
    backedUp: boolean;
}

export async function getEvmBridgeWallet(): Promise<SakuraEvmBridgeWallet | null> {
    const { value } = await Preferences.get({ key: EVM_WALLET_KEY });
    if (!value) return null;
    const wallet = new Wallet(value);
    const { value: backedUp } = await Preferences.get({ key: EVM_WALLET_BACKED_UP_KEY });
    return { address: wallet.address, backedUp: backedUp === "1" };
}

export async function createEvmBridgeWallet(): Promise<SakuraEvmBridgeWallet & { privateKey: string }> {
    const wallet = Wallet.createRandom();
    await Preferences.set({ key: EVM_WALLET_KEY, value: wallet.privateKey });
    await Preferences.remove({ key: EVM_WALLET_BACKED_UP_KEY });
    return { address: wallet.address, privateKey: wallet.privateKey, backedUp: false };
}

export async function revealEvmBridgePrivateKey(): Promise<string | null> {
    const { value } = await Preferences.get({ key: EVM_WALLET_KEY });
    return value || null;
}

export async function markEvmBridgeWalletBackedUp(): Promise<void> {
    await Preferences.set({ key: EVM_WALLET_BACKED_UP_KEY, value: "1" });
}

export async function removeEvmBridgeWallet(): Promise<void> {
    await Preferences.remove({ key: EVM_WALLET_KEY });
    await Preferences.remove({ key: EVM_WALLET_BACKED_UP_KEY });
}
