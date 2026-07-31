#!/bin/bash
# Suite V1 — Worker + D1 · spec v5 §8 (md5 aced02b998c6bc9d794d22aedad43c3d)
# Se corre contra `wrangler dev --local` (no requiere cuenta Cloudflare)
# y se RE-CORRE ENTERA contra el deploy real cuando exista (H2).
#
# Regla: PROPIEDAD, no presencia. Cada check valida la FORMA de la respuesta
# (clave esperada en el JSON), no solo el código HTTP.

BASE="${BASE:-http://127.0.0.1:8787}"
PIN="${PIN:-123456}"
PASS=0; FAIL=0

req() { # método url [data] [pin]
  local m="$1" u="$2" d="$3" p="$4"
  local args=(-s -m 15 -X "$m" -w $'\n%{http_code}')
  [ -n "$d" ] && args+=(-H "Content-Type: application/json" -d "$d")
  [ -n "$p" ] && args+=(-H "X-Selfie-Pin: $p")
  curl "${args[@]}" "$BASE$u"
}

check() { # nombre esperado_http body_debe_contener respuesta
  local nombre="$1" esp="$2" must="$3" resp="$4"
  local code="${resp##*$'\n'}" body="${resp%$'\n'*}"
  if [ "$code" = "$esp" ] && { [ -z "$must" ] || echo "$body" | grep -q "$must"; }; then
    PASS=$((PASS+1)); printf '  ✅ %-56s [%s] %s\n' "$nombre" "$code" "$(echo "$body" | head -c 90)"
  else
    FAIL=$((FAIL+1)); printf '  ❌ %-56s esperaba [%s + %s] obtuvo [%s] %s\n' "$nombre" "$esp" "$must" "$code" "$(echo "$body" | head -c 140)"
  fi
}

echo "═══ SUITE V1 · $BASE · $(date '+%Y-%m-%d %H:%M:%S') ═══"

echo; echo "── V1.1 health (forma, no solo código) ──"
check "GET /api/health" 200 '"service":"selfie-worker"' "$(req GET /api/health)"

echo; echo "── V1.3 crear eventos (PIN + validación + slug generado) ──"
check "POST sin PIN → 401" 401 '"error":"unauthorized"' "$(req POST /api/eventos '{"nombre":"X"}')"
check "POST PIN malo → 401" 401 '"error":"unauthorized"' "$(req POST /api/eventos '{"nombre":"X"}' 'pin-malo')"
check "POST nombre vacío → 400 con fields" 400 '"fields"' "$(req POST /api/eventos '{"nombre":"  "}' "$PIN")"
check "POST fecha inválida → 400" 400 '"fields"' "$(req POST /api/eventos '{"nombre":"Y","fecha":"31-12-2026"}' "$PIN")"
check "POST QA → 201" 201 '"evento"' "$(req POST /api/eventos '{"nombre":"QA Evento de Prueba","lugar":"Palermo, CABA","fecha":"2026-07-30","tipo":"Evento"}' "$PIN")"
# Slug: sin tildes, sin emoji, sin espacios.
# 🔴 Se valida la PROPIEDAD (forma del slug), no un literal: el literal
# "cumple-de-sofia" solo pasa con la DB virgen, y al re-correr la suite sobre una
# DB con estado da "-5", "-6"… y cantaría un FALSO ROJO sobre código sano.
# Misma lección que el ancla header-vs-md5: un test se ancla a lo estable.
R=$(req POST /api/eventos '{"nombre":"Cumple de Sofía ✨"}' "$PIN")
SLUG1=$(echo "$R" | grep -o '"slug":"[^"]*"' | head -1 | cut -d'"' -f4)
if echo "$SLUG1" | grep -qE '^cumple-de-sofia(-[0-9]+)?$'; then
  PASS=$((PASS+1)); printf '  ✅ %-56s slug=%s (sin tilde, sin emoji, sin espacios)\n' "POST 'Cumple de Sofía ✨' → slug normalizado" "$SLUG1"
else
  FAIL=$((FAIL+1)); printf '  ❌ %-56s slug=%s\n' "POST 'Cumple de Sofía ✨' → slug normalizado" "$SLUG1"
fi

echo; echo "── V1.4 colisión de slug (la fila original NO se pisa) ──"
R2=$(req POST /api/eventos '{"nombre":"Cumple de Sofía ✨"}' "$PIN")
SLUG2=$(echo "$R2" | grep -o '"slug":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$SLUG2" != "$SLUG1" ] && echo "$SLUG2" | grep -qE '^cumple-de-sofia-[0-9]+$'; then
  PASS=$((PASS+1)); printf '  ✅ %-56s %s ≠ %s\n' "mismo nombre → slug NUEVO con sufijo" "$SLUG2" "$SLUG1"
else
  FAIL=$((FAIL+1)); printf '  ❌ %-56s slug2=%s slug1=%s\n' "mismo nombre → slug NUEVO con sufijo" "$SLUG2" "$SLUG1"
fi
# La prueba que importa: la fila original sigue con SU nombre y no fue pisada.
check "original intacto tras la colisión" 200 "\"slug\":\"$SLUG1\"" "$(req GET /api/eventos/$SLUG1)"

echo; echo "── V1.2 🔴 ANTI-GVIZ: inexistente = 404, NUNCA 200 plausible ──"
check "GET evento real → 200" 200 '"evento"' "$(req GET /api/eventos/qa-evento-de-prueba)"
check "GET noexiste-123 → 404 not_found" 404 '"error":"not_found"' "$(req GET /api/eventos/noexiste-123)"
check "GET slug con forma inválida → 404" 404 '"error"' "$(req GET /api/eventos/NoExiste_MAYUS)"

echo; echo "── V1.5 PATCH / toggle activo ──"
check "PATCH activo=1 → 200" 200 '"activo":1' "$(req PATCH /api/eventos/qa-evento-de-prueba '{"activo":1}' "$PIN")"
check "GET /api/eventos refleja activo:1" 200 '"activo":1' "$(req GET /api/eventos)"
check "PATCH sin PIN → 401" 401 '"error":"unauthorized"' "$(req PATCH /api/eventos/qa-evento-de-prueba '{"activo":0}')"
check "PATCH a slug inexistente → 404" 404 '"error":"not_found"' "$(req PATCH /api/eventos/noexiste-123 '{"activo":1}' "$PIN")"
check "PATCH activo inválido ('SI') → 400" 400 '"fields"' "$(req PATCH /api/eventos/qa-evento-de-prueba '{"activo":"SI"}' "$PIN")"

echo; echo "── V1.6 leads (201 + la fila APARECE en el export = propiedad) ──"
check "POST lead válido → 201" 201 '"ok":true' "$(req POST /api/leads '{"email":"QA+V1@Caniche.TEST","evento":"qa-evento-de-prueba"}')"
check "POST email inválido 'abc' → 400" 400 '"fields"' "$(req POST /api/leads '{"email":"abc","evento":"qa-evento-de-prueba"}')"
check "POST evento inexistente → 404" 404 '"error":"evento_not_found"' "$(req POST /api/leads '{"email":"a@b.com","evento":"noexiste-123"}')"
check "export sin PIN → 401" 401 '"error":"unauthorized"' "$(req GET /api/leads/export.csv)"
check "export con PIN → header CSV exacto" 200 'email,evento,user_agent,created_at' "$(req GET /api/leads/export.csv '' "$PIN")"
# 🔴 El criterio real: lowercased y presente
check "🔴 la fila aparece LOWERCASED en el export" 200 'qa+v1@caniche.test' "$(req GET /api/leads/export.csv '' "$PIN")"

echo; echo "── V1.7 fotos: vacío ≠ inexistente ≠ tipo inválido (3 formas) ──"
check "tipo 'banana' → 400 tipo_invalido" 400 '"error":"tipo_invalido"' "$(req GET /api/fotos/qa-evento-de-prueba/banana)"
check "slug inexistente → 404 evento_not_found" 404 '"error":"evento_not_found"' "$(req GET /api/fotos/noexiste-123/suelta)"
# Sin credenciales Cloudinary (H1 pendiente) => 503 honesto, NO 200 con lista vacía
check "sin credenciales → 503 (NO 200 vacío)" 503 '"error":"cloudinary_no_configurado"' "$(req GET /api/fotos/qa-evento-de-prueba/suelta)"

echo; echo "── V1.9 rate limit del PIN (10 intentos errados) ──"
LIMITED=0
for i in $(seq 1 14); do
  C=$(curl -s -m 8 -o /dev/null -w "%{http_code}" -H "X-Selfie-Pin: malo$i" "$BASE/panel")
  [ "$C" = "429" ] && { LIMITED=$i; break; }
done
if [ "$LIMITED" != "0" ]; then
  PASS=$((PASS+1)); printf '  ✅ %-56s 429 en el intento %s\n' "rate limit del panel observable" "$LIMITED"
else
  FAIL=$((FAIL+1)); printf '  ❌ %-56s no hubo 429 en 14 intentos\n' "rate limit del panel observable"
fi

echo; echo "── V1.9b regresión: cero comparación de strings SI/SÍ en CÓDIGO NUEVO ──"
# ALCANCE (importa): el criterio de la spec es "no existe comparación de strings
# SI/SÍ en el CÓDIGO NUEVO". Los legacy js/selfie-sheets-{live,eventos}.js SÍ la
# tienen (5 ocurrencias) — son de la era Google, prod los carga HOY, y Río
# instruyó explícitamente NO tocarlos (se reemplazan en V2/V3 por selfie-home.js).
# Incluirlos acá haría fallar el test por código que la spec manda no modificar.
# Se los mide aparte, como referencia, para que la exclusión sea visible y no un
# agujero escondido en el criterio.
NUEVOS=$(grep -rn "'SI'\|\"SI\"\|'SÍ'\|\"SÍ\"" ../worker/src ../js/selfie-config.js ../js/selfie-album.js ../js/selfie-subir.js ../js/selfie-home.js 2>/dev/null | grep -v "SIN\|SIEMPRE" | wc -l | tr -d ' ')
LEGACY=$(grep -rn "'SI'\|\"SI\"" ../js/selfie-sheets-live.js ../js/selfie-sheets-eventos.js 2>/dev/null | wc -l | tr -d ' ')
if [ "$NUEVOS" = "0" ]; then
  PASS=$((PASS+1)); printf '  ✅ %-56s 0 en código nuevo (legacy intocado: %s)\n' "grep 'SI'/'SÍ' en worker/src + js nuevos" "$LEGACY"
else
  FAIL=$((FAIL+1)); printf '  ❌ %-56s %s ocurrencias en código NUEVO\n' "grep 'SI'/'SÍ'" "$NUEVOS"
fi

echo; echo "═══ RESULTADO: $PASS pasaron · $FAIL fallaron ═══"
[ "$FAIL" = "0" ] || exit 1
