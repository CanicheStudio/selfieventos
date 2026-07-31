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
    var input = el('gate-email');
    if (!form || !input) return;

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
    cont.innerHTML = '';
    var fotos = state.fotos[state.tab] || [];

    if (!fotos.length) {
      setEstado(state.tab === 'tira'
        ? 'Todavía no hay tiras de este evento.'
        : 'Todavía no hay fotos de este evento.');
      return;
    }
    setEstado('');
    fotos.forEach(function (f, i) { cont.appendChild(fotoNodo(f, i)); });
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
  }

  function initAcciones() {
    var todo = el('seleccionar-todo');
    if (todo) {
      todo.addEventListener('click', function (ev) {
        ev.preventDefault();
        (state.fotos[state.tab] || []).forEach(function (f) { state.sel[f.public_id] = f; });
        render();
      });
    }
    var zip = el('descargar-zip');
    if (zip) zip.addEventListener('click', function (ev) { ev.preventDefault(); descargarZip(); });
  }

  function descargarZip() {
    var fotos = Object.keys(state.sel).map(function (k) { return state.sel[k]; });
    if (!fotos.length) { setEstado('Elegí al menos una foto.'); return; }
    if (typeof window.JSZip === 'undefined' || typeof window.saveAs === 'undefined') {
      setEstado('No se pudo preparar la descarga.');
      console.error('[selfie-album] falta JSZip o FileSaver');
      return;
    }

    setEstado('Preparando tu descarga…');
    var zip = new window.JSZip();
    var pend = fotos.map(function (f) {
      return fetch(CFG.fotoUrl(f.public_id, 'q_auto,f_auto'))
        .then(function (r) { return r.blob(); })
        .then(function (b) {
          var nombre = f.public_id.split('/').pop() + '.' + (f.format || 'jpg');
          zip.file(nombre, b);
        });
    });

    Promise.all(pend)
      .then(function () { return zip.generateAsync({ type: 'blob' }); })
      .then(function (blob) {
        var base = (state.evento && state.evento.slug) || state.slug || 'fotos';
        window.saveAs(blob, 'selfie-' + base + '.zip');
        setEstado('');
      })
      .catch(function (err) {
        console.error('[selfie-album] zip', err);
        setEstado('No se pudo armar el ZIP. Probá de nuevo.');
      });
  }

  /* ─────────────────────────────── lightbox ──────────────────────────────── */

  function abrirLightbox(idx) {
    var lb = el('lightbox'), img = el('lightbox-img');
    if (!lb || !img) return;
    var fotos = state.fotos[state.tab] || [];
    var i = idx;

    function pintar() { img.src = CFG.fotoUrl(fotos[i].public_id, 'q_auto,f_auto'); }
    function cerrar() { show(lb, false); document.removeEventListener('keydown', teclas); }
    function teclas(ev) {
      if (ev.key === 'Escape') cerrar();
      else if (ev.key === 'ArrowRight') { i = (i + 1) % fotos.length; pintar(); }
      else if (ev.key === 'ArrowLeft') { i = (i - 1 + fotos.length) % fotos.length; pintar(); }
    }

    pintar();
    show(lb, true);
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
        // La tab Tiras solo existe si hay tiras (regla de negocio heredada).
        show(el('tab-tira'), state.fotos.tira.length > 0);
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
      gateVisible(false);
      show(el('galeria'), false);
      return;
    }

    getEvento(state.slug).then(function (evento) {
      if (!evento) {
        // 404 manejado: mensaje claro, sin excepción en consola.
        setEstado('No encontramos ese evento. Revisá el link del QR.');
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
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window, document);
