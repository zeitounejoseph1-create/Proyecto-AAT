-- Núcleo de reservas para PostgreSQL/Supabase. Aplicar después de schema.sql.
-- También refuerza las bases existentes creadas antes de activar RLS.
begin;

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

alter table restaurants add column if not exists approved boolean not null default false;
alter table restaurants add column if not exists published boolean not null default false;
alter table restaurants add column if not exists price_per_person_cents integer check (price_per_person_cents >= 0);
alter table restaurants add column if not exists image_url text;

alter table restaurant_hours drop constraint if exists restaurant_hours_check;
alter table restaurant_hours add column if not exists closes_next_day boolean not null default false;
alter table restaurant_hours add column if not exists is_closed boolean not null default false;
alter table restaurant_hours drop constraint if exists restaurant_hours_valid_interval;
alter table restaurant_hours add constraint restaurant_hours_valid_interval check (is_closed or
  (opens_at < time '24:00' and ((closes_next_day and closes_at <= opens_at) or
    (not closes_next_day and opens_at < closes_at))));

alter table reservations add column if not exists guest_access_token_hash text unique;
alter table reservations add column if not exists idempotency_key text unique;
alter table reservations add column if not exists customer_name text;
alter table reservations add column if not exists customer_email text;
alter table reservations add column if not exists booking_timezone text;
alter table reservations add column if not exists idempotency_request_hash text;

-- Las relaciones compuestas impiden asignar mesas de otro restaurante.
-- Si hay datos históricos inconsistentes, la migración falla y hace rollback.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='dining_tables'::regclass and conname='dining_tables_id_restaurant_unique') then
    alter table dining_tables add constraint dining_tables_id_restaurant_unique unique (id,restaurant_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='reservations'::regclass and conname='reservations_table_restaurant_fk') then
    alter table reservations add constraint reservations_table_restaurant_fk foreign key (table_id,restaurant_id) references dining_tables(id,restaurant_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='availability_blocks'::regclass and conname='availability_blocks_table_restaurant_fk') then
    alter table availability_blocks add constraint availability_blocks_table_restaurant_fk foreign key (table_id,restaurant_id) references dining_tables(id,restaurant_id) on delete cascade;
  end if;
  if exists (select 1 from pg_constraint where conrelid='reservations'::regclass and conname='no_overlapping_active_reservation' and position('attended' in pg_get_constraintdef(oid))=0) then
    alter table reservations drop constraint no_overlapping_active_reservation;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='reservations'::regclass and conname='no_overlapping_active_reservation') then
    alter table reservations add constraint no_overlapping_active_reservation
      exclude using gist (table_id with =,tstzrange(starts_at,ends_at,'[)') with &&) where (status in ('pending','confirmed','attended'));
  end if;
end;
$$;
create index if not exists reservations_restaurant_time_idx on reservations(restaurant_id,starts_at);
create index if not exists availability_blocks_restaurant_time_idx on availability_blocks(restaurant_id,starts_at);

create or replace function reservation_request_hash(uuid,date,time,integer,text,text)
returns text language sql immutable set search_path=pg_catalog,public,pg_temp as $$
  select encode(sha256(convert_to(jsonb_build_array($1,$2,$3,$4,btrim($5),lower(btrim($6)))::text,'UTF8')),'hex');
$$;

-- Se conserva el mejor snapshot disponible para las reservas anteriores.
update reservations b set customer_name=coalesce(b.customer_name,u.display_name),customer_email=coalesce(b.customer_email,lower(btrim(u.email)))
  from users u where u.id=b.customer_id and (b.customer_name is null or b.customer_email is null);
update reservations b set booking_timezone=r.timezone from restaurants r where r.id=b.restaurant_id and b.booking_timezone is null;
update reservations b set idempotency_request_hash=reservation_request_hash(b.restaurant_id,
    (b.starts_at at time zone b.booking_timezone)::date,(b.starts_at at time zone b.booking_timezone)::time,b.party_size,b.customer_name,b.customer_email)
  from restaurants r where r.id=b.restaurant_id and b.idempotency_key is not null and b.idempotency_request_hash is null;

create or replace function reservation_guest_payload(p_reservation_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object('id',b.id,'restaurant_id',b.restaurant_id,'table_id',b.table_id,'table_label',t.label,
    'party_size',b.party_size,'starts_at',b.starts_at,'ends_at',b.ends_at,'date',to_char(b.starts_at at time zone coalesce(b.booking_timezone,r.timezone),'YYYY-MM-DD'),
    'time',to_char(b.starts_at at time zone coalesce(b.booking_timezone,r.timezone),'HH24:MI'),'status',b.status,
    'restaurant_name',r.name,'address',r.address,'image_url',r.image_url,'timezone',coalesce(b.booking_timezone,r.timezone))
    from reservations b join restaurants r on r.id=b.restaurant_id join dining_tables t on t.id=b.table_id
   where b.id=p_reservation_id;
$$;

-- Todas las mutaciones de cupo toman el mismo lock del restaurante.
-- Los bloqueos no pueden solaparse con reservas activas ya confirmadas.
create or replace function lock_reservation_restaurant()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_old_id uuid; v_new_id uuid;
begin
  if tg_op <> 'INSERT' then v_old_id:=old.restaurant_id; end if;
  if tg_op <> 'DELETE' then v_new_id:=new.restaurant_id; end if;
  perform 1 from restaurants where id in (v_old_id,v_new_id) order by id for update;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function guard_reservation_allocation()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_old_id uuid;
begin
  if tg_op <> 'INSERT' then v_old_id:=old.restaurant_id; end if;
  perform 1 from restaurants where id in (v_old_id,new.restaurant_id) order by id for update;
  if new.booking_timezone is null then select timezone into new.booking_timezone from restaurants where id=new.restaurant_id; end if;
  if new.booking_timezone is not null and not exists (select 1 from pg_timezone_names where name=new.booking_timezone) then
    raise exception 'Invalid reservation timezone' using errcode='22023';
  end if;
  if new.status in ('pending','confirmed','attended') then
    if not exists (select 1 from dining_tables t where t.id=new.table_id and t.restaurant_id=new.restaurant_id and t.active and t.capacity>=new.party_size) then
      raise exception 'Table does not support this reservation' using errcode='23514';
    end if;
    if exists (select 1 from availability_blocks b where b.restaurant_id=new.restaurant_id and (b.table_id=new.table_id or b.table_id is null)
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(new.starts_at,new.ends_at,'[)')) then
      raise exception 'Requested time is blocked' using errcode='P0001';
    end if;
  end if;
  return new;
end;
$$;

create or replace function guard_availability_block()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_old_id uuid;
begin
  if tg_op <> 'INSERT' then v_old_id:=old.restaurant_id; end if;
  perform 1 from restaurants where id in (v_old_id,new.restaurant_id) order by id for update;
  if exists (select 1 from reservations b where b.restaurant_id=new.restaurant_id and (new.table_id is null or b.table_id=new.table_id)
    and b.status in ('pending','confirmed','attended') and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(new.starts_at,new.ends_at,'[)')) then
    raise exception 'Block overlaps an active reservation; cancel or move it first' using errcode='P0001';
  end if;
  return new;
end;
$$;

create or replace function validate_restaurant_timezone()
returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
  if not exists (select 1 from pg_timezone_names where name=new.timezone) then
    raise exception 'Invalid restaurant timezone' using errcode='22023';
  end if;
  return new;
end;
$$;

drop trigger if exists reservation_allocation_guard on reservations;
create trigger reservation_allocation_guard before insert or update on reservations for each row execute function guard_reservation_allocation();
drop trigger if exists reservation_delete_lock on reservations;
create trigger reservation_delete_lock before delete on reservations for each row execute function lock_reservation_restaurant();
drop trigger if exists availability_block_guard on availability_blocks;
create trigger availability_block_guard before insert or update on availability_blocks for each row execute function guard_availability_block();
drop trigger if exists availability_block_delete_lock on availability_blocks;
create trigger availability_block_delete_lock before delete on availability_blocks for each row execute function lock_reservation_restaurant();
drop trigger if exists dining_table_restaurant_lock on dining_tables;
create trigger dining_table_restaurant_lock before insert or update or delete on dining_tables for each row execute function lock_reservation_restaurant();
drop trigger if exists restaurant_hours_restaurant_lock on restaurant_hours;
create trigger restaurant_hours_restaurant_lock before insert or update or delete on restaurant_hours for each row execute function lock_reservation_restaurant();
drop trigger if exists subscription_restaurant_lock on subscriptions;
create trigger subscription_restaurant_lock before insert or update or delete on subscriptions for each row execute function lock_reservation_restaurant();
drop trigger if exists restaurant_timezone_guard on restaurants;
create trigger restaurant_timezone_guard before insert or update of timezone on restaurants for each row execute function validate_restaurant_timezone();

-- reviews aún no vincula una reserva asistida: rating permanece null hasta verificarla.
create or replace function list_bookable_restaurants()
returns table(id uuid,name text,cuisine text,price text,address text,latitude numeric,longitude numeric,rating numeric,image_url text,
  price_per_person integer,reservation_minutes integer,tables jsonb,weekly_hours jsonb,menu jsonb,cancellation_policy text,timezone text)
language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select r.id,r.name,r.cuisine,
    case when r.price_per_person_cents is not null then '$'||ceil(r.price_per_person_cents/100.0)::integer::text else r.price_band end,
    r.address,r.latitude,r.longitude,null::numeric,r.image_url,
    coalesce(round(r.price_per_person_cents/100.0)::integer,0),r.reservation_minutes,
    coalesce((select jsonb_agg(jsonb_build_array(t.label,t.capacity) order by t.capacity,t.label) from dining_tables t where t.restaurant_id=r.id and t.active),'[]'::jsonb),
    coalesce((select jsonb_object_agg((array['sun','mon','tue','wed','thu','fri','sat'])[h.weekday+1],jsonb_build_object('closed',h.is_closed,'open',h.opens_at,'close',h.closes_at,'closes_next_day',h.closes_next_day)) from restaurant_hours h where h.restaurant_id=r.id),'{}'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_array(m.name,m.price_cents/100.0) order by m.sort_order,m.name) from menu_items m where m.restaurant_id=r.id and m.available),'[]'::jsonb),
    r.cancellation_policy,r.timezone
   from restaurants r
  where r.approved and r.published and not r.requires_card_guarantee
    and exists (select 1 from subscriptions s where s.restaurant_id=r.id and s.status='active' and (s.renews_at is null or s.renews_at>statement_timestamp()))
  order by r.name;
$$;

-- Compara instantes reales para respetar cierres nocturnos y cambios DST.
create or replace function reservation_time_is_open(p_restaurant_id uuid,p_date date,p_time time,p_duration_minutes integer)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_zone text; v_start timestamptz; v_end timestamptz; v_day date; h restaurant_hours%rowtype;
begin
  if p_restaurant_id is null or p_date is null or not isfinite(p_date) or p_time is null or p_time>=time '24:00'
    or p_duration_minutes is null or p_duration_minutes not between 30 and 480 then return false; end if;
  select timezone into v_zone from restaurants where id=p_restaurant_id;
  if not found then return false; end if;
  v_start:=(p_date+p_time) at time zone v_zone;
  if (v_start at time zone v_zone) <> p_date+p_time then return false; end if;
  v_end:=v_start+make_interval(mins=>p_duration_minutes);
  for v_day in select p_date union all select p_date-1 loop
    select * into h from restaurant_hours where restaurant_id=p_restaurant_id and weekday=extract(dow from v_day)::smallint;
    if found and not h.is_closed and (v_day=p_date or h.closes_next_day) then
      if v_start >= ((v_day+h.opens_at) at time zone v_zone)
        and v_end <= ((v_day+h.closes_at+case when h.closes_next_day then interval '1 day' else interval '0 days' end) at time zone v_zone) then return true; end if;
    end if;
  end loop;
  return false;
end;
$$;

create or replace function available_reservation_slots(p_restaurant_id uuid,p_date date,p_party_size integer)
returns table(slot time,table_id uuid,table_label text)
language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare r restaurants%rowtype; v_candidate time; v_start timestamptz; v_end timestamptz; v_step integer;
begin
  if p_date is null or not isfinite(p_date) or p_party_size is null or p_party_size not between 1 and 30 then return; end if;
  select * into r from restaurants where id=p_restaurant_id and approved and published and not requires_card_guarantee
    and exists (select 1 from subscriptions s where s.restaurant_id=p_restaurant_id and s.status='active' and (s.renews_at is null or s.renews_at>statement_timestamp()));
  if not found or p_date < (statement_timestamp() at time zone r.timezone)::date or p_date > (statement_timestamp() at time zone r.timezone)::date+365 then return; end if;
  for v_step in 0..47 loop
    v_candidate:=time '00:00'+make_interval(mins=>v_step*30);
    v_start:=(p_date+v_candidate) at time zone r.timezone;
    v_end:=v_start+make_interval(mins=>r.reservation_minutes);
    if v_start>statement_timestamp() and reservation_time_is_open(p_restaurant_id,p_date,v_candidate,r.reservation_minutes) then
      return query select v_candidate,t.id,t.label from dining_tables t
        where t.restaurant_id=p_restaurant_id and t.active and t.capacity>=p_party_size
          and not exists (select 1 from reservations b where b.table_id=t.id and b.status in ('pending','confirmed','attended')
            and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_start,v_end,'[)'))
          and not exists (select 1 from availability_blocks b where b.restaurant_id=p_restaurant_id and (b.table_id=t.id or b.table_id is null)
            and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_start,v_end,'[)'))
        order by t.capacity,t.id limit 1;
    end if;
  end loop;
end;
$$;

create or replace function create_restaurant_reservation(p_restaurant_id uuid,p_date date,p_time time,p_party_size integer,
  p_customer_name text,p_customer_email text,p_access_token_hash text,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r restaurants%rowtype; v_customer_id uuid; v_table dining_tables%rowtype; b reservations%rowtype;
  v_start timestamptz; v_end timestamptz; v_request_hash text;
begin
  if p_restaurant_id is null or p_date is null or not isfinite(p_date) or p_time is null or p_time>=time '24:00'
    or extract(second from p_time)<>0 or mod(extract(minute from p_time)::integer,30)<>0
    or p_party_size is null or p_party_size not between 1 and 30 then
    raise exception 'Invalid date, time or party size; choose a half-hour slot' using errcode='22023';
  end if;
  if p_customer_name is null or length(btrim(p_customer_name)) not between 1 and 120 or p_customer_name ~ '[[:cntrl:]]'
    or p_customer_email is null or p_customer_email ~ '[[:cntrl:]]' or length(btrim(p_customer_email)) not between 5 and 254
    or btrim(p_customer_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Customer name and valid email are required' using errcode='22023';
  end if;
  if p_access_token_hash is null or p_access_token_hash !~ '^[0-9a-f]{64}$'
    or p_idempotency_key is null or p_idempotency_key !~ '^[a-zA-Z0-9_-]{16,100}$' then
    raise exception 'Invalid booking request token' using errcode='22023';
  end if;
  v_request_hash:=reservation_request_hash(p_restaurant_id,p_date,p_time,p_party_size,p_customer_name,p_customer_email);
  -- La clave se serializa globalmente, también si dos solicitudes nombran restaurantes distintos.
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key,0));
  select * into b from reservations where idempotency_key=p_idempotency_key;
  if found then
    if b.guest_access_token_hash is distinct from p_access_token_hash or b.idempotency_request_hash is distinct from v_request_hash then
      raise exception 'Idempotency key already used for another request' using errcode='23505';
    end if;
    return reservation_guest_payload(b.id);
  end if;
  select * into r from restaurants where id=p_restaurant_id for update;
  if not found or not r.approved or not r.published then raise exception 'Restaurant is not accepting reservations' using errcode='P0001'; end if;
  if r.requires_card_guarantee then raise exception 'Card guarantees are not enabled for online reservations yet' using errcode='P0001'; end if;
  if not exists (select 1 from subscriptions s where s.restaurant_id=p_restaurant_id and s.status='active' and (s.renews_at is null or s.renews_at>clock_timestamp())) then
    raise exception 'Restaurant subscription is not active' using errcode='P0001';
  end if;
  if p_date<(clock_timestamp() at time zone r.timezone)::date or p_date>(clock_timestamp() at time zone r.timezone)::date+365 then
    raise exception 'Choose a future date within the next 365 days' using errcode='22023';
  end if;
  v_start:=(p_date+p_time) at time zone r.timezone;
  if v_start<=clock_timestamp() then
    raise exception 'Choose a future date within the next 365 days' using errcode='22023';
  end if;
  if not reservation_time_is_open(p_restaurant_id,p_date,p_time,r.reservation_minutes) then
    raise exception 'Requested time is outside restaurant service hours' using errcode='P0001';
  end if;
  v_end:=v_start+make_interval(mins=>r.reservation_minutes);
  select t.* into v_table from dining_tables t where t.restaurant_id=p_restaurant_id and t.active and t.capacity>=p_party_size
    and not exists (select 1 from reservations other where other.table_id=t.id and other.status in ('pending','confirmed','attended')
      and tstzrange(other.starts_at,other.ends_at,'[)') && tstzrange(v_start,v_end,'[)'))
    and not exists (select 1 from availability_blocks block where block.restaurant_id=p_restaurant_id and (block.table_id=t.id or block.table_id is null)
      and tstzrange(block.starts_at,block.ends_at,'[)') && tstzrange(v_start,v_end,'[)'))
    order by t.capacity,t.id limit 1 for update;
  if not found then raise exception 'No compatible table is available at this time' using errcode='P0001'; end if;
  -- Una reserva anónima nunca sobrescribe nombre, rol ni otro dato de una cuenta existente.
  insert into users(id,email,display_name,role) values(gen_random_uuid(),lower(btrim(p_customer_email)),btrim(p_customer_name),'customer')
    on conflict(email) do nothing returning id into v_customer_id;
  if v_customer_id is null then select id into v_customer_id from users where email=lower(btrim(p_customer_email)); end if;
  -- Una espera por la mesa o por el contacto no prolonga la vigencia del horario.
  if v_start<=clock_timestamp() then raise exception 'Requested time has already started' using errcode='22023'; end if;
  if not exists (select 1 from subscriptions s where s.restaurant_id=p_restaurant_id and s.status='active' and (s.renews_at is null or s.renews_at>clock_timestamp())) then
    raise exception 'Restaurant subscription is not active' using errcode='P0001';
  end if;
  insert into reservations(id,restaurant_id,customer_id,table_id,party_size,starts_at,ends_at,status,guest_access_token_hash,idempotency_key,customer_name,customer_email,booking_timezone,idempotency_request_hash)
    values(gen_random_uuid(),p_restaurant_id,v_customer_id,v_table.id,p_party_size,v_start,v_end,'confirmed',p_access_token_hash,p_idempotency_key,
      btrim(p_customer_name),lower(btrim(p_customer_email)),r.timezone,v_request_hash) returning * into b;
  return reservation_guest_payload(b.id);
end;
$$;

create or replace function reservation_for_guest(p_access_token_hash text)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  select reservation_guest_payload(b.id) from reservations b where b.guest_access_token_hash=p_access_token_hash and p_access_token_hash ~ '^[0-9a-f]{64}$';
$$;

create or replace function cancel_restaurant_reservation(p_access_token_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare b reservations%rowtype;
begin
  if p_access_token_hash is null or p_access_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid reservation token' using errcode='22023'; end if;
  select * into b from reservations where guest_access_token_hash=p_access_token_hash;
  if not found then return null; end if;
  perform 1 from restaurants where id=b.restaurant_id for update;
  select * into b from reservations where guest_access_token_hash=p_access_token_hash for update;
  if not found then return null; end if;
  if b.status='cancelled' then return reservation_guest_payload(b.id); end if;
  if b.status not in ('pending','confirmed') or b.starts_at<=clock_timestamp() then
    raise exception 'Reservation can no longer be cancelled online' using errcode='P0001';
  end if;
  update reservations set status='cancelled' where id=b.id;
  return reservation_guest_payload(b.id);
end;
$$;

-- Sin políticas públicas: visitantes y cuentas autenticadas no acceden a tablas
-- ni funciones privilegiadas. Los RPC son invocados por la API del servidor.
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
revoke all on table users,restaurants,restaurant_hours,dining_tables,availability_blocks,menu_items,reservations,subscriptions,payment_events,reward_ledger,reviews from public,anon,authenticated;
revoke create on schema public from public,anon,authenticated;

revoke all on function reservation_request_hash(uuid,date,time,integer,text,text),reservation_guest_payload(uuid),lock_reservation_restaurant(),
  guard_reservation_allocation(),guard_availability_block(),validate_restaurant_timezone(),reservation_time_is_open(uuid,date,time,integer),
  list_bookable_restaurants(),available_reservation_slots(uuid,date,integer),create_restaurant_reservation(uuid,date,time,integer,text,text,text,text),
  reservation_for_guest(text),cancel_restaurant_reservation(text) from public,anon,authenticated;
grant execute on function list_bookable_restaurants(),available_reservation_slots(uuid,date,integer),
  create_restaurant_reservation(uuid,date,time,integer,text,text,text,text),reservation_for_guest(text),cancel_restaurant_reservation(text) to service_role;
commit;
