// Real browser -> Vercel-style API -> PostgreSQL. All data stays in a disposable local cluster.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startTestDatabase, seedRestaurant, startRpcBridge } = require('../scripts/test-database.cjs');
const { createAppServer } = require('../scripts/dev-server.cjs');

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
}
async function choose(page, url, fixture, time = '13:00') {
  await page.goto(url);
  await page.locator('#serviceStatus').filter({ hasText: 'conectadas' }).waitFor();
  await page.locator('#date').fill(fixture.date);
  await page.locator('#guests').selectOption('4');
  await until(async () => (await page.locator('#time option').allTextContents()).length > 0 && !(await page.locator('#status').textContent()).includes('Consultando'), 'Availability did not settle');
  await page.locator('#time').selectOption(time);
  await page.getByRole('button', { name: 'Ver y reservar', exact: true }).click();
  await page.locator('#bookName').fill('Browser Test Guest');
  await page.locator('#bookEmail').fill('browser@example.test');
  await page.locator('#acceptPolicy').check();
}

test('browser reservation safety with real PostgreSQL', { timeout: 120000 }, async t => {
  const db = await startTestDatabase();
  const bridge = await startRpcBridge(db);
  process.env.SUPABASE_URL = bridge.url; process.env.SUPABASE_SECRET_KEY = bridge.secret;
  const controls = { loseCreate: false, holdLookup: false, holdParty: null, held: [] };
  const server = createAppServer({ afterApi(req, res, data, end) {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    if (req.method === 'POST' && body?.action !== 'cancel' && controls.loseCreate && res.statusCode === 201) {
      controls.loseCreate = false;
      // PostgreSQL committed, but the transport could not deliver a verified response.
      // An explicit gateway failure avoids Chromium's transparent socket retry.
      res.statusCode = 502; end(JSON.stringify({ code: 'RESERVATION_UNVERIFIED', error: 'Response lost after commit' })); return;
    }
    if ((controls.holdLookup && req.method === 'GET' && req.headers.authorization) || (controls.holdParty && req.query.party_size === controls.holdParty)) { controls.held.push(() => end(data)); return; }
    end(data);
  } });
  const url = await listen(server);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const originalEnv = { url: process.env.SUPABASE_URL, secret: process.env.SUPABASE_SECRET_KEY };
  try {
    const fixture = await seedRestaurant(db, { name: '<img src=x onerror=alert(1)> Test Restaurant' });
    const context = await browser.newContext();
    // External illustrative photos are irrelevant to reservation tests.
    await context.route('https://images.unsplash.com/**', route => route.fulfill({ status: 204 }));
    const page = await context.newPage(); page.setDefaultTimeout(7000); const errors = []; page.on('pageerror', error => errors.push(error.message));

    await t.test('creates only after policy acceptance, persists, and cancels on server', async () => {
      await choose(page, url, fixture);
      assert.equal(await page.locator('#results img[onerror]').count(), 0, 'restaurant name is text, never HTML');
      await page.locator('#acceptPolicy').uncheck();
      await page.locator('#confirm').click();
      assert.equal((await db.pool.query('select count(*)::integer as count from reservations')).rows[0].count, 0);
      await page.locator('#acceptPolicy').check(); await page.locator('#confirm').click();
      await page.locator('#bookStatus').filter({ hasText: 'confirmada y guardada' }).waitFor();
      assert.equal(await page.locator('#confirm').isDisabled(), true, 'a completed form cannot make a second booking');
      assert.equal((await db.pool.query('select count(*)::integer as count from reservations')).rows[0].count, 1);
      await page.locator('#close').click(); await page.reload();
      await page.locator('#myBookings').filter({ hasText: 'Estado en servidor: Confirmada' }).waitFor();
      await page.getByRole('button', { name: 'Cancelar reserva', exact: true }).click();
      await page.getByRole('button', { name: 'Sí, cancelar mi reserva', exact: true }).click();
      await page.locator('#bookingListStatus').filter({ hasText: 'Cancelación guardada' }).waitFor();
      assert.equal((await db.pool.query('select status from reservations')).rows[0].status, 'cancelled');
      await page.getByRole('button', { name: 'Canceladas', exact: true }).click();
      await page.locator('#myBookings').filter({ hasText: 'Estado en servidor: Cancelada' }).waitFor();
      const slots = await db.pool.query('select * from available_reservation_slots($1,$2,4) where slot=\'13:00\'', [fixture.id, fixture.date]);
      assert.equal(slots.rowCount, 1, 'cancel restores table availability');
    });

    await t.test('lost creation response retries exact request and persists only once', async () => {
      await choose(page, url, fixture, '16:00'); controls.loseCreate = true;
      await page.locator('#confirm').click();
      await page.locator('#bookStatus').filter({ hasText: 'todavía no se pudo verificar' }).waitFor();
      const before = (await db.pool.query("select id from reservations where status='confirmed'")).rows;
      assert.equal(before.length, 1);
      await page.locator('#close').click();
      await page.getByRole('button', { name: 'Recuperar o reintentar', exact: true }).click();
      await page.locator('#recoveryBox').waitFor({ state: 'hidden' });
      const after = (await db.pool.query("select id from reservations where status='confirmed'")).rows;
      assert.deepEqual(after, before);
      assert.equal(await page.locator('#myBookings .card').count(), 1);
    });

    await t.test('a delayed lookup cannot revert a confirmed server cancellation', async () => {
      controls.holdLookup = true;
      await page.locator('#refreshBookings').click();
      await until(() => controls.held.length > 0, 'lookup was not held');
      await page.getByRole('button', { name: 'Cancelar reserva', exact: true }).click();
      await page.getByRole('button', { name: 'Sí, cancelar mi reserva', exact: true }).click();
      await page.locator('#bookingListStatus').filter({ hasText: 'Cancelación guardada' }).waitFor();
      controls.holdLookup = false; controls.held.splice(0).forEach(release => release());
      await until(() => page.locator('#refreshBookings').isEnabled(), 'lookup did not finish');
      assert.equal(await page.locator('#myBookings .card').count(), 0);
      assert.equal((await db.pool.query("select count(*)::integer as count from reservations where status='confirmed'")).rows[0].count, 0);
    });

    await t.test('old availability never overwrites a newer large-party search', async () => {
      controls.holdParty = '2';
      await page.locator('#guests').selectOption('2');
      await until(() => controls.held.length > 0, 'availability was not held');
      await page.locator('#guests').selectOption('20');
      await page.locator('#status').filter({ hasText: '0 restaurante(s)' }).waitFor();
      controls.holdParty = null; controls.held.splice(0).forEach(release => release());
      await page.waitForLoadState('networkidle');
      assert.equal(await page.getByRole('button', { name: 'Ver y reservar', exact: true }).count(), 0);
      assert.equal(await page.locator('#time option').count(), 0);
      assert.equal(await page.locator('#guests option').count(), 30);
    });

    await t.test('reload recovers a lost-response receipt from the server', async () => {
      await choose(page, url, fixture, '19:00'); controls.loseCreate = true;
      await page.locator('#confirm').click();
      await page.locator('#bookStatus').filter({ hasText: 'todavía no se pudo verificar' }).waitFor();
      await page.reload();
      await page.locator('#myBookings').filter({ hasText: 'Estado en servidor: Confirmada' }).waitFor();
      await page.locator('#recoveryBox').waitFor({ state: 'hidden' });
      assert.equal((await db.pool.query("select count(*)::integer as count from reservations where status='confirmed'")).rows[0].count, 1);
    });

    await t.test('two existing tabs preserve both private receipts after separate confirmations', async () => {
      const a = await context.newPage(); const b = await context.newPage();
      a.setDefaultTimeout(7000); b.setDefaultTimeout(7000);
      await choose(a, url, fixture, '10:00'); await choose(b, url, fixture, '13:00');
      await a.locator('#confirm').click();
      await a.locator('#bookStatus').filter({ hasText: 'confirmada y guardada' }).waitFor();
      await b.locator('#confirm').click();
      await b.locator('#bookStatus').filter({ hasText: 'confirmada y guardada' }).waitFor();
      await page.reload();
      await until(async () => await page.locator('#myBookings .card').count() === 3, 'a tab overwrote another tab receipt');
      assert.equal((await db.pool.query("select count(*)::integer as count from reservations where status='confirmed'")).rows[0].count, 3);
      await a.close(); await b.close();
    });

    await t.test('mobile layout has no overflow, browser check-in, or fake rewards', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload(); await page.locator('#serviceStatus').filter({ hasText: 'conectadas' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.equal(await page.getByRole('button', { name: 'Confirmar asistencia', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Recompensas', exact: true }).click();
      assert.match(await page.locator('#panelContent').textContent(), /No se acreditan puntos/);
      assert.equal(await page.locator('input[autocomplete="cc-number"]').count(), 0);
      assert.deepEqual(errors, []);
    });
    await context.close();

    await t.test('unconfigured service and corrupt legacy storage cannot create fake confirmations', async () => {
      delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SECRET_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      const offline = await browser.newContext();
      await offline.route('https://images.unsplash.com/**', route => route.fulfill({ status: 204 }));
      await offline.addInitScript(() => { localStorage.setItem('mesalista-mvp', '{broken'); localStorage.setItem('mesalista-reservation-access-tokens', '{}'); });
      const p = await offline.newPage(); const failures = []; p.on('pageerror', error => failures.push(error.message));
      await p.goto(url);
      await p.locator('#serviceStatus').filter({ hasText: 'no están disponibles' }).waitFor();
      await p.getByRole('button', { name: 'Ver ejemplo', exact: true }).first().click();
      assert.equal(await p.locator('#confirm').count(), 0);
      assert.equal(await p.locator('#myBookings .card').count(), 0);
      assert.deepEqual(failures, []);
      await offline.close(); Object.assign(process.env, { SUPABASE_URL: originalEnv.url, SUPABASE_SECRET_KEY: originalEnv.secret });
    });
  } finally {
    controls.held.splice(0).forEach(release => release());
    await browser.close(); await new Promise(resolve => server.close(resolve)); await bridge.stop(); await db.stop();
  }
});
