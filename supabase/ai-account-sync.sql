-- PharmaTRACK account AI configuration and encrypted secret vault.
--
-- Run after security-rls.sql. The client uses only the public anon key and these
-- SECURITY DEFINER RPCs. No service-role key belongs in the client.
--
-- Important: encrypted_secret is application-layer AES-GCM ciphertext. Postgres
-- can authorize and version it but cannot decrypt provider credentials.

create extension if not exists pgcrypto;

create table if not exists public.pharmatrack_ai_configurations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  config_version bigint not null default 0,
  settings jsonb not null default '{}'::jsonb,
  vault_salt text not null,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by_device_id text not null,
  constraint pharmatrack_ai_settings_no_credentials check (
    settings::text !~* '"(apiKey|api_key|authorization|secret|access_token|refresh_token|headers)"\s*:'
  )
);

create table if not exists public.pharmatrack_ai_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  device_label text not null default 'PharmaTRACK device',
  device_token_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  last_active_at timestamptz not null default timezone('utc', now()),
  revoked_at timestamptz,
  primary key (user_id, device_id)
);

create table if not exists public.pharmatrack_ai_secrets (
  secret_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null,
  credential_type text not null,
  encrypted_secret jsonb not null,
  secret_version bigint not null default 1,
  local_version bigint not null default 0,
  key_status text not null default 'configured',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  last_used_at timestamptz,
  unique (user_id, provider_id, credential_type),
  constraint pharmatrack_ai_encrypted_secret_envelope check (
    jsonb_typeof(encrypted_secret) = 'object'
    and encrypted_secret->>'version' = '1'
    and encrypted_secret->>'algorithm' = 'AES-GCM-256'
    and length(coalesce(encrypted_secret->>'iv', '')) > 0
    and length(coalesce(encrypted_secret->>'ciphertext', '')) > 0
    and length(coalesce(encrypted_secret->>'aad', '')) > 0
  )
);

alter table public.pharmatrack_ai_configurations enable row level security;
alter table public.pharmatrack_ai_devices enable row level security;
alter table public.pharmatrack_ai_secrets enable row level security;

-- Direct table access is intentionally denied. The RPCs below check both the
-- authenticated account and a non-revoked, hashed device session token.
drop policy if exists "AI configuration direct access is denied" on public.pharmatrack_ai_configurations;
drop policy if exists "AI devices direct access is denied" on public.pharmatrack_ai_devices;
drop policy if exists "AI secrets direct access is denied" on public.pharmatrack_ai_secrets;

create or replace function public.pharmatrack_ai_device_is_active(
  p_device_id text,
  p_device_token text
) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.pharmatrack_ai_devices d
    where d.user_id = auth.uid()
      and d.device_id = p_device_id
      and d.revoked_at is null
      and d.device_token_hash = encode(digest(p_device_token, 'sha256'), 'hex')
  );
$$;

create or replace function public.pharmatrack_ai_register_device(
  p_device_id text,
  p_device_label text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  token text := encode(gen_random_bytes(32), 'hex');
  existing public.pharmatrack_ai_devices;
begin
  if uid is null or p_device_id is null or length(trim(p_device_id)) < 8 then
    raise exception 'Authenticated account and device identity are required';
  end if;
  select * into existing from public.pharmatrack_ai_devices
    where user_id = uid and device_id = p_device_id;
  if existing.revoked_at is not null then
    raise exception 'This device has been revoked. Sign in from an authorized device to re-add it.';
  end if;
  insert into public.pharmatrack_ai_devices(user_id, device_id, device_label, device_token_hash)
  values (uid, p_device_id, coalesce(nullif(trim(p_device_label), ''), 'PharmaTRACK device'), encode(digest(token, 'sha256'), 'hex'))
  on conflict (user_id, device_id) do update set
    device_label = excluded.device_label,
    device_token_hash = excluded.device_token_hash,
    last_active_at = timezone('utc', now());
  return jsonb_build_object('deviceToken', token, 'deviceId', p_device_id);
end;
$$;

create or replace function public.pharmatrack_ai_get_configuration(
  p_device_id text,
  p_device_token text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare row public.pharmatrack_ai_configurations;
begin
  if not public.pharmatrack_ai_device_is_active(p_device_id, p_device_token) then
    raise exception 'AI device session is revoked or invalid';
  end if;
  update public.pharmatrack_ai_devices set last_active_at = timezone('utc', now())
    where user_id = auth.uid() and device_id = p_device_id;
  select * into row from public.pharmatrack_ai_configurations where user_id = auth.uid();
  if row.user_id is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object(
    'found', true, 'configVersion', row.config_version, 'settings', row.settings,
    'vaultSalt', row.vault_salt, 'updatedAt', row.updated_at,
    'updatedByDeviceId', row.updated_by_device_id
  );
end;
$$;

create or replace function public.pharmatrack_ai_upsert_configuration(
  p_device_id text,
  p_device_token text,
  p_base_version bigint,
  p_settings jsonb,
  p_vault_salt text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  row public.pharmatrack_ai_configurations;
  next_version bigint;
begin
  if not public.pharmatrack_ai_device_is_active(p_device_id, p_device_token) then raise exception 'AI device session is revoked or invalid'; end if;
  if p_settings::text ~* '"(apiKey|api_key|authorization|secret|access_token|refresh_token|headers)"\s*:' then
    raise exception 'Sensitive credential fields are not accepted in account configuration';
  end if;
  select * into row from public.pharmatrack_ai_configurations where user_id = uid for update;
  if row.user_id is not null and p_base_version < row.config_version then
    return jsonb_build_object(
      'accepted', false, 'conflict', true, 'configVersion', row.config_version,
      'configuration', jsonb_build_object('found', true, 'configVersion', row.config_version,
        'settings', row.settings, 'vaultSalt', row.vault_salt, 'updatedAt', row.updated_at,
        'updatedByDeviceId', row.updated_by_device_id)
    );
  end if;
  if row.user_id is not null and row.vault_salt <> p_vault_salt then
    raise exception 'Account vault salt cannot be changed';
  end if;
  next_version := coalesce(row.config_version, 0) + 1;
  insert into public.pharmatrack_ai_configurations(user_id, config_version, settings, vault_salt, updated_by_device_id)
  values (uid, next_version, p_settings, coalesce(nullif(p_vault_salt, ''), encode(gen_random_bytes(16), 'base64')), p_device_id)
  on conflict (user_id) do update set config_version = excluded.config_version,
    settings = excluded.settings, updated_at = timezone('utc', now()), updated_by_device_id = excluded.updated_by_device_id;
  return jsonb_build_object('accepted', true, 'configVersion', next_version);
end;
$$;

create or replace function public.pharmatrack_ai_get_secret_metadata(
  p_device_id text, p_device_token text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not public.pharmatrack_ai_device_is_active(p_device_id, p_device_token) then raise exception 'AI device session is revoked or invalid'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'secretId', s.secret_id, 'providerId', s.provider_id, 'credentialType', s.credential_type,
    'secretVersion', s.secret_version, 'updatedAt', s.updated_at, 'keyStatus', s.key_status
  ) order by s.provider_id) from public.pharmatrack_ai_secrets s where s.user_id = auth.uid()), '[]'::jsonb);
end;
$$;

create or replace function public.pharmatrack_ai_get_secrets(
  p_device_id text, p_device_token text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not public.pharmatrack_ai_device_is_active(p_device_id, p_device_token) then raise exception 'AI device session is revoked or invalid'; end if;
  -- This returns ciphertext only. It is separate from configuration metadata,
  -- and the database/server still cannot turn it into an API key.
  return coalesce((select jsonb_agg(jsonb_build_object(
    'secretId', s.secret_id, 'providerId', s.provider_id, 'credentialType', s.credential_type,
    'encryptedSecret', s.encrypted_secret, 'secretVersion', s.secret_version,
    'updatedAt', s.updated_at, 'keyStatus', s.key_status
  ) order by s.provider_id) from public.pharmatrack_ai_secrets s where s.user_id = auth.uid()), '[]'::jsonb);
end;
$$;

create or replace function public.pharmatrack_ai_upsert_secret(
  p_device_id text, p_device_token text, p_provider_id text, p_credential_type text,
  p_base_version bigint, p_encrypted_secret jsonb, p_local_version bigint
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare uid uuid := auth.uid(); row public.pharmatrack_ai_secrets; next_version bigint;
begin
  if not public.pharmatrack_ai_device_is_active(p_device_id, p_device_token) then raise exception 'AI device session is revoked or invalid'; end if;
  if nullif(trim(p_provider_id), '') is null or p_credential_type <> 'api_provider_credentials' then
    raise exception 'A valid provider credential type is required';
  end if;
  if jsonb_typeof(p_encrypted_secret) <> 'object'
     or p_encrypted_secret->>'version' <> '1'
     or p_encrypted_secret->>'algorithm' <> 'AES-GCM-256'
     or nullif(p_encrypted_secret->>'iv', '') is null
     or nullif(p_encrypted_secret->>'ciphertext', '') is null
     or (p_encrypted_secret->>'aad' <> (uid::text || ':' || p_provider_id))
     or p_encrypted_secret ?| array['apiKey', 'api_key', 'authorization', 'secret', 'access_token', 'refresh_token'] then
    raise exception 'Only a validated encrypted secret envelope is accepted';
  end if;
  select * into row from public.pharmatrack_ai_secrets where user_id = uid and provider_id = p_provider_id and credential_type = p_credential_type for update;
  if row.secret_id is not null and p_base_version < row.secret_version then
    return jsonb_build_object('accepted', false, 'conflict', true, 'secretVersion', row.secret_version);
  end if;
  next_version := coalesce(row.secret_version, 0) + 1;
  insert into public.pharmatrack_ai_secrets(user_id, provider_id, credential_type, encrypted_secret, secret_version, local_version, key_status)
  values (uid, p_provider_id, p_credential_type, p_encrypted_secret, next_version, coalesce(p_local_version, 0), 'configured')
  on conflict (user_id, provider_id, credential_type) do update set encrypted_secret = excluded.encrypted_secret,
    secret_version = excluded.secret_version, local_version = excluded.local_version,
    key_status = 'configured', updated_at = timezone('utc', now());
  return jsonb_build_object('accepted', true, 'secretVersion', next_version);
end;
$$;

create or replace function public.pharmatrack_ai_delete_secret(
  p_device_id text, p_device_token text, p_provider_id text, p_credential_type text, p_base_version bigint
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare uid uuid := auth.uid(); row public.pharmatrack_ai_secrets;
begin
  if not public.pharmatrack_ai_device_is_active(p_device_id, p_device_token) then raise exception 'AI device session is revoked or invalid'; end if;
  select * into row from public.pharmatrack_ai_secrets where user_id = uid and provider_id = p_provider_id and credential_type = p_credential_type for update;
  if row.secret_id is null then return jsonb_build_object('accepted', true); end if;
  if p_base_version < row.secret_version then return jsonb_build_object('accepted', false, 'conflict', true, 'secretVersion', row.secret_version); end if;
  delete from public.pharmatrack_ai_secrets where secret_id = row.secret_id;
  return jsonb_build_object('accepted', true);
end;
$$;

create or replace function public.pharmatrack_ai_list_devices(
  p_device_id text, p_device_token text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not public.pharmatrack_ai_device_is_active(p_device_id, p_device_token) then raise exception 'AI device session is revoked or invalid'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'deviceId', d.device_id, 'label', d.device_label, 'createdAt', d.created_at,
    'lastActiveAt', d.last_active_at, 'revokedAt', d.revoked_at
  ) order by d.last_active_at desc) from public.pharmatrack_ai_devices d where d.user_id = auth.uid()), '[]'::jsonb);
end;
$$;

create or replace function public.pharmatrack_ai_revoke_device(
  p_device_id text, p_device_token text, p_target_device_id text
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.pharmatrack_ai_device_is_active(p_device_id, p_device_token) then raise exception 'AI device session is revoked or invalid'; end if;
  if p_target_device_id = p_device_id then raise exception 'Use sign out or account deletion for the current device'; end if;
  update public.pharmatrack_ai_devices set revoked_at = timezone('utc', now())
    where user_id = auth.uid() and device_id = p_target_device_id and revoked_at is null;
end;
$$;

create or replace function public.pharmatrack_ai_delete_account_data(
  p_device_id text, p_device_token text
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.pharmatrack_ai_device_is_active(p_device_id, p_device_token) then raise exception 'AI device session is revoked or invalid'; end if;
  delete from public.pharmatrack_ai_secrets where user_id = auth.uid();
  delete from public.pharmatrack_ai_configurations where user_id = auth.uid();
  delete from public.pharmatrack_ai_devices where user_id = auth.uid();
end;
$$;

revoke all on public.pharmatrack_ai_configurations from anon, authenticated;
revoke all on public.pharmatrack_ai_devices from anon, authenticated;
revoke all on public.pharmatrack_ai_secrets from anon, authenticated;
revoke all on function public.pharmatrack_ai_device_is_active(text, text) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_register_device(text, text) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_get_configuration(text, text) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_upsert_configuration(text, text, bigint, jsonb, text) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_get_secret_metadata(text, text) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_get_secrets(text, text) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_upsert_secret(text, text, text, text, bigint, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_delete_secret(text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_list_devices(text, text) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_revoke_device(text, text, text) from public, anon, authenticated;
revoke all on function public.pharmatrack_ai_delete_account_data(text, text) from public, anon, authenticated;
grant execute on function public.pharmatrack_ai_register_device(text, text) to authenticated;
grant execute on function public.pharmatrack_ai_get_configuration(text, text) to authenticated;
grant execute on function public.pharmatrack_ai_upsert_configuration(text, text, bigint, jsonb, text) to authenticated;
grant execute on function public.pharmatrack_ai_get_secret_metadata(text, text) to authenticated;
grant execute on function public.pharmatrack_ai_get_secrets(text, text) to authenticated;
grant execute on function public.pharmatrack_ai_upsert_secret(text, text, text, text, bigint, jsonb, bigint) to authenticated;
grant execute on function public.pharmatrack_ai_delete_secret(text, text, text, text, bigint) to authenticated;
grant execute on function public.pharmatrack_ai_list_devices(text, text) to authenticated;
grant execute on function public.pharmatrack_ai_revoke_device(text, text, text) to authenticated;
grant execute on function public.pharmatrack_ai_delete_account_data(text, text) to authenticated;
