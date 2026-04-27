-- Security hardening migration for Threats 22-34.
-- Run this in the Supabase SQL editor before deploying the updated server.

create extension if not exists pgcrypto;

alter table public.users
  add column if not exists phone_hash text,
  add column if not exists sms_locked_at timestamptz;

create unique index if not exists users_phone_hash_unique
  on public.users (phone_hash)
  where phone_hash is not null;

create table if not exists public.session_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text,
  ip_address text,
  user_agent text
);

create index if not exists session_tokens_user_active_idx
  on public.session_tokens (user_id, expires_at)
  where revoked_at is null;

create index if not exists session_tokens_hash_idx
  on public.session_tokens (token_hash);

alter table public.messages
  add column if not exists message_classification text not null default 'standard';

alter table public.user_documents
  add column if not exists document_classification text not null default 'confidential';

alter table public.user_document_chunks
  add column if not exists chunk_classification text not null default 'confidential';

alter table public.session_tokens enable row level security;

drop policy if exists "No client access to session tokens" on public.session_tokens;
create policy "No client access to session tokens"
  on public.session_tokens
  for all
  using (false)
  with check (false);

-- Optional backfill after deployment:
-- Existing plaintext phone rows will be encrypted and assigned phone_hash lazily
-- the next time each user logs in, texts, calls, or is opened by admin tooling.
