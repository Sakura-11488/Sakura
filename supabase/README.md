# Supabase (Sakura)

## Migrations

SQL migrations live in:

`supabase/migrations/`

Initial schema:

- `20250408120000_sakura_schema.sql` — tables used by the Next.js app (`src/lib/supabase.ts`, `creator.ts`, `comments.ts`, `cloud-sync.ts`, `novel.ts`, highlight API).

## Apply

**Dashboard:** paste the migration file into the SQL editor and run.

**CLI:** [Supabase CLI](https://supabase.com/docs/guides/cli) — link the project, then:

```bash
supabase db push
```

## Edge Functions

`supabase/functions/sakura-ai-chat/` is the server-side proxy for Sakura AI chat.
It keeps the model provider key out of the client bundle, applies a small
per-wallet/IP rate limit, trims long chat payloads, and stops retrying across
fallback models when the provider returns `429`.

Deploy:

```bash
supabase functions deploy sakura-ai-chat
```

Required secret:

```bash
supabase secrets set GROQ_API_KEY=your_upgraded_provider_key
```

Optional tuning:

```bash
supabase secrets set SAKURA_AI_RATE_LIMIT_PER_MINUTE=24
supabase secrets set SAKURA_AI_MAX_MESSAGES=26
supabase secrets set SAKURA_AI_MODEL=llama-3.1-8b-instant
supabase secrets set SAKURA_AI_FALLBACK_MODELS=llama-3.3-70b-versatile,openai/gpt-oss-20b
```

The app calls this function through `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. `NEXT_PUBLIC_SAKURA_AI_PROXY_URL` can override
the function URL when needed.

## RLS

This migration does **not** enable Row Level Security. Configure RLS and policies in the Supabase dashboard for production (the app uses the anon key from the client for many operations).

## Internal notes

See `.sakura-internal` in the repo root for architecture truth and table ↔ code mapping.
