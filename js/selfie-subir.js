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

  // Guarda anti doble-carga: durante la migracion de los paneles freeform a
  // registered scripts la pagina puede referenciar el archivo DOS veces por
  // una ventana de publish — el segundo init duplicaria handlers y POSTs.
  if (window.__selfieSubirInit) return;
  window.__selfieSubirInit = true;

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

  if (!CFG) { console.error('[selfie-subir] falta selfie-config.js'); return; }

  var LS_PIN = 'selfie_pin';
  var state = { pin: null, eventos: [], slug: null, tipo: 'suelta' };

  var el = function (attr) { return document.querySelector('[data-selfie="' + attr + '"]'); };
  function show(n, on) { if (n) n.style.display = on ? '' : 'none'; }

  // Los Blocks hookeados de Cani pueden traer el nodo de texto ADENTRO
  // (Paragraph dentro del Block con el hook): textContent sobre el contenedor
  // pisaría ese párrafo — se escribe sobre el nodo interno si existe
  // (directiva Cani 2026-08-30, análogo al querySelector('img') del lightbox).
  function nodoTexto(n) {
    // Los components de Lumos guardan el texto en un nodo interno propio
    // (.button_main_text en Button Main, .u-text en Typography). Se apunta al
    // nodo de TEXTO, nunca al contenedor (button_main_element envuelve tambien
    // el icono: escribir ahi lo borraria).
    return n ? (n.querySelector('p,[class*="u-text"],[class*="_text"]') || n) : null;
  }

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
      nodoTexto(n).textContent = msg; show(n, !!msg); n.setAttribute('data-error', esError ? '1' : '0');
    }
    if (msg) (esError ? console.warn : console.info)('[selfie-subir]', msg);
  }


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
    asegurarSubmit(form);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      // El Form Block de Webflow delega su submit en document: sin cortar la
      // propagacion, webflow.js procesa el form igual y muestra su "Thank you!"
      // (reporte del agente de /subir, 2026-09-01).
      ev.stopPropagation();
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
    asegurarSubmit(form);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      // Mismo corte que pin-form: que el submit no llegue al handler delegado
      // de webflow.js (Form Block).
      ev.stopPropagation();
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
        // El panel arranca oculto por CSS de página (regla por atributo), sin
        // style inline: decidir por computed style, no por style.display (que
        // vale '' al arranque y hacía que abriera recién al segundo clic).
        show(p, !p || getComputedStyle(p).display === 'none');
      });
    }
    // Estado inicial explícito: deja style="display:none" desde el arranque,
    // así el par de reglas CSS de la página ([data-selfie="nuevo-panel"] /
    // [style]) parte de un estado conocido.
    show(el('nuevo-panel'), false);
  }

  /* ─────────────── modales de Lumos (piezas de Cani, con guarda) ─────────── */

  // Mismo patrón que el lightbox del álbum: API pública de Lumos si está
  // (anima con GSAP y restaura el scroll), <dialog> nativo como fallback.
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

  function nombreEvento() {
    var ev = state.eventos.filter(function (e) { return e.slug === state.slug; })[0];
    return (ev && ev.nombre) || state.slug || 'tu evento';
  }

  // A3: resultado REAL de la tanda en el modal de éxito de Cani. Caso negativo
  // incluido: con errores nunca se muestra un "✓ éxito" pleno. Sin la pieza,
  // fallback al mensaje de estado (comportamiento previo).
  function mostrarResultado(subidas, fallidas) {
    var texto = fallidas
      ? (subidas + ' subida' + (subidas === 1 ? '' : 's') + ', ' + fallidas +
         ' con error — probá de nuevo las que fallaron')
      : (subidas + ' foto' + (subidas === 1 ? ' subida' : 's subidas') + ' a ' + nombreEvento());
    var modal = el('exito');
    if (!modal) {
      setEstado(fallidas ? texto : '¡Listo! Ya podés verlas en el álbum del evento.', fallidas > 0);
      return;
    }
    var t = el('exito-texto');
    if (t) nodoTexto(t).textContent = texto;
    var ver = el('exito-ver-album');
    if (ver) {
      // El Button Main de Lumos bindea el attr en el div wrapper: el href real
      // va en el <a> interno; si el clickable es <button>, se navega por click.
      var destino = '/album?evento=' + encodeURIComponent(state.slug);
      var verLink = ver.tagName === 'A' ? ver : ver.querySelector('a');
      if (verLink) verLink.setAttribute('href', destino);
      else ver.onclick = function () { window.location.href = destino; };
    }
    setEstado('');
    abrirModal(modal);
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
    // Paso 3 (Section paso-subir, arranca display:none): visible solo con un
    // evento elegido. Con guarda: sin la Section, no cambia nada.
    show(el('paso-subir'), !!state.slug);
    var t = nodoTexto(n);   // el texto cae en el nodo interno de la pieza de Cani
    if (!state.slug) { t.textContent = 'Elegí un evento para poder subir.'; return; }
    var ev = state.eventos.filter(function (e) { return e.slug === state.slug; })[0];
    t.textContent = 'Subiendo a: ' + ((ev && ev.nombre) || state.slug) +
      ' · ' + (state.tipo === 'tira' ? 'Tiras' : 'Fotos');
  }

  function initUpload() {
    var btn = el('subir-btn');
    if (!btn) return;

    // A1: mientras el widget carga su iframe no pasa nada visible (segundos en
    // el celular de Fer) → estado observable en el botón, sin timers: se
    // restaura con el primer display-changed del widget (o ante un error).
    // El texto va al nodo interno del botón si lo hay; en un component con
    // estructura sin nodo de texto reconocible, solo disabled (no se pisa).
    var btnTexto = btn.querySelector('p,[class*="u-text"]');
    if (!btnTexto && btn.children.length === 0) btnTexto = btn;
    var textoOriginal = btnTexto ? btnTexto.textContent : '';
    var abriendo = false;
    function botonEsperando(on) {
      abriendo = on;
      // El data-selfie del Button Main cae en el div wrapper: el disabled va
      // sobre el <button>/<a> interno, sobre el div no hace nada.
      var real = btn.querySelector('button, a') || btn;
      if ('disabled' in real) real.disabled = on;
      if (on) real.setAttribute('disabled', '');
      else real.removeAttribute('disabled');
      if (btnTexto) btnTexto.textContent = on ? 'Abriendo el selector…' : textoOriginal;
    }

    // A3: "Subir más" cierra el modal de éxito (pieza de Cani, con guarda).
    var subirMas = el('exito-subir-mas');
    if (subirMas) {
      subirMas.addEventListener('click', function (ev) {
        ev.preventDefault();
        cerrarModal(el('exito'));
      });
    }

    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      // El atributo disabled no frena clicks si el botón es un <a> → guarda propia.
      if (abriendo) return;

      // Bloqueo explícito: sin evento no se sube (si no, las fotos caen en un
      // tag que ningún álbum pide y se pierden sin que nadie se entere).
      if (!state.slug) { setEstado('Primero elegí el evento.', true); return; }
      if (typeof window.cloudinary === 'undefined') {
        setEstado('No se pudo abrir el subidor.', true);
        console.error('[selfie-subir] falta el widget de Cloudinary');
        return;
      }

      botonEsperando(true);
      // A3: conteo por tanda desde los callbacks (el widget se crea por click,
      // así que los contadores arrancan en cero solos).
      var subidas = 0, fallidas = 0;

      var tag = CFG.tagFor(state.slug, state.tipo);   // contrato compartido con el Worker
      var widget = window.cloudinary.createUploadWidget({
        cloudName: CFG.CLOUD_NAME,
        uploadPreset: CFG.UPLOAD_PRESET,
        folder: CFG.CLOUDINARY_FOLDER,
        tags: [tag],
        sources: ['local', 'camera'],
        multiple: true,
        maxFiles: 300,
        // A5: solo imágenes — un .zip o video se rechaza en el picker, no
        // después de subirlo ('image' es shortcut documentado del widget).
        clientAllowedFormats: ['image'],
        language: 'es',
        text: { es: {
          or: 'o',
          menu: { files: 'Mis fotos', camera: 'Cámara' },
          // A5: errores del widget en español. Claves verificadas contra el
          // text.json oficial (uploader.errors.*) — no inventar claves acá.
          uploader: { errors: {
            allowed_formats: 'Ese archivo no es una imagen. Subí fotos JPG o PNG.',
            max_number_of_files: 'Son demasiados archivos: hasta 300 por tanda.',
            max_file_size: 'El archivo es demasiado pesado.',
            min_file_size: 'El archivo es demasiado chico.',
            file_too_large: 'El archivo ({{size}}) supera el máximo permitido ({{allowed}}).'
          } }
        } }
      }, function (error, result) {
        if (error) {
          fallidas += 1;
          botonEsperando(false);
          console.error('[selfie-subir]', error);
          setEstado('Hubo un problema al subir. Probá de nuevo.', true);
          return;
        }
        if (result && result.event === 'display-changed') {
          // El widget ya se mostró (o cambió de estado): el botón vuelve solo.
          botonEsperando(false);
        }
        if (result && result.event === 'success') {
          subidas += 1;
          setEstado('Subida: ' + (result.info && result.info.original_filename ? result.info.original_filename : 'foto'));
        }
        if (result && result.event === 'queues-end') {
          // A2: la tanda terminó, el widget sobra. quiet: sin confirmación
          // (la cola ya está vacía, no se aborta nada).
          widget.close({ quiet: true });
          // Con 0 y 0 no hay nada que anunciar (queues-end sin archivos).
          if (subidas + fallidas > 0) mostrarResultado(subidas, fallidas);
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
