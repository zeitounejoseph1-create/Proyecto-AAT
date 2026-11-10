const { createHash, randomBytes, randomUUID } = require('node:crypto');

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

const configured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const hashToken = value => createHash('sha256').update(value).digest('hex');

async function rpc(name, payload) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.message || 'Database request failed');
    error.databaseCode = body?.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'Method not allowed' });
  }
  if (!configured()) return json(res, 503, { error: 'Reservation service is not configured' });

  try {
    if (req.method === 'GET') {
      const { token, restaurant_id, date, party_size, mode } = req.query || {};
      if (!token && !restaurant_id && !date && !party_size && !mode) return json(res, 200, { configured: true });
      if (mode === 'restaurants') {
        const restaurants = await rpc('list_bookable_restaurants', {});
        return json(res, 200, { restaurants: Array.isArray(restaurants) ? restaurants : [] });
      }
      if (token) {
        if (typeof token !== 'string' || token.length < 40 || token.length > 200) return json(res, 400, { error: 'Invalid access token' });
        const reservation = await rpc('reservation_for_guest', { p_access_token_hash: hashToken(token) });
        if (!reservation) return json(res, 404, { error: 'Reservation not found' });
        return json(res, 200, { reservation });
      }
      if (typeof restaurant_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(restaurant_id) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isInteger(Number(party_size)) || Number(party_size) < 1 || Number(party_size) > 30) {
        return json(res, 400, { error: 'restaurant_id, date and party_size are required' });
      }
      const slots = await rpc('available_reservation_slots', { p_restaurant_id: restaurant_id, p_date: date, p_party_size: Number(party_size) });
      return json(res, 200, { slots: Array.isArray(slots) ? slots : [] });
    }

    const body = req.body || {};
    const { restaurant_id, date, time, party_size, name, email } = body;
    if (typeof restaurant_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(restaurant_id) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '') || !Number.isInteger(party_size) || party_size < 1 || party_size > 30 || typeof name !== 'string' || !name.trim() || name.trim().length > 120 || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return json(res, 400, { error: 'Restaurant, date, time, party size, name and valid email are required' });
    }
    const accessToken = typeof body.access_token === 'string' && body.access_token.length >= 40 ? body.access_token : randomBytes(32).toString('base64url');
    const idempotencyKey = typeof body.idempotency_key === 'string' && body.idempotency_key.length >= 16 ? body.idempotency_key : randomUUID();
    const reservation = await rpc('create_restaurant_reservation', {
      p_restaurant_id: restaurant_id,
      p_date: date,
      p_time: `${time}:00`,
      p_party_size: party_size,
      p_customer_name: name.trim(),
      p_customer_email: email.trim().toLowerCase(),
      p_access_token_hash: hashToken(accessToken),
      p_idempotency_key: idempotencyKey
    });
    return json(res, 201, { reservation, access_token: accessToken, idempotency_key: idempotencyKey });
  } catch (error) {
    if (error.databaseCode === 'P0001' || error.databaseCode === '23P01' || error.databaseCode === '23505') {
      return json(res, 409, { error: error.message || 'That table is no longer available. Choose another time.' });
    }
    console.error('Reservation API error:', error.message);
    return json(res, 500, { error: 'Could not complete the reservation' });
  }
};
