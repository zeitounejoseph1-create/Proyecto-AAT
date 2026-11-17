// Tests use a new disposable database, never an existing Supabase project.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { startTestDatabase, seedRestaurant, startRpcBridge } = require('../scripts/test-database.cjs');
const { createAppServer } = require('../scripts/dev-server.cjs');

test('catalogue diagnosis against disposable PostgreSQL and the real API', { timeout: 120000 }, async t => {
  const db = await startTestDatabase();
  let bridge, server;
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const visible = await seedRestaurant(db, { name: 'Visible One' });
    const noTables = await seedRestaurant(db, { name: 'Visible Without Tables' });
    await db.pool.query('delete from dining_tables where restaurant_id=$1', [noTables.id]);
    await db.pool.query('delete from restaurant_hours where restaurant_id=$1', [noTables.id]);
    const unapproved = await seedRestaurant(db);
    await db.pool.query('update restaurants set approved=false where id=$1', [unapproved.id]);
    const unpublished = await seedRestaurant(db);
    await db.pool.query('update restaurants set published=false where id=$1', [unpublished.id]);
    const missing = await seedRestaurant(db);
    await db.pool.query('delete from subscriptions where restaurant_id=$1', [missing.id]);
    const inactive = await seedRestaurant(db);
    await db.pool.query("update subscriptions set status='cancelled' where restaurant_id=$1", [inactive.id]);
    const expired = await seedRestaurant(db);
    await db.pool.query("update subscriptions set renews_at=now()-interval '1 day' where restaurant_id=$1", [expired.id]);
    const card = await seedRestaurant(db);
    await db.pool.query('update restaurants set requires_card_guarantee=true where id=$1', [card.id]);

    await t.test('catalogue returns every eligible restaurant; hours and capacity only affect slots', async () => {
      bridge = await startRpcBridge(db);
      process.env.SUPABASE_URL = bridge.url; process.env.SUPABASE_SECRET_KEY = bridge.secret;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      server = createAppServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const base = 'http://127.0.0.1:' + server.address().port;
      const response = await fetch(base + '/api/reservations?mode=restaurants');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.restaurants.map(r => r.id).sort(), [visible.id, noTables.id].sort());
      assert.ok(body.restaurants.every(r => !('owner_id' in r) && !('email' in r)));
      for (const [fixture, party, hasSlots] of [[visible, 2, true], [visible, 20, false], [noTables, 2, false]]) {
        const result = await fetch(base + '/api/reservations?restaurant_id=' + fixture.id + '&date=' + fixture.date + '&party_size=' + party);
        assert.equal(result.status, 200);
        assert.equal((await result.json()).slots.length > 0, hasSlots);
      }
    });

    await t.test('read-only diagnostic counts distinguish main, local and installed catalogue filters', async () => {
      const sql = await readFile(path.join(__dirname, '../db/diagnose_catalog.sql'), 'utf8');
      const client = await db.pool.connect();
      let results;
      try { results = await client.query(sql); }
      finally { await client.query('rollback'); client.release(); }
      const [counts, rpc, metadata] = results.filter(result => result.command === 'SELECT').map(result => result.rows[0]);
      assert.equal(Number(counts.total_restaurants), 8);
      assert.equal(Number(counts.excluded_not_approved), 1);
      assert.equal(Number(counts.excluded_not_published), 1);
      assert.equal(Number(counts.excluded_no_current_subscription), 3);
      assert.equal(Number(counts.requires_card_guarantee), 1);
      assert.equal(Number(counts.eligible_using_main_filters), 3);
      assert.equal(Number(counts.eligible_using_local_branch_filters), 2);
      assert.equal(Number(rpc.installed_rpc_catalog_count), 2);
      assert.equal(metadata.definition_mentions_card_guarantee, true);
      assert.equal(metadata.definition_mentions_subscriptions, true);
      assert.equal((await db.pool.query('select count(*)::integer as count from restaurants')).rows[0].count, 8);
      assert.equal((await db.pool.query('select count(*)::integer as count from reservations')).rows[0].count, 0);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (bridge) await bridge.stop();
    await db.stop();
    for (const key of keys) { if (original[key] == null) delete process.env[key]; else process.env[key] = original[key]; }
  }
});
