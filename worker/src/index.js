/**
 * Selfie Eventos — Cloudflare Worker (backend propio)
 * Spec v5 SELLADA · md5 aced02b998c6bc9d794d22aedad43c3d
 *
 * Endpoints (contrato §4). Regla transversal: todo endpoint de lectura tiene su
 * CASO NEGATIVO especificado, y "no existe" (404 con cuerpo de error) NUNCA se
 * confunde con "existe vacío" (200 con lista vacía).
 *
 * 🔴 CRITERIO ANTI-FALSO-VERDE (origen medido, no teórico): el endpoint gviz de
 * Google devuelve 200 con la PRIMERA pestaña cuando le pedís una que no existe
 * (verificado: respuesta byte-idéntica, mismo md5). Un backend propio que
 * devolviera "el primer evento" ante un slug inexistente reintroduciría ese
 * mismo falso verde. Acá: slug inexistente => 404 SIEMPRE, con cuerpo de error.
 */

const VERSION = '1.0.0';
const TIPOS_FOTO = ['suelta', 'tira'];
const CACHE_TTL_FOTOS = 60; // segundos (spec §4)

/* ─────────────────────────── helpers de respuesta ─────────────────────────── */

function corsHeaders(env) {
  // CORS restringido (spec §4): NUNCA '*'
  const origin = (env && env.ALLOWED_ORIGIN) || 'https://selfieeventos.webflow.io';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Selfie-Pin',
    'Vary': 'Origin'
  };
}

function json(data, status, env, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(env),
      ...(extraHeaders || {})
    }
  });
}

const notFound = (env, error) => json({ error: error || 'not_found' }, 404, env);
const unauthorized = (env) => json({ error: 'unauthorized' }, 401, env);
const validation = (env, fields) => json({ error: 'validation', fields }, 400, env);

/* ─────────────────────────────── utilidades ──────────────────────────────── */

/**
 * Slug desde nombre: lowercase, sin diacríticos, sin emoji, espacios→guiones.
 * Spec §3: lo genera el SERVER; el cliente nunca manda slug en la creación.
 */
function slugify(nombre) {
  return String(nombre)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')      // saca diacríticos (Sofía -> Sofia)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')          // saca emoji/símbolos (✨ fuera)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getCookie(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

const COOKIE_PANEL = 'selfie_panel';

function checkPin(request, env) {
  // Sin PANEL_PIN configurado NO se abre el paso: fallar cerrado, no abierto.
  if (!env.PANEL_PIN) return false;
  // Header (JS de /subir y /album) o cookie HttpOnly del panel (browser de
  // Cani). La cookie es SameSite=Strict: ninguna otra origen puede montar una
  // request con ella, así que los endpoints mutantes no quedan expuestos a CSRF.
  const pin = request.headers.get('X-Selfie-Pin') || getCookie(request, COOKIE_PANEL);
  return typeof pin === 'string' && pin.length > 0 && pin === env.PANEL_PIN;
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/* ───────────────────── rate limit (V1.9) — por IP, en memoria ───────────────
 * Free tier: no hay Durable Objects garantizados. Se limita por isolate con un
 * Map en memoria. LIMITACIÓN REAL Y DECLARADA: los isolates de Cloudflare son
 * múltiples y efímeros, así que esto NO es un límite global duro — es fricción
 * que frena un bucle simple desde una IP. La MEDICIÓN de su alcance real va a
 * Ester (no se auto-acepta como riesgo: se decide con el dato).
 * ------------------------------------------------------------------------- */
const rateBuckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now > b.reset) {
    rateBuckets.set(key, { count: 1, reset: now + windowMs });
    return { limited: false, remaining: max - 1 };
  }
  b.count += 1;
  if (b.count > max) {
    return { limited: true, retryAfter: Math.ceil((b.reset - now) / 1000) };
  }
  return { limited: false, remaining: max - b.count };
}

const clientIp = (request) =>
  request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'local';

/* ──────────────────────────── Cloudinary Admin API ────────────────────────── */

/**
 * Lista fotos por TAG vía Admin API (spec §2: única vía técnica — CORS bloquea
 * el preflight desde el browser, medido con control positivo).
 * El tag es el contrato compartido con quien SUBE: evt-<slug>-<tipo>.
 */
const tagFor = (slug, tipo) => `evt-${slug}-${tipo}`;

async function listarFotosPorTag(env, slug, tipo) {
  const cloud = env.CLOUDINARY_CLOUD_NAME;
  const key = env.CLOUDINARY_API_KEY;
  const secret = env.CLOUDINARY_API_SECRET;

  // Estado honesto: sin credenciales NO se inventa una lista vacía (eso sería
  // un falso verde: "no hay fotos" cuando en realidad no se pudo preguntar).
  if (!cloud || !key || !secret) {
    return { pendiente: true, motivo: 'cloudinary_no_configurado' };
  }

  const tag = tagFor(slug, tipo);
  const url = `https://api.cloudinary.com/v1_1/${cloud}/resources/image/tags/${encodeURIComponent(tag)}?max_results=500`;
  const auth = btoa(`${key}:${secret}`);

  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });

  // 404 de Cloudinary ante un tag sin recursos = "vacío", no "roto".
  if (res.status === 404) return { fotos: [] };
  if (!res.ok) {
    return { error: true, status: res.status, body: (await res.text()).slice(0, 300) };
  }

  const data = await res.json();
  const fotos = (data.resources || []).map((r) => ({
    public_id: r.public_id,
    width: r.width,
    height: r.height,
    format: r.format
  }));
  return { fotos };
}

/* ─────────────────────────────── handlers ────────────────────────────────── */

async function getEventos(env) {
  const { results } = await env.DB.prepare(
    `SELECT slug, nombre, lugar, fecha, tipo, activo, imagen FROM eventos ORDER BY fecha DESC, created_at DESC`
  ).all();
  // El backend NO fuerza un único activo (spec §2): devuelve todos.
  return json({ eventos: results || [] }, 200, env);
}

async function getEvento(env, slug) {
  const row = await env.DB.prepare(
    `SELECT slug, nombre, lugar, fecha, tipo, activo, imagen FROM eventos WHERE slug = ?`
  ).bind(slug).first();
  // 🔴 Acá vive el criterio anti-gviz: inexistente => 404, jamás un 200 plausible.
  if (!row) return notFound(env);
  return json({ evento: row }, 200, env);
}

async function crearEvento(request, env) {
  if (!checkPin(request, env)) return unauthorized(env);

  const ip = clientIp(request);
  const rl = rateLimit(`crear:${ip}`, 30, 60_000);
  if (rl.limited) {
    return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429, env,
      { 'Retry-After': String(rl.retryAfter) });
  }

  const body = await readJson(request);
  if (!body) return validation(env, ['body']);

  const fields = [];
  const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : '';
  if (!nombre) fields.push('nombre');
  if (body.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(body.fecha)) fields.push('fecha');
  if (body.activo !== undefined && ![0, 1, true, false].includes(body.activo)) fields.push('activo');
  // Rechazo NUNCA silencioso (delta v4): devuelve QUÉ campo falló.
  if (fields.length) return validation(env, fields);

  let base = slugify(nombre);
  if (!base) base = 'evento'; // nombre solo-emoji => slug usable igual
  let slug = base;
  let n = 1;
  // Colisión => sufijo -2, -3… La fila original queda INTACTA (§8-V1.4).
  while (await env.DB.prepare(`SELECT 1 FROM eventos WHERE slug = ?`).bind(slug).first()) {
    n += 1;
    slug = `${base}-${n}`;
  }

  const activo = body.activo === 1 || body.activo === true ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO eventos (slug, nombre, lugar, fecha, tipo, activo, imagen) VALUES (?,?,?,?,?,?,?)`
  ).bind(slug, nombre, body.lugar || null, body.fecha || null, body.tipo || null, activo, body.imagen || null).run();

  const evento = await env.DB.prepare(
    `SELECT slug, nombre, lugar, fecha, tipo, activo, imagen FROM eventos WHERE slug = ?`
  ).bind(slug).first();
  return json({ evento }, 201, env);
}

async function editarEvento(request, env, slug) {
  if (!checkPin(request, env)) return unauthorized(env);

  const existe = await env.DB.prepare(`SELECT slug FROM eventos WHERE slug = ?`).bind(slug).first();
  if (!existe) return notFound(env);

  const body = await readJson(request);
  if (!body) return validation(env, ['body']);

  const sets = [];
  const vals = [];
  const fields = [];

  if (body.nombre !== undefined) {
    if (typeof body.nombre !== 'string' || !body.nombre.trim()) fields.push('nombre');
    else { sets.push('nombre = ?'); vals.push(body.nombre.trim()); }
  }
  for (const k of ['lugar', 'tipo', 'imagen']) {
    if (body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(body[k]); }
  }
  if (body.fecha !== undefined) {
    if (body.fecha !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.fecha)) fields.push('fecha');
    else { sets.push('fecha = ?'); vals.push(body.fecha); }
  }
  if (body.activo !== undefined) {
    if (![0, 1, true, false].includes(body.activo)) fields.push('activo');
    else { sets.push('activo = ?'); vals.push(body.activo === 1 || body.activo === true ? 1 : 0); }
  }

  if (fields.length) return validation(env, fields);
  if (!sets.length) return validation(env, ['(ningún campo editable enviado)']);

  vals.push(slug);
  await env.DB.prepare(`UPDATE eventos SET ${sets.join(', ')} WHERE slug = ?`).bind(...vals).run();

  const evento = await env.DB.prepare(
    `SELECT slug, nombre, lugar, fecha, tipo, activo, imagen FROM eventos WHERE slug = ?`
  ).bind(slug).first();
  return json({ evento }, 200, env);
}

/**
 * Borra TODOS los recursos de un tag vía Admin API. Mismo contrato tagFor que
 * el listado. 404 de Cloudinary = tag sin recursos = 0 borradas, no error.
 */
async function borrarFotosPorTag(env, slug, tipo) {
  const cloud = env.CLOUDINARY_CLOUD_NAME;
  const key = env.CLOUDINARY_API_KEY;
  const secret = env.CLOUDINARY_API_SECRET;
  // Fallar cerrado: sin credenciales no se puede saber si hay fotos — no se
  // borra el evento a medias (las fotos quedarían huerfanas sin registro).
  if (!cloud || !key || !secret) {
    return { pendiente: true, motivo: 'cloudinary_no_configurado' };
  }
  const tag = tagFor(slug, tipo);
  const url = `https://api.cloudinary.com/v1_1/${cloud}/resources/image/tags/${encodeURIComponent(tag)}`;
  const auth = btoa(`${key}:${secret}`);
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Basic ${auth}` } });
  if (res.status === 404) return { borradas: 0 };
  if (!res.ok) {
    return { error: true, status: res.status, body: (await res.text()).slice(0, 300) };
  }
  const data = await res.json();
  return { borradas: Object.keys(data.deleted || {}).length };
}

async function borrarEvento(request, env, slug) {
  if (!checkPin(request, env)) return unauthorized(env);

  const ip = clientIp(request);
  const rl = rateLimit(`borrar:${ip}`, 10, 60_000);
  if (rl.limited) {
    return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429, env,
      { 'Retry-After': String(rl.retryAfter) });
  }

  const existe = await env.DB.prepare(`SELECT slug, nombre FROM eventos WHERE slug = ?`).bind(slug).first();
  if (!existe) return notFound(env);

  // ORDEN: fotos PRIMERO, fila DESPUÉS. Si Cloudinary falla, el evento queda
  // entero y el borrado se reintenta — nunca un evento borrado con fotos vivas
  // que ningún álbum puede listar. Los LEADS se conservan a propósito (dato de
  // negocio; el slug huérfano en leads es registro histórico).
  const fotos = { suelta: 0, tira: 0 };
  for (const tipo of TIPOS_FOTO) {
    const r = await borrarFotosPorTag(env, slug, tipo);
    if (r.pendiente) {
      return json({ error: 'fotos_no_disponibles', motivo: r.motivo }, 503, env);
    }
    if (r.error) {
      return json({ error: 'cloudinary', status: r.status }, 502, env);
    }
    fotos[tipo] = r.borradas;
  }

  await env.DB.prepare(`DELETE FROM eventos WHERE slug = ?`).bind(slug).run();
  await invalidarCacheFotos(slug);

  return json({ ok: true, slug, nombre: existe.nombre, fotos_borradas: fotos }, 200, env);
}

/**
 * Borra fotos SUELTAS (algunas, no todas) de un evento. Operador con PIN, desde
 * el álbum en modo operador. Contrato: POST {evento, public_ids[]} → solo se
 * borran los public_ids que PERTENECEN al evento (intersección con el listado
 * real por tag, ambos tipos): un id ajeno o inventado se devuelve en
 * `rechazadas` y no toca Cloudinary. Tope 100 por llamada (límite de la Admin
 * API). Fail-closed igual que borrarEvento: sin credenciales → 503.
 */
async function borrarFotos(request, env) {
  if (!checkPin(request, env)) return unauthorized(env);

  const ip = clientIp(request);
  const rl = rateLimit(`borrarfotos:${ip}`, 30, 60_000);
  if (rl.limited) {
    return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429, env,
      { 'Retry-After': String(rl.retryAfter) });
  }

  const body = await readJson(request);
  if (!body) return json({ error: 'json_invalido' }, 400, env);
  const slug = String(body.evento || '').trim();
  const ids = Array.isArray(body.public_ids)
    ? body.public_ids.filter((x) => typeof x === 'string' && x.length > 0 && x.length < 200).slice(0, 100)
    : [];
  const fields = [];
  if (!slug) fields.push('evento');
  if (!ids.length) fields.push('public_ids');
  if (fields.length) return json({ error: 'campos_invalidos', fields }, 400, env);

  const existe = await env.DB.prepare(`SELECT slug FROM eventos WHERE slug = ?`).bind(slug).first();
  if (!existe) return notFound(env, 'evento_not_found');

  // Pertenencia: el listado real del evento (mismo contrato tagFor que el álbum).
  const propias = new Set();
  for (const tipo of TIPOS_FOTO) {
    const r = await listarFotosPorTag(env, slug, tipo);
    if (r.pendiente) return json({ error: 'fotos_no_disponibles', motivo: r.motivo }, 503, env);
    if (r.error) return json({ error: 'cloudinary', status: r.status }, 502, env);
    r.fotos.forEach((f) => propias.add(f.public_id));
  }
  const aBorrar = ids.filter((id) => propias.has(id));
  const rechazadas = ids.filter((id) => !propias.has(id));
  if (!aBorrar.length) return json({ ok: true, evento: slug, borradas: 0, ids: [], rechazadas }, 200, env);

  const cloud = env.CLOUDINARY_CLOUD_NAME;
  const auth = btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`);
  const url = `https://api.cloudinary.com/v1_1/${cloud}/resources/image/upload?` +
    aBorrar.map((id) => 'public_ids[]=' + encodeURIComponent(id)).join('&');
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    return json({ error: 'cloudinary', status: res.status, detalle: (await res.text()).slice(0, 300) }, 502, env);
  }
  const data = await res.json();
  // Cloudinary responde {deleted: {id: 'deleted' | 'not_found'}}: se cuenta solo lo borrado de verdad.
  const borradas = Object.entries(data.deleted || {}).filter(([, v]) => v === 'deleted').map(([k]) => k);
  await invalidarCacheFotos(slug);
  return json({ ok: true, evento: slug, borradas: borradas.length, ids: borradas, rechazadas }, 200, env);
}

async function crearLead(request, env) {
  const ip = clientIp(request);
  // En el salón todos los invitados salen por la MISMA IP (Wi-Fi/NAT): 20/min
  // por IP tiraba leads reales en el pico del evento (QA 2026-09-02). El tope
  // por IP queda amplio (anti-abuso grosero) y el freno fino es por IP+email.
  const rl = rateLimit(`lead:${ip}`, 200, 60_000);
  if (rl.limited) {
    return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429, env,
      { 'Retry-After': String(rl.retryAfter) });
  }

  const body = await readJson(request);
  if (!body) return validation(env, ['body']);

  const fields = [];
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const evento = typeof body.evento === 'string' ? body.evento.trim() : '';
  if (!email || !EMAIL_RE.test(email)) fields.push('email');
  if (!evento) fields.push('evento');
  if (fields.length) return validation(env, fields);

  const rlEmail = rateLimit(`lead:${ip}:${email}`, 5, 60_000);
  if (rlEmail.limited) {
    return json({ error: 'rate_limited', retry_after: rlEmail.retryAfter }, 429, env,
      { 'Retry-After': String(rlEmail.retryAfter) });
  }

  // El evento tiene que existir: 404 distinto de 400 (formas distintas, §4).
  const row = await env.DB.prepare(`SELECT slug FROM eventos WHERE slug = ?`).bind(evento).first();
  if (!row) return notFound(env, 'evento_not_found');

  // user_agent del HEADER, no del payload (el cliente no dicta su propia huella).
  const ua = request.headers.get('User-Agent') || '';
  await env.DB.prepare(
    `INSERT INTO leads (email, evento_slug, user_agent) VALUES (?,?,?)`
  ).bind(email, evento, ua).run();

  return json({ ok: true }, 201, env);
}

// Cache del listado en el Worker (spec §4: Cache API, TTL 60 s). Cada apertura
// del álbum eran 2 llamadas a la Admin API (tope 500/h ≈ 250 aperturas/hora y
// después 502 para todos — QA 2026-09-02). La clave es una URL sintética por
// evento+tipo; se invalida al borrar fotos, al borrar el evento y cuando
// /subir termina una tanda (POST /api/eventos/:slug/refrescar).
const claveCacheFotos = (slug, tipo) =>
  new Request(`https://selfie-worker.cache/api/fotos/${encodeURIComponent(slug)}/${tipo}`);

async function invalidarCacheFotos(slug) {
  try {
    const cache = caches.default;
    for (const tipo of TIPOS_FOTO) await cache.delete(claveCacheFotos(slug, tipo));
  } catch (e) { /* sin Cache API (dev local viejo): el TTL corto lo cubre */ }
}

async function getFotos(env, ctx, slug, tipo) {
  if (!TIPOS_FOTO.includes(tipo)) return json({ error: 'tipo_invalido' }, 400, env);

  // Se chequea D1 ANTES de llamar a Cloudinary (§4): así "evento inexistente"
  // se distingue de "evento sin fotos" sin depender de un tercero.
  const row = await env.DB.prepare(`SELECT slug FROM eventos WHERE slug = ?`).bind(slug).first();
  if (!row) return notFound(env, 'evento_not_found');

  let cache = null;
  try { cache = caches.default; } catch (e) { cache = null; }
  if (cache) {
    const hit = await cache.match(claveCacheFotos(slug, tipo));
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('X-Selfie-Cache', 'HIT');
      return res;
    }
  }

  const r = await listarFotosPorTag(env, slug, tipo);

  if (r.pendiente) {
    // 503, NO 200 con lista vacía: "no pude preguntar" ≠ "no hay fotos".
    return json({ error: 'cloudinary_no_configurado', evento: slug, tipo }, 503, env);
  }
  if (r.error) {
    return json({ error: 'cloudinary_error', status: r.status, detalle: r.body }, 502, env);
  }
  // Vacío legítimo => 200 con lista vacía (≠ 404). El browser cachea poco
  // (15 s) para que un borrado/subida se vea rápido; el Worker cachea 60 s.
  const res = json({ evento: slug, tipo, fotos: r.fotos }, 200, env, {
    'Cache-Control': `public, max-age=15, s-maxage=${CACHE_TTL_FOTOS}`,
    'X-Selfie-Cache': 'MISS'
  });
  if (cache) {
    const put = cache.put(claveCacheFotos(slug, tipo), res.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put); else await put;
  }
  return res;
}

async function refrescarFotos(request, env, slug) {
  if (!checkPin(request, env)) return unauthorized(env);
  const row = await env.DB.prepare(`SELECT slug FROM eventos WHERE slug = ?`).bind(slug).first();
  if (!row) return notFound(env);
  await invalidarCacheFotos(slug);
  return json({ ok: true, slug }, 200, env);
}

async function exportCsv(request, env) {
  if (!checkPin(request, env)) return unauthorized(env);
  const evento = new URL(request.url).searchParams.get('evento') || '';
  const q = evento && SLUG_RE.test(evento)
    ? env.DB.prepare(`SELECT email, evento_slug, user_agent, created_at FROM leads WHERE evento_slug = ? ORDER BY created_at DESC`).bind(evento)
    : env.DB.prepare(`SELECT email, evento_slug, user_agent, created_at FROM leads ORDER BY created_at DESC`);
  const { results } = await q.all();

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['email,evento,user_agent,created_at'];
  for (const r of results || []) {
    lines.push([r.email, r.evento_slug, r.user_agent, r.created_at].map(esc).join(','));
  }
  return new Response(lines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="selfie-leads${evento && SLUG_RE.test(evento) ? '-' + evento : ''}.csv"`,
      ...corsHeaders(env)
    }
  });
}

/* ───────────────────────────────── router ────────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (path === '/api/health' && method === 'GET') {
        return json({ ok: true, service: 'selfie-worker', version: VERSION }, 200, env);
      }

      if (path === '/api/eventos' && method === 'GET') return getEventos(env);
      if (path === '/api/eventos' && method === 'POST') return crearEvento(request, env);

      const mEvento = path.match(/^\/api\/eventos\/([^/]+)$/);
      if (mEvento) {
        const slug = decodeURIComponent(mEvento[1]);
        // Un slug con forma inválida NO puede existir => 404 (no 500 ni 200).
        if (!SLUG_RE.test(slug)) return notFound(env);
        if (method === 'GET') return getEvento(env, slug);
        if (method === 'PATCH') return editarEvento(request, env, slug);
        if (method === 'DELETE') return borrarEvento(request, env, slug);
      }
      const mRefrescar = path.match(/^\/api\/eventos\/([^/]+)\/refrescar$/);
      if (mRefrescar && method === 'POST') {
        const slug = decodeURIComponent(mRefrescar[1]);
        if (!SLUG_RE.test(slug)) return notFound(env);
        return refrescarFotos(request, env, slug);
      }

      if (path === '/api/fotos/borrar' && method === 'POST') return borrarFotos(request, env);

      const mFotos = path.match(/^\/api\/fotos\/([^/]+)\/([^/]+)$/);
      if (mFotos && method === 'GET') {
        const slug = decodeURIComponent(mFotos[1]);
        const tipo = decodeURIComponent(mFotos[2]);
        if (!TIPOS_FOTO.includes(tipo)) return json({ error: 'tipo_invalido' }, 400, env);
        if (!SLUG_RE.test(slug)) return notFound(env, 'evento_not_found');
        return getFotos(env, ctx, slug, tipo);
      }

      if (path === '/api/leads' && method === 'POST') return crearLead(request, env);
      if (path === '/api/leads/export.csv' && method === 'GET') return exportCsv(request, env);

      if (path === '/panel' && method === 'GET') {
        // La sonda de /subir (validarPin) manda el PIN por header: 401 si es
        // malo, 200 si es bueno. El browser de Cani llega sin header: form.
        const porHeader = !!request.headers.get('X-Selfie-Pin');
        if (porHeader) {
          const ip = clientIp(request);
          const rl = rateLimit(`panel:${ip}`, 10, 60_000);
          if (rl.limited) {
            return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429, env,
              { 'Retry-After': String(rl.retryAfter) });
          }
          if (!checkPin(request, env)) return unauthorized(env);
        }
        if (!checkPin(request, env)) return htmlResponse(panelLoginHtml(null), 200, env);
        return htmlResponse(await panelHtml(request, env), 200, env);
      }
      if (path === '/panel/login' && method === 'POST') {
        const ip = clientIp(request);
        const rl = rateLimit(`panel:${ip}`, 10, 60_000);
        if (rl.limited) return htmlResponse(panelLoginHtml('Demasiados intentos. Esperá un minuto.'), 429, env);
        const form = await request.formData().catch(() => null);
        const pin = form ? String(form.get('pin') || '').trim() : '';
        if (!env.PANEL_PIN || !pin || pin !== env.PANEL_PIN) return htmlResponse(panelLoginHtml('PIN incorrecto.'), 401, env);
        return new Response(null, {
          status: 303,
          headers: {
            Location: '/panel',
            'Set-Cookie': `${COOKIE_PANEL}=${encodeURIComponent(pin)}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`
          }
        });
      }
      if (path === '/panel/salir' && method === 'POST') {
        return new Response(null, {
          status: 303,
          headers: { Location: '/panel', 'Set-Cookie': `${COOKIE_PANEL}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` }
        });
      }

      return notFound(env, 'ruta_no_encontrada');
    } catch (err) {
      // El error se registra, pero no se filtra el stack al cliente.
      console.error('[selfie-worker]', err && err.stack ? err.stack : err);
      return json({ error: 'internal', detalle: String(err && err.message ? err.message : err) }, 500, env);
    }
  }
};

/* Panel mínimo (V4 lo valida con Cani). Sin dependencias externas. */
function htmlResponse(html, status, env) {
  return new Response(html, {
    status: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...corsHeaders(env) }
  });
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PANEL_CSS = `*{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:28px 20px 60px;background:#0b0b0d;color:#f1ede7;line-height:1.5}
main{max-width:1040px;margin:0 auto;display:flex;flex-direction:column;gap:22px}h1{font-size:1.4rem;font-weight:500;margin:0}h2{font-size:1rem;font-weight:600;margin:0;color:#b8b2ab}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.muted{color:#7f7a75;font-size:.9rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.tile{background:#141417;border:1px solid #2a2a30;border-radius:12px;padding:14px 16px}
.tile b{display:block;font-size:1.8rem;font-weight:400;line-height:1.1}.tile span{font-size:.85rem;color:#b8b2ab}
form.f{display:flex;gap:10px;flex-wrap:wrap;align-items:center}select,input,button,a.btn{font:inherit;border-radius:999px;border:1px solid #3a3a42;background:#141417;color:#f1ede7;padding:8px 14px}
button,a.btn{background:#e8756a;border-color:#e8756a;color:#1a0d0b;text-decoration:none;cursor:pointer;font-weight:600}button.sec,a.btn.sec{background:transparent;color:#f1ede7;border-color:#3a3a42}
.tw{overflow-x:auto;border:1px solid #2a2a30;border-radius:12px}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #2a2a30;white-space:nowrap}
th{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:#7f7a75;font-weight:500;background:#141417}tr:last-child td{border-bottom:0}td.n{color:#7f7a75}
.login{max-width:380px;margin:12vh auto 0;display:flex;flex-direction:column;gap:14px}.login input{width:100%;font-size:1.1rem;letter-spacing:.2em;text-align:center}.err{color:#ff9a9a;font-size:.9rem}`;

function panelLoginHtml(error) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Panel - Selfie Eventos</title><style>${PANEL_CSS}</style></head><body><main class="login">
<h1>Panel de leads</h1><p class="muted">Ingresá el PIN para ver los leads y exportarlos.</p>
<form method="post" action="/panel/login"><input type="password" name="pin" inputmode="numeric" autocomplete="current-password" placeholder="PIN" required autofocus>
${error ? `<p class="err">${esc(error)}</p>` : ''}<p><button type="submit">Entrar</button></p></form></main></body></html>`;
}

async function panelHtml(request, env) {
  const url = new URL(request.url);
  const filtro = url.searchParams.get('evento') || '';
  const filtroOk = filtro && SLUG_RE.test(filtro) ? filtro : '';
  const eventos = (await env.DB.prepare(`SELECT slug, nombre, fecha FROM eventos ORDER BY fecha DESC, nombre`).all()).results || [];
  const conteos = (await env.DB.prepare(`SELECT evento_slug, COUNT(*) AS n FROM leads GROUP BY evento_slug`).all()).results || [];
  const total = conteos.reduce((a, r) => a + r.n, 0);
  const porSlug = Object.fromEntries(conteos.map((r) => [r.evento_slug, r.n]));
  const nombreDe = Object.fromEntries(eventos.map((e) => [e.slug, e.nombre]));
  const q = filtroOk
    ? env.DB.prepare(`SELECT email, evento_slug, created_at FROM leads WHERE evento_slug = ? ORDER BY created_at DESC LIMIT 500`).bind(filtroOk)
    : env.DB.prepare(`SELECT email, evento_slug, created_at FROM leads ORDER BY created_at DESC LIMIT 500`);
  const leads = (await q.all()).results || [];
  const csv = `/api/leads/export.csv${filtroOk ? '?evento=' + encodeURIComponent(filtroOk) : ''}`;
  const opciones = eventos.map((e) => `<option value="${esc(e.slug)}"${e.slug === filtroOk ? ' selected' : ''}>${esc(e.nombre)}${e.fecha ? ' · ' + esc(e.fecha) : ''} (${porSlug[e.slug] || 0})</option>`).join('');
  const filas = leads.length
    ? leads.map((l) => `<tr><td>${esc(l.email)}</td><td>${esc(nombreDe[l.evento_slug] || l.evento_slug)}</td><td class="n">${esc((l.created_at || '').replace('T', ' ').slice(0, 16))}</td></tr>`).join('')
    : `<tr><td colspan="3" class="n">Todavía no hay leads${filtroOk ? ' para este evento' : ''}.</td></tr>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Panel - Selfie Eventos</title><style>${PANEL_CSS}</style></head><body><main>
<div class="top"><div><h1>Leads de Selfie Eventos</h1><p class="muted">Emails dejados en el álbum. Se muestran los últimos 500; el CSV trae todo.</p></div>
<form method="post" action="/panel/salir"><button class="sec" type="submit">Salir</button></form></div>
<div class="tiles"><div class="tile"><b>${total}</b><span>leads en total</span></div><div class="tile"><b>${eventos.length}</b><span>eventos</span></div><div class="tile"><b>${filtroOk ? (porSlug[filtroOk] || 0) : leads.length}</b><span>${filtroOk ? 'leads de ' + esc(nombreDe[filtroOk] || filtroOk) : 'en esta lista'}</span></div></div>
<form class="f" method="get" action="/panel"><label for="evento" class="muted">Evento</label><select id="evento" name="evento" onchange="this.form.submit()"><option value="">Todos</option>${opciones}</select>
<noscript><button type="submit">Filtrar</button></noscript><a class="btn" href="${csv}">Descargar CSV${filtroOk ? ' del evento' : ''}</a></form>
<div class="tw"><table><thead><tr><th>Email</th><th>Evento</th><th>Fecha (UTC)</th></tr></thead><tbody>${filas}</tbody></table></div>
</main></body></html>`;
}
