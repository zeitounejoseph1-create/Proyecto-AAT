const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const handler = require('./api/reservations.js');

const RESTAURANT = '11111111-1111-4111-8111-111111111111';
const TABLE = '22222222-2222-4222-8222-222222222222';
const RESERVATION = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'a'.repeat(43);
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const booking = overrides => ({ restaurant_id: RESTAURANT, date: '2026-11-13', time: '23:30', party_size: 4, name: 'Exact Test Input', email: 'exact-test@example.test', access_token: TOKEN, idempotency_key: 'reservation-core-test-0001', ...overrides });
const reservation = overrides => ({ id: RESERVATION, restaurant_id: RESTAURANT, table_id: TABLE, table_label: 'A1', party_size: 4, date: '2026-11-13', time: '23:30:00', status: 'confirmed', starts_at: '2026-11-14T05:30:00+00:00', ends_at: '2026-11-14T07:00:00+00:00', ...overrides });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function request(method, query = {}, body = {}, headers = {}) {
  return { method, query, body, headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers } };
}

async function call(req) {
  const res = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = JSON.parse(body); } };
  await handler(req, res);
  return res;
}

let previous;
let calls;
let logs;
beforeEach(() => {
  previous = { fetch: global.fetch, error: console.error, env: Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]])) };
  process.env.SUPABASE_URL = 'https://database.example.test/';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_server_only_test_key';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  calls = [];
  logs = [];
  console.error = (...args) => logs.push(args);
  global.fetch = async (url, options) => { calls.push({ url, options, payload: JSON.parse(options.body) }); return response(reservation()); };
});
afterEach(() => {
  global.fetch = previous.fetch;
  console.error = previous.error;
  for (const [key, value] of Object.entries(previous.env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('missing secrets, invalid server URLs and public keys fail closed without contacting a database', async () => {
  delete process.env.SUPABASE_SECRET_KEY;
  assert.equal((await call(request('GET'))).statusCode, 503);
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  for (const url of ['not-a-url', 'http://database.example.test', 'https://user:password@database.example.test', 'https://database.example.test/path', 'https://database.example.test/?key=secret']) {
    process.env.SUPABASE_URL = url;
    assert.equal((await call(request('GET'))).statusCode, 503, url);
  }
  process.env.SUPABASE_URL = 'https://database.example.test';
  process.env.SUPABASE_SECRET_KEY = 'sb_publishable_public_key';
  assert.equal((await call(request('GET'))).statusCode, 503);
  assert.equal(calls.length, 0);
});

test('health exposes only configuration and rejects unsupported methods', async () => {
  const health = await call(request('GET'));
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.body, { configured: true });
  assert.equal(health.headers['Cache-Control'], 'no-store');
  assert.equal(health.headers['X-Content-Type-Options'], 'nosniff');
  const unsupported = await call(request('DELETE'));
  assert.equal(unsupported.statusCode, 405);
  assert.equal(unsupported.headers.Allow, 'GET, POST');
  assert.equal(calls.length, 0);
});

test('creation strictly validates real dates, UUIDs, slots, size, guest details and retry secrets before RPC', async () => {
  for (const change of [
    { restaurant_id: '-'.repeat(36) }, { restaurant_id: [RESTAURANT] }, { date: '2026-02-29' }, { date: '2026-13-01' }, { date: '0000-01-01' }, { date: ['2026-11-13'] },
    { time: '23:31' }, { time: '24:00' }, { time: '23:30:00' }, { party_size: '4' }, { party_size: null }, { party_size: 0 }, { party_size: 31 },
    { name: ' ' }, { name: 'x'.repeat(121) }, { name: 'Unsafe\nName' }, { email: 'invalid' }, { email: 'a@b.test\u0000' },
    { access_token: undefined }, { access_token: 'a'.repeat(201) }, { access_token: '!'.repeat(43) },
    { idempotency_key: undefined }, { idempotency_key: 'x'.repeat(101) }, { idempotency_key: 'unsafe spaces in key' }, { extra: 'ignored?' }, { action: 'modify' }
  ]) {
    const res = await call(request('POST', {}, booking(change)));
    assert.equal(res.statusCode, 400, JSON.stringify(change));
    assert.equal(res.body.code, 'INVALID_REQUEST');
  }
  assert.equal(calls.length, 0);
});

test('JSON content type, object body and bounded body size are required', async () => {
  for (const body of [null, [], 7, '{bad json', 'null']) assert.equal((await call(request('POST', {}, body))).statusCode, 400);
  assert.equal((await call(request('POST', {}, booking(), { 'content-type': 'text/plain' }))).statusCode, 415);
  assert.equal((await call(request('POST', {}, booking(), { 'content-type': undefined }))).statusCode, 415);
  assert.equal((await call(request('POST', {}, { large: 'x'.repeat(9000) }))).statusCode, 413);
  assert.equal((await call(request('POST', {}, 'x'.repeat(9000)))).statusCode, 413);
  assert.equal(calls.length, 0);
});

test('creation sends the exact normalized request atomically and verifies the confirmed response', async () => {
  const res = await call(request('POST', {}, booking({ action: 'create', name: ' Exact Test Input ', email: ' EXACT-TEST@example.test ' })));
  assert.equal(res.statusCode, 201);
  assert.deepEqual(calls[0].payload, { p_restaurant_id: RESTAURANT, p_date: '2026-11-13', p_time: '23:30:00', p_party_size: 4, p_customer_name: 'Exact Test Input', p_customer_email: 'exact-test@example.test', p_access_token_hash: HASH, p_idempotency_key: 'reservation-core-test-0001' });
  assert.equal(calls[0].url, 'https://database.example.test/rest/v1/rpc/create_restaurant_reservation');
  assert.equal(calls[0].options.headers.apikey, process.env.SUPABASE_SECRET_KEY);
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(calls[0].payload).includes(TOKEN), false);
  assert.deepEqual(res.body, { reservation: reservation(), access_token: TOKEN, idempotency_key: 'reservation-core-test-0001' });
});

test('legacy service_role JWT configuration remains compatible', async () => {
  delete process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy-service-role-jwt';
  assert.equal((await call(request('POST', {}, booking()))).statusCode, 201);
  assert.equal(calls[0].options.headers.apikey, 'legacy-service-role-jwt');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer legacy-service-role-jwt');
});

test('leap dates and large groups are accepted when the database confirms them', async () => {
  global.fetch = async () => response(reservation({ date: '2028-02-29', party_size: 30, starts_at: '2028-03-01T05:30:00Z', ends_at: '2028-03-01T07:00:00Z' }));
  assert.equal((await call(request('POST', {}, booking({ date: '2028-02-29', party_size: 30 })))).statusCode, 201);
});

test('a lost create response can be retried with the original keys without changing the RPC payload', async () => {
  const sent = [];
  global.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) throw new Error('connection lost after commit');
    return response(reservation());
  };
  const first = await call(request('POST', {}, booking()));
  assert.equal(first.statusCode, 502);
  assert.equal(first.body.code, 'RESERVATION_UNVERIFIED');
  assert.equal(first.body.retryable, true);
  assert.equal(Object.hasOwn(first.body, 'reservation'), false);
  const retry = await call(request('POST', {}, booking()));
  assert.equal(retry.statusCode, 201);
  assert.equal(retry.body.reservation.id, RESERVATION);
  assert.deepEqual(sent[0], sent[1]);
});

test('HTTP success with missing, mismatched or unconfirmed database data never confirms a booking', async () => {
  for (const result of [null, [], {}, reservation({ id: 'fake-id' }), reservation({ table_id: null }), reservation({ restaurant_id: TABLE }), reservation({ date: '2026-11-14' }), reservation({ time: '23:00:00' }), reservation({ party_size: 5 }), reservation({ status: 'pending' }), reservation({ status: 'attended' }), reservation({ starts_at: 'invalid' }), reservation({ ends_at: '2026-11-14T05:30:00Z' })]) {
    global.fetch = async () => response(result);
    const res = await call(request('POST', {}, booking()));
    assert.equal(res.statusCode, 502, JSON.stringify(result));
    assert.equal(res.body.code, 'RESERVATION_UNVERIFIED');
    assert.equal(Object.hasOwn(res.body, 'reservation'), false);
  }
});

test('a replay of an already cancelled reservation reports its actual state', async () => {
  global.fetch = async () => response(reservation({ status: 'cancelled' }));
  const res = await call(request('POST', {}, booking()));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'RESERVATION_CANCELLED');
  assert.equal(res.body.reservation.status, 'cancelled');
});

test('database conflicts and invalid input are distinct and never expose PostgreSQL messages', async () => {
  for (const code of ['P0001', '23P01', '23505', '22023']) {
    global.fetch = async () => response({ code, message: `private guest@example.test token ${TOKEN}` }, 400);
    const res = await call(request('POST', {}, booking()));
    assert.equal(res.statusCode, code === '22023' ? 400 : 409);
    assert.equal(res.body.code, code === '22023' ? 'INVALID_REQUEST' : 'RESERVATION_CONFLICT');
    assert.equal(JSON.stringify(res.body).includes('guest@example.test'), false);
    assert.equal(JSON.stringify(res.body).includes(TOKEN), false);
  }
  assert.deepEqual(logs, []);
});

test('upstream authorization errors, non-JSON responses and outages are never treated as confirmed', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    global.fetch = async () => response({ message: `private error ${TOKEN}` }, status);
    const res = await call(request('POST', {}, booking()));
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'RESERVATION_UNVERIFIED');
    assert.equal(JSON.stringify(res.body).includes(TOKEN), false);
  }
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(`invalid JSON ${TOKEN}`); } });
  assert.equal((await call(request('POST', {}, booking()))).statusCode, 502);
  assert.equal((await call(request('GET', {}, {}, { authorization: `Bearer ${TOKEN}` }))).statusCode, 502);
  assert.equal(JSON.stringify(logs).includes(TOKEN), false);
});

test('the database deadline aborts the request and leaves the create result unverified', async t => {
  const realSetTimeout = global.setTimeout;
  let deadline;
  t.mock.method(global, 'setTimeout', (callback, milliseconds) => { deadline = milliseconds; return realSetTimeout(callback, 1); });
  let signal;
  global.fetch = async (url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  };
  const res = await call(request('POST', {}, booking()));
  assert.equal(deadline, 8000);
  assert.equal(signal.aborted, true);
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.code, 'RESERVATION_UNVERIFIED');
});

test('guest lookup accepts a private header, hashes the token and strips internal fields', async () => {
  global.fetch = async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return response(reservation({ customer_email: 'private@example.test', guest_access_token_hash: HASH, idempotency_key: 'private' }));
  };
  const res = await call(request('GET', {}, {}, { authorization: `Bearer ${TOKEN}` }));
  assert.equal(res.statusCode, 200);
  assert.match(calls[0].url, /rpc\/reservation_for_guest$/);
  assert.deepEqual(calls[0].payload, { p_access_token_hash: HASH });
  assert.deepEqual(res.body.reservation, reservation());
});

test('guest lookup preserves legacy links and distinguishes missing records from database failure', async () => {
  assert.equal((await call(request('GET', { token: TOKEN }))).statusCode, 200);
  global.fetch = async () => response(null);
  assert.equal((await call(request('GET', { token: TOKEN }))).statusCode, 404);
  global.fetch = async () => response({});
  assert.equal((await call(request('GET', { token: TOKEN }))).statusCode, 502);
});

test('query arrays, mixed modes, coercible counts, impossible dates and invalid lookup tokens are rejected', async () => {
  const valid = { restaurant_id: RESTAURANT, date: '2026-11-13', party_size: '4' };
  for (const query of [{ token: '' }, { token: 'a'.repeat(201) }, { token: [TOKEN] }, { token: TOKEN, mode: 'restaurants' }, { mode: ['restaurants'] }, { mode: 'restaurants', extra: 'x' }, { ...valid, mode: 'restaurants' }, { ...valid, restaurant_id: '-'.repeat(36) }, { ...valid, date: '2026-02-30' }, { ...valid, party_size: ['4'] }, { ...valid, party_size: '4e0' }, { ...valid, party_size: ' 4' }, { ...valid, party_size: '04' }, { ...valid, party_size: 4 }, { unknown: '1' }]) {
    assert.equal((await call(request('GET', query))).statusCode, 400, JSON.stringify(query));
  }
  assert.equal((await call(request('GET', { token: TOKEN }, {}, { authorization: `Bearer ${TOKEN}` }))).statusCode, 400);
  assert.equal((await call(request('GET', {}, {}, { authorization: 'Bearer unsafe' }))).statusCode, 400);
  assert.equal(calls.length, 0);
});

test('availability returns only verified RPC slots and treats malformed data as an outage', async () => {
  const query = { restaurant_id: RESTAURANT, date: '2026-11-13', party_size: '4' };
  global.fetch = async (url, options) => { calls.push({ url, payload: JSON.parse(options.body) }); return response([{ slot: '23:30:00', table_id: TABLE, table_label: 'A1', secret: 'private' }]); };
  const res = await call(request('GET', query));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].payload, { p_restaurant_id: RESTAURANT, p_date: '2026-11-13', p_party_size: 4 });
  assert.deepEqual(res.body.slots, [{ slot: '23:30:00', table_id: TABLE, table_label: 'A1' }]);
  for (const result of [null, {}, [{}], [{ slot: '23:31:00', table_id: TABLE, table_label: 'A1' }]]) {
    global.fetch = async () => response(result);
    assert.equal((await call(request('GET', query))).statusCode, 502);
  }
  global.fetch = async () => response([]);
  assert.deepEqual((await call(request('GET', query))).body, { slots: [] });
});

test('restaurant listing limits its public response and rejects an invalid RPC contract', async () => {
  global.fetch = async () => response([{ id: RESTAURANT, name: 'Real restaurant', rating: null, owner_email: 'private@example.test' }]);
  const res = await call(request('GET', { mode: 'restaurants' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.restaurants, [{ id: RESTAURANT, name: 'Real restaurant', rating: null }]);
  for (const result of [null, {}, [{ id: 'bad', name: 'Fake' }]]) {
    global.fetch = async () => response(result);
    assert.equal((await call(request('GET', { mode: 'restaurants' }))).statusCode, 502);
  }
});

test('cancellation calls the authorized atomic RPC and requires a confirmed cancelled state', async () => {
  global.fetch = async (url, options) => { calls.push({ url, payload: JSON.parse(options.body) }); return response(reservation({ status: 'cancelled' })); };
  for (let retry = 0; retry < 2; retry++) {
    const res = await call(request('POST', {}, { action: 'cancel', access_token: TOKEN }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.reservation.status, 'cancelled');
  }
  assert.match(calls[0].url, /rpc\/cancel_restaurant_reservation$/);
  assert.deepEqual(calls[0].payload, { p_access_token_hash: HASH });
  assert.deepEqual(calls[0].payload, calls[1].payload);
  global.fetch = async () => response(reservation());
  const notCancelled = await call(request('POST', {}, { action: 'cancel', access_token: TOKEN }));
  assert.equal(notCancelled.statusCode, 502);
  assert.equal(notCancelled.body.code, 'RESERVATION_UNVERIFIED');
});

test('cancellation rejects invalid authority, returns missing records, and reports final-state conflicts', async () => {
  for (const body of [{ action: 'cancel' }, { action: 'cancel', access_token: ['unsafe'] }, { action: 'cancel', access_token: TOKEN, reservation_id: RESERVATION }]) assert.equal((await call(request('POST', {}, body))).statusCode, 400);
  assert.equal(calls.length, 0);
  global.fetch = async () => response(null);
  assert.equal((await call(request('POST', {}, { action: 'cancel', access_token: TOKEN }))).statusCode, 404);
  global.fetch = async () => response({ code: 'P0001', message: 'internal detail' }, 400);
  assert.equal((await call(request('POST', {}, { action: 'cancel', access_token: TOKEN }))).statusCode, 409);
});
