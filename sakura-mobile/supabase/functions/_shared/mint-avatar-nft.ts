import { Keypair } from 'https://esm.sh/@solana/web3.js@1.98.4';
import {
  createNft,
  mplTokenMetadata,
} from 'https://esm.sh/@metaplex-foundation/mpl-token-metadata@3.2.1';
import {
  generateSigner,
  keypairIdentity,
  percentAmount,
  publicKey as umiPublicKey,
} from 'https://esm.sh/@metaplex-foundation/umi@1.5.1';
import { createUmi } from 'https://esm.sh/@metaplex-foundation/umi-bundle-defaults@1.5.1';
import { fromWeb3JsKeypair } from 'https://esm.sh/@metaplex-foundation/umi-web3js-adapters@1.5.1';
import bs58 from 'https://esm.sh/bs58@6.0.0';
import { getSolanaRpcUrl } from './solana-rpc.ts';

function loadMintAuthority(): Keypair {
  const raw = Deno.env.get('AVATAR_MINT_AUTHORITY_SECRET')?.trim();
  if (!raw) throw new Error('Avatar NFT minting is not configured on the server.');
  try {
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    const parsed = JSON.parse(raw) as number[];
    if (!Array.isArray(parsed) || parsed.length < 64) {
      throw new Error('AVATAR_MINT_AUTHORITY_SECRET is invalid.');
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
}

export async function mintAvatarNft(input: {
  recipientWallet: string;
  metadataUri: string;
  name: string;
  symbol?: string;
}): Promise<{ mintAddress: string; signature: string }> {
  const payer = loadMintAuthority();
  const umi = createUmi(getSolanaRpcUrl()).use(mplTokenMetadata());
  umi.use(keypairIdentity(fromWeb3JsKeypair(payer)));

  const mint = generateSigner(umi);
  const collectionMint = Deno.env.get('AVATAR_COLLECTION_MINT')?.trim();

  const builder = createNft(umi, {
    mint,
    name: input.name.slice(0, 32),
    symbol: (input.symbol ?? 'SKRAV').slice(0, 10),
    uri: input.metadataUri,
    sellerFeeBasisPoints: percentAmount(0),
    tokenOwner: umiPublicKey(input.recipientWallet),
    ...(collectionMint
      ? {
          collection: {
            key: umiPublicKey(collectionMint),
            verified: false,
          },
        }
      : {}),
  });

  const { signature } = await builder.sendAndConfirm(umi, {
    confirm: { commitment: 'confirmed' },
  });

  return {
    mintAddress: mint.publicKey.toString(),
    signature: bs58.encode(signature),
  };
}

export function getMintAuthorityPublicKey(): string | null {
  try {
    return loadMintAuthority().publicKey.toBase58();
  } catch {
    return null;
  }
}
