// Browser -> real API -> disposable PostgreSQL. No hosted Supabase or real reservations.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestDatabase, seedRestaurant, startRpcBridge } = require('../scripts/test-database.cjs');
const { createAppServer } = require('../scripts/dev-server.cjs');

test('restaurant name search and verified time selection', { timeout: 120000 }, async t => {
  const keys = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const db = await startTestDatabase(); let bridge, server, browser, context;
  const controls = { holdParty: null, held: [], failAvailability: false };
  try {
    const original = await seedRestaurant(db, { name: 'Restaurante Demo MesaLista' });
    bridge = await startRpcBridge(db);
    process.env.SUPABASE_URL = bridge.url; process.env.SUPABASE_SECRET_KEY = bridge.secret; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    server = createAppServer({ afterApi(req, res, data, end) {
      if (req.method === 'GET' && req.query.restaurant_id) {
        if (controls.failAvailability) { res.statusCode = 503; end(JSON.stringify({ code: 'DATABASE_UNAVAILABLE', error: 'Test outage' })); return; }
        if (controls.holdParty === req.query.party_size) { controls.held.push(() => end(data)); return; }
      }
      end(data);
    } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('https://images.unsplash.com/**', route => route.fulfill({ status: 204 }));
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    const errors = [], mutations = [];
    page.on('pageerror', error => errors.push(error.name));
    page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/reservations') mutations.push('POST'); });
    const times = () => page.locator('#time option').evaluateAll(options => options.map(o => o.value));
    const settled = () => page.waitForFunction(() => !/Conectando|Consultando/.test(document.getElementById('status').textContent));
    async function open() {
      await page.goto(origin); await page.locator('#serviceStatus').filter({ hasText: 'conectadas' }).waitFor();
      await page.locator('#date').fill(original.date); await settled();
    }
    async function search(value) { await page.locator('#q').fill(value); await settled(); }
    async function expectedSlots(fixture, party) {
      return (await db.pool.query('select slot from available_reservation_slots($1,$2,$3)', [fixture.id, fixture.date, party])).rows.map(r => r.slot.slice(0, 5));
    }
    let roma;
    await t.test('missing example name explains no matches and offers no unrelated or invented slots', async () => {
      await open(); const actual = await times(); assert.deepEqual(actual, await expectedSlots(original, 2)); assert.ok(actual.length);
      await search('Trattoria Roma');
      assert.match(await page.locator('#status').textContent(), /No encontramos restaurantes publicados con ese nombre/);
      assert.equal(await page.locator('#time').isDisabled(), true); assert.deepEqual(await times(), []);
      assert.equal(await page.getByRole('button', { name: 'Ver y reservar', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Ver ejemplo', exact: true }).count(), 0);
      assert.equal((await page.locator('#q').getAttribute('placeholder')).includes('Trattoria Roma'), false);
      await search(''); assert.deepEqual(await times(), actual); assert.equal(await page.locator('#time').isDisabled(), false);
    });
    await t.test('a published exact name, partial name, accents and spaces keep only that restaurant’s SQL slots', async () => {
      // Fictional published restaurant exists only in this disposable test database.
      roma = await seedRestaurant(db, { name: 'Trattoría  Roma' });
      await db.pool.query("update restaurants set cuisine='Italiana' where id=$1", [roma.id]);
      await db.pool.query("update restaurant_hours set opens_at='12:00',closes_at='20:00' where restaurant_id=$1", [roma.id]);
      await open(); await page.locator('#time').selectOption('16:00');
      for (const name of ['Trattoria Roma', 'ROMA', '  trATTOria    roma  ', 'Trattoría Roma']) {
        await search(name); assert.equal(await page.locator('#time').isDisabled(), false);
        assert.deepEqual(await times(), await expectedSlots(roma, 2)); assert.equal(await page.locator('#time').inputValue(), '16:00');
        assert.equal(await page.getByRole('button', { name: 'Ver y reservar', exact: true }).count(), 1);
      }
      await search('Does not exist'); await search('Trattoria Roma');
      assert.equal(await page.locator('#time').inputValue(), '16:00');
      await page.locator('#q').fill(''); await settled();
      await page.locator('#q').pressSequentially('Trattoria Roma', { delay: 30 }); await settled();
      assert.deepEqual(await times(), await expectedSlots(roma, 2));
    });
    await t.test('suggestion, cuisine and price filters select matching server times and never create a reservation', async () => {
      await open();
      await search('roma'); await page.locator('#nameSuggestions button').click(); await settled();
      assert.equal(await page.locator('#q').inputValue(), 'Trattoría  Roma');
      await page.locator('#cuisine').selectOption('Italiana'); await settled(); assert.deepEqual(await times(), await expectedSlots(roma, 2));
      await page.locator('#price').selectOption('200'); await settled();
      assert.deepEqual(await times(), []); assert.equal(await page.locator('#time').isDisabled(), true);
      assert.match(await page.locator('#status').textContent(), /tipo o precio/);
      await page.locator('#price').selectOption('400'); await settled(); await page.locator('#time').selectOption('13:00');
      await page.getByRole('button', { name: 'Ver y reservar', exact: true }).click();
      try {
        assert.match(await page.locator('#modalContent').textContent(), /Trattoría\s+Roma/);
        await page.locator('#bookName').fill('Search test guest'); await page.locator('#bookEmail').fill('search@example.test');
        assert.equal(await page.locator('#acceptPolicy').isChecked(), false);
        await page.locator('#confirm').click();
      } finally { await page.locator('#close').click(); }
      assert.deepEqual(mutations, []); assert.equal((await db.pool.query('select count(*)::int n from reservations')).rows[0].n, 0);
    });
    await t.test('no capacity, new dates and outages have explicit states without stale time choices', async () => {
      await open(); await search('Roma');
      await page.locator('#guests').selectOption('20'); await settled();
      assert.deepEqual(await times(), []); assert.equal(await page.locator('#time').isDisabled(), true);
      assert.match(await page.locator('#timeStatus').textContent(), /Sin mesas/);
      await page.locator('#guests').selectOption('2'); await settled();
      controls.failAvailability = true;
      try {
        await page.getByRole('button', { name: 'Buscar mesas', exact: true }).click(); await settled();
        assert.deepEqual(await times(), []); assert.match(await page.locator('#timeStatus').textContent(), /No se pudo verificar/);
      } finally { controls.failAvailability = false; }
      const date = (await db.pool.query("select ($1::date + 1)::text date", [original.date])).rows[0].date;
      await page.locator('#date').fill(date); await settled();
      const expected = (await db.pool.query('select slot from available_reservation_slots($1,$2,2)', [roma.id, date])).rows.map(r => r.slot.slice(0, 5));
      assert.deepEqual(await times(), expected); assert.equal(await page.locator('#time').isDisabled(), false);
    });
    await t.test('a delayed query cannot restore slots after a nonmatching name replaces it', async () => {
      await open(); await search('Roma');
      controls.holdParty = '4'; await page.locator('#guests').selectOption('4');
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('Consultando'));
      assert.equal(await page.locator('#time').isDisabled(), true); assert.deepEqual(await times(), []);
      for (let i = 0; !controls.held.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(controls.held.length, 'the old availability response must be held before changing the name');
      await search('Trattoria that does not exist');
      controls.holdParty = null; controls.held.splice(0).forEach(release => release());
      await page.waitForLoadState('networkidle');
      assert.deepEqual(await times(), []); assert.equal(await page.locator('#time').isDisabled(), true);
      assert.match(await page.locator('#status').textContent(), /No encontramos restaurantes publicados/);
      await search('Roma'); assert.deepEqual(await times(), await expectedSlots(roma, 4));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
      assert.equal((await db.pool.query('select count(*)::int n from reservations')).rows[0].n, 0);
    });
  } finally {
    controls.held.splice(0).forEach(release => release());
    if (context) await context.close(); if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve)); if (bridge) await bridge.stop(); await db.stop();
    for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
  }
});
