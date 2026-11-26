-- Suite real PostgreSQL para una base desechable. No modifica datos al terminar.
begin;
do $test$
declare
  v_owner uuid:=gen_random_uuid(); v_restaurant uuid:=gen_random_uuid(); v_other uuid:=gen_random_uuid(); v_dst uuid:=gen_random_uuid();
  v_spring date; v_fall date;
  v_table uuid:=gen_random_uuid(); v_other_table uuid:=gen_random_uuid(); v_large_table uuid:=gen_random_uuid();
  v_friday date:=(statement_timestamp() at time zone 'America/Mexico_City')::date+7+
    ((5-extract(dow from statement_timestamp() at time zone 'America/Mexico_City')::integer+7)%7);
  v_email text; v_key text:='reservation-core-test-'||gen_random_uuid();
  v_first jsonb; v_repeat jsonb; v_cancel jsonb; v_owner_booking jsonb; v_guest_booking jsonb;
  v_failed boolean; v_count integer;
begin
  v_email:='reservation-core-owner-'||v_owner||'@example.test';
  insert into users(id,email,display_name,role) values(v_owner,v_email,'Original Owner','restaurant_owner');
  insert into restaurants(id,owner_id,name,cuisine,price_band,address,city,timezone,reservation_minutes,approved,published,price_per_person_cents,cancellation_policy)
  values(v_restaurant,v_owner,'Reservation Core Test','Mexicana','$$','Test Address','Test City','America/Mexico_City',90,true,true,40000,'Cancel before arrival'),
    (v_other,v_owner,'Other Restaurant','Mexicana','$$','Other Address','Test City','America/Mexico_City',90,true,true,40000,'Cancel before arrival');
  insert into subscriptions(id,restaurant_id,status,weekly_price_cents)
    values(gen_random_uuid(),v_restaurant,'active',0),(gen_random_uuid(),v_other,'active',0);
  insert into dining_tables(id,restaurant_id,label,capacity) values(v_table,v_restaurant,'T4',4),(v_other_table,v_other,'Other T4',4);
  insert into restaurant_hours(id,restaurant_id,weekday,opens_at,closes_at,closes_next_day)
    values(gen_random_uuid(),v_restaurant,5,'13:00','01:00',true),(gen_random_uuid(),v_restaurant,1,'13:00','22:00',false),
      (gen_random_uuid(),v_other,5,'13:00','01:00',true);
  insert into restaurant_hours(id,restaurant_id,weekday,opens_at,closes_at,is_closed)
    values(gen_random_uuid(),v_restaurant,0,'00:00','00:00',true);

  -- Un bloqueo global del otro restaurante no afecta este inventario.
  insert into availability_blocks(id,restaurant_id,starts_at,ends_at)
    values(gen_random_uuid(),v_other,(v_friday+time '00:00') at time zone 'America/Mexico_City',((v_friday+1)+time '03:00') at time zone 'America/Mexico_City');
  if not exists(select 1 from available_reservation_slots(v_restaurant,v_friday,4) where slot='23:30') then raise exception 'FAIL: other restaurant block leaked into availability'; end if;
  if exists(select 1 from available_reservation_slots(v_other,v_friday,4)) then raise exception 'FAIL: restaurant-wide block was ignored'; end if;
  if not reservation_time_is_open(v_restaurant,v_friday+1,'00:00',30) then raise exception 'FAIL: previous overnight service not recognized'; end if;
  if reservation_time_is_open(v_restaurant,v_friday+3,'21:00',90) then raise exception 'FAIL: booking exceeds Monday close'; end if;
  if reservation_time_is_open(v_restaurant,v_friday+2,'13:00',90) then raise exception 'FAIL: closed Sunday accepted'; end if;

  insert into restaurants(id,owner_id,name,cuisine,price_band,address,city,timezone,cancellation_policy)
    values(v_dst,v_owner,'DST Test','Test','$','Test Address','Test City','America/New_York','Test only');
  insert into restaurant_hours(id,restaurant_id,weekday,opens_at,closes_at)
    values(gen_random_uuid(),v_dst,0,'00:00','04:00');
  v_spring:=make_date(extract(year from statement_timestamp())::integer+1,3,1);
  v_spring:=v_spring+((7-extract(dow from v_spring)::integer)%7)+7;
  if reservation_time_is_open(v_dst,v_spring,'02:30',30) then raise exception 'FAIL: nonexistent spring DST time accepted'; end if;
  if reservation_time_is_open(v_dst,v_spring,'01:30',120) then raise exception 'FAIL: real duration exceeded spring DST close'; end if;
  if not reservation_time_is_open(v_dst,v_spring,'00:30',120) then raise exception 'FAIL: valid spring DST interval rejected'; end if;
  v_fall:=make_date(extract(year from statement_timestamp())::integer+1,11,1);
  v_fall:=v_fall+((7-extract(dow from v_fall)::integer)%7);
  update restaurant_hours set closes_at='02:00' where restaurant_id=v_dst;
  if not reservation_time_is_open(v_dst,v_fall,'00:30',120) then raise exception 'FAIL: valid real interval at fall DST rejected'; end if;

  v_first:=create_restaurant_reservation(v_restaurant,v_friday,'23:30',4,'Exact Test Input','exact-test@example.test',repeat('a',64),v_key);
  v_repeat:=create_restaurant_reservation(v_restaurant,v_friday,'23:30',4,' Exact Test Input ','EXACT-test@example.test',repeat('a',64),v_key);
  if v_first<>v_repeat then raise exception 'FAIL: idempotent retry payload changed'; end if;
  update restaurants set timezone='UTC' where id=v_restaurant;
  if create_restaurant_reservation(v_restaurant,v_friday,'23:30',4,'Exact Test Input','exact-test@example.test',repeat('a',64),v_key)<>v_first then raise exception 'FAIL: restaurant timezone edit changed persisted confirmation'; end if;
  update restaurants set timezone='America/Mexico_City' where id=v_restaurant;
  if v_first ? 'customer_email' or v_first ? 'customer_name' then raise exception 'FAIL: guest response exposed contact data'; end if;
  if reservation_for_guest(repeat('a',64))<>v_first then raise exception 'FAIL: guest lookup inconsistent'; end if;
  if reservation_for_guest(repeat('0',64)) is not null then raise exception 'FAIL: unknown token returned data'; end if;
  if (select count(*) from reservations where idempotency_key=v_key)<>1 then raise exception 'FAIL: duplicate persisted booking'; end if;
  if exists(select 1 from available_reservation_slots(v_restaurant,v_friday,4) where slot='23:30') then raise exception 'FAIL: occupied slot advertised'; end if;
  if not exists(select 1 from available_reservation_slots(v_restaurant,v_friday,4) where slot='22:00') then raise exception 'FAIL: adjacent nonoverlapping slot rejected'; end if;

  v_failed:=false;
  begin perform create_restaurant_reservation(v_restaurant,v_friday,'23:00',4,'Another','another@example.test',repeat('b',64),v_key||'-other');
  exception when sqlstate 'P0001' then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: partially overlapping last-table booking accepted'; end if;

  -- Mismo token y clave no autorizan cambiar ninguna parte del pedido.
  v_failed:=false;
  begin perform create_restaurant_reservation(v_restaurant,v_friday,'23:30',3,'Exact Test Input','exact-test@example.test',repeat('a',64),v_key);
  exception when unique_violation then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: changed party replay accepted'; end if;
  v_failed:=false;
  begin perform create_restaurant_reservation(v_restaurant,v_friday,'23:30',4,'Changed Name','exact-test@example.test',repeat('a',64),v_key);
  exception when unique_violation then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: changed contact replay accepted'; end if;
  v_failed:=false;
  begin perform create_restaurant_reservation(v_other,v_friday,'23:30',4,'Exact Test Input','exact-test@example.test',repeat('a',64),v_key);
  exception when unique_violation then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: cross-restaurant key replay accepted'; end if;

  -- Reintentar sigue siendo seguro si después cambian publicación/suscripción.
  update restaurants set published=false where id=v_restaurant;
  update subscriptions set status='past_due' where restaurant_id=v_restaurant;
  if create_restaurant_reservation(v_restaurant,v_friday,'23:30',4,'Exact Test Input','exact-test@example.test',repeat('a',64),v_key)<>v_first then raise exception 'FAIL: retry lost persisted booking'; end if;
  if exists(select 1 from available_reservation_slots(v_restaurant,v_friday,4)) then raise exception 'FAIL: inactive restaurant advertised'; end if;
  update restaurants set published=true where id=v_restaurant;
  update subscriptions set status='active' where restaurant_id=v_restaurant;

  -- Null, pasado y horas sin alineación no pasan el RPC aunque la API falle.
  v_failed:=false;
  begin perform create_restaurant_reservation(v_restaurant,v_friday,'20:00',null,'Guest','guest@example.test',repeat('b',64),v_key||'-null');
  exception when invalid_parameter_value then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: null party accepted'; end if;
  v_failed:=false;
  begin perform create_restaurant_reservation(v_restaurant,v_friday,'20:15',4,'Guest','guest@example.test',repeat('b',64),v_key||'-time');
  exception when invalid_parameter_value then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: off-grid time accepted'; end if;
  v_failed:=false;
  begin perform create_restaurant_reservation(v_restaurant,v_friday-30,'20:00',4,'Guest','guest@example.test',repeat('b',64),v_key||'-past');
  exception when invalid_parameter_value then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: past booking accepted'; end if;
  v_failed:=false;
  begin perform create_restaurant_reservation(v_restaurant,v_friday,'20:00',4,null,'guest@example.test',repeat('b',64),v_key||'-name');
  exception when invalid_parameter_value then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: null name accepted'; end if;
  if exists(select 1 from available_reservation_slots(v_restaurant,v_friday-30,4)) then raise exception 'FAIL: past availability advertised'; end if;

  -- La tarjeta aún no integrada nunca se omite silenciosamente.
  update restaurants set requires_card_guarantee=true where id=v_restaurant;
  if exists(select 1 from list_bookable_restaurants() where id=v_restaurant) or exists(select 1 from available_reservation_slots(v_restaurant,v_friday,4)) then raise exception 'FAIL: unsupported card guarantee advertised'; end if;
  v_failed:=false;
  begin perform create_restaurant_reservation(v_restaurant,v_friday,'20:00',4,'Guest','guest@example.test',repeat('b',64),v_key||'-card');
  exception when sqlstate 'P0001' then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: required card guarantee bypassed'; end if;
  update restaurants set requires_card_guarantee=false where id=v_restaurant;

  -- Las reservas anónimas conservan su contacto sin modificar cuentas existentes.
  v_owner_booking:=create_restaurant_reservation(v_restaurant,v_friday+3,'13:00',4,'Unverified Guest Name',v_email,repeat('c',64),v_key||'-owner');
  if (select display_name<>'Original Owner' or role<>'restaurant_owner' from users where id=v_owner) then raise exception 'FAIL: guest overwrote account'; end if;
  if (select customer_name from reservations where id=(v_owner_booking->>'id')::uuid)<>'Unverified Guest Name' then raise exception 'FAIL: contact snapshot not saved'; end if;

  insert into availability_blocks(id,restaurant_id,table_id,starts_at,ends_at) values(gen_random_uuid(),v_restaurant,v_table,
    ((v_friday+3)+time '16:00') at time zone 'America/Mexico_City',((v_friday+3)+time '18:00') at time zone 'America/Mexico_City');
  if exists(select 1 from available_reservation_slots(v_restaurant,v_friday+3,4) where slot='16:00') then raise exception 'FAIL: table block ignored'; end if;
  v_failed:=false;
  begin insert into availability_blocks(id,restaurant_id,starts_at,ends_at) values(gen_random_uuid(),v_restaurant,(v_first->>'starts_at')::timestamptz,(v_first->>'ends_at')::timestamptz);
  exception when sqlstate 'P0001' then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: block accepted over an active reservation'; end if;
  v_failed:=false;
  begin insert into availability_blocks(id,restaurant_id,table_id,starts_at,ends_at) values(gen_random_uuid(),v_restaurant,v_other_table,
    ((v_friday+3)+time '20:00') at time zone 'America/Mexico_City',((v_friday+3)+time '21:00') at time zone 'America/Mexico_City');
  exception when foreign_key_violation then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: block references another restaurant table'; end if;

  -- Cancelación por capacidad secreta, idempotente y efectiva en disponibilidad.
  if cancel_restaurant_reservation(repeat('0',64)) is not null then raise exception 'FAIL: unknown token cancelled a reservation'; end if;
  v_cancel:=cancel_restaurant_reservation(repeat('a',64));
  if v_cancel->>'status'<>'cancelled' or v_cancel->>'id'<>v_first->>'id' or cancel_restaurant_reservation(repeat('a',64))<>v_cancel then raise exception 'FAIL: cancellation not idempotent'; end if;
  if not exists(select 1 from available_reservation_slots(v_restaurant,v_friday,4) where slot='23:30') then raise exception 'FAIL: cancelled table not released'; end if;
  if create_restaurant_reservation(v_restaurant,v_friday,'23:30',4,'Exact Test Input','exact-test@example.test',repeat('a',64),v_key)->>'status'<>'cancelled' then raise exception 'FAIL: retry resurrected a cancelled booking'; end if;
  v_guest_booking:=create_restaurant_reservation(v_restaurant,v_friday,'23:30',4,'Next Guest','next@example.test',repeat('b',64),v_key||'-next');
  update reservations set status='attended' where id=(v_guest_booking->>'id')::uuid;
  if exists(select 1 from available_reservation_slots(v_restaurant,v_friday,4) where slot='23:30') then raise exception 'FAIL: check-in freed an occupied table'; end if;
  v_failed:=false;
  begin insert into reservations(id,restaurant_id,customer_id,table_id,party_size,starts_at,ends_at,status)
    values(gen_random_uuid(),v_restaurant,v_owner,v_table,4,(v_guest_booking->>'starts_at')::timestamptz,(v_guest_booking->>'ends_at')::timestamptz,'confirmed');
  exception when exclusion_violation then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: direct write bypassed attended exclusion guard'; end if;
  v_failed:=false;
  begin perform cancel_restaurant_reservation(repeat('b',64)); exception when sqlstate 'P0001' then v_failed:=true; end;
  if not v_failed then raise exception 'FAIL: attended reservation cancelled by guest'; end if;

  -- Hasta vincular reviews a asistencia real no se anuncia una calificación.
  insert into reviews(id,restaurant_id,rating,body) values(gen_random_uuid(),v_restaurant,5,'Unverified review fixture');
  if exists(select 1 from list_bookable_restaurants() where id=v_restaurant and rating is not null) then raise exception 'FAIL: unverified rating published'; end if;
  insert into dining_tables(id,restaurant_id,label,capacity) values(v_large_table,v_restaurant,'Large group',20);
  if not exists(select 1 from available_reservation_slots(v_restaurant,v_friday,20) where table_id=v_large_table) then raise exception 'FAIL: configured large-group table not supported'; end if;
  if exists(select 1 from available_reservation_slots(v_restaurant,v_friday,21)) then raise exception 'FAIL: party exceeds configured capacity'; end if;

  raise notice 'PASS: overnight/DST-safe windows, isolated blocks, overlap/capacity, exact idempotency, cancellation, contact snapshots, strict validation, subscription/card gates, unverified rating suppression';
end;
$test$;
rollback;
