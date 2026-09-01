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

function checkPin(request, env) {
  const pin = request.headers.get('X-Selfie-Pin');
  // Sin PANEL_PIN configurado NO se abre el paso: fallar cerrado, no abierto.
  if (!env.PANEL_PIN) return false;
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

  return json({ ok: true, slug, nombre: existe.nombre, fotos_borradas: fotos }, 200, env);
}

async function crearLead(request, env) {
  const ip = clientIp(request);
  const rl = rateLimit(`lead:${ip}`, 20, 60_000);
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

async function getFotos(env, slug, tipo) {
  if (!TIPOS_FOTO.includes(tipo)) return json({ error: 'tipo_invalido' }, 400, env);

  // Se chequea D1 ANTES de llamar a Cloudinary (§4): así "evento inexistente"
  // se distingue de "evento sin fotos" sin depender de un tercero.
  const row = await env.DB.prepare(`SELECT slug FROM eventos WHERE slug = ?`).bind(slug).first();
  if (!row) return notFound(env, 'evento_not_found');

  const r = await listarFotosPorTag(env, slug, tipo);

  if (r.pendiente) {
    // 503, NO 200 con lista vacía: "no pude preguntar" ≠ "no hay fotos".
    return json({ error: 'cloudinary_no_configurado', evento: slug, tipo }, 503, env);
  }
  if (r.error) {
    return json({ error: 'cloudinary_error', status: r.status, detalle: r.body }, 502, env);
  }
  // Vacío legítimo => 200 con lista vacía (≠ 404).
  return json({ evento: slug, tipo, fotos: r.fotos }, 200, env, {
    'Cache-Control': `public, max-age=${CACHE_TTL_FOTOS}`
  });
}

async function exportCsv(request, env) {
  if (!checkPin(request, env)) return unauthorized(env);
  const { results } = await env.DB.prepare(
    `SELECT email, evento_slug, user_agent, created_at FROM leads ORDER BY created_at DESC`
  ).all();

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['email,evento,user_agent,created_at'];
  for (const r of results || []) {
    lines.push([r.email, r.evento_slug, r.user_agent, r.created_at].map(esc).join(','));
  }
  return new Response(lines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="selfie-leads.csv"',
      ...corsHeaders(env)
    }
  });
}

/* ───────────────────────────────── router ────────────────────────────────── */

export default {
  async fetch(request, env) {
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

      const mFotos = path.match(/^\/api\/fotos\/([^/]+)\/([^/]+)$/);
      if (mFotos && method === 'GET') {
        const slug = decodeURIComponent(mFotos[1]);
        const tipo = decodeURIComponent(mFotos[2]);
        if (!TIPOS_FOTO.includes(tipo)) return json({ error: 'tipo_invalido' }, 400, env);
        if (!SLUG_RE.test(slug)) return notFound(env, 'evento_not_found');
        return getFotos(env, slug, tipo);
      }

      if (path === '/api/leads' && method === 'POST') return crearLead(request, env);
      if (path === '/api/leads/export.csv' && method === 'GET') return exportCsv(request, env);

      if (path === '/panel' && method === 'GET') {
        const ip = clientIp(request);
        const rl = rateLimit(`panel:${ip}`, 10, 60_000);
        if (rl.limited) {
          return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429, env,
            { 'Retry-After': String(rl.retryAfter) });
        }
        if (!checkPin(request, env)) return unauthorized(env);
        return new Response(PANEL_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(env) }
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
const PANEL_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Panel — Selfie Eventos</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:1.5rem;background:#111;color:#eee}
h1{font-size:1.25rem}table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{text-align:left;padding:.5rem;border-bottom:1px solid #333;font-size:.9rem}
a{color:#f2766a}</style></head><body>
<h1>Panel — Selfie Eventos</h1>
<p><a href="/api/leads/export.csv">Exportar leads (CSV)</a></p>
<p>Eventos y leads se listan vía <code>/api/eventos</code> y <code>/api/leads/export.csv</code>.</p>
</body></html>`;
