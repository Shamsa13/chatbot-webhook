-- Security hardening migration for Threats 22-34.
-- Run this in the Supabase SQL editor before deploying the updated server.

create extension if not exists pgcrypto;

alter table public.users
  add column if not exists phone_hash text,
  add column if not exists sms_locked_at timestamptz,
  add column if not exists auth_user_id uuid,
  add column if not exists auth_provider text,
  add column if not exists auth_email_verified_at timestamptz;

create unique index if not exists users_phone_hash_unique
  on public.users (phone_hash)
  where phone_hash is not null;

create unique index if not exists users_auth_user_id_unique
  on public.users (auth_user_id)
  where auth_user_id is not null;

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

create table if not exists public.webhook_deduplication (
  source text not null,
  event_id text not null,
  payload_hash text,
  status text not null default 'received',
  first_seen_at timestamptz not null default now(),
  processed_at timestamptz,
  details jsonb,
  primary key (source, event_id)
);

create index if not exists webhook_deduplication_seen_idx
  on public.webhook_deduplication (first_seen_at desc);

create table if not exists public.otp_audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  flow text,
  phone_hash text,
  user_id uuid references public.users(id) on delete set null,
  auth_user_id uuid,
  ip_address text,
  user_agent text,
  success boolean not null default false,
  failure_reason text,
  twilio_message_sid text
);

create index if not exists otp_audit_phone_created_idx
  on public.otp_audit_log (phone_hash, created_at desc);

create table if not exists public.login_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  flow text,
  user_id uuid references public.users(id) on delete set null,
  phone_hash text,
  auth_user_id uuid,
  auth_provider text,
  ip_address text,
  user_agent text,
  success boolean not null default false,
  failure_reason text
);

create index if not exists login_audit_user_created_idx
  on public.login_audit (user_id, created_at desc);

create index if not exists login_audit_phone_created_idx
  on public.login_audit (phone_hash, created_at desc);

create table if not exists public.document_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references public.users(id) on delete set null,
  document_id uuid,
  action text not null,
  document_name text,
  ip_address text,
  user_agent text,
  success boolean not null default false,
  chunks_before integer,
  chunks_after integer,
  failure_reason text,
  details jsonb
);

create index if not exists document_audit_user_created_idx
  on public.document_audit (user_id, created_at desc);

alter table public.messages
  add column if not exists message_classification text not null default 'standard';

alter table public.user_documents
  add column if not exists document_classification text not null default 'confidential';

alter table public.user_document_chunks
  add column if not exists chunk_classification text not null default 'confidential';

alter table public.session_tokens enable row level security;
alter table public.webhook_deduplication enable row level security;
alter table public.otp_audit_log enable row level security;
alter table public.login_audit enable row level security;
alter table public.document_audit enable row level security;

drop policy if exists "No client access to session tokens" on public.session_tokens;
create policy "No client access to session tokens"
  on public.session_tokens
  for all
  using (false)
  with check (false);

drop policy if exists "No client access to webhook dedupe" on public.webhook_deduplication;
create policy "No client access to webhook dedupe"
  on public.webhook_deduplication
  for all
  using (false)
  with check (false);

drop policy if exists "No client access to otp audit" on public.otp_audit_log;
create policy "No client access to otp audit"
  on public.otp_audit_log
  for all
  using (false)
  with check (false);

drop policy if exists "No client access to login audit" on public.login_audit;
create policy "No client access to login audit"
  on public.login_audit
  for all
  using (false)
  with check (false);

drop policy if exists "No client access to document audit" on public.document_audit;
create policy "No client access to document audit"
  on public.document_audit
  for all
  using (false)
  with check (false);

-- Optional backfill after deployment:
-- Existing plaintext phone rows will be encrypted and assigned phone_hash lazily
-- the next time each user logs in, texts, calls, or is opened by admin tooling.
