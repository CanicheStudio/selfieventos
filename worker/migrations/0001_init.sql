-- Migración 0001 — esquema inicial (spec v5 §3, md5 aced02b998c6bc9d794d22aedad43c3d)
-- Selfie Eventos · backend propio (Cloudflare Worker + D1)

CREATE TABLE IF NOT EXISTS eventos (
  slug        TEXT PRIMARY KEY,             -- normalizado: ^[a-z0-9-]{1,60}$ (lo genera el server)
  nombre      TEXT NOT NULL,
  lugar       TEXT,
  fecha       TEXT,                         -- ISO YYYY-MM-DD
  tipo        TEXT,
  activo      INTEGER NOT NULL DEFAULT 0,   -- 0|1 — INTEGER por diseño: mata el bug de 'SI'/'SÍ'/'si'
  imagen      TEXT,                         -- public_id de portada en Cloudinary (opcional)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,                -- lowercased + trimmed server-side
  evento_slug TEXT NOT NULL,                -- FK lógica a eventos.slug (validada en el endpoint)
  user_agent  TEXT,                         -- del header, NO del payload (el cliente no lo dicta)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Los leads NO deduplican por diseño (log de captura, decisión heredada de la estrategia sellada).
-- Índice para el export y para el conteo por evento.
CREATE INDEX IF NOT EXISTS idx_leads_evento ON leads (evento_slug);
CREATE INDEX IF NOT EXISTS idx_eventos_activo ON eventos (activo);
