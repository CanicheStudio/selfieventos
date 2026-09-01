/**
 * selfie-album-v2.js — Álbum del evento (backend propio)
 * ------------------------------------------------------
 * Spec v5 SELLADA · md5 aced02b998c6bc9d794d22aedad43c3d · §5
 *
 * ARCHIVO NUEVO — no reemplaza a js/selfie-album.js (v1) hasta que V3 cablee
 * las páginas en Webflow. Prod hoy no referencia este archivo.
 *
 * Flujo: ?evento=slug → GET /api/eventos/:slug (404 => "no encontrado", SIN
 * excepción) → email gate (POST /api/leads) → GET /api/fotos/:slug/:tipo →
 * galería 2 tabs → selección → lightbox → ZIP client-side.
 *
 * 🔴 EL BUG VIEJO MUERE POR DISEÑO: el front ya no arma NINGUNA URL de listado
 * contra Cloudinary. El único que lista es el Worker (por tag, vía Admin API);
 * el front solo MUESTRA (baseUrl + public_id).
 *
 * NOTA DE MÉTODO: este comentario NO cita el literal del endpoint viejo a
 * propósito. Citarlo haría que el propio criterio de cierre (grep de ese
 * literal → debe dar 0) encuentre el comentario y cante un falso rojo sobre
 * código sano. Un comentario de trazabilidad nombra el mecanismo, nunca el
 * string que se removió.
 */
(function (window, document) {
  'use strict';

  var CFG = window.SELFIE_CONFIG;

  // Turnstile de Webflow Forms: el runtime nuevo deshabilita el submit de CADA
  // form (disabled + w-form-loading) hasta tener token del challenge; si el
  // challenge no responde, el boton queda muerto (medido en prod 2026-09-01,
  // logica visible en webflow.js: `!s.is("[data-wf-no-turnstile]")`). Nuestros
  // forms no usan Webflow Forms (los datos van al Worker): opt-out explicito,
  // SOLO en forms hookeados nuestros, ANTES de que webflow.js inicialice
  // (este script carga primero en el body). El boton se re-habilita por si
  // este script llego a correr despues.
  function optOutTurnstile() {
    var forms = document.querySelectorAll('form[data-selfie], [data-selfie] form');
    Array.prototype.forEach.call(forms, function (f) {
      f.setAttribute('data-wf-no-turnstile', '');
      var w = f.closest('.w-form');
      if (w) w.setAttribute('data-wf-no-turnstile', '');
      var b = f.querySelector('button[type="submit"], input[type="submit"]');
      if (b) { b.disabled = false; b.classList.remove('w-form-loading'); }
    });
  }
  // Corre YA (si el script va al final del body, gana antes del init de
  // webflow.js) y de nuevo en DOMContentLoaded (si alguien mueve el script al
  // head, el sweep inmediato no encuentra forms — el segundo pase re-habilita).
  optOutTurnstile();
  document.addEventListener('DOMContentLoaded', optOutTurnstile);

  if (!CFG) { console.error('[selfie-album] falta selfie-config.js'); return; }

  var LS_EMAIL = 'selfie_email';
  var state = { slug: null, evento: null, fotos: { suelta: [], tira: [] }, tab: 'suelta', sel: {} };

  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  var el = function (attr) { return $('[data-selfie="' + attr + '"]'); };

  function show(node, on) { if (node) node.style.display = on ? '' : 'none'; }

  // Los Blocks hookeados de Cani pueden traer el nodo de texto ADENTRO
  // (Paragraph dentro del Block con el hook): textContent sobre el contenedor
  // pisaría ese párrafo — se escribe sobre el nodo interno si existe, análogo
  // al querySelector('img') del lightbox (directiva Cani 2026-08-30).
  function nodoTexto(n) {
    // Los components de Lumos guardan el texto en un nodo interno propio
    // (.button_main_text en Button Main, .u-text en Typography). Se apunta al
    // nodo de TEXTO, nunca al contenedor (button_main_element envuelve tambien
    // el icono: escribir ahi lo borraria).
    return n ? (n.querySelector('p,[class*="u-text"],[class*="_text"]') || n) : null;
  }

  function setEstado(msg) {
    var n = el('estado');
    if (n) { nodoTexto(n).textContent = msg; show(n, !!msg); }
    if (msg) console.info('[selfie-album]', msg);
  }

  function estadoAlTope() {
    // Errores de pagina (sin evento valido): el nodo estado vive junto a la
    // galeria, fuera del viewport inicial. Se muda junto al gate para que el
    // mensaje se vea sin scroll. Mover un nodo existente no es crear HTML.
    var n = el('estado');
    var gate = el('gate');
    if (n && gate && gate.parentNode) gate.parentNode.insertBefore(n, gate.nextSibling);
    // Medido en el E2E: aun mudado, el mensaje queda a ~1181px (hero de ~677px
    // encima) — bajo el pliegue en 1440x900. El scroll es parte del fix, no un
    // extra. OJO ORDEN: llamar DESPUES de setEstado — con el nodo vacio el CSS
    // lo oculta (:empty) y scrollIntoView sobre display:none no hace nada.
    // Y el scroll DEBE reintentar: el browser restaura la posicion (0) en el
    // evento load, que con imagenes pesadas llega DESPUES de este codigo y lo
    // pisa (observado en prod: scrollY volvia a 0 con el nodo bien ubicado).
    if (!n || !n.textContent) return;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    var bajarAlMensaje = function () {
      if (n.textContent && n.getBoundingClientRect().top > window.innerHeight * 0.9) {
        n.scrollIntoView({ block: 'center' });
      }
    };
    bajarAlMensaje();
    setTimeout(bajarAlMensaje, 1200);
    setTimeout(bajarAlMensaje, 2500);
  }

  /* ───────────────────────────── datos (Worker) ───────────────────────────── */

  function getEvento(slug) {
    return fetch(CFG.api('/api/eventos/' + encodeURIComponent(slug)))
      .then(function (r) {
        // 404 es un estado ESPERADO, no una excepción: se maneja, no se tira.
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('evento http ' + r.status);
        return r.json().then(function (d) { return d.evento; });
      });
  }

  function getFotos(slug, tipo) {
    return fetch(CFG.api('/api/fotos/' + encodeURIComponent(slug) + '/' + encodeURIComponent(tipo)))
      .then(function (r) {
        if (r.status === 404) return [];               // evento inexistente
        if (r.status === 503) {                        // backend sin credenciales
          console.warn('[selfie-album] fotos no disponibles (backend no configurado)');
          return [];
        }
        if (!r.ok) throw new Error('fotos http ' + r.status);
        return r.json().then(function (d) { return d.fotos || []; });
      });
  }

  function postLead(email, slug) {
    return fetch(CFG.api('/api/leads'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, evento: slug })
    }).then(function (r) { return r.ok; });
  }

  /* ────────────────────────────── email gate ─────────────────────────────── */


  // Los Button Main de Cani renderizan <button type="button"> (medido en
  // /subir 2026-09-01): ese type NO dispara el submit del form, y los handlers
  // escuchan 'submit' — click muerto. Cualquier boton interno que no sea
  // type=submit pasa a disparar el submit con validacion nativa. Guard: si el
  // Designer luego lo cambia a type=submit, no se engancha (evita el doble).
  function asegurarSubmit(form) {
    if (!form || form.tagName !== 'FORM') return;
    Array.prototype.forEach.call(form.querySelectorAll('button'), function (b) {
      if ((b.getAttribute('type') || 'submit').toLowerCase() === 'submit') return;
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    });
  }

  function gateVisible(on) {
    show(el('gate'), on);
    show(el('galeria'), !on);
  }

  function initGate() {
    var form = el('gate-form');
    if (!form) return;
    // webflow.js ata su propio submit al form (POST a Webflow Forms) ⇒ el lead
    // se capturaba DOBLE (D1 + Webflow, con límite de 50/mes en plan free).
    // Reemplazar el nodo por su clon suelta esos listeners; D1 queda como única captura.
    var clon = form.cloneNode(true);
    form.parentNode.replaceChild(clon, form);
    form = clon;
    // El handler de Webflow Forms vive en document, delegado con el selector
    // ".w-form form" (medido en la pasada final del E2E): sin la clase en el
    // wrapper, el submit ya no matchea y no hay doble captura del lead.
    var wfWrapper = form.closest('.w-form');
    if (wfWrapper) wfWrapper.classList.remove('w-form');
    var input = form.querySelector('[data-selfie="gate-email"]') || el('gate-email');
    if (!input) return;
    asegurarSubmit(form);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = (input.value || '').trim().toLowerCase();
      // Validación mínima en cliente; el server revalida (nunca confiar en el front).
      if (!email || email.indexOf('@') === -1 || email.indexOf('.') === -1) {
        setEstado('Poné un email válido para ver las fotos.');
        input.focus();
        return;
      }
      postLead(email, state.slug).then(function (ok) {
        if (!ok) console.warn('[selfie-album] el lead no se registró; dejo pasar igual');
        // El gate es captura de leads, NO barrera de seguridad: si el backend
        // falla, el invitado ve sus fotos igual. Nunca bloquear por tracking.
        try { window.localStorage.setItem(LS_EMAIL, email); } catch (e) {}
        gateVisible(false);
        cargarFotos();
      });
    });

    var skip = el('gate-skip');
    if (skip) {
      skip.addEventListener('click', function (ev) {
        ev.preventDefault();
        gateVisible(false);
        cargarFotos();
      });
    }
  }

  function yaDejoEmail() {
    try { return !!window.localStorage.getItem(LS_EMAIL); } catch (e) { return false; }
  }

  /* ─────────────────────────────── galería ───────────────────────────────── */

  function toggleSeleccion(foto) {
    if (state.sel[foto.public_id]) delete state.sel[foto.public_id];
    else state.sel[foto.public_id] = foto;
    actualizarBarra();
  }

  // A8/v7: la card de foto es un componente de CANI (§2 de la spec): cada
  // grilla trae su template adentro (card-suelta / card-tira). Se captura UNA
  // vez y se saca del DOM — así renderTab() puede vaciar el grid sin matarlo,
  // y el template nunca se muestra ni se cuenta como foto.
  // v7: dos grillas fijas (grid-suelta / grid-tira), cada una con su propio
  // template (card-suelta / card-tira). La grilla real es el slot .u-grid que
  // está DENTRO del componente Grid: el div de afuera (.u-grid-wrapper) es el
  // panel que Lumos usa para el switch de tabs y le pisa el display — nunca
  // escribir ahí.
  function gridDe(tab) {
    var wrap = el(tab === 'tira' ? 'grid-tira' : 'grid-suelta');
    return wrap ? (wrap.querySelector('.u-grid') || wrap) : null;
  }

  var tplCache = {};
  function cardTpl(tab) {
    if (Object.prototype.hasOwnProperty.call(tplCache, tab)) return tplCache[tab];
    var cont = gridDe(tab);
    var t = cont && cont.querySelector('[data-selfie="card-' + tab + '"]');
    if (t && t.parentNode) t.parentNode.removeChild(t);   // sale del DOM y queda cacheado
    tplCache[tab] = t || null;
    return tplCache[tab];
  }

  function refrescarCard(card, foto) {
    // Estado "seleccionada" = clase is-selected (border, CSS de Cani) + el tilde
    // nativo del checkbox. El tilde se setea acá y no por el click del browser:
    // el handler hace preventDefault (para que el check no abra el visor), lo que
    // cancela el marcado nativo — y así el estado también queda correcto cuando
    // la selección viene de "Seleccionar todas" o del visor.
    var on = !!state.sel[foto.public_id];
    card.classList.toggle('is-selected', on);
    var input = card.querySelector('input[type="checkbox"]');
    if (input) { input.checked = on; input.setAttribute('aria-checked', on ? 'true' : 'false'); }
  }

  function fotoNodoDesdeTemplate(tpl, foto, idx, tab) {
    var card = tpl.cloneNode(true);
    card.removeAttribute('data-selfie');   // el clon es una card, no el template
    card.style.display = '';               // por si el template se oculta inline
    card.setAttribute('data-idx', String(idx));

    // El Visual Image de Lumos bindea el atributo en el wrapper: la foto se
    // escribe siempre sobre el <img> real (mismo criterio que el lightbox).
    var img = card.tagName === 'IMG' ? card : card.querySelector('img');
    if (img) {
      img.loading = 'lazy';
      img.alt = state.evento ? ('Foto de ' + state.evento.nombre) : 'Foto del evento';
      img.src = CFG.fotoUrl(foto.public_id, 'c_fill,w_400,q_auto,f_auto');
    }

    // Visor: el click va en la CARD entera, no en el <img> — la card de Cani
    // trae un clickable_wrap u-cover-absolute (capa Lumos que tapa la foto y se
    // come los clicks: medido en prod 2026-09-01, elementFromPoint sobre la foto
    // devolvía la capa y el visor era inalcanzable). La zona del checkbox queda
    // excluida: ahí manda la selección.
    card.addEventListener('click', function (ev) {
      if (ev.target.closest('label, input, [data-selfie="card-check"]')) return;
      abrirLightbox(idx, tab);
    });

    var check = card.querySelector('[data-selfie="card-check"]');
    if (check) {
      check.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();   // que el check no abra el visor
        toggleSeleccion(foto);
        refrescarCard(card, foto);
      });
    }

    // El hook card-check es un prop del componente de Cani y puede caer en
    // cualquier nodo de la card (el texto, el wrapper, el input mismo). Si el
    // click aterriza DIRECTO en el checkbox nativo por fuera del hook, el
    // preventDefault de arriba no corre y el tilde cambiaría sin actualizar la
    // selección — este listener sincroniza ese camino. No duplica: cuando el
    // click pasa por el hook, el preventDefault cancela el tilde nativo y
    // 'change' nunca dispara.
    var inputNativo = card.querySelector('input[type="checkbox"]');
    if (inputNativo) {
      inputNativo.addEventListener('change', function () {
        toggleSeleccion(foto);
        refrescarCard(card, foto);
      });
    }

    refrescarCard(card, foto);
    return card;
  }

  // TODO(§2): cuando la card template exista en el Designer y esté VERIFICADA,
  // este fabricador de UI por createElement (y sus estilos) se elimina.
  // Hasta entonces es el fallback que mantiene el álbum vivo.
  function fotoNodo(foto, idx, tab) {
    var wrap = document.createElement('div');
    wrap.className = 'selfie_foto_item';
    wrap.setAttribute('data-idx', String(idx));

    var img = document.createElement('img');
    img.className = 'selfie_foto_img';
    img.loading = 'lazy';
    img.alt = state.evento ? ('Foto de ' + state.evento.nombre) : 'Foto del evento';
    img.src = CFG.fotoUrl(foto.public_id, 'c_fill,w_400,q_auto,f_auto');

    var check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'selfie_foto_check';
    check.checked = !!state.sel[foto.public_id];
    check.setAttribute('aria-label', 'Seleccionar foto ' + (idx + 1));
    check.addEventListener('change', function () {
      if (check.checked) state.sel[foto.public_id] = foto;
      else delete state.sel[foto.public_id];
      actualizarBarra();
    });

    img.addEventListener('click', function () { abrirLightbox(idx, tab); });

    wrap.appendChild(img);
    wrap.appendChild(check);
    return wrap;
  }

  // v7: como Lumos ya muestra/oculta el panel activo, se renderizan LAS DOS
  // grillas de una y el cambio de tab no re-renderiza nada.
  function renderTab(tab) {
    var cont = gridDe(tab);
    if (!cont) return 0;
    var tpl = cardTpl(tab);   // capturar ANTES de vaciar (el template vive adentro)
    cont.innerHTML = '';
    var fotos = state.fotos[tab] || [];
    fotos.forEach(function (f, i) {
      cont.appendChild(tpl ? fotoNodoDesdeTemplate(tpl, f, i, tab) : fotoNodo(f, i, tab));
    });
    return fotos.length;
  }

  function render() {
    var nSuelta = renderTab('suelta');
    var nTira = renderTab('tira');
    // La visibilidad de las tabs NO se toca acá: es de cargarFotos (regla A7 —
    // con un solo tipo con fotos se ocultan las dos, no una).
    setEstado((nSuelta + nTira) ? '' : 'Todavía no hay fotos de este evento.');
    actualizarBarra();
  }

  function initTabs() {
    // Lumos maneja el switch de paneles; acá se registra la tab activa y se
    // limpia la selección al cambiar (feedback Cani 2026-09-01: la selección
    // no viaja entre tabs — quedaba gente "des-seleccionando" a mano).
    function alCambiarTab(tab) {
      if (state.tab === tab) return;   // re-click en la tab activa: no limpiar
      state.tab = tab;
      if (Object.keys(state.sel).length) { state.sel = {}; render(); }
      marcarTab();
    }
    var tSuelta = el('tab-suelta');
    var tTira = el('tab-tira');
    if (tSuelta) tSuelta.addEventListener('click', function () { alCambiarTab('suelta'); });
    if (tTira) tTira.addEventListener('click', function () { alCambiarTab('tira'); });
  }

  function marcarTab() {
    var tSuelta = el('tab-suelta'), tTira = el('tab-tira');
    if (tSuelta) tSuelta.setAttribute('aria-selected', state.tab === 'suelta' ? 'true' : 'false');
    if (tTira) tTira.setAttribute('aria-selected', state.tab === 'tira' ? 'true' : 'false');
  }

  /* ──────────────────────── selección + descarga ZIP ─────────────────────── */

  function actualizarBarra() {
    var n = Object.keys(state.sel).length;
    var cont = el('contador');
    if (cont) nodoTexto(cont).textContent = n ? (n + ' seleccionada' + (n > 1 ? 's' : '')) : '';
    show(el('barra'), n > 0);
    actualizarSeleccionarTodo();
  }

  function todasSeleccionadas() {
    var fotos = state.fotos[state.tab] || [];
    return fotos.length > 0 && fotos.every(function (f) { return !!state.sel[f.public_id]; });
  }

  function actualizarSeleccionarTodo() {
    // A9: el label acompaña al toggle si el botón es texto simple o si trae su
    // nodo de texto interno reconocible (p / u-text). Component con estructura
    // sin nodo de texto identificable: el texto es de Cani y no se toca.
    var todo = el('seleccionar-todo');
    if (!todo) return;
    var t = todo.querySelector('p,[class*="u-text"]');
    if (!t && todo.children.length > 0) return;
    (t || todo).textContent = todasSeleccionadas() ? 'Quitar selección' : 'Seleccionar todas';
  }

  function initAcciones() {
    var todo = el('seleccionar-todo');
    if (todo) {
      // A9: toggle — con todo ya seleccionado, deselecciona todo (y la barra
      // se oculta sola vía actualizarBarra dentro de render).
      todo.addEventListener('click', function (ev) {
        ev.preventDefault();
        var fotos = state.fotos[state.tab] || [];
        // "Quitar selección" limpia TODO (no solo la tab activa) — coherente
        // con que la selección ya no viaja entre tabs.
        if (todasSeleccionadas()) state.sel = {};
        else fotos.forEach(function (f) { state.sel[f.public_id] = f; });
        render();
      });
    }
    var zip = el('descargar-zip');
    if (zip) zip.addEventListener('click', function (ev) { ev.preventDefault(); descargarZip(); });
  }

  // Modales de Lumos (piezas de Cani, con guarda) — mismo patrón que el
  // lightbox: API pública de Lumos si está (anima con GSAP y restaura el
  // scroll), <dialog> nativo como fallback, display como último recurso.
  function lumosModalApi(node) {
    var id = node && node.getAttribute('data-modal-target');
    return (id && window.lumos && window.lumos.modal && window.lumos.modal.list &&
      window.lumos.modal.list[id]) || null;
  }

  function abrirModal(node) {
    if (!node) return;
    var api = lumosModalApi(node);
    if (api) api.open();
    else if (node.tagName === 'DIALOG' && typeof node.showModal === 'function') { if (!node.open) node.showModal(); }
    else show(node, true);
  }

  function cerrarModal(node) {
    if (!node) return;
    var api = lumosModalApi(node);
    if (api) api.close();
    else if (node.tagName === 'DIALOG') { if (node.open) node.close(); }
    else show(node, false);
  }

  function descargarZip() {
    var fotos = Object.keys(state.sel).map(function (k) { return state.sel[k]; });
    if (!fotos.length) { setEstado('Elegí al menos una foto.'); return; }
    if (typeof window.JSZip === 'undefined' || typeof window.saveAs === 'undefined') {
      setEstado('No se pudo preparar la descarga.');
      console.error('[selfie-album] falta JSZip o FileSaver');
      return;
    }

    // A10: mientras arma el ZIP el botón queda deshabilitado — dos clicks
    // seguidos disparaban dos armados (observado). El Button Main de Lumos es
    // un div: se marca por atributo + clase y se ignora el click mientras dura.
    var btnZip = el('descargar-zip');
    function zipOcupado(on) {
      if (!btnZip) return;
      var real = btnZip.tagName === 'BUTTON' ? btnZip : btnZip.querySelector('button,a');
      if (real && 'disabled' in real) real.disabled = on;
      if (on) btnZip.setAttribute('aria-disabled', 'true');
      else btnZip.removeAttribute('aria-disabled');
      btnZip.classList.toggle('is-disabled', on);
    }
    if (btnZip && btnZip.getAttribute('aria-disabled') === 'true') return;  // ya está armando
    zipOcupado(true);

    // A10: progreso en el modal de Cani, actualizado por foto bajada. Sin la
    // pieza en el Designer: el mensaje de estado de siempre.
    var modal = el('progreso');
    var progTexto = el('progreso-texto');
    var total = fotos.length, bajadas = 0;
    function pintarProgreso() {
      if (progTexto) nodoTexto(progTexto).textContent =
        'Preparando tu descarga… (' + bajadas + ' de ' + total + ' fotos)';
    }
    if (modal) { pintarProgreso(); abrirModal(modal); }
    else setEstado('Preparando tu descarga…');

    var zip = new window.JSZip();
    var pend = fotos.map(function (f) {
      return fetch(CFG.fotoUrl(f.public_id, 'q_auto,f_auto'))
        .then(function (r) { return r.blob(); })
        .then(function (b) {
          var nombre = f.public_id.split('/').pop() + '.' + (f.format || 'jpg');
          zip.file(nombre, b);
          bajadas += 1;
          pintarProgreso();
        });
    });

    Promise.all(pend)
      .then(function () { return zip.generateAsync({ type: 'blob' }); })
      .then(function (blob) {
        var base = (state.evento && state.evento.slug) || state.slug || 'fotos';
        window.saveAs(blob, 'selfie-' + base + '.zip');
        cerrarModal(modal);   // guarda de nulo adentro
        setEstado('');
        zipOcupado(false);
      })
      .catch(function (err) {
        cerrarModal(modal);   // también en error: nunca un overlay clavado
        console.error('[selfie-album] zip', err);
        setEstado('No se pudo armar el ZIP. Probá de nuevo.');
        zipOcupado(false);
      });
  }

  /* ─────────────────────────────── lightbox ──────────────────────────────── */

  // A11: descarga de UNA foto con el FileSaver ya cargado para el ZIP (saveAs
  // sobre blob — un <a download> cross-origin a Cloudinary lo ignora el browser).
  function descargarFoto(foto) {
    if (typeof window.saveAs === 'undefined') {
      console.error('[selfie-album] falta FileSaver para descargar la foto');
      setEstado('No se pudo preparar la descarga.');
      return;
    }
    fetch(CFG.fotoUrl(foto.public_id, 'q_auto,f_auto'))
      .then(function (r) {
        if (!r.ok) throw new Error('foto http ' + r.status);
        return r.blob();
      })
      .then(function (b) {
        window.saveAs(b, foto.public_id.split('/').pop() + '.' + (foto.format || 'jpg'));
      })
      .catch(function (err) {
        console.error('[selfie-album] descarga foto', err);
        setEstado('No se pudo descargar la foto. Probá de nuevo.');
      });
  }

  function abrirLightbox(idx, tab) {
    var lb = el('lightbox'), img = el('lightbox-img');
    if (!lb || !img) return;
    // El Visual Image de Lumos bindea el atributo en el div wrapper, no en el
    // <img> interno — la foto se escribe siempre sobre un <img> real.
    if (img.tagName !== 'IMG') img = img.querySelector('img');
    if (!img) return;
    // El Modal de Lumos es un <dialog> nativo: se abre/cierra con la API del
    // dialog, y el cierre puede llegar por afuera (X, backdrop, Esc de Lumos)
    // → la limpieza se cuelga del evento 'close', no del camino de salida.
    var esDialog = lb.tagName === 'DIALOG' && typeof lb.showModal === 'function';
    // El Modal de Lumos anima backdrop/content con GSAP: showModal() pelado lo
    // abre invisible y close() directo no restaura el scroll del body — se usa
    // su API pública (window.lumos.modal) cuando está, con fallback al dialog.
    var modalId = lb.getAttribute('data-modal-target');
    var lumosModal = window.lumos && window.lumos.modal && window.lumos.modal.list &&
      modalId && window.lumos.modal.list[modalId];
    var fotos = state.fotos[tab || state.tab] || [];
    var i = idx;

    // A11: el botón "Seleccionar" del visor refleja el estado de la foto EN
    // PANTALLA (cambia con las flechas) — clase is-selected siempre; texto
    // solo si el botón es texto simple (component de Cani: no se toca).
    var btnSel = el('lightbox-seleccionar');
    function refrescarSeleccion() {
      if (!btnSel || !fotos[i]) return;
      var on = !!state.sel[fotos[i].public_id];
      btnSel.classList.toggle('is-selected', on);
      // Texto: sobre el nodo interno (p / u-text) si existe; texto simple si
      // no tiene hijos; component sin nodo reconocible: solo la clase.
      var t = btnSel.querySelector('p,[class*="u-text"]');
      if (t || btnSel.children.length === 0) {
        (t || btnSel).textContent = on ? 'Seleccionada' : 'Seleccionar';
      }
    }

    function pintar() {
      img.src = CFG.fotoUrl(fotos[i].public_id, 'q_auto,f_auto');
      refrescarSeleccion();
    }
    function limpiar() { document.removeEventListener('keydown', teclas); }
    function cerrar() {
      if (lumosModal) lumosModal.close();
      else if (esDialog) { if (lb.open) lb.close(); }
      else { show(lb, false); limpiar(); }
    }
    function teclas(ev) {
      if (ev.key === 'Escape') cerrar();
      else if (ev.key === 'ArrowRight') { i = (i + 1) % fotos.length; pintar(); }
      else if (ev.key === 'ArrowLeft') { i = (i - 1 + fotos.length) % fotos.length; pintar(); }
    }

    pintar();
    if (esDialog) {
      // resetModal de Lumos también cierra vía dialog.close() → dispara 'close'
      lb.addEventListener('close', limpiar, { once: true });
      if (lumosModal) lumosModal.open();
      else lb.showModal();
    } else {
      show(lb, true);
    }
    document.addEventListener('keydown', teclas);
    var close = el('lightbox-close');
    if (close) close.onclick = cerrar;

    // A11: acciones del visor (piezas de Cani, con guarda). onclick asignado
    // (no addEventListener): abrirLightbox corre por apertura y los handlers
    // deben PISARSE, no apilarse — mismo criterio que lightbox-close.
    var descargar = el('lightbox-descargar');
    if (descargar) {
      descargar.onclick = function (ev) {
        ev.preventDefault();
        if (fotos[i]) descargarFoto(fotos[i]);
      };
    }
    if (btnSel) {
      btnSel.onclick = function (ev) {
        ev.preventDefault();
        if (!fotos[i]) return;
        toggleSeleccion(fotos[i]);
        refrescarSeleccion();
        render();   // la card de la galería refleja el cambio sin cerrar el visor
      };
    }
  }

  /* ──────────────────────────────── arranque ─────────────────────────────── */

  function cargarFotos() {
    return Promise.all([getFotos(state.slug, 'suelta'), getFotos(state.slug, 'tira')])
      .then(function (res) {
        state.fotos.suelta = res[0];
        state.fotos.tira = res[1];
        // A7: con un solo tipo con fotos las tabs sobran — se ocultan LAS DOS
        // (una tab solitaria no elige nada). Si Cani envuelve las tabs en una
        // fila propia, ocultar ambos links equivale a ocultar la fila.
        var haySueltas = state.fotos.suelta.length > 0;
        var hayTiras = state.fotos.tira.length > 0;
        var ambas = haySueltas && hayTiras;
        show(el('tab-suelta'), ambas);
        show(el('tab-tira'), ambas);
        // Sin tabs a la vista, la activa DEBE ser la que tiene fotos (si no,
        // un evento solo-tiras quedaría clavado en "no hay fotos" sin salida).
        // v7: los paneles los muestra/oculta Lumos y arranca en el primero
        // (sueltas) — el click programático dispara su switch aunque el link
        // esté oculto por display:none.
        if (!ambas && hayTiras) {
          state.tab = 'tira';
          var tTira = el('tab-tira');
          if (tTira) tTira.click();
        }
        render();
        marcarTab();
      })
      .catch(function (err) {
        console.error('[selfie-album]', err);
        setEstado('No pudimos cargar las fotos. Recargá la página.');
      });
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    state.slug = params.get('evento');

    if (!state.slug) {
      // A12: sin ?evento= en la URL, la salida es la form de código de Cani
      // (con guarda: sin la pieza, el mensaje de estado actual queda intacto).
      var codigoForm = el('codigo-form');
      if (codigoForm) {
        // Mismo saneo que el gate: webflow.js delega su submit en
        // '.w-form form' (POST a Webflow Forms, 50/mes en plan free) — el
        // clon suelta listeners directos y sin la clase no matchea el delegado.
        var clonForm = codigoForm.cloneNode(true);
        codigoForm.parentNode.replaceChild(clonForm, codigoForm);
        codigoForm = clonForm;
        var wfWrap = codigoForm.closest('.w-form');
        if (wfWrap) wfWrap.classList.remove('w-form');

        show(codigoForm, true);
        codigoForm.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var input = codigoForm.querySelector('[data-selfie="codigo-input"]') || el('codigo-input');
          var valor = input ? (input.value || '').trim() : '';
          if (!valor) return;
          // La validación ya existe: slug inválido → 404 → mensaje de error actual.
          window.location.search = '?evento=' + encodeURIComponent(valor);
        });
      } else {
        setEstado('Falta el código del evento. Escaneá el QR de la cabina.');
        estadoAlTope();
      }
      gateVisible(false);
      show(el('galeria'), false);
      return;
    }

    getEvento(state.slug).then(function (evento) {
      if (!evento) {
        // 404 manejado: mensaje claro, sin excepción en consola.
        setEstado('No encontramos ese evento. Revisá el link del QR.');
        estadoAlTope();
        gateVisible(false);
        show(el('galeria'), false);
        return;
      }
      state.evento = evento;
      // RichText de Cani: el texto cae en el nodo interno (nodoTexto), no en
      // el contenedor — un write directo volaría el <p> y su estilo de párrafo.
      var titulo = el('evento-nombre');
      if (titulo) nodoTexto(titulo).textContent = evento.nombre;
      var lugar = el('evento-lugar');
      if (lugar && evento.lugar) nodoTexto(lugar).textContent = evento.lugar;

      initGate();
      initTabs();
      initAcciones();

      if (yaDejoEmail()) { gateVisible(false); cargarFotos(); }
      else gateVisible(true);
    }).catch(function (err) {
      console.error('[selfie-album]', err);
      setEstado('No pudimos cargar el evento. Recargá la página.');
      estadoAlTope();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window, document);
