const { test } = require('node:test');
const assert = require('node:assert/strict');
const { environmentSummary, diagnose } = require('../scripts/diagnose.cjs');

test('environment diagnostics never expose URL, credentials, or unrelated environment values', () => {
  const secret = 'sb_secret_test_do_not_print';
  const result = environmentSummary({ SUPABASE_URL: 'https://private-project.example.test', SUPABASE_SECRET_KEY: secret, UNRELATED_SECRET: 'do_not_print_either' });
  assert.equal(result.url_valid, true); assert.equal(result.key_kind, 'secret');
  assert.equal(result.private_key_present, true);
  assert.doesNotMatch(JSON.stringify(result), /private-project|do_not_print/);
  assert.equal(environmentSummary({ SUPABASE_URL: 'https://user:password@example.test/rest/v1' }).url_valid, false);
  assert.equal(environmentSummary({ SUPABASE_SECRET_KEY: 'sb_publishable_test' }).key_kind, 'publishable_invalid_for_server');
});

test('public diagnostics make only anonymous GETs and do not confuse catalogue size with total database size', async () => {
  const originalFetch = global.fetch;
  const calls = [], output = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith('/') ? '<script src="/assets/app.js"></script>' : url.includes('mode=restaurants') ? { restaurants: [{ id: 'fixture-id', name: 'Fixture', timezone: 'America/Mexico_City' }] } : url.includes('restaurant_id=') ? { slots: [] } : { configured: true };
    return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status: 200 });
  };
  try {
    const result = await diagnose('https://public.example.test', value => output.push(value));
    assert.equal(result.healthy, true); assert.equal(calls.length, 5);
    assert.ok(calls.every(call => call.options.method === 'GET' && !call.options.headers.Authorization && !call.options.headers.apikey && !call.options.body));
    const catalogue = output.find(row => row.check === 'public_catalog');
    assert.equal(catalogue.eligible_count, 1);
    assert.equal(catalogue.total_database_count, 'requires_authorized_sql_read');
  } finally { global.fetch = originalFetch; }
});
