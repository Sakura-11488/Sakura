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

## RLS

This migration does **not** enable Row Level Security. Configure RLS and policies in the Supabase dashboard for production (the app uses the anon key from the client for many operations).

## Internal notes

See `.sakura-internal` in the repo root for architecture truth and table ↔ code mapping.
