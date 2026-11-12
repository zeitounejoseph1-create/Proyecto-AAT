// Execute with: node --test scripts/verify-database.cjs (requires pg + embedded-postgres dev dependencies).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { startTestDatabase, seedRestaurant } = require('./test-database.cjs');

const createSql = 'select create_restaurant_reservation($1,$2,$3,$4,$5,$6,$7,$8) as booking';
const applicationTables = ['users', 'restaurants', 'restaurant_hours', 'dining_tables', 'availability_blocks', 'menu_items', 'reservations', 'subscriptions', 'payment_events', 'reward_ledger', 'reviews'];
const token = () => createHash('sha256').update(randomUUID()).digest('hex');
const bookingArgs = (restaurant, time = '13:00') => [restaurant.id, restaurant.date, time, 4, 'Exact Test Input', `guest-${randomUUID()}@example.test`, token(), randomUUID()];

async function waitUntilBlocked(pool, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The second real PostgreSQL connection never blocked on the first transaction');
}

async function competeQueries(db, firstQuery, secondQuery, beforeCommit, beforeStart) {
  const first = await db.client();
  const second = await db.client();
  try {
    await first.query("set statement_timeout='10s'");
    await second.query("set statement_timeout='10s'");
    const pid = (await second.query('select pg_backend_pid() as pid')).rows[0].pid;
    if (beforeStart) await beforeStart();
    await first.query('begin');
    const winner = await first.query(firstQuery);
    const pending = second.query(secondQuery).then(value => ({ value }), error => ({ error }));
    // Prove overlap using the database lock state, then release the first booking.
    await waitUntilBlocked(db.pool, pid);
    if (beforeCommit) await beforeCommit(first, pid);
    await first.query('commit');
    return { winner, contender: await pending };
  } finally {
    await first.query('rollback').catch(() => {});
    await Promise.all([first.end(), second.end()]);
  }
}

async function compete(db, firstArgs, secondArgs) {
  const result = await competeQueries(db, { text: createSql, values: firstArgs }, { text: createSql, values: secondArgs });
  return { ...result, winner: result.winner.rows[0].booking };
}

test('reservation database invariants on disposable real PostgreSQL', { timeout: 120000 }, async t => {
  const db = await startTestDatabase();
  try {
    console.log((await db.pool.query('select version() as version')).rows[0].version);
    const restaurant = await seedRestaurant(db);
    await t.test('SQL integration suite and migration repairs an existing database with disabled RLS', async () => {
      // Simulate the earlier unprotected schema, including existing restaurant data.
      for (const name of applicationTables) await db.pool.query(`alter table ${name} disable row level security; grant all on table ${name} to anon, authenticated`);
      await db.pool.query(await readFile(path.join(__dirname, '../db/reservation_core.sql'), 'utf8'));
      const sql = await readFile(path.join(__dirname, '../db/reservation_core.test.sql'), 'utf8');
      const client = await db.pool.connect();
      client.on('notice', notice => { if (notice.message.startsWith('PASS:')) console.log(notice.message); });
      try { await client.query(sql); } finally { await client.query('rollback'); client.release(); }
    });
    await t.test('anon/authenticated RLS and RPC restrictions; service_role executes catalog', async () => {
      const tables = applicationTables;
      const protectedTables = await db.pool.query('select relname, relrowsecurity from pg_class where relname = any($1::text[]) and relnamespace = \'public\'::regnamespace', [tables]);
      assert.equal(protectedTables.rows.length, tables.length);
      assert.ok(protectedTables.rows.every(row => row.relrowsecurity), 'every application table enables RLS');
      const functions = [
        'list_bookable_restaurants()', 'available_reservation_slots(uuid,date,integer)',
        'create_restaurant_reservation(uuid,date,time without time zone,integer,text,text,text,text)',
        'reservation_for_guest(text)', 'cancel_restaurant_reservation(text)',
        'reservation_time_is_open(uuid,date,time without time zone,integer)',
        'reservation_request_hash(uuid,date,time without time zone,integer,text,text)',
        'reservation_guest_payload(uuid)', 'lock_reservation_restaurant()',
        'guard_reservation_allocation()', 'guard_availability_block()', 'validate_restaurant_timezone()'
      ];
      for (const role of ['anon', 'authenticated']) {
        const client = await db.client(role);
        try {
          for (const name of tables) {
            try { assert.equal((await client.query(`select count(*)::integer as count from ${name}`)).rows[0].count, 0, `${role} must not read ${name}`); }
            catch (error) { if (error.code !== '42501') throw error; }
          }
          for (const fn of functions) {
            assert.equal((await db.pool.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, fn])).rows[0].allowed, false, `${role} must not execute ${fn}`);
          }
          await assert.rejects(client.query('select * from list_bookable_restaurants()'), error => error.code === '42501');
          // Even with broad Supabase-style grants, a browser role cannot create a restaurant.
          await assert.rejects(client.query(`insert into users(id,email,display_name) values($1,$2,'Unauthorized')`, [randomUUID(), `unauthorized-${randomUUID()}@example.test`]), error => error.code === '42501');
        } finally { await client.end(); }
      }
      const service = await db.client();
      try { assert.ok((await service.query('select * from list_bookable_restaurants()')).rows.some(row => row.id === restaurant.id)); }
      finally { await service.end(); }
    });

    await t.test('two overlapping connections compete for the last table: exactly one reservation', async () => {
      const first = bookingArgs(restaurant);
      const second = bookingArgs(restaurant);
      const { winner, contender } = await compete(db, first, second);
      assert.ok(winner.id);
      assert.ok(contender.error, 'second guest must fail after the winner commits');
      assert.ok(['P0001', '23P01'].includes(contender.error.code), contender.error.message);
      const persisted = await db.pool.query('select count(*)::integer as count from reservations where restaurant_id=$1 and idempotency_key=any($2::text[])', [restaurant.id, [first[7], second[7]]]);
      assert.equal(persisted.rows[0].count, 1);
    });

    await t.test('concurrent identical retry persists once and returns the same reservation payload', async () => {
      const args = bookingArgs(restaurant, '16:00');
      const { winner, contender } = await compete(db, args, args);
      assert.ifError(contender.error);
      assert.deepEqual(contender.value.rows[0].booking, winner);
      assert.equal((await db.pool.query('select count(*)::integer as count from reservations where idempotency_key=$1', [args[7]])).rows[0].count, 1);
    });

    await t.test('same idempotency key cannot be reused with changed payload across restaurants', async () => {
      const other = await seedRestaurant(db, { name: 'Other Restaurant' });
      const first = bookingArgs(restaurant, '19:00');
      const second = [...first];
      second[0] = other.id;
      const { winner, contender } = await compete(db, first, second);
      assert.ok(winner.id);
      assert.equal(contender.error?.code, '23505');
      assert.equal((await db.pool.query('select count(*)::integer as count from reservations where idempotency_key=$1', [first[7]])).rows[0].count, 1);
    });

    await t.test('restaurant blocks and bookings serialize in either order without conflicting allocations', async () => {
      const blockQuery = (fixture, time) => ({
        text: `insert into availability_blocks(id,restaurant_id,table_id,starts_at,ends_at,reason)
          values($1,$2,$3,($4::date+$5::time) at time zone 'America/Mexico_City',
            (($4::date+$5::time) at time zone 'America/Mexico_City')+interval '90 minutes','Concurrency test') returning id`,
        values: [randomUUID(), fixture.id, fixture.tableId, fixture.date, time]
      });
      const blockedRestaurant = await seedRestaurant(db, { name: 'Block First Restaurant' });
      const blockedArgs = bookingArgs(blockedRestaurant);
      const blockWins = await competeQueries(db, blockQuery(blockedRestaurant, '13:00'), { text: createSql, values: blockedArgs });
      assert.equal(blockWins.winner.rowCount, 1);
      assert.equal(blockWins.contender.error?.code, 'P0001');
      assert.equal((await db.pool.query('select count(*)::integer as count from reservations where restaurant_id=$1', [blockedRestaurant.id])).rows[0].count, 0);

      const bookedRestaurant = await seedRestaurant(db, { name: 'Booking First Restaurant' });
      const bookedArgs = bookingArgs(bookedRestaurant);
      const bookingWins = await competeQueries(db, { text: createSql, values: bookedArgs }, blockQuery(bookedRestaurant, '13:00'));
      assert.ok(bookingWins.winner.rows[0].booking.id);
      assert.equal(bookingWins.contender.error?.code, 'P0001');
      assert.equal((await db.pool.query('select count(*)::integer as count from availability_blocks where restaurant_id=$1', [bookedRestaurant.id])).rows[0].count, 0);
    });

    await t.test('a cancellation waiting for a lock rechecks the real clock after the reservation starts', async () => {
      const fixture = await seedRestaurant(db, { name: 'Cancellation Deadline Restaurant' });
      const hash = token();
      const id = randomUUID();
      // The short deadline is deliberate: the function begins before it, waits,
      // and must reject after the holder releases the restaurant lock.
      const result = await competeQueries(db,
        { text: 'select id from restaurants where id=$1 for update', values: [fixture.id] },
        { text: 'select cancel_restaurant_reservation($1)', values: [hash] },
        async (holder, pid) => {
          const timing = await db.pool.query(`select a.query_start < b.starts_at as began_before_deadline
            from pg_stat_activity a cross join reservations b where a.pid=$1 and b.id=$2`, [pid, id]);
          assert.equal(timing.rows[0].began_before_deadline, true, 'the cancellation statement must start before the deadline to prove the clock regression');
          await holder.query('select pg_sleep(0.25)');
        },
        // Connect both clients before starting the short deadline.
        () => db.pool.query(`insert into reservations(id,restaurant_id,customer_id,table_id,party_size,starts_at,ends_at,status,guest_access_token_hash)
          values($1,$2,$3,$4,4,clock_timestamp()+interval '200 milliseconds',clock_timestamp()+interval '90 minutes','confirmed',$5)`,
        [id, fixture.id, fixture.owner, fixture.tableId, hash]));
      assert.equal(result.contender.error?.code, 'P0001');
      assert.equal((await db.pool.query('select status from reservations where id=$1', [id])).rows[0].status, 'confirmed');
    });
  } finally { await db.stop(); }
});
