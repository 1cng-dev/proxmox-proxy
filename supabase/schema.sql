-- Proxcy-API multi-tenant authorization schema.
-- Run this against the Supabase project referenced by SUPABASE_URL.
-- Ownership rows are written by the provisioning/billing workflow via the
-- service_role key — never by an end user — so RLS below is a backstop,
-- not the primary authorization control (that's authorizeVm middleware).

create table if not exists public.vm_ownership (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  customer_id text not null,
  vmid integer not null,
  node text not null,
  pmx_type text not null default 'qemu',
  status_cache text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (node, vmid)
);

create index if not exists idx_vm_ownership_user on public.vm_ownership(user_id);
create index if not exists idx_vm_ownership_vmid on public.vm_ownership(vmid, node);

alter table public.vm_ownership enable row level security;

create policy "Users can view own vm ownership"
  on public.vm_ownership for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy is defined for the authenticated role on
-- purpose: only the service_role key (used by Proxcy-API's provisioning
-- workflow and syncVmStatus job) may write to this table.

create table if not exists public.vm_action_audit (
  id bigserial primary key,
  user_id uuid not null,
  vmid integer not null,
  node text not null,
  action text not null,   -- start | stop | shutdown | reboot | delete | console
  result text not null,   -- success | error
  ip_address text,
  created_at timestamptz not null default now()
);

create index if not exists idx_vm_action_audit_vmid on public.vm_action_audit(vmid, node);
create index if not exists idx_vm_action_audit_user on public.vm_action_audit(user_id);
