# selfie-worker — backend propio de Selfie Eventos

Cloudflare Worker + D1. Reemplaza Google Sheet + Apps Script (spec v5, md5 `aced02b998c6bc9d794d22aedad43c3d`).

## Correr local (NO requiere cuenta Cloudflare)

```bash
cd worker
npx wrangler d1 execute selfie --local --file=migrations/0001_init.sql   # una vez
npx wrangler dev --local --port 8787
PIN=123456 ./tests/v1-suite.sh          # suite V1 (28 checks)
```

`.dev.vars` (gitignoreado) define `PANEL_PIN` para local. **Nunca commitear secrets.**

## Endpoints

Contrato completo en la spec §4. Regla transversal: **"no existe" (404 con cuerpo de error) nunca se confunde con "existe vacío" (200 con lista vacía)**.

| Ruta | Auth | Notas |
|---|---|---|
| `GET /api/health` | — | `{"ok":true,"service":"selfie-worker"}` |
| `GET /api/eventos` | — | todos; el front elige el activo más reciente |
| `GET /api/eventos/:slug` | — | **404 si no existe — NUNCA 200 plausible** |
| `POST /api/eventos` | PIN | slug generado server-side; colisión → `-2`, `-3`… |
| `PATCH /api/eventos/:slug` | PIN | incluye toggle `activo` (0/1) |
| `GET /api/fotos/:slug/:tipo` | — | tipo ∈ {suelta,tira}; vacío → `200 "fotos":[]` |
| `POST /api/leads` | — | email lowercased; `user_agent` del header |
| `GET /api/leads/export.csv` | PIN | header `email,evento,user_agent,created_at` |
| `GET /panel` | PIN | panel mínimo |

## 🔴 Criterio anti-falso-verde (por qué el 404 es innegociable)

El endpoint `gviz` de Google Sheets, ante una pestaña **inexistente**, devuelve **200 con la primera pestaña** — verificado: respuesta byte-idéntica (mismo md5) a pedir la primera. Un backend que ante un slug inexistente devolviera "el primer evento" reintroduciría ese falso verde en infra propia.

Por eso: **slug inexistente ⇒ 404 con cuerpo de error, siempre.** Está cubierto por los checks V1.2 de la suite y debe seguir cubierto.

## Rate limit (umbral fijado en construcción — spec §4)

| Vía | Umbral | Ventana |
|---|---|---|
| `POST /api/leads` | 20 req | 60 s por IP |
| `POST`/`PATCH /api/eventos` | 30 req | 60 s por IP |
| `GET /panel` (intentos de PIN) | 10 req | 60 s por IP |

**Medición real (V1.9, local):** el 429 aparece en el **intento 11** del panel — observable y reproducible.

🔴 **LIMITACIÓN DECLARADA, NO AUTO-ACEPTADA.** La implementación usa un `Map` en memoria del isolate. Cloudflare corre **múltiples isolates efímeros**, así que esto **no es un límite global duro**: un atacante distribuido, o con suerte de routing, puede exceder el umbral. Es **fricción real contra un bucle simple desde una IP**, no una defensa dura.
Alternativas evaluadas: Durable Objects (límite global real, **no** en free tier) · KV (consistencia eventual, no sirve para contar) · Cache API (mismo problema de reparto por colo).
**Esta limitación se eleva a Ester con la medición, para que decida** si se acepta como riesgo registrado — no se auto-acepta (regla explícita del encargo).

## Secrets y rotación

```bash
wrangler secret put PANEL_PIN
wrangler secret put CLOUDINARY_CLOUD_NAME
wrangler secret put CLOUDINARY_API_KEY
wrangler secret put CLOUDINARY_API_SECRET
```

Rotación (sin redeploy de código): generar clave nueva en Cloudinary → `wrangler secret put` → verificar con `GET /api/fotos/<slug-real>/suelta` → 200 con fotos.

## Estado

- **V1 local: 28/28 checks** (evidencia cruda en `handoff/V1-evidencia-cruda-2026-07-30.txt`).
- **Pendiente H1** (cuenta Cloudinary): `/api/fotos` con fotos reales y V1.8 (medición del cache). Sin credenciales el endpoint devuelve **503**, no un 200 con lista vacía — "no pude preguntar" ≠ "no hay fotos".
- **Pendiente H2** (cuenta Cloudflare): deploy real. La suite se re-corre **entera** contra el deploy.
