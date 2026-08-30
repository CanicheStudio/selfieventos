/**
 * selfie-subir.js — Página /subir (la herramienta de Fer)
 * -------------------------------------------------------
 * Spec v5 SELLADA · md5 aced02b998c6bc9d794d22aedad43c3d · §5
 *
 * OBJETIVO DE NEGOCIO: Fer opera TODO desde acá, sin dashboards.
 * Crear evento + subir fotos, desde el teléfono, durante el evento.
 *
 * Flujo: PIN → selector de evento (GET /api/eventos) o "Evento nuevo"
 * (POST /api/eventos) → toggle Fotos/Tiras → widget de Cloudinary con el tag
 * correcto (tagFor) → las fotos aparecen solas en /album.
 *
 * 🔴 EL PIN ES FRICCIÓN, NO SEGURIDAD DURA. Viaja en un header hacia el Worker
 * (que lo valida server-side). No protege contra alguien decidido: protege
 * contra que la URL circule y cualquiera suba cosas. Declarado así en la spec.
 */
(function (window, document) {
  'use strict';

  var CFG = window.SELFIE_CONFIG;
  if (!CFG) { console.error('[selfie-subir] falta selfie-config.js'); return; }

  var LS_PIN = 'selfie_pin';
  var state = { pin: null, eventos: [], slug: null, tipo: 'suelta' };

  var el = function (attr) { return document.querySelector('[data-selfie="' + attr + '"]'); };
  function show(n, on) { if (n) n.style.display = on ? '' : 'none'; }

  function setEstado(msg, esError) {
    var n = el('estado');
    if (n) {
      // El nodo puede quedar dentro de la seccion OCULTA (gate vs app): un
      // "PIN incorrecto" escrito en un contenedor display:none es invisible
      // (bug real: Cani no veia ningun error al fallar el PIN, 2026-08-29).
      // Se muda al contenedor visible antes de escribir.
      var gate = el('pin-gate');
      var app = el('app');
      var visible = (gate && gate.style.display !== 'none') ? gate : app;
      if (visible && n.parentElement !== visible) visible.appendChild(n);
      n.textContent = msg; show(n, !!msg); n.setAttribute('data-error', esError ? '1' : '0');
    }
    if (msg) (esError ? console.warn : console.info)('[selfie-subir]', msg);
  }

  function pinHeaders() {
    return { 'Content-Type': 'application/json', 'X-Selfie-Pin': state.pin || '' };
  }

  /* ──────────────────────────────── PIN ──────────────────────────────────── */

  function initPin() {
    try { state.pin = window.localStorage.getItem(LS_PIN); } catch (e) {}
    if (state.pin) { validarPin(state.pin); return; }
    show(el('pin-gate'), true);
    show(el('app'), false);

    var form = el('pin-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var input = el('pin-input');
      var v = input ? (input.value || '').trim() : '';
      if (!v) { setEstado('Escribí el PIN.', true); return; }
      validarPin(v);
    });
  }

  function validarPin(pin) {
    // Se valida contra el SERVER (no hay comparación de PIN en el front).
    // Sonda: GET /panel con el PIN → 200 si es válido (el HTML se descarta).
    // C3: la sonda vieja (POST inválido a propósito) hacía que el caso ESPERADO
    // fuera un 400, y el browser pinta TODO 4xx en rojo en consola aunque el JS
    // lo maneje — no se puede suprimir desde el código. Con /panel la carga
    // normal queda limpia; el 4xx rojo queda solo para el PIN realmente malo.
    setEstado('Validando…');
    fetch(CFG.api('/panel'), {
      headers: { 'X-Selfie-Pin': pin }
    }).then(function (r) {
      if (r.status === 401) {
        setEstado('PIN incorrecto.', true);
        try { window.localStorage.removeItem(LS_PIN); } catch (e) {}
        state.pin = null;
        show(el('pin-gate'), true);
        show(el('app'), false);
        return;
      }
      if (r.status === 429) { setEstado('Demasiados intentos. Esperá un minuto.', true); return; }
      if (!r.ok) { setEstado('No se pudo validar el PIN. Probá de nuevo.', true); return; }
      // 200 = PIN válido.
      state.pin = pin;
      try { window.localStorage.setItem(LS_PIN, pin); } catch (e) {}
      setEstado('');
      show(el('pin-gate'), false);
      show(el('app'), true);
      cargarEventos();
    }).catch(function (err) {
      console.error('[selfie-subir]', err);
      setEstado('No se pudo conectar. Revisá la señal.', true);
    });
  }

  /* ───────────────────────────── eventos ─────────────────────────────────── */

  function cargarEventos() {
    return fetch(CFG.api('/api/eventos'))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.eventos = d.eventos || [];
        var sel = el('evento-select');
        if (!sel) return;
        sel.innerHTML = '';
        var vacio = document.createElement('option');
        vacio.value = '';
        vacio.textContent = state.eventos.length ? 'Elegí el evento…' : 'No hay eventos todavía';
        sel.appendChild(vacio);
        state.eventos.forEach(function (e) {
          var o = document.createElement('option');
          o.value = e.slug;
          o.textContent = e.nombre + (e.fecha ? ' · ' + e.fecha : '');
          sel.appendChild(o);
        });
        sel.addEventListener('change', function () {
          state.slug = sel.value || null;
          actualizarDestino();
        });
      })
      .catch(function (err) {
        console.error('[selfie-subir]', err);
        setEstado('No se pudieron cargar los eventos.', true);
      });
  }

  function initEventoNuevo() {
    var form = el('nuevo-form');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var nombre = (el('nuevo-nombre') || {}).value || '';
      var lugar = (el('nuevo-lugar') || {}).value || '';
      var fecha = (el('nuevo-fecha') || {}).value || '';
      var tipo = (el('nuevo-tipo') || {}).value || '';

      if (!nombre.trim()) { setEstado('Poné el nombre del evento.', true); return; }
      setEstado('Creando evento…');

      fetch(CFG.api('/api/eventos'), {
        method: 'POST',
        headers: pinHeaders(),
        body: JSON.stringify({
          nombre: nombre.trim(),
          lugar: lugar.trim() || null,
          fecha: fecha || null,
          tipo: tipo.trim() || null
        })
      }).then(function (r) {
        if (r.status === 401) { setEstado('El PIN dejó de ser válido.', true); return null; }
        return r.json().then(function (d) {
          if (!r.ok) {
            // Rechazo NUNCA silencioso: se dice QUÉ campo falló.
            var campos = (d.fields || []).join(', ');
            setEstado(campos ? ('Revisá: ' + campos) : 'No se pudo crear el evento.', true);
            return null;
          }
          return d.evento;
        });
      }).then(function (evento) {
        if (!evento) return;
        setEstado('Evento creado: ' + evento.nombre);
        state.slug = evento.slug;
        return cargarEventos().then(function () {
          var sel = el('evento-select');
          if (sel) sel.value = evento.slug;
          actualizarDestino();
          show(el('nuevo-panel'), false);
        });
      }).catch(function (err) {
        console.error('[selfie-subir]', err);
        setEstado('No se pudo crear el evento.', true);
      });
    });

    var toggle = el('nuevo-toggle');
    if (toggle) {
      toggle.addEventListener('click', function (ev) {
        ev.preventDefault();
        var p = el('nuevo-panel');
        show(p, !p || p.style.display === 'none');
      });
    }
  }

  function initFecha() {
    // A13: click/focus en cualquier parte del campo fecha abre el calendario
    // directo. showPicker() requiere user-gesture y no existe en browsers
    // viejos → try/catch con fallback silencioso al comportamiento nativo.
    var fecha = el('nuevo-fecha');
    if (!fecha || typeof fecha.showPicker !== 'function') return;
    var abrirCalendario = function () { try { fecha.showPicker(); } catch (e) {} };
    fecha.addEventListener('focus', abrirCalendario);
    fecha.addEventListener('click', abrirCalendario);
  }

  /* ─────────────────────── tipo (Fotos / Tiras) + upload ─────────────────── */

  function initTipo() {
    var bs = el('tipo-suelta'), bt = el('tipo-tira');
    function set(t) {
      state.tipo = t;
      if (bs) bs.setAttribute('aria-pressed', t === 'suelta' ? 'true' : 'false');
      if (bt) bt.setAttribute('aria-pressed', t === 'tira' ? 'true' : 'false');
      actualizarDestino();
    }
    if (bs) bs.addEventListener('click', function (e) { e.preventDefault(); set('suelta'); });
    if (bt) bt.addEventListener('click', function (e) { e.preventDefault(); set('tira'); });
    set('suelta');
  }

  function actualizarDestino() {
    var n = el('destino');
    if (!n) return;
    if (!state.slug) { n.textContent = 'Elegí un evento para poder subir.'; return; }
    var ev = state.eventos.filter(function (e) { return e.slug === state.slug; })[0];
    n.textContent = 'Subiendo a: ' + ((ev && ev.nombre) || state.slug) +
      ' · ' + (state.tipo === 'tira' ? 'Tiras' : 'Fotos');
  }

  function initUpload() {
    var btn = el('subir-btn');
    if (!btn) return;

    btn.addEventListener('click', function (ev) {
      ev.preventDefault();

      // Bloqueo explícito: sin evento no se sube (si no, las fotos caen en un
      // tag que ningún álbum pide y se pierden sin que nadie se entere).
      if (!state.slug) { setEstado('Primero elegí el evento.', true); return; }
      if (typeof window.cloudinary === 'undefined') {
        setEstado('No se pudo abrir el subidor.', true);
        console.error('[selfie-subir] falta el widget de Cloudinary');
        return;
      }

      var tag = CFG.tagFor(state.slug, state.tipo);   // contrato compartido con el Worker
      var widget = window.cloudinary.createUploadWidget({
        cloudName: CFG.CLOUD_NAME,
        uploadPreset: CFG.UPLOAD_PRESET,
        folder: CFG.CLOUDINARY_FOLDER,
        tags: [tag],
        sources: ['local', 'camera'],
        multiple: true,
        maxFiles: 300,
        language: 'es',
        text: { es: { or: 'o', menu: { files: 'Mis fotos', camera: 'Cámara' } } }
      }, function (error, result) {
        if (error) {
          console.error('[selfie-subir]', error);
          setEstado('Hubo un problema al subir. Probá de nuevo.', true);
          return;
        }
        if (result && result.event === 'success') {
          setEstado('Subida: ' + (result.info && result.info.original_filename ? result.info.original_filename : 'foto'));
        }
        if (result && result.event === 'queues-end') {
          setEstado('¡Listo! Ya podés verlas en el álbum del evento.');
        }
      });
      widget.open();
    });
  }

  function init() {
    initPin();
    initEventoNuevo();
    initFecha();
    initTipo();
    initUpload();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window, document);
