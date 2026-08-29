#!/bin/bash
# Suite V2 — JS del front · spec v5 §8 (md5 aced02b998c6bc9d794d22aedad43c3d)
# Tests node + estáticos sobre el repo. NO requiere Webflow ni deploy.
# Se corre desde worker/:  ./tests/v2-suite.sh

JS="$(cd "$(dirname "$0")/../../js" && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ✅ %-58s %s\n' "$1" "$2"; }
no(){ FAIL=$((FAIL+1)); printf '  ❌ %-58s %s\n' "$1" "$2"; }

echo "═══ SUITE V2 · $JS · $(date '+%Y-%m-%d %H:%M:%S') ═══"
NUEVOS="selfie-config.js selfie-album-v2.js selfie-subir.js selfie-home.js"

echo; echo "── V2.4 parse estricto de los 4 archivos nuevos ──"
for f in $NUEVOS; do
  if node --check "$JS/$f" 2>/dev/null; then ok "node --check $f" "sintaxis OK"
  else no "node --check $f" "$(node --check "$JS/$f" 2>&1 | head -1)"; fi
done

echo; echo "── V2.1 assertReady(): custodia de placeholders + anti-legacy ──"
R=$(node -e "
global.window={};require('$JS/selfie-config.js');
var C=window.SELFIE_CONFIG;
C.WORKER_URL='<<<PENDIENTE H2: placeholder sintetico>>>'; C.CLOUD_NAME='<<<PENDIENTE H1: placeholder sintetico>>>';
console.log('PEND:'+JSON.stringify(C.assertReady()));
C.WORKER_URL='https://w.workers.dev'; C.CLOUD_NAME='selfie-caniche';
console.log('LISTO:'+JSON.stringify(C.assertReady()));
C.CLOUD_NAME='dcjutekja';
console.log('LEGACY:'+JSON.stringify(C.assertReady()));
" 2>&1)
echo "$R" | grep -q 'PEND:\["WORKER_URL","CLOUD_NAME"\]' \
  && ok "con placeholders → los lista" "$(echo "$R"|grep PEND)" \
  || no "con placeholders → los lista" "$(echo "$R"|grep PEND)"
echo "$R" | grep -q 'LISTO:\[\]' \
  && ok "con valores reales → []" "gate pasa solo si está completo" \
  || no "con valores reales → []" "$(echo "$R"|grep LISTO)"
echo "$R" | grep -q 'LEGACY:\["CLOUD_NAME(legacy dcjutekja)"\]' \
  && ok "🔴 dcjutekja → RECHAZADO por nombre" "el falso verde no puede pasar" \
  || no "🔴 dcjutekja → RECHAZADO" "$(echo "$R"|grep LEGACY)"

echo; echo "── V2.2 tagFor(): falla RUIDOSA ante mal uso (regresión sellada) ──"
R2=$(node -e "
global.window={};require('$JS/selfie-config.js');
var C=window.SELFIE_CONFIG;
console.log('OK1:'+C.tagFor('qa-evento-de-prueba','suelta'));
console.log('OK2:'+C.tagFor('qa-evento-de-prueba','tira'));
try{C.tagFor('evt-x-suelta');console.log('THROW:NO');}catch(e){console.log('THROW:SI|'+e.message.slice(0,70));}
try{C.tagFor('x','fotos');console.log('THROW2:NO');}catch(e){console.log('THROW2:SI');}
" 2>&1)
echo "$R2" | grep -q 'OK1:evt-qa-evento-de-prueba-suelta' && ok "tagFor(slug,'suelta') canónico" "evt-qa-evento-de-prueba-suelta" || no "tagFor suelta" "$R2"
echo "$R2" | grep -q 'OK2:evt-qa-evento-de-prueba-tira' && ok "tagFor(slug,'tira') canónico" "evt-qa-evento-de-prueba-tira" || no "tagFor tira" "$R2"
echo "$R2" | grep -q 'THROW:SI' && ok "tagFor(tag) 1 arg → THROW" "$(echo "$R2"|grep THROW: |cut -c1-80)" || no "tagFor(tag) → THROW" "$R2"
echo "$R2" | grep -q 'THROW2:SI' && ok "tipo inválido ('fotos') → THROW" "rechaza tipos fuera del contrato" || no "tipo inválido → THROW" "$R2"

echo; echo "── V2.3 CERO Google y CERO list en el código NUEVO ──"
# El alcance es el CÓDIGO NUEVO: los legacy selfie-sheets-*.js siguen vivos en
# prod por instrucción explícita (se reemplazan en V3). Se los mide aparte para
# que la exclusión sea visible y no un agujero en el criterio.
# 🔴 DOS TRAMPAS DEL INSTRUMENTO, las dos medidas acá (daban 0 con violación viva):
#  (1) `grep -c a b` imprime UNA LÍNEA POR ARCHIVO ("file:N") y meter eso en
#      $(( )) revienta la aritmética dejando un 0 con cara de medición.
#  (2) en esta máquina `grep` es ugrep: una VARIABLE SIN COMILLAS con varias
#      rutas la toma como UN nombre de archivo, avisa "No such file or
#      directory" por stderr (que el 2>/dev/null se tragaba) y devuelve 0.
# Cura: recorrer archivo por archivo, y AUTO-TEST del contador antes de confiar
# en él (un contador que no puede detectar una violación no mide nada).
contar() { # patrón_extendido → líneas que matchean en los 4 archivos nuevos
  local pat="$1" total=0 f n
  for f in $NUEVOS; do
    n=$(grep -hE "$pat" "$JS/$f" 2>/dev/null | wc -l | tr -d ' ')
    total=$((total + n))
  done
  echo "$total"
}

# AUTO-TEST: con un patrón que SÍ existe seguro, el contador debe dar > 0.
# Si diera 0, el instrumento está roto y cualquier "0 violaciones" sería falso.
CENTINELA=$(contar "selfie")
if [ "$CENTINELA" -gt 0 ]; then
  ok "auto-test del contador (centinela 'selfie')" "$CENTINELA matches ⇒ el grep SÍ mide"
else
  no "auto-test del contador" "0 con patrón que existe ⇒ INSTRUMENTO ROTO, los 0 de abajo no valen"
fi

N_LIST=$(contar "image/list")
N_GOOG=$(contar "2PACX|script\.google|docs\.google|gviz")
[ "$N_LIST" = "0" ] && ok "grep 'image/list' en los 4 nuevos" "0 (listUrl NO se portó)" || no "grep 'image/list'" "$N_LIST"
[ "$N_GOOG" = "0" ] && ok "grep Google (2PACX/script/docs/gviz)" "0 (cero Google en código nuevo)" || no "grep Google" "$N_GOOG"

LEG=$(grep -lE "2PACX|docs\.google" "$JS/selfie-sheets-live.js" "$JS/selfie-sheets-eventos.js" 2>/dev/null | wc -l | tr -d ' ')
printf '  ℹ️  %-58s %s archivo(s) legacy con Google (intocados a propósito)\n' "referencia: legacy v1 sin modificar" "$LEG"

echo; echo "── V2.5 el contrato data-selfie VIVO se preserva (no romper el home) ──"
# selfie-home.js debe usar los MISMOS atributos que el script v1 que corre hoy.
FALTAN=""
for a in live-title live-subtitle live-image title text image link; do
  grep -q "data-selfie=\\\\\"$a\\\\\"\|data-selfie=\"$a\"" "$JS/selfie-home.js" || FALTAN="$FALTAN $a"
done
[ -z "$FALTAN" ] && ok "los 7 data-selfie del contrato v1 presentes" "no se inventó contrato nuevo" || no "faltan data-selfie:" "$FALTAN"
grep -q "section_eventos-en-vivo" "$JS/selfie-home.js" && ok "usa #section_eventos-en-vivo (id vivo)" "misma sección que el v1" || no "id de sección live" "no encontrado"
grep -q "card_primary_wrap" "$JS/selfie-home.js" && ok "clona .card_primary_wrap (markup de Cani manda)" "no genera HTML propio" || no "clonado de card" "no encontrado"
grep -q "swiper.update" "$JS/selfie-home.js" && ok "actualiza Swiper tras inyectar slides" "si no, no desliza" || no "swiper.update" "no encontrado"

echo; echo "── V2.6 los legacy que prod carga HOY siguen intactos ──"
cd "$JS/.." || exit 1
DIRTY=$(git status --porcelain js/selfie-sheets-live.js js/selfie-sheets-eventos.js js/selfie-album.js 2>/dev/null | wc -l | tr -d ' ')
[ "$DIRTY" = "0" ] && ok "sheets-live / sheets-eventos / album.js v1" "0 modificados (git)" || no "legacy modificados" "$DIRTY archivos"

echo; echo "═══ RESULTADO V2: $PASS pasaron · $FAIL fallaron ═══"
[ "$FAIL" = "0" ] || exit 1
