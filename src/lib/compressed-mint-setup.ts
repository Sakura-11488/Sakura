import { createTree, mplBubblegum } from "@metaplex-foundation/mpl-bubblegum";
import {
    generateSigner,
    signerIdentity,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromWalletAdapter } from "@metaplex-foundation/umi-signer-wallet-adapters";
import type { Transaction, VersionedTransaction, PublicKey as Web3PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { RPC_ENDPOINT } from "@/lib/solana";

const DEFAULT_TREE_MAX_DEPTH = 14;
const DEFAULT_TREE_MAX_BUFFER_SIZE = 64;
const DEFAULT_TREE_CANOPY_DEPTH = 8;

type WalletTransaction = Transaction | VersionedTransaction;

export interface WalletAdapterMintSetup {
    publicKey: Web3PublicKey | null;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
    signTransaction?: <T extends WalletTransaction>(transaction: T) => Promise<T>;
    signAllTransactions?: <T extends WalletTransaction>(transactions: T[]) => Promise<T[]>;
}

export interface CreateCompressedMintSetupInput {
    walletAdapter: WalletAdapterMintSetup;
    maxDepth?: number;
    maxBufferSize?: number;
    canopyDepth?: number;
}

export interface CreatedCompressedMintSetup {
    treeAddress: string;
    signature: string;
    maxDepth: number;
    maxBufferSize: number;
    canopyDepth: number;
}

export async function createCompressedMintSetupOnChain(
    input: CreateCompressedMintSetupInput
): Promise<CreatedCompressedMintSetup> {
    if (!input.walletAdapter.publicKey || !input.walletAdapter.signTransaction) {
        throw new Error("Wallet transaction signing is unavailable.");
    }

    const umi = createUmi(RPC_ENDPOINT)
        .use(mplBubblegum());
    const walletSigner = createSignerFromWalletAdapter(input.walletAdapter);
    umi.use(signerIdentity(walletSigner));

    const maxDepth = input.maxDepth ?? DEFAULT_TREE_MAX_DEPTH;
    const maxBufferSize = input.maxBufferSize ?? DEFAULT_TREE_MAX_BUFFER_SIZE;
    const canopyDepth = input.canopyDepth ?? DEFAULT_TREE_CANOPY_DEPTH;
    const merkleTree = generateSigner(umi);

    const builder = await createTree(umi, {
        merkleTree,
        maxDepth,
        maxBufferSize,
        canopyDepth,
        public: false,
    });

    const { signature } = await builder.sendAndConfirm(umi);

    return {
        treeAddress: merkleTree.publicKey.toString(),
        signature: bs58.encode(signature),
        maxDepth,
        maxBufferSize,
        canopyDepth,
    };
}
