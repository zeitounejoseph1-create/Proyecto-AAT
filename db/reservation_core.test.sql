-- Integration test for reservation_core.sql. Run against a disposable Supabase/PostgreSQL database.
-- The transaction rolls back all fixtures when the test succeeds.
begin;
do $$
declare
  v_owner_id uuid := gen_random_uuid();
  v_restaurant_id uuid := gen_random_uuid();
  first_result jsonb;
  repeated_result jsonb;
  failed_as_expected boolean := false;
  token_hash text := repeat('a',64);
  key_value text := 'reservation-core-test-0001';
begin
  insert into users(id,email,display_name,role)
  values(v_owner_id,'reservation-core-owner-'||v_owner_id||'@example.test','Integration Test Owner','restaurant_owner');
  insert into restaurants(id,owner_id,name,cuisine,price_band,address,city,timezone,reservation_minutes,
    approved,published,price_per_person_cents,cancellation_policy)
  values(v_restaurant_id,v_owner_id,'Reservation Core Test','Mexicana','$$','Test Address','Test City',
    'America/Mexico_City',90,true,true,40000,'Test only');
  insert into subscriptions(id,restaurant_id,status,weekly_price_cents)
  values(gen_random_uuid(),v_restaurant_id,'active',19900);
  insert into dining_tables(id,restaurant_id,label,capacity)
  values(gen_random_uuid(),v_restaurant_id,'T4',4);
  insert into restaurant_hours(id,restaurant_id,weekday,opens_at,closes_at,closes_next_day)
  values(gen_random_uuid(),v_restaurant_id,5,'13:00','01:00',true),
        (gen_random_uuid(),v_restaurant_id,1,'13:00','22:00',false);
  insert into restaurant_hours(id,restaurant_id,weekday,opens_at,closes_at,is_closed)
  values(gen_random_uuid(),v_restaurant_id,0,'00:00','00:00',true);

  if not exists(select 1 from available_reservation_slots(v_restaurant_id,'2026-11-13',4) where slot='23:30') then
    raise exception 'FAIL: expected 23:30 to be available on Friday through 01:00';
  end if;
  first_result := create_restaurant_reservation(v_restaurant_id,'2026-11-13','23:30',4,
    'Exact Test Input','exact-test@example.test',token_hash,key_value);
  repeated_result := create_restaurant_reservation(v_restaurant_id,'2026-11-13','23:30',4,
    'Exact Test Input','exact-test@example.test',token_hash,key_value);
  if first_result->>'id' <> repeated_result->>'id' then
    raise exception 'FAIL: idempotent retry returned a different reservation';
  end if;
  if (select count(*) from reservations where reservations.restaurant_id=v_restaurant_id and idempotency_key=key_value) <> 1 then
    raise exception 'FAIL: reservation did not persist exactly once';
  end if;
  if exists(select 1 from available_reservation_slots(v_restaurant_id,'2026-11-13',4) where slot='23:30') then
    raise exception 'FAIL: occupied table still appears available';
  end if;
  if reservation_time_is_open(v_restaurant_id,'2026-11-16','21:00',90) then
    raise exception 'FAIL: booking exceeds Monday 22:00 close';
  end if;
  if reservation_time_is_open(v_restaurant_id,'2026-11-15','13:00',90) then
    raise exception 'FAIL: Sunday marked closed accepted a reservation';
  end if;

  begin
    perform create_restaurant_reservation(v_restaurant_id,'2026-11-13','23:30',4,
      'Second Guest','second@example.test',repeat('b',64),'reservation-core-test-0002');
  exception when sqlstate 'P0001' then
    failed_as_expected := true;
  end;
  if not failed_as_expected then raise exception 'FAIL: second guest reserved the occupied last table'; end if;
  raise notice 'PASS: one table for four, occupied rejection, idempotent retry, overnight close, closed day, after-close rejection';
end;
$$;
rollback;
