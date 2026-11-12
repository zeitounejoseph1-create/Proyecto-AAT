-- MesaLista: esquema inicial PostgreSQL para sustituir la persistencia local del MVP.
-- Ejecutar mediante una herramienta de migraciones (por ejemplo Prisma, Drizzle o node-pg-migrate).

-- Requerida por gen_random_uuid(), utilizada por la API de reservaciones.
create extension if not exists pgcrypto;

create type user_role as enum ('customer', 'restaurant_owner', 'platform_admin');
create type reservation_status as enum ('pending', 'confirmed', 'cancelled', 'attended', 'no_show');
create type subscription_status as enum ('trial', 'active', 'past_due', 'cancelled');

create table users (
  id uuid primary key,
  email text not null unique,
  display_name text not null,
  role user_role not null default 'customer',
  created_at timestamptz not null default now()
);

create table restaurants (
  id uuid primary key,
  owner_id uuid not null references users(id),
  name text not null,
  cuisine text not null,
  price_band text not null check (price_band in ('$', '$$', '$$$', '$$$$')),
  address text not null,
  city text not null,
  latitude numeric(9,6),
  longitude numeric(9,6),
  timezone text not null default 'America/Mexico_City',
  approved boolean not null default false,
  published boolean not null default false,
  price_per_person_cents integer check (price_per_person_cents >= 0),
  image_url text,
  reservation_minutes smallint not null default 120 check (reservation_minutes between 30 and 480),
  requires_card_guarantee boolean not null default false,
  no_show_fee_cents integer check (no_show_fee_cents >= 0),
  cancellation_policy text not null,
  created_at timestamptz not null default now()
);

create table restaurant_hours (
  id uuid primary key,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  closes_next_day boolean not null default false,
  is_closed boolean not null default false,
  constraint restaurant_hours_valid_interval check (is_closed or
    (opens_at < time '24:00' and ((closes_next_day and closes_at <= opens_at) or
      (not closes_next_day and opens_at < closes_at)))),
  unique (restaurant_id, weekday)
);

create table dining_tables (
  id uuid primary key,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  label text not null,
  capacity smallint not null check (capacity between 1 and 30),
  combinable_group text,
  active boolean not null default true,
  unique (restaurant_id, label),
  constraint dining_tables_id_restaurant_unique unique (id, restaurant_id)
);

create table availability_blocks (
  id uuid primary key,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  table_id uuid references dining_tables(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  constraint availability_blocks_table_restaurant_fk foreign key (table_id, restaurant_id)
    references dining_tables(id, restaurant_id) on delete cascade,
  check (starts_at < ends_at)
);

create table menu_items (
  id uuid primary key,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name text not null,
  description text,
  price_cents integer not null check (price_cents >= 0),
  available boolean not null default true,
  sort_order integer not null default 0
);

create table reservations (
  id uuid primary key,
  restaurant_id uuid not null references restaurants(id),
  customer_id uuid not null references users(id),
  table_id uuid not null references dining_tables(id),
  party_size smallint not null check (party_size between 1 and 30),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status reservation_status not null default 'pending',
  guest_access_token_hash text unique,
  idempotency_key text unique,
  -- Snapshot del contacto de esta solicitud; no cambia el perfil global del usuario.
  customer_name text,
  customer_email text,
  booking_timezone text,
  idempotency_request_hash text,
  payment_guarantee_provider text,
  payment_guarantee_reference text,
  created_at timestamptz not null default now(),
  check (starts_at < ends_at),
  constraint reservations_table_restaurant_fk foreign key (table_id, restaurant_id)
    references dining_tables(id, restaurant_id)
);

-- Impide que una misma mesa tenga dos reservas activas que se solapen.
create extension if not exists btree_gist;
alter table reservations add constraint no_overlapping_active_reservation
  exclude using gist (table_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status in ('pending', 'confirmed', 'attended'));
create index reservations_restaurant_time_idx on reservations (restaurant_id, starts_at);

create table subscriptions (
  id uuid primary key,
  restaurant_id uuid not null unique references restaurants(id),
  status subscription_status not null,
  weekly_price_cents integer not null check (weekly_price_cents >= 0),
  renews_at timestamptz,
  provider_customer_reference text,
  provider_subscription_reference text,
  created_at timestamptz not null default now()
);

create table payment_events (
  id uuid primary key,
  restaurant_id uuid references restaurants(id),
  reservation_id uuid references reservations(id),
  provider text not null,
  provider_event_reference text not null unique,
  amount_cents integer not null check (amount_cents >= 0),
  event_type text not null,
  created_at timestamptz not null default now()
);

create table reward_ledger (
  id uuid primary key,
  customer_id uuid not null references users(id),
  reservation_id uuid not null unique references reservations(id),
  points integer not null check (points > 0),
  created_at timestamptz not null default now()
);

create table reviews (
  id uuid primary key,
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  customer_id uuid references users(id),
  rating smallint not null check (rating between 1 and 5),
  body text not null check (char_length(body) between 3 and 280),
  created_at timestamptz not null default now()
);

-- La API pública solo debe acceder mediante las funciones RPC de reservation_core.sql.
-- service_role puede ejecutar esas funciones y bypassa RLS en Supabase.
alter table users enable row level security;
alter table restaurants enable row level security;
alter table restaurant_hours enable row level security;
alter table dining_tables enable row level security;
alter table availability_blocks enable row level security;
alter table menu_items enable row level security;
alter table reservations enable row level security;
alter table subscriptions enable row level security;
alter table payment_events enable row level security;
alter table reward_ledger enable row level security;
alter table reviews enable row level security;
