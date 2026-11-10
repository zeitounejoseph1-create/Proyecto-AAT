const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('./api/reservations.js');

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = JSON.parse(body); }
  };
}

function request(method, query = {}, body = {}) {
  return { method, query, body };
}

test('reservation API stays unavailable when database secrets are missing', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = mockResponse();
  await handler(request('GET'), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'Reservation service is not configured');
});

test('reservation API validates before contacting PostgreSQL', async () => {
  process.env.SUPABASE_URL = 'https://database.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only-test-secret';
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('unexpected DB call'); };
  try {
    const res = mockResponse();
    await handler(request('POST', {}, { restaurant_id: 'bad-id' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('reservation API sends the approved exact test input to the atomic database function', async () => {
  process.env.SUPABASE_URL = 'https://database.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only-test-secret';
  const originalFetch = global.fetch;
  let sent;
  global.fetch = async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ id: 'reservation-test-1', restaurant_id: '11111111-1111-4111-8111-111111111111', party_size: 4, date: '2026-11-13', time: '23:30:00', status: 'confirmed' }) };
  };
  try {
    const res = mockResponse();
    await handler(request('POST', {}, {
      restaurant_id: '11111111-1111-4111-8111-111111111111',
      date: '2026-11-13', time: '23:30', party_size: 4,
      name: 'Exact Test Input', email: 'exact-test@example.test',
      access_token: 'a'.repeat(50), idempotency_key: 'reservation-core-test-0001'
    }), res);
    assert.equal(res.statusCode, 201);
    assert.match(sent.url, /rpc\/create_restaurant_reservation$/);
    assert.equal(sent.body.p_date, '2026-11-13');
    assert.equal(sent.body.p_time, '23:30:00');
    assert.equal(sent.body.p_party_size, 4);
    assert.equal(sent.body.p_customer_name, 'Exact Test Input');
    assert.equal(res.body.reservation.status, 'confirmed');
    assert.equal(res.body.access_token, 'a'.repeat(50));
  } finally {
    global.fetch = originalFetch;
  }
});

test('database availability conflicts return HTTP 409', async () => {
  process.env.SUPABASE_URL = 'https://database.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only-test-secret';
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ code: 'P0001', message: 'No compatible table is available at this time' }) });
  try {
    const res = mockResponse();
    await handler(request('POST', {}, {
      restaurant_id: '11111111-1111-4111-8111-111111111111', date: '2026-11-13', time: '23:30',
      party_size: 4, name: 'Second Guest', email: 'second@example.test'
    }), res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /No compatible table/);
  } finally {
    global.fetch = originalFetch;
  }
});
