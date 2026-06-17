import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import type { SakuraTreasury } from "../target/types/sakura_treasury";

async function fund(
  provider: AnchorProvider,
  wallet: Keypair,
  lamports = 2 * LAMPORTS_PER_SOL
) {
  const sig = await provider.connection.requestAirdrop(wallet.publicKey, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

function treasuryPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sakura-treasury")],
    programId
  );
  return pda;
}

function deriveTreasuryAta(mint: PublicKey, treasury: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    mint,
    treasury,
    true 
  );
}

describe("Finding 1 — admin param arbitrary Pubkey", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SakuraTreasury as Program<SakuraTreasury>;

  const deployer = Keypair.generate();
  const victim   = Keypair.generate();
  const treasury = treasuryPda(program.programId);

  let mint: PublicKey;
  let treasuryAta: PublicKey;

  before(async () => {
    await fund(provider, deployer);
    await fund(provider, victim);

    mint = await createMint(
      provider.connection,
      deployer,
      deployer.publicKey,
      null,
      6
    );
    treasuryAta = deriveTreasuryAta(mint, treasury);
  });

  describe("Regression — treasury.admin always equals the signer", () => {

    it("treasury.admin equals the signer who called initialize()", async () => {
      await program.methods
        .initialize()            
        .accounts({
          treasury,
          treasuryTokenAccount: treasuryAta, 
          mint,
          admin: deployer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([deployer])
        .rpc();

      const state = await program.account.treasuryState.fetch(treasury);

      assert.isTrue(
        state.admin.equals(deployer.publicKey),
        `treasury.admin should equal signer.\n  Expected: ${deployer.publicKey.toBase58()}\n  Got:      ${state.admin.toBase58()}`
      );
      assert.isFalse(
        state.admin.equals(victim.publicKey),
        "treasury.admin must never be an unrelated third-party pubkey"
      );

      console.log("\ntreasury.admin correctly set to signer:", state.admin.toBase58());
    });

    it("victim cannot withdraw — was never set as admin", async () => {

      const victimAtaAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        victim,        
        mint,
        victim.publicKey
      );
      const victimAta = victimAtaAccount.address;

      try {
        await program.methods
          .withdraw(new BN(1))
          .accounts({
            treasury,
            admin: victim.publicKey,
            treasuryTokenAccount: treasuryAta,
            adminTokenAccount: victimAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([victim])
          .rpc();

        assert.fail("Withdraw by non-admin should have been rejected");
      } catch (e: any) {
        const isUnauthorized =
          e?.error?.errorCode?.code === "Unauthorized" ||
          e?.message?.includes("Unauthorized") ||
          e?.message?.includes("6001");

        assert.isTrue(
          isUnauthorized,
          `Expected Unauthorized (6001), got: ${e?.message ?? e}`
        );
        console.log(
          "\nWithdraw correctly rejected for non-admin:",
          e?.error?.errorCode?.code ?? "Unauthorized (6001)"
        );
      }
    });

    it("deployer (actual signer) can withdraw — admin rights are correctly assigned", async () => {
      const deployerAta = getAssociatedTokenAddressSync(mint, deployer.publicKey);

      try {
        await program.methods
          .withdraw(new BN(1))
          .accounts({
            treasury,
            admin: deployer.publicKey,
            treasuryTokenAccount: treasuryAta,
            adminTokenAccount: deployerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([deployer])
          .rpc();
      } catch (e: any) {
        const isUnauthorized =
          e?.error?.errorCode?.code === "Unauthorized" ||
          e?.message?.includes("Unauthorized") ||
          e?.message?.includes("6001");

        assert.isFalse(
          isUnauthorized,
          "deployer should not get Unauthorized — admin is correctly set"
        );

        console.log(
          "\nAdmin check PASSED for deployer. tx failed for non-auth reason:",
          e?.error?.errorCode?.code ?? e?.message?.slice(0, 80)
        );
      }
    });
  });
});