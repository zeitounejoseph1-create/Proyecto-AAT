/* MesaLista: the server is the authority for availability and reservations. */
(() => {
  'use strict';
  const API = '/api/reservations';
  const KEYS = { demo: 'mesalista-demo-restaurants-v2', tokens: 'mesalista-reservation-access-tokens', receiptPrefix: 'mesalista-receipt-v1:', pending: 'mesalista-pending-reservation-v1', pendingPrefix: 'mesalista-request-v2:' };
  const $ = id => document.getElementById(id);
  const days = [['sun', 'Domingo'], ['mon', 'Lunes'], ['tue', 'Martes'], ['wed', 'Miércoles'], ['thu', 'Jueves'], ['fri', 'Viernes'], ['sat', 'Sábado']];
  const money = value => value == null ? 'Precio por consultar' : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(value) + ' MXN';
  const formatTime = value => /^\d{2}:\d{2}/.test(value || '') ? new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' }).format(new Date('2000-01-01T' + value.slice(0, 5) + ':00Z')) : 'Sin horario';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const normalized = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const state = { mode: 'loading', restaurants: [], reservations: [], tokens: [], pending: null, recoveryMessage: '', reservationRevisions: new Map(), availability: new Map(), generation: 0, loading: false, failed: false, submitting: false, bookingView: 'upcoming', coords: null };

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text != null) item.textContent = String(text);
    if (className) item.className = className;
    return item;
  }
  function button(text, action, className = 'btn') {
    const item = node('button', text, className);
    item.type = 'button';
    item.addEventListener('click', action);
    return item;
  }
  function option(value, text) { const item = node('option', text); item.value = value; return item; }
  function read(key, fallback) {
    try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); }
    catch { return fallback; }
  }
  function write(key, value) {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  }
  const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{40,200}$/.test(value);
  function storageKeys(prefix) { try { return Object.keys(localStorage).filter(key => key.startsWith(prefix)); } catch { return []; } }
  function savedTokens() {
    const legacy = read(KEYS.tokens, []);
    return [...new Set([...(Array.isArray(legacy) ? legacy : []), ...storageKeys(KEYS.receiptPrefix).map(key => key.slice(KEYS.receiptPrefix.length))].filter(validToken))];
  }
  const validDraft = draft => draft?.payload && validToken(draft.payload.access_token) && /^[A-Za-z0-9_-]{16,100}$/.test(draft.payload.idempotency_key || '');
  const pendingKey = draft => KEYS.pendingPrefix + draft.payload.idempotency_key;
  function savedPending() { return storageKeys(KEYS.pendingPrefix).map(key => read(key, null)).find(validDraft) || null; }
  const safeImage = value => {
    if (typeof value === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
    try { const url = new URL(value, location.origin); return url.protocol === 'https:' || (url.origin === location.origin && url.protocol === location.protocol) ? url.href : ''; }
    catch { return ''; }
  };
  function photo(src, alt) {
    const img = node('img');
    const url = safeImage(src);
    if (url) img.src = url;
    img.alt = alt;
    img.loading = 'lazy';
    return img;
  }
  function filters() { return { q: normalized($('q').value), cuisine: $('cuisine').value, price: Number($('price').value), date: $('date').value, party: Number($('guests').value), time: $('time').value }; }
  function matches(restaurant, f) { return (!f.q || normalized(restaurant.name).includes(f.q)) && (!f.cuisine || restaurant.cuisine === f.cuisine) && (!f.price || (restaurant.pricePerPerson != null && restaurant.pricePerPerson <= f.price)); }
  function hasSlot(restaurant, f) {
    const result = state.availability.get(restaurant.id);
    return !!result && result.date === f.date && result.party === f.party && result.slots.some(slot => slot.slot.slice(0, 5) === f.time);
  }
  async function request(params = '', options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await fetch(API + params, { ...options, headers: { Accept: 'application/json', ...options.headers }, cache: 'no-store', signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== 'object') {
        const error = new Error(payload?.error || 'No se pudo verificar la operación con el servidor.');
        error.status = response.status;
        error.code = payload?.code;
        error.reservation = payload?.reservation;
        throw error;
      }
      return payload;
    } finally { clearTimeout(timeout); }
  }
  function post(payload) { return request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }

  // Preserve the existing restaurant examples separately from the live catalogue.
  const examples = [
    { id: 'maiz', name: 'Maíz de Barrio', cuisine: 'Mexicana', address: 'Roma Norte, CDMX', lat: 19.421, lng: -99.168, pricePerPerson: 200, img: 'https://images.unsplash.com/photo-1551504734-5ee1c4a1479b?auto=format&fit=crop&w=800&q=80', menu: [['Tostada de atún', 185], ['Mole negro', 265]], tables: [['M1', 2], ['M2', 4], ['M3', 6]] },
    { id: 'roma', name: 'Trattoria Roma', cuisine: 'Italiana', address: 'Condesa, CDMX', lat: 19.412, lng: -99.177, pricePerPerson: 400, img: 'https://images.unsplash.com/photo-1551183053-bf91a1d81141?auto=format&fit=crop&w=800&q=80', menu: [['Burrata', 220], ['Pasta fresca', 310]], tables: [['R1', 2], ['R2', 4], ['R3', 8]] },
    { id: 'nori', name: 'Nori House', cuisine: 'Japonesa', address: 'Juárez, CDMX', lat: 19.429, lng: -99.160, pricePerPerson: 400, img: 'https://images.unsplash.com/photo-1579871494447-9811cf80d66c?auto=format&fit=crop&w=800&q=80', menu: [['Nigiri', 540], ['Ramen', 245]], tables: [['N1', 2], ['N2', 4], ['N3', 6]] }
  ];
  let demo = read(KEYS.demo, null);
  if (!Array.isArray(demo)) {
    const legacy = read('mesalista-mvp', {});
    demo = Array.isArray(legacy?.restaurants) ? legacy.restaurants.filter(r => typeof r?.id === 'string' && !/^[0-9a-f-]{36}$/i.test(r.id)) : examples;
  }
  demo = demo.filter(r => r && typeof r.id === 'string' && typeof r.name === 'string' && Array.isArray(r.tables)).map(r => ({ ...r, menu: Array.isArray(r.menu) ? r.menu : [], demo: true, pricePerPerson: Number(r.pricePerPerson || String(r.price || '').replace(/\D/g, '')) || null }));
  if (!demo.length) demo = examples.map(r => ({ ...r, demo: true }));
  state.tokens = savedTokens();
  const legacyPending = read(KEYS.pending, null);
  if (validDraft(legacyPending) && write(pendingKey(legacyPending), legacyPending)) write(KEYS.pending, null);
  state.pending = savedPending() || (validDraft(legacyPending) ? legacyPending : null);

  function updateCuisine() {
    const selected = $('cuisine').value;
    $('cuisine').replaceChildren(option('', 'Todas'), ...[...new Set(state.restaurants.map(r => r.cuisine))].sort().map(c => option(c, c)));
    if ([...$('cuisine').options].some(o => o.value === selected)) $('cuisine').value = selected;
  }
  function render() {
    const f = filters();
    const candidates = state.restaurants.filter(r => matches(r, f));
    const list = state.mode === 'online' ? candidates.filter(r => hasSlot(r, f)) : candidates;
    $('results').replaceChildren();
    if (state.mode === 'loading') { $('status').textContent = 'Conectando con el servicio de reservas…'; return; }
    if (state.loading) { $('status').textContent = 'Consultando disponibilidad en el servidor…'; return; }
    $('status').textContent = state.mode === 'online' ? (state.failed ? 'No pudimos consultar todos los horarios. Vuelve a buscar. ' : '') + (list.length + ' restaurante(s) con disponibilidad consultada para ' + f.party + ' personas' + (f.time ? ' a las ' + formatTime(f.time) : '') + '.') : 'Catálogo de ejemplo. No representa disponibilidad ni restaurantes publicados.';
    for (const restaurant of list) {
      const card = node('article', null, 'card');
      card.append(photo(restaurant.img, restaurant.demo ? 'Fotografía ilustrativa' : restaurant.name));
      if (!restaurant.hasOwnPhoto) card.append(node('small', 'Fotografía ilustrativa', 'illustration'));
      const pad = node('div', null, 'pad');
      pad.append(node('span', restaurant.demo ? 'EJEMPLO · ' + restaurant.cuisine : restaurant.cuisine, 'tag'), node('h3', restaurant.name), node('p', restaurant.address), node('p', money(restaurant.pricePerPerson) + ' por persona'));
      pad.append(node('p', restaurant.rating == null ? 'Sin calificación verificada' : 'Calificación verificada: ' + restaurant.rating + ' / 5'));
      const footer = node('div', null, 'card-footer');
      footer.append(node('span', restaurant.demo ? 'Reserva real no disponible' : formatTime(f.time)), button(restaurant.demo ? 'Ver ejemplo' : 'Ver y reservar', () => show(restaurant.id), 'btn primary'));
      pad.append(footer); card.append(pad); $('results').append(card);
    }
    if (!list.length) $('results').append(node('p', state.mode === 'online' ? 'No hay mesas con esos criterios. Cambia la fecha, hora o personas.' : 'No hay ejemplos con esos criterios.'));
  }

  let searchTimer;
  function scheduleSearch() { clearTimeout(searchTimer); refreshAvailability(); }
  async function refreshAvailability() {
    const generation = ++state.generation;
    const f = filters();
    state.availability.clear();
    if (state.mode !== 'online') { state.loading = false; render(); return; }
    state.loading = true; state.failed = false; render();
    const candidates = state.restaurants.filter(r => matches(r, f));
    const results = await Promise.all(candidates.map(async restaurant => {
      try {
        const data = await request('?restaurant_id=' + encodeURIComponent(restaurant.id) + '&date=' + encodeURIComponent(f.date) + '&party_size=' + f.party);
        if (!Array.isArray(data.slots)) throw new Error('Respuesta de disponibilidad inválida');
        return { id: restaurant.id, slots: data.slots };
      } catch { return { id: restaurant.id, error: true, slots: [] }; }
    }));
    if (generation !== state.generation) return;
    const times = new Set();
    for (const result of results) {
      state.failed ||= !!result.error;
      state.availability.set(result.id, { date: f.date, party: f.party, slots: result.slots });
      result.slots.forEach(slot => times.add(String(slot.slot).slice(0, 5)));
    }
    $('time').replaceChildren(...[...times].sort().map(time => option(time, formatTime(time))));
    if (times.has(f.time)) $('time').value = f.time;
    state.loading = false;
    render();
  }

  function show(id) {
    const restaurant = state.restaurants.find(r => r.id === id);
    if (!restaurant) return;
    const f = { ...filters() };
    const content = $('modalContent');
    content.replaceChildren(node('h2', restaurant.name), node('p', restaurant.address + ' · ' + restaurant.cuisine), node('p', money(restaurant.pricePerPerson) + ' por persona'), node('h3', 'Menú'));
    const menu = node('ul', null, 'menu-items');
    for (const item of restaurant.menu) { const li = node('li'); li.append(node('span', item[0]), node('span', money(item[1]))); menu.append(li); }
    content.append(menu.childElementCount ? menu : node('p', 'Menú pendiente de actualizar.'), node('h3', 'Horarios'));
    if (restaurant.weeklyHours) for (const [key, label] of days) { const h = restaurant.weeklyHours[key]; if (h) content.append(node('p', label + ': ' + (h.closed ? 'Cerrado' : formatTime(h.open) + ' – ' + formatTime(h.close) + (h.closes_next_day ? ' del día siguiente' : '')))); }
    else content.append(node('p', 'Horarios de ejemplo pendientes de configurar.'));
    if (restaurant.demo || state.mode !== 'online') { content.append(node('p', 'Este perfil es un ejemplo. No se pueden confirmar reservas reales.', 'notice')); $('modal').showModal(); return; }
    if (state.loading || !hasSlot(restaurant, f)) { content.append(node('p', 'Actualiza la búsqueda para seleccionar un horario disponible.', 'notice')); $('modal').showModal(); return; }
    content.append(node('h3', 'Reservar'), node('p', f.party + ' personas · ' + f.date + ' · ' + formatTime(f.time)), node('p', 'Zona horaria: ' + restaurant.timezone), node('p', restaurant.policy));
    const form = node('form', null, 'booking-form'); form.id = 'bookingForm';
    for (const [inputId, labelText, type, max] of [['bookName', 'NOMBRE', 'text', 120], ['bookEmail', 'CORREO', 'email', 254]]) {
      const label = node('label', labelText, 'field');
      const input = node('input'); input.id = inputId; input.name = inputId; input.type = type; input.required = true; input.maxLength = max; input.autocomplete = type === 'email' ? 'email' : 'name'; label.append(input); form.append(label);
    }
    const accept = node('label', null, 'policy-accept');
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.id = 'acceptPolicy'; checkbox.required = true;
    accept.append(checkbox, node('span', 'Acepto la política de cancelación indicada por este restaurante. No se solicita ni se cobra una tarjeta.'));
    const submit = node('button', 'Confirmar mesa', 'btn lime'); submit.type = 'submit'; submit.id = 'confirm';
    const status = node('p', '', 'notice'); status.id = 'bookStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    form.append(accept, submit, status); content.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (state.submitting || form.dataset.completed || !form.reportValidity()) return;
      state.pending ||= savedPending();
      if (state.pending) { renderRecovery(); status.textContent = 'Hay una solicitud pendiente. Resuélvela con el botón de recuperación antes de reservar otra mesa.'; return; }
      const token = new Uint8Array(32); crypto.getRandomValues(token);
      const draft = { restaurantName: restaurant.name, payload: { restaurant_id: id, date: f.date, time: f.time, party_size: f.party, name: $('bookName').value.trim(), email: $('bookEmail').value.trim(), access_token: btoa(String.fromCharCode(...token)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), idempotency_key: crypto.randomUUID() } };
      if (!draft.payload.name) { status.textContent = 'Escribe tu nombre.'; return; }
      if (!write(pendingKey(draft), draft)) { status.textContent = 'Permite el almacenamiento de este sitio para guardar el comprobante privado antes de enviar la reserva.'; return; }
      form.dataset.accessToken = draft.payload.access_token;
      state.pending = draft; state.recoveryMessage = ''; renderRecovery();
      await submitPending(status, submit);
    });
    $('modal').showModal();
  }

  function validReservation(item) { return !!item && typeof item.id === 'string' && typeof item.restaurant_id === 'string' && ['confirmed', 'cancelled', 'pending', 'attended', 'no_show'].includes(item.status) && typeof item.starts_at === 'string'; }
  function upsertReservation(item, token) {
    state.reservationRevisions.set(token, (state.reservationRevisions.get(token) || 0) + 1);
    const entry = { ...item, token };
    const index = state.reservations.findIndex(r => r.id === item.id);
    if (index < 0) state.reservations.push(entry); else state.reservations[index] = entry;
    renderBookings();
  }
  function rememberToken(token) { state.tokens = [...new Set([...state.tokens, ...savedTokens(), token])]; return write(KEYS.receiptPrefix + token, true); }
  function clearPending(draft = state.pending) {
    if (draft) {
      write(pendingKey(draft), null);
      if (read(KEYS.pending, null)?.payload?.idempotency_key === draft.payload.idempotency_key) write(KEYS.pending, null);
    }
    if (state.pending?.payload.idempotency_key === draft?.payload.idempotency_key) state.pending = savedPending();
    renderRecovery();
  }
  async function submitPending(status = $('recoveryStatus'), submit) {
    if (!state.pending || state.submitting) return;
    const draft = state.pending;
    state.submitting = true; if (submit) submit.disabled = true;
    status.textContent = 'Verificando y guardando la reserva en el servidor…';
    try {
      const data = await post(draft.payload);
      if (!validReservation(data.reservation) || data.reservation.status !== 'confirmed') throw new Error('Respuesta no verificada');
      upsertReservation(data.reservation, draft.payload.access_token);
      if ($('bookingForm')?.dataset.accessToken === draft.payload.access_token) $('bookingForm').dataset.completed = 'true';
      const persisted = rememberToken(draft.payload.access_token);
      if (persisted) clearPending(draft);
      status.textContent = 'Reservación confirmada y guardada en el servidor. Referencia: ' + data.reservation.id + (persisted ? '.' : '. Conserva esta página abierta para recuperar tu comprobante.');
      $('bookingListStatus').textContent = 'Reserva confirmada por el servidor.';
      await refreshAvailability();
    } catch (error) {
      if (error.status === 400 || error.status === 409) {
        if (validReservation(error.reservation)) { rememberToken(draft.payload.access_token); upsertReservation(error.reservation, draft.payload.access_token); }
        clearPending(draft);
        status.textContent = error.status === 409 ? 'El servidor no confirmó esta solicitud: ' + error.message + ' Actualiza los horarios.' : 'Revisa los datos: ' + error.message;
        await refreshAvailability();
      } else status.textContent = 'El resultado todavía no se pudo verificar. Usa «Recuperar o reintentar»; conservará el mismo folio para evitar duplicados.';
    } finally { state.recoveryMessage = status.textContent; state.submitting = false; if (submit) submit.disabled = !!submit.closest('form')?.dataset.completed; renderRecovery(); }
  }
  function renderRecovery() {
    const box = $('recoveryBox'); box.hidden = !state.pending;
    box.replaceChildren();
    if (!state.pending) return;
    const status = node('p', state.recoveryMessage, 'notice'); status.id = 'recoveryStatus'; status.setAttribute('role', 'status');
    const retry = button('Recuperar o reintentar', () => submitPending(status, retry), 'btn primary'); retry.disabled = state.submitting;
    box.append(node('h3', 'Solicitud pendiente de verificar'), node('p', state.pending.restaurantName + ' · ' + state.pending.payload.date + ' · ' + formatTime(state.pending.payload.time)), node('p', 'Conservamos la misma solicitud hasta conocer su resultado. Al reintentar no se genera una segunda reserva.'), retry, status);
  }

  async function syncReservations() {
    $('refreshBookings').disabled = true;
    let failures = 0;
    state.tokens = [...new Set([...state.tokens, ...savedTokens()])];
    const toCheck = [...state.tokens];
    if (state.pending && !toCheck.includes(state.pending.payload.access_token)) toCheck.push(state.pending.payload.access_token);
    for (const token of toCheck) {
      const revision = state.reservationRevisions.get(token) || 0;
      try {
        const data = await request('', { headers: { Authorization: 'Bearer ' + token } });
        if ((state.reservationRevisions.get(token) || 0) !== revision) continue;
        if (!validReservation(data.reservation)) throw new Error('Reserva inválida');
        upsertReservation(data.reservation, token);
        if (state.pending?.payload.access_token === token && rememberToken(token)) clearPending();
      } catch (error) {
        if ((state.reservationRevisions.get(token) || 0) !== revision) continue;
        // A lost response can still be committing. Only an idempotent retry resolves it.
        if (!(error.status === 404 && state.pending?.payload.access_token === token)) failures++;
        state.reservations = state.reservations.filter(r => r.token !== token);
      }
    }
    $('bookingListStatus').textContent = failures ? 'No pudimos verificar ' + failures + ' comprobante(s). Vuelve a actualizar; no se muestran como confirmados sin respuesta del servidor.' : (state.reservations.length ? 'Estados consultados en el servidor.' : 'No hay reservas verificadas en este navegador.');
    $('refreshBookings').disabled = false;
    renderBookings();
  }
  function renderBookings() {
    $('myBookings').replaceChildren();
    const list = state.reservations.filter(r => state.bookingView === 'cancelled' ? r.status === 'cancelled' : state.bookingView === 'completed' ? r.status !== 'cancelled' && (Date.parse(r.starts_at) < Date.now() || ['attended', 'no_show'].includes(r.status)) : ['confirmed', 'pending'].includes(r.status) && Date.parse(r.starts_at) >= Date.now());
    const names = { confirmed: 'Confirmada', cancelled: 'Cancelada', pending: 'Pendiente', attended: 'Asistencia verificada', no_show: 'Sin asistencia' };
    for (const reservation of list) {
      const restaurant = state.restaurants.find(r => r.id === reservation.restaurant_id);
      const card = node('article', null, 'card'); const pad = node('div', null, 'pad');
      pad.append(node('h3', reservation.restaurant_name || restaurant?.name || 'Restaurante'), node('p', reservation.date + ' · ' + formatTime(reservation.time) + ' · ' + reservation.party_size + ' personas'), node('p', 'Estado en servidor: ' + names[reservation.status]), node('p', 'Referencia: ' + reservation.id));
      if (reservation.status === 'confirmed' && Date.parse(reservation.starts_at) > Date.now()) {
        const status = node('p', '', 'notice'); status.setAttribute('role', 'status');
        const cancel = button('Cancelar reserva', () => {
          cancel.hidden = true;
          const confirm = button('Sí, cancelar mi reserva', async () => {
            state.reservationRevisions.set(reservation.token, (state.reservationRevisions.get(reservation.token) || 0) + 1);
            confirm.disabled = true; status.textContent = 'Cancelando en el servidor…';
            try {
              const data = await post({ action: 'cancel', access_token: reservation.token });
              if (!validReservation(data.reservation) || data.reservation.status !== 'cancelled') throw new Error('Cancelación no verificada');
              upsertReservation(data.reservation, reservation.token); await refreshAvailability();
              $('bookingListStatus').textContent = 'Cancelación guardada en el servidor. La mesa vuelve a estar disponible.';
            } catch { status.textContent = 'No pudimos verificar la cancelación. Actualiza la reserva antes de intentarlo de nuevo.'; confirm.disabled = false; }
          });
          pad.append(node('p', '¿Confirmas la cancelación? Esta acción libera tu mesa.'), confirm, button('Conservar reserva', renderBookings));
        });
        pad.append(cancel, status);
      }
      card.append(pad); $('myBookings').append(card);
    }
    if (!list.length) $('myBookings').append(node('p', 'No hay reservas verificadas en esta categoría.'));
  }

  function panel(view) {
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    const text = view === 'rewards' ? 'Los puntos y niveles se habilitarán con asistencia verificada por el personal. No se acreditan puntos desde el navegador.' : view === 'subscription' ? 'La suscripción semanal tendrá precios configurables. No hay cobros ni activaciones de pago desde esta vista.' : view === 'tables' ? 'La configuración real de mesas y bloqueos requiere iniciar sesión como personal autorizado del restaurante. Puedes probar horarios y capacidad en el editor de ejemplos.' : 'Consulta tus comprobantes en «Reservaciones en este navegador». La administración de reservas de un restaurante requiere el panel privado con permisos.';
    $('panelContent').replaceChildren(node('p', text));
  }
  function renderNearby() {
    if (!state.coords) return;
    const radians = value => value * Math.PI / 180;
    const distance = r => {
      const a = Math.sin(radians(r.lat - state.coords.lat) / 2) ** 2 + Math.cos(radians(state.coords.lat)) * Math.cos(radians(r.lat)) * Math.sin(radians(r.lng - state.coords.lng) / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    const list = state.restaurants.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng)).map(r => ({ r, km: distance(r) })).sort((a, b) => a.km - b.km);
    $('nearbyList').replaceChildren(...list.map(({ r, km }) => { const card = node('article', null, 'near'); card.append(photo(r.img, r.name), button(r.name, () => show(r.id)), node('p', km.toFixed(1) + ' km · ' + r.address + (r.demo ? ' · Ejemplo ilustrativo' : ''))); return card; }));
    if (!list.length) $('nearbyList').append(node('p', 'No hay ubicaciones disponibles para este catálogo.'));
  }
  function locate() {
    if (!navigator.geolocation) { $('geoStatus').textContent = 'Tu navegador no permite compartir ubicación.'; return; }
    $('geoStatus').textContent = 'Solicitando ubicación…';
    navigator.geolocation.getCurrentPosition(position => { state.coords = { lat: position.coords.latitude, lng: position.coords.longitude }; $('geoStatus').textContent = 'Ubicación compartida para ordenar los restaurantes cercanos.'; renderNearby(); }, () => { $('geoStatus').textContent = 'No se compartió la ubicación. Puedes seguir buscando por nombre.'; }, { timeout: 10000, maximumAge: 60000 });
  }

  // Local configuration remains useful, but never modifies the live catalogue.
  let photoFiles = [];
  function defaultHours() { return Object.fromEntries(days.map(([key]) => [key, { closed: key === 'sun', open: '13:00', close: key === 'fri' || key === 'sat' ? '01:00' : '22:00' }])); }
  const times = Array.from({ length: 48 }, (_, i) => String(Math.floor(i / 2)).padStart(2, '0') + (i % 2 ? ':30' : ':00'));
  for (const [key, label] of days) {
    const row = node('div', null, 'schedule-row'); row.dataset.day = key; row.append(node('b', label));
    for (const [kind, text] of [['open', 'ABRE'], ['close', 'CIERRA']]) { const field = node('label', text, 'field'); const select = node('select'); select.dataset[kind] = ''; select.append(...times.map(t => option(t, formatTime(t)))); field.append(select); row.append(field); }
    const field = node('label', ' Cerrado'); const input = node('input'); input.type = 'checkbox'; input.dataset.closed = ''; field.prepend(input); row.append(field);
    input.addEventListener('change', () => row.querySelectorAll('select').forEach(select => { select.disabled = input.checked; })); $('scheduleRows').append(row);
  }
  function setHours(hours) { for (const row of $('scheduleRows').children) { const h = hours[row.dataset.day] || { closed: true, open: '13:00', close: '22:00' }; row.querySelector('[data-open]').value = h.open; row.querySelector('[data-close]').value = h.close; row.querySelector('[data-closed]').checked = h.closed; row.querySelectorAll('select').forEach(s => { s.disabled = h.closed; }); } }
  function getHours() { return Object.fromEntries([...$('scheduleRows').children].map(row => [row.dataset.day, { open: row.querySelector('[data-open]').value, close: row.querySelector('[data-close]').value, closed: row.querySelector('[data-closed]').checked }])); }
  function updateEditor() { $('editRestaurantSelect').replaceChildren(option('', 'Nuevo restaurante'), ...demo.map(r => option(r.id, r.name))); }
  updateEditor(); setHours(defaultHours());
  $('editRestaurantSelect').addEventListener('change', () => {
    const r = demo.find(item => item.id === $('editRestaurantSelect').value); photoFiles = [];
    $('newRestaurantName').value = r?.name || ''; $('newRestaurantAddress').value = r?.address || ''; $('newRestaurantCuisine').value = r?.cuisine || 'Mexicana'; $('newRestaurantPrice').value = r?.pricePerPerson || 300; $('newRestaurantCapacity').value = Math.max(1, ...(r?.tables || []).map(t => Number(t[1]))); setHours(r?.weeklyHours || defaultHours()); $('photoPreview').replaceChildren(); $('newRestaurantPhotos').value = '';
  });
  $('copyMonday').addEventListener('click', () => { const hours = getHours(); for (const [key] of days) if (!hours[key].closed) hours[key] = { ...hours.mon, closed: false }; setHours(hours); });
  $('newRestaurantPhotos').addEventListener('change', async event => {
    photoFiles = []; $('photoPreview').replaceChildren();
    const files = [...event.target.files].slice(0, 6);
    for (const file of files) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { $('restaurantStatus').textContent = 'Usa imágenes JPG, PNG o WebP de hasta 2 MB.'; continue; }
      const src = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(null); reader.readAsDataURL(file); });
      if (src) { photoFiles.push(src); const img = node('img'); img.src = src; img.alt = 'Vista previa local'; $('photoPreview').append(img); }
    }
  });
  $('restaurantForm').addEventListener('submit', event => {
    event.preventDefault(); const hours = getHours();
    if (!Object.values(hours).some(h => !h.closed)) { $('restaurantStatus').textContent = 'Selecciona al menos un día abierto.'; return; }
    if (Object.values(hours).some(h => !h.closed && (!h.open || !h.close || h.open === h.close))) { $('restaurantStatus').textContent = 'Usa horarios de apertura y cierre diferentes.'; return; }
    const existing = demo.find(r => r.id === $('editRestaurantSelect').value);
    const item = { ...existing, id: existing?.id || 'rest-' + crypto.randomUUID(), name: $('newRestaurantName').value.trim(), address: $('newRestaurantAddress').value.trim() || 'Ubicación pendiente', cuisine: $('newRestaurantCuisine').value, pricePerPerson: Number($('newRestaurantPrice').value), tables: [['T1', Number($('newRestaurantCapacity').value)]], menu: existing?.menu || [], weeklyHours: hours, demo: true, img: photoFiles[0] || existing?.img || examples[0].img };
    const next = existing ? demo.map(r => r.id === item.id ? item : r) : [...demo, item];
    if (!write(KEYS.demo, next)) { $('restaurantStatus').textContent = 'No se pudo guardar. Reduce el tamaño de las fotos o permite el almacenamiento del sitio.'; return; }
    demo = next; updateEditor(); $('editRestaurantSelect').value = item.id;
    if (state.mode === 'offline') { state.restaurants = demo; updateCuisine(); render(); renderNearby(); }
    $('restaurantStatus').textContent = 'Ejemplo guardado en este navegador. No se publicó ni se activó una suscripción.';
  });

  $('date').min = today; $('date').value = today;
  $('guests').replaceChildren(...Array.from({ length: 30 }, (_, i) => option(i + 1, (i + 1) + (i ? ' personas' : ' persona')))); $('guests').value = '2';
  $('price').replaceChildren(option('', 'Todos los precios'), ...[200, 400, 600, 800, 1000, 1500].map(amount => option(amount, 'Hasta ' + money(amount))));
  $('time').replaceChildren(...times.map(t => option(t, formatTime(t)))); $('time').value = '13:00';
  $('searchForm').addEventListener('submit', event => { event.preventDefault(); scheduleSearch(); location.hash = 'buscar'; });
  for (const id of ['guests', 'date', 'cuisine', 'price']) $(id).addEventListener('change', scheduleSearch);
  $('time').addEventListener('change', render);
  $('q').addEventListener('input', () => {
    const q = normalized($('q').value);
    const matches = q ? state.restaurants.filter(r => normalized(r.name).includes(q)).slice(0, 6) : [];
    $('nameSuggestions').replaceChildren(...matches.map(r => button(r.name, () => { $('q').value = r.name; $('nameSuggestions').hidden = true; scheduleSearch(); })));
    $('nameSuggestions').hidden = !matches.length;
    // Invalidate immediately so old responses cannot restore availability while typing.
    ++state.generation; state.availability.clear(); state.loading = state.mode === 'online'; render();
    clearTimeout(searchTimer); searchTimer = setTimeout(refreshAvailability, 200);
  });
  document.addEventListener('click', event => { if (!event.target.closest('#q') && !event.target.closest('#nameSuggestions')) $('nameSuggestions').hidden = true; });
  $('close').addEventListener('click', () => $('modal').close());
  $('geo').addEventListener('click', locate); $('nearby').addEventListener('click', locate);
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => panel(b.dataset.view)));
  document.querySelectorAll('[data-booking-view]').forEach(b => b.addEventListener('click', () => { state.bookingView = b.dataset.bookingView; document.querySelectorAll('[data-booking-view]').forEach(item => item.classList.toggle('active', item === b)); renderBookings(); }));
  $('refreshBookings').addEventListener('click', syncReservations);
  $('reviews').append(node('p', 'Todavía no hay reseñas de asistencia verificada.'));
  for (const name of ['Básico', 'Pro', 'Premium']) { const card = node('article', null, 'card'); const pad = node('div', null, 'pad'); pad.append(node('h3', name), node('p', 'Precio semanal por configurar'), node('p', 'Sin comisión por reservación. Beneficios sujetos a configuración.')); card.append(pad); $('planCards').append(card); }
  const hero = document.querySelector('.hero > div');
  const heroImage = photo('https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1200&q=75', 'Interior ilustrativo de un restaurante'); heroImage.className = 'hero-visual'; hero.append(heroImage);
  panel('reservations'); renderBookings(); renderRecovery(); render();
  async function initialize() {
    try {
      const health = await request(); if (!health.configured) throw new Error('Servicio sin configurar');
      const data = await request('?mode=restaurants'); if (!Array.isArray(data.restaurants)) throw new Error('Catálogo no verificado');
      state.restaurants = data.restaurants.map(r => ({ id: r.id, name: r.name, cuisine: r.cuisine, address: r.address, pricePerPerson: r.price_per_person == null || r.price_per_person === 0 ? null : Number(r.price_per_person), img: r.image_url || examples[0].img, hasOwnPhoto: !!r.image_url, menu: Array.isArray(r.menu) ? r.menu : [], tables: r.tables || [], weeklyHours: r.weekly_hours, timezone: r.timezone, lat: r.latitude == null ? null : Number(r.latitude), lng: r.longitude == null ? null : Number(r.longitude), rating: r.rating == null ? null : Number(r.rating), policy: r.cancellation_policy || 'Consulta la política con el restaurante.' }));
      state.mode = 'online'; $('serviceStatus').textContent = 'Reservas conectadas al servidor. Cada confirmación y cancelación se guarda en Supabase.';
      updateCuisine(); await refreshAvailability();
    } catch {
      state.mode = 'offline'; state.restaurants = demo;
      $('serviceStatus').textContent = 'Las reservas reales no están disponibles. Mostramos ejemplos para explorar; ninguna mesa se puede confirmar.';
      updateCuisine(); render();
    }
    renderNearby(); await syncReservations();
  }
  initialize();
})();
