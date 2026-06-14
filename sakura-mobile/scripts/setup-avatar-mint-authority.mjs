/**
 * Generate a dedicated Solana keypair for avatar NFT minting.
 * Fund the public address with mainnet SOL (~0.02 SOL per mint for rent + fees).
 *
 * Usage: node scripts/setup-avatar-mint-authority.mjs
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', '.secrets');
const keypair = Keypair.generate();
const secretBase58 = bs58.encode(keypair.secretKey);

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'avatar-mint-authority.json');
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      publicKey: keypair.publicKey.toBase58(),
      secretKeyBase58: secretBase58,
      createdAt: new Date().toISOString(),
      note: 'Fund publicKey with mainnet SOL. Set AVATAR_MINT_AUTHORITY_SECRET in Supabase secrets.',
    },
    null,
    2,
  ),
);

console.log('Avatar mint authority created.');
console.log('Public key (fund with SOL):', keypair.publicKey.toBase58());
console.log('Saved to:', outPath);
console.log('');
console.log('Set Supabase secret:');
console.log(`  npx supabase secrets set AVATAR_MINT_AUTHORITY_SECRET="${secretBase58}"`);
console.log('  npx supabase secrets set AVATAR_PAYMENT_WALLET="G8tc69u9PVjAjaL4h8iD3t845dJrvnTKusrLrjv89EZ1"');
console.log('  npx supabase secrets set AVATAR_MINT_PRICE_SAKURA="100000"');
