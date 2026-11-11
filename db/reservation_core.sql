-- Reservation core migration for PostgreSQL/Supabase.
-- Apply to the database before enabling the Vercel function.

create extension if not exists pgcrypto;

alter table restaurants add column if not exists approved boolean not null default false;
alter table restaurants add column if not exists published boolean not null default false;
alter table restaurants add column if not exists price_per_person_cents integer check (price_per_person_cents >= 0);
alter table restaurants add column if not exists image_url text;

alter table restaurant_hours drop constraint if exists restaurant_hours_check;
alter table restaurant_hours add column if not exists closes_next_day boolean not null default false;
alter table restaurant_hours add column if not exists is_closed boolean not null default false;
alter table restaurant_hours drop constraint if exists restaurant_hours_valid_interval;
alter table restaurant_hours add constraint restaurant_hours_valid_interval
  check (is_closed or (opens_at <> closes_at and (closes_next_day or opens_at < closes_at)));

alter table reservations add column if not exists guest_access_token_hash text unique;
alter table reservations add column if not exists idempotency_key text unique;

create or replace function list_bookable_restaurants()
returns table(id uuid,name text,cuisine text,price text,address text,latitude numeric,longitude numeric,rating numeric,image_url text,
  price_per_person integer,reservation_minutes integer,tables jsonb,weekly_hours jsonb,menu jsonb,cancellation_policy text,timezone text)
language sql stable security definer set search_path=public as $$
  select r.id,r.name,r.cuisine,
    case when r.price_per_person_cents is not null then '$'||ceil(r.price_per_person_cents/100.0)::integer::text else r.price_band end,
    r.address,r.latitude,r.longitude,(select round(avg(rv.rating),1) from reviews rv where rv.restaurant_id=r.id),r.image_url,
    coalesce(round(r.price_per_person_cents/100.0)::integer,0),r.reservation_minutes,
    coalesce((select jsonb_agg(jsonb_build_array(t.label,t.capacity) order by t.capacity,t.label) from dining_tables t where t.restaurant_id=r.id and t.active),'[]'::jsonb),
    coalesce((select jsonb_object_agg((array['sun','mon','tue','wed','thu','fri','sat'])[h.weekday+1],jsonb_build_object('closed',h.is_closed,'open',h.opens_at,'close',h.closes_at,'closes_next_day',h.closes_next_day)) from restaurant_hours h where h.restaurant_id=r.id),'{}'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_array(m.name,m.price_cents/100.0) order by m.sort_order,m.name) from menu_items m where m.restaurant_id=r.id and m.available),'[]'::jsonb),
    r.cancellation_policy,r.timezone
   from restaurants r
  where r.approved and r.published and exists (select 1 from subscriptions s where s.restaurant_id=r.id and s.status='active' and (s.renews_at is null or s.renews_at>now()))
  order by r.name;
$$;

create or replace function reservation_time_is_open(
  p_restaurant_id uuid,
  p_date date,
  p_time time,
  p_duration_minutes integer
) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  local_start timestamp := p_date + p_time;
  local_end timestamp := p_date + p_time + make_interval(mins => p_duration_minutes);
  h restaurant_hours%rowtype;
begin
  select * into h from restaurant_hours
   where restaurant_id=p_restaurant_id and weekday=extract(dow from p_date)::smallint;
  if found and not h.is_closed then
    if local_start >= (p_date + h.opens_at)
       and local_end <= (p_date + h.closes_at +
         (case
            when h.closes_next_day then interval '1 day'
            else interval '0 days'
          end)) then
      return true;
    end if;
  end if;

  select * into h from restaurant_hours
   where restaurant_id=p_restaurant_id and weekday=extract(dow from (p_date-1))::smallint;
  if found and not h.is_closed and h.closes_next_day then
    if local_start >= (p_date-1)+h.opens_at
       and local_end <= p_date+h.closes_at then
      return true;
    end if;
  end if;
  return false;
end;
$$;

create or replace function available_reservation_slots(
  p_restaurant_id uuid,
  p_date date,
  p_party_size integer
) returns table(slot time, table_id uuid, table_label text)
language plpgsql stable security definer set search_path = public as $$
declare
  restaurant_row restaurants%rowtype;
  candidate time;
  free_table_id uuid;
  free_table_label text;
  step integer;
begin
  select r.* into restaurant_row from restaurants r
   where r.id=p_restaurant_id and r.approved and r.published
     and exists (select 1 from subscriptions s where s.restaurant_id=r.id and s.status='active' and (s.renews_at is null or s.renews_at>now()));
  if not found then return; end if;
  if p_party_size < 1 or p_party_size > 30 then return; end if;

  for step in 0..47 loop
    candidate := time '00:00' + make_interval(mins => step*30);
    if reservation_time_is_open(p_restaurant_id,p_date,candidate,restaurant_row.reservation_minutes) then
      select t.id,t.label into free_table_id,free_table_label
        from dining_tables t
       where t.restaurant_id=p_restaurant_id and t.active and t.capacity>=p_party_size
         and not exists (select 1 from reservations b where b.table_id=t.id and b.status in ('pending','confirmed')
           and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange((p_date+candidate) at time zone restaurant_row.timezone,
             ((p_date+candidate) at time zone restaurant_row.timezone)+make_interval(mins=>restaurant_row.reservation_minutes),'[)'))
         and not exists (select 1 from availability_blocks b where (b.table_id=t.id or b.table_id is null)
           and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange((p_date+candidate) at time zone restaurant_row.timezone,
             ((p_date+candidate) at time zone restaurant_row.timezone)+make_interval(mins=>restaurant_row.reservation_minutes),'[)'))
       order by t.capacity,t.id limit 1;
      if found then slot:=candidate;table_id:=free_table_id;table_label:=free_table_label;return next; end if;
    end if;
  end loop;
end;
$$;

create or replace function create_restaurant_reservation(
  p_restaurant_id uuid,
  p_date date,
  p_time time,
  p_party_size integer,
  p_customer_name text,
  p_customer_email text,
  p_access_token_hash text,
  p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  restaurant_row restaurants%rowtype;
  customer_id uuid;
  chosen_table dining_tables%rowtype;
  reservation_row reservations%rowtype;
  start_at timestamptz;
  end_at timestamptz;
  existing_access_hash text;
begin
  if p_party_size < 1 or p_party_size > 30 then raise exception 'Party size must be between 1 and 30' using errcode='22023'; end if;
  if length(trim(p_customer_name)) not between 1 and 120 or length(trim(p_customer_email)) not between 5 and 254 then
    raise exception 'Customer name and email are required' using errcode='22023';
  end if;
  if p_access_token_hash !~ '^[0-9a-f]{64}$' or length(p_idempotency_key) not between 16 and 100 then
    raise exception 'Invalid booking request token' using errcode='22023';
  end if;

  select * into reservation_row from reservations where idempotency_key=p_idempotency_key;
  if found then
    if reservation_row.guest_access_token_hash<>p_access_token_hash then raise exception 'Idempotency key already used' using errcode='23505'; end if;
    return jsonb_build_object('id',reservation_row.id,'restaurant_id',reservation_row.restaurant_id,'table_id',reservation_row.table_id,
      'party_size',reservation_row.party_size,'date',p_date,'time',p_time,'status',reservation_row.status,'starts_at',reservation_row.starts_at,'ends_at',reservation_row.ends_at);
  end if;

  -- Serializes booking attempts for one restaurant; the exclusion constraint is the final race guard.
  select r.* into restaurant_row from restaurants r where r.id=p_restaurant_id for update;
  if not found or not restaurant_row.approved or not restaurant_row.published then raise exception 'Restaurant is not accepting reservations' using errcode='P0001'; end if;
  select * into reservation_row from reservations where idempotency_key=p_idempotency_key;
  if found then
    if reservation_row.guest_access_token_hash<>p_access_token_hash then raise exception 'Idempotency key already used' using errcode='23505'; end if;
    return jsonb_build_object('id',reservation_row.id,'restaurant_id',reservation_row.restaurant_id,'table_id',reservation_row.table_id,
      'party_size',reservation_row.party_size,'date',p_date,'time',p_time,'status',reservation_row.status,'starts_at',reservation_row.starts_at,'ends_at',reservation_row.ends_at);
  end if;
  if not exists (select 1 from subscriptions s where s.restaurant_id=p_restaurant_id and s.status='active' and (s.renews_at is null or s.renews_at>now())) then
    raise exception 'Restaurant subscription is not active' using errcode='P0001';
  end if;
  if not reservation_time_is_open(p_restaurant_id,p_date,p_time,restaurant_row.reservation_minutes) then
    raise exception 'Requested time is outside restaurant service hours' using errcode='P0001';
  end if;

  start_at := (p_date+p_time) at time zone restaurant_row.timezone;
  end_at := start_at+make_interval(mins=>restaurant_row.reservation_minutes);
  insert into users(id,email,display_name,role) values(gen_random_uuid(),lower(trim(p_customer_email)),trim(p_customer_name),'customer')
    on conflict(email) do update set display_name=excluded.display_name returning id into customer_id;

  select t.* into chosen_table from dining_tables t
   where t.restaurant_id=p_restaurant_id and t.active and t.capacity>=p_party_size
     and not exists (select 1 from reservations b where b.table_id=t.id and b.status in ('pending','confirmed')
       and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(start_at,end_at,'[)'))
     and not exists (select 1 from availability_blocks b where (b.table_id=t.id or b.table_id is null)
       and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(start_at,end_at,'[)'))
   order by t.capacity,t.id limit 1 for update skip locked;
  if not found then raise exception 'No compatible table is available at this time' using errcode='P0001'; end if;

  insert into reservations(id,restaurant_id,customer_id,table_id,party_size,starts_at,ends_at,status,guest_access_token_hash,idempotency_key)
    values(gen_random_uuid(),p_restaurant_id,customer_id,chosen_table.id,p_party_size,start_at,end_at,'confirmed',p_access_token_hash,p_idempotency_key)
    returning * into reservation_row;
  return jsonb_build_object('id',reservation_row.id,'restaurant_id',reservation_row.restaurant_id,'table_id',reservation_row.table_id,
    'table_label',chosen_table.label,'party_size',reservation_row.party_size,'date',p_date,'time',p_time,'status',reservation_row.status,
    'starts_at',reservation_row.starts_at,'ends_at',reservation_row.ends_at);
end;
$$;

create or replace function reservation_for_guest(p_access_token_hash text)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('id',b.id,'restaurant_id',b.restaurant_id,'table_id',b.table_id,'table_label',t.label,
    'party_size',b.party_size,'starts_at',b.starts_at,'ends_at',b.ends_at,'date',to_char(b.starts_at at time zone r.timezone,'YYYY-MM-DD'),
    'time',to_char(b.starts_at at time zone r.timezone,'HH24:MI'),'status',b.status,
    'restaurant_name',r.name,'address',r.address,'image_url',r.image_url,'timezone',r.timezone)
    from reservations b join restaurants r on r.id=b.restaurant_id join dining_tables t on t.id=b.table_id
   where b.guest_access_token_hash=p_access_token_hash;
$$;

revoke all on function reservation_time_is_open(uuid,date,time,integer) from public;
revoke all on function list_bookable_restaurants() from public;
revoke all on function available_reservation_slots(uuid,date,integer) from public;
revoke all on function create_restaurant_reservation(uuid,date,time,integer,text,text,text,text) from public;
revoke all on function reservation_for_guest(text) from public;
revoke all on function reservation_time_is_open(uuid,date,time,integer) from anon, authenticated;
revoke all on function list_bookable_restaurants() from anon, authenticated;
revoke all on function available_reservation_slots(uuid,date,integer) from anon, authenticated;
revoke all on function create_restaurant_reservation(uuid,date,time,integer,text,text,text,text) from anon, authenticated;
revoke all on function reservation_for_guest(text) from anon, authenticated;
grant execute on function available_reservation_slots(uuid,date,integer) to service_role;
grant execute on function list_bookable_restaurants() to service_role;
grant execute on function create_restaurant_reservation(uuid,date,time,integer,text,text,text,text) to service_role;
grant execute on function reservation_for_guest(text) to service_role;
