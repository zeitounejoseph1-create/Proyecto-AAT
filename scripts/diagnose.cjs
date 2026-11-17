// Read-only diagnostics: no POST/PUT/PATCH/DELETE, credentials or customer tokens are sent.
const { existsSync } = require('node:fs');
const path = require('node:path');

function environmentSummary(env = process.env) {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  let urlValid = false;
  try {
    const url = new URL(env.SUPABASE_URL);
    const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    urlValid = (url.protocol === 'https:' || (local && url.protocol === 'http:')) && !url.username && !url.password && !url.search && !url.hash && ['', '/'].includes(url.pathname);
  } catch {}
  return { env_local_exists: existsSync(path.join(__dirname,'../.env.local')), url_present: Boolean(env.SUPABASE_URL), url_valid: Boolean(urlValid), private_key_present: Boolean(key), key_kind: !key ? 'missing' : key.startsWith('sb_secret_') ? 'secret' : key.startsWith('sb_publishable_') ? 'publishable_invalid_for_server' : 'legacy_or_other' };
}
async function get(base, suffix) {
  const response = await fetch(base + suffix, { method: 'GET', headers: { Accept: suffix === '/' ? 'text/html' : 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  const text = await response.text();
  let body; if (suffix !== '/') { try { body = JSON.parse(text); } catch {} }
  return { response, body, text };
}
async function diagnose(base, emit = value => console.log(JSON.stringify(value))) {
  const summary = { origin: base, reads_only: true, healthy: true };
  const page = await get(base,'/');
  summary.healthy = page.response.ok;
  emit({ check: 'page', status: page.response.status, app_script: page.text.includes('/assets/app.js') ? 'external' : 'legacy_or_other', ok: page.response.ok });
  const health = await get(base,'/api/reservations');
  emit({ check: 'api_configuration', status: health.response.status, configured: health.body?.configured === true, code: health.body?.code || null });
  if (!health.response.ok || health.body?.configured !== true) { summary.healthy = false; return summary; }
  const result = await get(base,'/api/reservations?mode=restaurants');
  const list = result.body?.restaurants;
  const valid = result.response.ok && Array.isArray(list) && list.every(r => typeof r?.id === 'string' && typeof r?.name === 'string');
  emit({ check: 'public_catalog', status: result.response.status, valid_contract: valid, eligible_count: valid ? list.length : null, total_database_count: 'requires_authorized_sql_read', code: result.body?.code || null });
  if (!valid) { summary.healthy = false; return summary; }
  for (const restaurant of list.slice(0,3)) {
    const tomorrow = new Date(Date.now() + 86400000);
    let date;
    try { date = new Intl.DateTimeFormat('en-CA',{timeZone:restaurant.timezone || 'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(tomorrow); }
    catch { date = tomorrow.toISOString().slice(0,10); }
    for (const party of [2,20]) {
      const slots = await get(base,'/api/reservations?restaurant_id='+encodeURIComponent(restaurant.id)+'&date='+encodeURIComponent(date)+'&party_size='+party);
      const good = slots.response.ok && Array.isArray(slots.body?.slots);
      emit({ check: 'availability', restaurant_id: restaurant.id, date, party_size: party, status: slots.response.status, valid_contract: good, slot_count: good ? slots.body.slots.length : null, code: slots.body?.code || null });
      summary.healthy &&= good;
    }
  }
  return summary;
}
if (require.main === module) {
  const mode = process.argv[2] || 'local';
  if (!['local','public'].includes(mode)) { console.error('Use: node scripts/diagnose.cjs local|public'); process.exitCode = 1; }
  else {
    console.log(JSON.stringify({ check: 'local_environment_names_only', ...environmentSummary() }));
    const base = mode === 'public' ? 'https://proyecto-aat.vercel.app' : 'http://127.0.0.1:'+(process.env.PORT || 3000);
    diagnose(base).then(result => { console.log(JSON.stringify(result)); if (!result.healthy) process.exitCode = 2; }).catch(error => { console.error(JSON.stringify({ check:'network', origin:base, error_type:error.name, healthy:false })); process.exitCode = 2; });
  }
}
module.exports = { environmentSummary, diagnose };
