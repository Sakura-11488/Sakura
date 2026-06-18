# Apply iOS Expo sync migrations and deploy merged edge functions.
# Requires: npx supabase login (or SUPABASE_ACCESS_TOKEN) and linked project aofzomovaozcwcozokll

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "`n=== Sakura iOS sync backend deploy ===" -ForegroundColor Cyan

npx supabase link --project-ref aofzomovaozcwcozokll

$migrations = @(
  '20260617130000_chat_typing.sql',
  '20260617130100_sync_follower_count.sql',
  '20260617130200_follow_realtime.sql',
  '20260617130300_chat_media_message_types.sql',
  '20260617130400_chat_realtime_upstream.sql'
)

foreach ($m in $migrations) {
  Write-Host "Applying $m..." -ForegroundColor Yellow
  Get-Content "supabase\migrations\$m" | npx supabase db query --linked
}

$functions = @(
  'creator-chat',
  'follow-creator',
  'notify-sakura-transfer',
  'creator-work-mint-verify',
  'upload-profile-avatar'
)

foreach ($fn in $functions) {
  Write-Host "Deploying $fn..." -ForegroundColor Yellow
  npx supabase functions deploy $fn
}

Write-Host "`nDone. Set EXPO_PUBLIC_GIPHY_API_KEY in .env for GIF chat.`n" -ForegroundColor Green
