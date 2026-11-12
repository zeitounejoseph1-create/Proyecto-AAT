// Test-only PostgreSQL harness. Never connects to an existing or production database.
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes, randomUUID } = require('node:crypto');
const net = require('node:net');
const http = require('node:http');

const repo = path.resolve(__dirname, '..');
function dependency(name) {
  return require.resolve(name, { paths: [repo, process.env.VERIFICATION_NODE_MODULES || path.resolve(repo, '../verification-runtime')] });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startTestDatabase() {
  const { default: EmbeddedPostgres } = await import(pathToFileURL(dependency('embedded-postgres')).href);
  const { Pool, Client } = require(dependency('pg'));
  const directory = await mkdtemp(path.join(tmpdir(), 'mesalista-postgres-test-'));
  const password = randomBytes(32).toString('hex');
  const port = await freePort();
  const logs = [];
  const cluster = new EmbeddedPostgres({
    databaseDir: path.join(directory, 'data'), user: 'postgres', password, port,
    persistent: false, autoRehydrateSymlinks: true,
    postgresFlags: ['-h', '127.0.0.1', '-k', directory],
    onLog: value => logs.push(String(value)), onError: value => logs.push(String(value))
  });
  let pool;
  try {
    await cluster.initialise();
    await cluster.start();
    const config = { host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', connectionTimeoutMillis: 5000 };
    pool = new Pool(config);
    // Mirror Supabase's API roles and broad default grants before migrations.
    // RLS and explicit migration revocations must protect private data even then.
    await pool.query(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    `);
    await pool.query(await readFile(path.join(repo, 'db/schema.sql'), 'utf8'));
    await pool.query(await readFile(path.join(repo, 'db/reservation_core.sql'), 'utf8'));
    return {
      pool, port, logs,
      async client(role = 'service_role') {
        if (!['postgres', 'service_role', 'anon', 'authenticated'].includes(role)) throw new Error('Unsupported test role');
        const client = new Client(config);
        await client.connect();
        await client.query(`set role ${role}`);
        return client;
      },
      async stop() { await pool.end(); await cluster.stop(); await rm(directory, { recursive: true, force: true }); }
    };
  } catch (error) {
    if (pool) await pool.end().catch(() => {});
    await cluster.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    error.message += '\n' + logs.slice(-8).join('\n');
    throw error;
  }
}

async function seedRestaurant(db, options = {}) {
  const owner = randomUUID();
  const id = randomUUID();
  const tableId = randomUUID();
  const date = (await db.pool.query("select ((now() at time zone 'America/Mexico_City')::date + 2)::text as date")).rows[0].date;
  await db.pool.query('insert into users(id,email,display_name,role) values($1,$2,$3,$4)', [owner, `owner-${owner}@example.test`, 'Test Owner', 'restaurant_owner']);
  await db.pool.query(`insert into restaurants(id,owner_id,name,cuisine,price_band,address,city,timezone,reservation_minutes,approved,published,price_per_person_cents,cancellation_policy)
    values($1,$2,$3,'Mexicana','$$','Test Address','Test City','America/Mexico_City',90,true,true,40000,'Test cancellation policy')`, [id, owner, options.name || 'Integration Restaurant']);
  await db.pool.query('insert into subscriptions(id,restaurant_id,status,weekly_price_cents) values($1,$2,$3,19900)', [randomUUID(), id, 'active']);
  await db.pool.query('insert into dining_tables(id,restaurant_id,label,capacity) values($1,$2,$3,4)', [tableId, id, 'T4']);
  await db.pool.query(`insert into restaurant_hours(id,restaurant_id,weekday,opens_at,closes_at)
    select gen_random_uuid(),$1,day,'00:00','23:59' from generate_series(0,6) as day`, [id]);
  return { id, owner, tableId, date };
}

const RPC = {
  list_bookable_restaurants: { args: [], rows: true },
  available_reservation_slots: { args: ['p_restaurant_id', 'p_date', 'p_party_size'], rows: true },
  create_restaurant_reservation: { args: ['p_restaurant_id', 'p_date', 'p_time', 'p_party_size', 'p_customer_name', 'p_customer_email', 'p_access_token_hash', 'p_idempotency_key'] },
  reservation_for_guest: { args: ['p_access_token_hash'] },
  cancel_restaurant_reservation: { args: ['p_access_token_hash'] }
};

// A deliberately small PostgREST-compatible transport for browser -> API -> real SQL tests.
async function startRpcBridge(db) {
  const secret = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const name = req.url?.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];
    const rpc = RPC[name];
    if (req.method !== 'POST' || !rpc) return send(404, { message: 'Unknown test RPC' });
    if (req.headers.apikey !== secret || req.headers.authorization !== `Bearer ${secret}`) return send(401, { message: 'Invalid test bridge credentials' });
    let client;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Body too large'); }
      const payload = JSON.parse(body || '{}');
      const values = rpc.args.map(key => payload[key]);
      const placeholders = rpc.args.map((key, index) => `${key} => $${index + 1}`).join(',');
      client = await db.client();
      const result = await client.query(rpc.rows ? `select * from ${name}(${placeholders})` : `select ${name}(${placeholders}) as value`, values);
      send(200, rpc.rows ? result.rows : result.rows[0]?.value ?? null);
    } catch (error) {
      send(400, { code: error.code || 'TEST_BRIDGE_ERROR', message: error.message });
    } finally { if (client) await client.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, secret, async stop() { await new Promise(resolve => server.close(resolve)); } };
}

module.exports = { startTestDatabase, seedRestaurant, startRpcBridge };
