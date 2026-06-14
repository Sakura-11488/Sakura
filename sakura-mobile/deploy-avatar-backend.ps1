# Deploy paid avatar NFT backend to Sakura Supabase
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "`n=== Sakura avatar NFT backend deploy ===" -ForegroundColor Cyan

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Host "Set SUPABASE_ACCESS_TOKEN or run: npx supabase login --token ..." -ForegroundColor Yellow
}

npx supabase link --project-ref aofzomovaozcwcozokll

Write-Host "Applying migrations..." -ForegroundColor Cyan
Get-Content "supabase\migrations\20260613120000_user_anime_avatars.sql" | npx supabase db query --linked
Get-Content "supabase\migrations\20260614120000_user_avatar_nft_payment.sql" | npx supabase db query --linked

Write-Host "Deploying generate-user-avatar..." -ForegroundColor Cyan
npx supabase functions deploy generate-user-avatar

Write-Host "`nRequired secrets:" -ForegroundColor Yellow
Write-Host "  FLUX_PROVIDER=fal"
Write-Host "  BFL_API_KEY=<fal key>"
Write-Host "  AVATAR_PAYMENT_WALLET=G8tc69u9PVjAjaL4h8iD3t845dJrvnTKusrLrjv89EZ1"
Write-Host "  AVATAR_MINT_PRICE_SAKURA=100000"
Write-Host "  AVATAR_MINT_AUTHORITY_SECRET=<from scripts/setup-avatar-mint-authority.mjs>"
Write-Host "  SOLANA_RPC_URL=<mainnet RPC with good limits>"
Write-Host "`nFund the mint authority public key with mainnet SOL before testing.`n" -ForegroundColor Green
