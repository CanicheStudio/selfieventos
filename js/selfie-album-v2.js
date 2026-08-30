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
  if (!CFG) { console.error('[selfie-album] falta selfie-config.js'); return; }

  var LS_EMAIL = 'selfie_email';
  var state = { slug: null, evento: null, fotos: { suelta: [], tira: [] }, tab: 'suelta', sel: {} };

  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  var el = function (attr) { return $('[data-selfie="' + attr + '"]'); };

  function show(node, on) { if (node) node.style.display = on ? '' : 'none'; }

  function setEstado(msg) {
    var n = el('estado');
    if (n) { n.textContent = msg; show(n, !!msg); }
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

  // A8: la card de foto es un componente de CANI (§2 de la spec): el template
  // vive OCULTO dentro del grid con data-selfie="card-template". Se captura
  // UNA vez y se saca del DOM — así render() puede vaciar el grid sin matarlo,
  // y el template nunca se muestra ni se cuenta como foto.
  var tplCard = null;
  function cardTpl() {
    if (tplCard) return tplCard;
    var cont = el('grid');
    var t = cont && cont.querySelector('[data-selfie="card-template"]');
    if (t) { t.parentNode.removeChild(t); tplCard = t; }
    return tplCard;
  }

  function refrescarCard(card, foto) {
    // Estado "seleccionada" = clase is-selected (check tildado + border, CSS de Cani).
    card.classList.toggle('is-selected', !!state.sel[foto.public_id]);
  }

  function fotoNodoDesdeTemplate(tpl, foto, idx) {
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
      img.addEventListener('click', function () { abrirLightbox(idx); });
    }

    var check = card.querySelector('[data-selfie="card-check"]');
    if (check) {
      check.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();   // que el check no abra el visor
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
  function fotoNodo(foto, idx) {
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

    img.addEventListener('click', function () { abrirLightbox(idx); });

    wrap.appendChild(img);
    wrap.appendChild(check);
    return wrap;
  }

  function render() {
    var cont = el('grid');
    if (!cont) return;
    var tpl = cardTpl();   // capturar ANTES de vaciar el grid (el template vive adentro)
    cont.innerHTML = '';
    var fotos = state.fotos[state.tab] || [];

    if (!fotos.length) {
      setEstado(state.tab === 'tira'
        ? 'Todavía no hay tiras de este evento.'
        : 'Todavía no hay fotos de este evento.');
      return;
    }
    setEstado('');
    fotos.forEach(function (f, i) {
      cont.appendChild(tpl ? fotoNodoDesdeTemplate(tpl, f, i) : fotoNodo(f, i));
    });
    actualizarBarra();
  }

  function initTabs() {
    var tSuelta = el('tab-suelta');
    var tTira = el('tab-tira');
    if (tSuelta) tSuelta.addEventListener('click', function () { state.tab = 'suelta'; render(); marcarTab(); });
    if (tTira) tTira.addEventListener('click', function () { state.tab = 'tira'; render(); marcarTab(); });
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
    if (cont) cont.textContent = n ? (n + ' seleccionada' + (n > 1 ? 's' : '')) : '';
    show(el('barra'), n > 0);
    actualizarSeleccionarTodo();
  }

  function todasSeleccionadas() {
    var fotos = state.fotos[state.tab] || [];
    return fotos.length > 0 && fotos.every(function (f) { return !!state.sel[f.public_id]; });
  }

  function actualizarSeleccionarTodo() {
    // A9: el label acompaña al toggle SOLO si el botón es texto simple (sin
    // hijos). Si es un component de Lumos con estructura propia, el texto es
    // de Cani y no se toca — queda el comportamiento.
    var todo = el('seleccionar-todo');
    if (!todo || todo.children.length > 0) return;
    todo.textContent = todasSeleccionadas() ? 'Quitar selección' : 'Seleccionar todas';
  }

  function initAcciones() {
    var todo = el('seleccionar-todo');
    if (todo) {
      // A9: toggle — con todo ya seleccionado, deselecciona todo (y la barra
      // se oculta sola vía actualizarBarra dentro de render).
      todo.addEventListener('click', function (ev) {
        ev.preventDefault();
        var fotos = state.fotos[state.tab] || [];
        if (todasSeleccionadas()) fotos.forEach(function (f) { delete state.sel[f.public_id]; });
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

    // A10: progreso en el modal de Cani, actualizado por foto bajada. Sin la
    // pieza en el Designer: el mensaje de estado de siempre.
    var modal = el('progreso');
    var progTexto = el('progreso-texto');
    var total = fotos.length, bajadas = 0;
    function pintarProgreso() {
      if (progTexto) progTexto.textContent =
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
      })
      .catch(function (err) {
        cerrarModal(modal);   // también en error: nunca un overlay clavado
        console.error('[selfie-album] zip', err);
        setEstado('No se pudo armar el ZIP. Probá de nuevo.');
      });
  }

  /* ─────────────────────────────── lightbox ──────────────────────────────── */

  function abrirLightbox(idx) {
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
    var fotos = state.fotos[state.tab] || [];
    var i = idx;

    function pintar() { img.src = CFG.fotoUrl(fotos[i].public_id, 'q_auto,f_auto'); }
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
        if (!ambas && hayTiras) state.tab = 'tira';
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
      setEstado('Falta el código del evento. Escaneá el QR de la cabina.');
      estadoAlTope();
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
      var titulo = el('evento-nombre');
      if (titulo) titulo.textContent = evento.nombre;
      var lugar = el('evento-lugar');
      if (lugar && evento.lugar) lugar.textContent = evento.lugar;

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
