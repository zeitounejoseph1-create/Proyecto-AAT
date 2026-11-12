const { createHash } = require('node:crypto');

const RPC_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{40,200}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,100}$/;
const STATUSES = new Set(['pending', 'confirmed', 'cancelled', 'attended', 'no_show']);
const RESERVATION_FIELDS = ['id', 'restaurant_id', 'table_id', 'table_label', 'party_size', 'date', 'time', 'status', 'starts_at', 'ends_at', 'restaurant_name', 'address', 'image_url', 'timezone'];
const RESTAURANT_FIELDS = ['id', 'name', 'cuisine', 'price', 'address', 'latitude', 'longitude', 'rating', 'image_url', 'price_per_person', 'reservation_minutes', 'tables', 'weekly_hours', 'menu', 'cancellation_policy', 'timezone'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const onlyKeys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const hashToken = value => createHash('sha256').update(value).digest('hex');

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(JSON.stringify(body));
};
const invalid = (res, message = 'Revisa los datos de la solicitud.') => json(res, 400, { error: message, code: 'INVALID_REQUEST' });

function configuration() {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.startsWith('sb_publishable_')) return null;
  try {
    const url = new URL(process.env.SUPABASE_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
    return { base: url.origin, key };
  } catch {
    return null;
  }
}

function validDate(value) {
  if (!matches(/^(?!0000)\d{4}-\d{2}-\d{2}$/, value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return matches(/^([01]\d|2[0-3]):(?:00|30)(?::00(?:\.0+)?)?$/, value);
}

function verifiedReservation(value, expected) {
  const timestamp = value => matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, value) && Number.isFinite(Date.parse(value));
  if (!object(value) || !matches(UUID, value.id) || !matches(UUID, value.restaurant_id) || !matches(UUID, value.table_id) || !Number.isInteger(value.party_size) || value.party_size < 1 || value.party_size > 30 || !validDate(value.date) || !validTime(value.time) || !STATUSES.has(value.status) || !timestamp(value.starts_at) || !timestamp(value.ends_at) || Date.parse(value.ends_at) <= Date.parse(value.starts_at)) {
    throw new Error('INVALID_DATABASE_RESPONSE');
  }
  if (expected && (value.restaurant_id.toLowerCase() !== expected.restaurant_id || value.date !== expected.date || value.time.slice(0, 5) !== expected.time || value.party_size !== expected.party_size)) {
    throw new Error('INVALID_DATABASE_RESPONSE');
  }
  return pick(value, RESERVATION_FIELDS);
}

async function rpc(config, name, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const headers = { apikey: config.key, 'Content-Type': 'application/json', Accept: 'application/json' };
    // Opaque sb_secret keys go only in apikey; legacy service_role JWTs also use Bearer.
    // https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
    if (!config.key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${config.key}`;
    const response = await fetch(`${config.base}/rest/v1/rpc/${name}`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error'
    });
    let body;
    try { body = await response.json(); } catch (error) {
      if (response.ok) throw error;
      body = null;
    }
    if (!response.ok) {
      const error = new Error('DATABASE_REQUEST_FAILED');
      error.databaseCode = object(body) && typeof body.code === 'string' ? body.code : undefined;
      error.status = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError' || error.name === 'TimeoutError') error.timedOut = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'Método no permitido.', code: 'METHOD_NOT_ALLOWED' });
  }
  const config = configuration();
  if (!config) return json(res, 503, { error: 'Reservation service is not configured', code: 'SERVICE_UNAVAILABLE' });

  let operation = 'read';
  try {
    if (req.method === 'GET') {
      const query = req.query || {};
      if (!onlyKeys(query, ['token', 'restaurant_id', 'date', 'party_size', 'mode'])) return invalid(res);
      const { token, restaurant_id, date, party_size, mode } = query;
      const authorization = req.headers?.authorization;
      if (authorization !== undefined && !matches(/^Bearer [A-Za-z0-9_-]{40,200}$/, authorization)) return invalid(res, 'El enlace de acceso no es válido.');
      const headerToken = authorization?.slice(7);
      if (headerToken && token) return invalid(res);
      const accessToken = headerToken || token;
      if (accessToken !== undefined) {
        if (!matches(ACCESS_TOKEN, accessToken) || Object.keys(query).some(key => key !== 'token')) return invalid(res, 'El enlace de acceso no es válido.');
        const result = await rpc(config, 'reservation_for_guest', { p_access_token_hash: hashToken(accessToken) });
        if (result === null) return json(res, 404, { error: 'No se encontró la reserva.', code: 'RESERVATION_NOT_FOUND' });
        return json(res, 200, { reservation: verifiedReservation(result) });
      }
      if (Object.keys(query).length === 0) return json(res, 200, { configured: true });
      if (mode === 'restaurants' && Object.keys(query).length === 1) {
        const result = await rpc(config, 'list_bookable_restaurants', {});
        if (!Array.isArray(result) || result.some(item => !object(item) || !matches(UUID, item.id) || typeof item.name !== 'string' || !item.name.trim())) throw new Error('INVALID_DATABASE_RESPONSE');
        return json(res, 200, { restaurants: result.map(item => pick(item, RESTAURANT_FIELDS)) });
      }
      if (mode !== undefined || !matches(UUID, restaurant_id) || !validDate(date) || !matches(/^(?:[1-9]|[12]\d|30)$/, party_size) || Object.keys(query).length !== 3) return invalid(res, 'Selecciona un restaurante, una fecha válida y entre 1 y 30 personas.');
      const result = await rpc(config, 'available_reservation_slots', { p_restaurant_id: restaurant_id.toLowerCase(), p_date: date, p_party_size: Number(party_size) });
      if (!Array.isArray(result) || result.some(item => !object(item) || !validTime(item.slot) || !matches(UUID, item.table_id) || typeof item.table_label !== 'string')) throw new Error('INVALID_DATABASE_RESPONSE');
      return json(res, 200, { slots: result.map(item => pick(item, ['slot', 'table_id', 'table_label'])) });
    }

    const contentType = req.headers?.['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;.*)?$/i.test(contentType)) return json(res, 415, { error: 'Envía la solicitud como JSON.', code: 'INVALID_CONTENT_TYPE' });
    let body = req.body;
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) return json(res, 413, { error: 'La solicitud es demasiado grande.', code: 'REQUEST_TOO_LARGE' });
      try { body = JSON.parse(body); } catch { return invalid(res); }
    }
    if (!object(body)) return invalid(res);
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return json(res, 413, { error: 'La solicitud es demasiado grande.', code: 'REQUEST_TOO_LARGE' });

    if (body.action === 'cancel') {
      if (!onlyKeys(body, ['action', 'access_token']) || !matches(ACCESS_TOKEN, body.access_token)) return invalid(res, 'El enlace de acceso no es válido.');
      operation = 'cancel';
      const result = await rpc(config, 'cancel_restaurant_reservation', { p_access_token_hash: hashToken(body.access_token) });
      if (result === null) return json(res, 404, { error: 'No se encontró la reserva.', code: 'RESERVATION_NOT_FOUND' });
      const reservation = verifiedReservation(result);
      if (reservation.status !== 'cancelled') throw new Error('INVALID_DATABASE_RESPONSE');
      return json(res, 200, { reservation });
    }

    if (!onlyKeys(body, ['action', 'restaurant_id', 'date', 'time', 'party_size', 'name', 'email', 'access_token', 'idempotency_key']) || (body.action !== undefined && body.action !== 'create')) return invalid(res);
    const { restaurant_id, date, time, party_size, name, email, access_token, idempotency_key } = body;
    const customerName = typeof name === 'string' ? name.trim() : '';
    const customerEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!matches(UUID, restaurant_id) || !validDate(date) || !matches(/^([01]\d|2[0-3]):(?:00|30)$/, time) || !Number.isInteger(party_size) || party_size < 1 || party_size > 30 || !customerName || customerName.length > 120 || /[\u0000-\u001f\u007f]/.test(customerName) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) || customerEmail.length > 254 || /[\u0000-\u001f\u007f]/.test(customerEmail) || !matches(ACCESS_TOKEN, access_token) || !matches(IDEMPOTENCY_KEY, idempotency_key)) return invalid(res, 'Revisa restaurante, fecha, horario, personas, nombre, correo y claves de la solicitud.');

    operation = 'create';
    const expected = { restaurant_id: restaurant_id.toLowerCase(), date, time, party_size };
    const result = await rpc(config, 'create_restaurant_reservation', {
      p_restaurant_id: expected.restaurant_id, p_date: date, p_time: `${time}:00`, p_party_size: party_size,
      p_customer_name: customerName, p_customer_email: customerEmail,
      p_access_token_hash: hashToken(access_token), p_idempotency_key: idempotency_key
    });
    const reservation = verifiedReservation(result, expected);
    if (reservation.status === 'cancelled') return json(res, 409, { error: 'Esta solicitud corresponde a una reserva cancelada. Inicia una nueva reserva.', code: 'RESERVATION_CANCELLED', reservation });
    if (reservation.status !== 'confirmed') throw new Error('INVALID_DATABASE_RESPONSE');
    return json(res, 201, { reservation, access_token, idempotency_key });
  } catch (error) {
    if (error.databaseCode === '22023') return invalid(res);
    if (['P0001', '23P01', '23505'].includes(error.databaseCode)) return json(res, 409, {
      error: operation === 'cancel' ? 'Esta reserva ya no se puede cancelar.' : 'No se pudo aceptar esta solicitud. Consulta la disponibilidad o inicia una nueva reserva si cambiaste los datos.',
      code: 'RESERVATION_CONFLICT'
    });
    // Do not log database messages: they can contain customer data or request secrets.
    console.error('Reservation API failure', { operation, databaseCode: error.databaseCode, status: error.status, timedOut: Boolean(error.timedOut) });
    const write = operation !== 'read';
    return json(res, error.timedOut ? 504 : 502, {
      error: write ? 'No pudimos verificar el resultado. Reintenta la misma solicitud con las mismas claves para consultar su estado sin duplicarla.' : 'No se pudo consultar el servicio de reservaciones. Intenta de nuevo.',
      code: write ? 'RESERVATION_UNVERIFIED' : 'SERVICE_UNAVAILABLE', retryable: true
    });
  }
};
