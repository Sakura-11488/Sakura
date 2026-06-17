use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("5GBAvcfjpj5XU9Y1wkubdvear2VHk6r55Bf1WjehVuV6");

#[program]
pub mod sakura_treasury {
    use super::*;

    /// Initialize the treasury PDA and its SAKURA token account.
    /// Called once by admin.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let treasury = &mut ctx.accounts.treasury;
        treasury.admin = ctx.accounts.admin.key();
        treasury.treasury_bump = ctx.bumps.treasury;
        treasury.total_deposited = 0;
        Ok(())
    }

    /// Anyone can deposit SAKURA into the treasury PDA token account.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount >= 100_000 * 10u64.pow(9), TreasuryError::AmountTooLow);

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.treasury_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount)?;

        let treasury = &mut ctx.accounts.treasury;
        treasury.total_deposited = treasury.total_deposited.saturating_add(amount);

        Ok(())
    }

    /// Admin-only: withdraw SAKURA from treasury to admin's token account.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let treasury = &ctx.accounts.treasury;
        require!(
            ctx.accounts.admin.key() == treasury.admin,
            TreasuryError::Unauthorized
        );

        let bump = &[ctx.accounts.treasury.treasury_bump];
        let seeds: &[&[u8]] = &[b"sakura-treasury", bump];
        let signer_seeds = &[seeds];

        let cpi_accounts = Transfer {
            from: ctx.accounts.treasury_token_account.to_account_info(),
            to: ctx.accounts.admin_token_account.to_account_info(),
            authority: ctx.accounts.treasury.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            amount,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 1 + 8,
        seeds = [b"sakura-treasury"],
        bump
    )]
    pub treasury: Account<'info, TreasuryState>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = treasury,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"sakura-treasury"],
        bump = treasury.treasury_bump,
    )]
    pub treasury: Account<'info, TreasuryState>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.owner == treasury.key(),
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"sakura-treasury"],
        bump = treasury.treasury_bump,
    )]
    pub treasury: Account<'info, TreasuryState>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct TreasuryState {
    pub admin: Pubkey,
    pub treasury_bump: u8,
    pub total_deposited: u64,
}

#[error_code]
pub enum TreasuryError {
    #[msg("Amount must be at least 100,000 SAKURA")]
    AmountTooLow,
    #[msg("Only admin can withdraw")]
    Unauthorized,
}
