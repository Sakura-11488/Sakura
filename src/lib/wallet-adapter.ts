import {
    BaseMessageSignerWalletAdapter,
    WalletName,
    WalletReadyState,
    WalletNotReadyError,
    WalletSignTransactionError
} from '@solana/wallet-adapter-base';
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getWalletAccountWithBiometrics, getStoredPublicKey } from './wallet';
import bs58 from 'bs58';

export const SakuraWalletName = 'Sakura Wallet' as WalletName<'Sakura Wallet'>;

export class SakuraNativeWalletAdapter extends BaseMessageSignerWalletAdapter {
    name = SakuraWalletName;
    url = 'https://sakura.milla.so';
    icon = '/icon.png';
    supportedTransactionVersions: ReadonlySet<any> = new Set(['legacy', 0]);

    private _connecting: boolean = false;
    private _publicKey: PublicKey | null = null;
    private _readyState: WalletReadyState = WalletReadyState.Installed;

    get publicKey() {
        return this._publicKey;
    }

    get connecting() {
        return this._connecting;
    }

    get readyState() {
        return this._readyState;
    }

    async connect(): Promise<void> {
        try {
            if (this.connected) return;
            // Prior connect may have aborted without clearing the lock (Electron / React races).
            if (this._connecting) {
                this._connecting = false;
            }
            if (this._readyState !== WalletReadyState.Installed) throw new WalletNotReadyError();

            this._connecting = true;

            // Instead of prompting biometrics just to connect (which gets annoying fast),
            // we read the public key from the plain preferences. We ONLY prompt 
            // biometrics when a signature is actually requested.
            const pubkeyStr = await getStoredPublicKey();

            if (pubkeyStr) {
                this._publicKey = new PublicKey(pubkeyStr);
                this.emit('connect', this._publicKey);
            } else {
                // If there's no stored public key, we can't connect.
                throw new Error("No wallet found. Please create or import one.");
            }
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        } finally {
            this._connecting = false;
        }
    }

    /**
     * After create/import we already know the pubkey; avoids a second Preferences round-trip
     * and fixes Solana adapter "return early" if _connecting was stuck.
     */
    applyPersistedPublicKey(base58PublicKey: string): void {
        this._connecting = false;
        const pk = new PublicKey(base58PublicKey);
        this._publicKey = pk;
        this.emit('connect', pk);
    }

    async disconnect(): Promise<void> {
        this._publicKey = null;
        this._connecting = false;
        this.emit('disconnect');
    }

    async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
        try {
            // Prompt for Face ID/Fingerprint
            const wallet = await getWalletAccountWithBiometrics();
            if (!wallet) throw new WalletSignTransactionError("Authentication failed or cancelled");

            if ('version' in transaction) {
                transaction.sign([wallet]);
            } else {
                (transaction as Transaction).partialSign(wallet);
            }
            return transaction;
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
        const wallet = await getWalletAccountWithBiometrics();
        if (!wallet) throw new WalletSignTransactionError("Authentication failed or cancelled");

        for (const transaction of transactions) {
            if ('version' in transaction) {
                transaction.sign([wallet]);
            } else {
                (transaction as Transaction).partialSign(wallet);
            }
        }
        return transactions;
    }

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
        try {
            const wallet = await getWalletAccountWithBiometrics();
            if (!wallet) throw new WalletSignTransactionError("Authentication failed or cancelled");

            // @noble/curves or tweetnacl is ideal here, but web3.js exposes some ed25519 curves internally in v1
            // Let's use tweetnacl dynamically if needed, but for now we throw if not implemented, 
            // since Sakura mostly just signs transactions. Or we can just include tweetnacl.
            // Actually, we can just install tweetnacl
            const nacl = await import("tweetnacl");
            return nacl.default.sign.detached(message, wallet.secretKey);
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }
}
