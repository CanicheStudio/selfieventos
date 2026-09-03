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
    // El nodo de estado NO se mueve de donde Cani lo puso (2026-09-02: el
    // reparenteo anterior lo sacaba de su Card y lo dejaba colgando al final
    // de la Section — "me lo tira afuera de la caja"). Puede haber uno por
    // seccion (gate y app), todos con el hook "estado": se escribe en todos y
    // el que este en la seccion visible es el que se ve.
    var nodos = document.querySelectorAll('[data-selfie="estado"]');
    Array.prototype.forEach.call(nodos, function (n) {
      nodoTexto(n).textContent = msg;
      show(n, !!msg);
      n.setAttribute('data-error', esError ? '1' : '0');
    });
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
      if ((b.getAttribute('type') || 'submit').toLowerCase() !== 'submit') {
        b.addEventListener('click', function (ev) {
          ev.preventDefault();
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
      }
      // El runtime de Webflow Forms (Turnstile) deshabilita el boton en su
      // callback 'ready' cuando el challenge no entrega token, y gana la
      // carrera contra el opt-out segun el timing de carga (medido en prod:
      // disabled=true sin w-form-loading). Nuestros forms no son de Webflow:
      // cualquier disabled que un tercero le ponga al boton se revierte.
      if (typeof MutationObserver === 'function') {
        new MutationObserver(function () {
          if (b.disabled) { b.disabled = false; b.classList.remove('w-form-loading'); }
        }).observe(b, { attributes: true, attributeFilter: ['disabled', 'class'] });
      }
      if (b.disabled) { b.disabled = false; b.classList.remove('w-form-loading'); }
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

  // El close() de Lumos es asincronico: revierte su timeline de GSAP y recien
  // en onReverseComplete llama al close() nativo del <dialog>. Si esa vuelta
  // no llega (timeline sin crear, tick de GSAP frenado, error en el medio) el
  // dialog queda open=true: invisible pero MODAL, y toda la pagina de atras
  // queda inerte — "no me deja subir mas" (medido en el Chrome de Cani,
  // 2026-09-02). Pasada su animacion, si sigue abierto se cierra nativo y se
  // restaura lo que resetModal() de Lumos hubiera restaurado.
  function asegurarCierre(node) {
    if (!node || node.tagName !== 'DIALOG') return;
    setTimeout(function () {
      if (!node.open) return;
      node.close();
      document.body.style.overflow = '';
    }, 700);
  }

  function cerrarModal(node) {
    if (!node) return;
    var api = lumosModalApi(node);
    if (api) { api.close(); asegurarCierre(node); return; }
    if (node.tagName === 'DIALOG') { if (node.open) node.close(); }
    else show(node, false);
  }

  // Mismo respaldo para los cierres que maneja Lumos solo (X, backdrop, Esc):
  // no pasan por cerrarModal(), asi que se escuchan en el dialog.
  function vigilarCierre(node) {
    if (!node || node.tagName !== 'DIALOG') return;
    node.addEventListener('click', function (e) {
      if (e.target.closest('[data-modal-close]')) asegurarCierre(node);
    });
    node.addEventListener('cancel', function () { asegurarCierre(node); });
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
    // UX Cani 2026-09-02: un botón promete acción inmediata — "Subir fotos" /
    // "Subir tiras" NO son toggles: setean el tipo y abren el selector en el
    // mismo gesto (antes había que tocar un tercer botón y nadie lo entendía).
    var bs = el('tipo-suelta'), bt = el('tipo-tira');
    function set(t) {
      state.tipo = t;
      if (bs) bs.setAttribute('aria-pressed', t === 'suelta' ? 'true' : 'false');
      if (bt) bt.setAttribute('aria-pressed', t === 'tira' ? 'true' : 'false');
      actualizarDestino();
    }
    if (bs) bs.addEventListener('click', function (e) { e.preventDefault(); set('suelta'); abrirSelector(bs); });
    if (bt) bt.addEventListener('click', function (e) { e.preventDefault(); set('tira'); abrirSelector(bt); });
    set('suelta');
  }

  // Botón "Ver álbum" de la card del evento (pieza de Cani, hook ver-album):
  // Fer entra al álbum del evento elegido sin subir ni borrar nada. Con
  // evento: apunta a /album?evento=<slug> en pestaña nueva (no pierde /subir).
  // Sin evento: oculto. Mismo binding que exito-ver-album (Button Main pone
  // el attr en el wrapper; el href real va en el <a> interno si lo hay).
  function actualizarVerAlbum() {
    var n = el('ver-album');
    if (!n) return;
    show(n, !!state.slug);
    if (!state.slug) return;
    var destino = '/album?evento=' + encodeURIComponent(state.slug);
    var link = n.tagName === 'A' ? n : n.querySelector('a');
    if (link) {
      link.setAttribute('href', destino);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
    } else {
      n.onclick = function (ev) { ev.preventDefault(); window.open(destino, '_blank', 'noopener'); };
    }
  }

  function actualizarDestino() {
    actualizarVerAlbum();
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


  /* ───────────────────────── borrar evento (Fer) ─────────────────────────── */

  function initBorrar() {
    var btn = el('borrar-evento-toggle');
    if (!btn) return;
    var t = nodoTexto(btn);
    var textoOriginal = t ? t.textContent : '';
    var armado = false;
    var timer = null;
    var borrando = false;

    function desarmar() {
      armado = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (t) t.textContent = textoOriginal;
    }

    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (borrando) return;
      if (!state.slug) { setEstado('Primero elegí el evento a borrar.', true); return; }

      // Confirmación de dos clicks (destructivo): el primero arma, el segundo
      // dentro de los 6s ejecuta. Sin confirm() nativo (bloquea y es feo).
      if (!armado) {
        armado = true;
        if (t) t.textContent = '¿Seguro? Borra el evento y TODAS sus fotos';
        setEstado('Vas a borrar el evento y todas sus fotos. Tocá de nuevo para confirmar.', true);
        timer = setTimeout(function () { desarmar(); setEstado(''); }, 6000);
        return;
      }

      desarmar();
      borrando = true;
      setEstado('Borrando evento…');
      fetch(CFG.api('/api/eventos/' + encodeURIComponent(state.slug)), {
        method: 'DELETE',
        headers: pinHeaders()
      }).then(function (r) {
        borrando = false;
        if (r.status === 401) { setEstado('PIN inválido. Recargá la página.', true); return; }
        if (r.status === 429) { setEstado('Demasiados intentos. Esperá un minuto.', true); return; }
        if (r.status === 503 || r.status === 502) { setEstado('No se pudieron borrar las fotos. No se borró nada — probá de nuevo.', true); return; }
        if (r.status === 404) { setEstado('Ese evento ya no existe.', true); return cargarEventos(); }
        if (!r.ok) { setEstado('No se pudo borrar el evento.', true); return; }
        return r.json().then(function (d) {
          var n = (d.fotos_borradas ? (d.fotos_borradas.suelta + d.fotos_borradas.tira) : 0);
          setEstado('Evento borrado: ' + (d.nombre || d.slug) + (n ? ' (' + n + ' foto' + (n === 1 ? ' borrada' : 's borradas') + ')' : ''));
          state.slug = null;
          return cargarEventos().then(function () { actualizarDestino(); });
        });
      }).catch(function (err) {
        borrando = false;
        console.error('[selfie-subir]', err);
        setEstado('No se pudo conectar. Revisá la señal.', true);
      });
    });
  }

  var abriendoSelector = false;

  /* Subida DIRECTA a Cloudinary (preset unsigned) con input nativo.
   * El widget oficial murió acá 2026-09-02: vive en un iframe que depende de
   * storage de terceros — con third-party cookies bloqueadas (incógnito, y el
   * default al que Chrome migra) el iframe cuelga o se degrada a una ventana
   * popup (medido en el Chrome de Cani, perfil normal E incógnito). El diálogo
   * NATIVO de archivos no depende de nada de eso, y en el celular ofrece
   * cámara/galería solo. Menos piezas.
   * CORS verificado: OPTIONS a api.cloudinary.com con Origin del site → 200
   * con Allow-Origin correcto y POST permitido (medido 2026-09-02). */

  var LIMITE_TANDA = 300;             // paridad con el tope del widget viejo
  var LIMITE_BYTES = 10 * 1024 * 1024; // paridad con el preset (10 MB)

  // UN solo input de archivos, creado al cargar la página y reutilizado.
  // Medido en el Chrome de Cani (152 / macOS 26, 2026-09-02): un input
  // type=file creado y clickeado en el mismo gesto NO abre el diálogo (y
  // tampoco dispara 'cancel' — queda mudo); el mismo input, si ya existía
  // en la página antes del click, abre. Comet y Playwright no distinguen,
  // por eso el bug solo se veía en su Chrome. `pendiente` guarda el contexto
  // del click en curso (tag y botón) para cuando llegue el 'change'.
  var inputArchivos = null;
  var pendiente = null;

  function crearInputArchivos() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.style.display = 'none';
    input.addEventListener('change', function () {
      var ctx = pendiente;
      pendiente = null;
      var todos = Array.prototype.slice.call(input.files || []);
      input.value = '';   // libera los archivos y permite re-elegir los mismos
      if (ctx && todos.length) procesarTanda(todos, ctx.tag, ctx.btn);
    });
    input.addEventListener('cancel', function () { pendiente = null; });
    document.body.appendChild(input);
    return input;
  }

  function subirArchivo(file, tag) {
    var datos = new FormData();
    datos.append('file', file);
    datos.append('upload_preset', CFG.UPLOAD_PRESET);
    datos.append('folder', CFG.CLOUDINARY_FOLDER);
    datos.append('tags', tag);
    return fetch('https://api.cloudinary.com/v1_1/' + CFG.CLOUD_NAME + '/image/upload', {
      method: 'POST',
      body: datos
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) {
        console.warn('[selfie-subir] upload ' + r.status, t.slice(0, 200));
        return false;
      });
      return true;
    }).catch(function (e) {
      console.warn('[selfie-subir] upload error', e);
      return false;
    });
  }

  function abrirSelector(btn) {
    if (abriendoSelector) return;

    // Bloqueo explícito: sin evento no se sube (si no, las fotos caen en un
    // tag que ningún álbum pide y se pierden sin que nadie se entere).
    if (!state.slug) { setEstado('Primero elegí el evento.', true); return; }

    if (!inputArchivos) inputArchivos = crearInputArchivos();
    pendiente = { tag: CFG.tagFor(state.slug, state.tipo), btn: btn };
    // El click del usuario ES el gesto que el browser exige para abrir el
    // diálogo — tiene que ser sincrónico, sin promesas en el medio.
    inputArchivos.click();
  }

  function procesarTanda(todos, tag, btn) {
    var btnTexto = nodoTexto(btn);
    var textoOriginal = btnTexto ? btnTexto.textContent : '';
    function pintarBoton(msg) { if (btnTexto) btnTexto.textContent = msg || textoOriginal; }
    function ocupado(on) {
      abriendoSelector = on;
      if (!btn) return;
      var real = btn.querySelector('button, a') || btn;
      if ('disabled' in real) real.disabled = on;
      if (on) real.setAttribute('disabled', '');
      else real.removeAttribute('disabled');
    }

    if (todos.length > LIMITE_TANDA) {
      setEstado('Son demasiados archivos: hasta ' + LIMITE_TANDA + ' por tanda.', true);
      return;
    }
    var fallidas = 0;
    var lote = todos.filter(function (f) {
      // A5: solo imágenes y tope de peso — se rechaza ANTES de subir.
      if (f.type.indexOf('image/') !== 0 || f.size > LIMITE_BYTES) { fallidas += 1; return false; }
      return true;
    });

    ocupado(true);
    var subidas = 0, hechas = 0, total = lote.length;
    function progreso() {
      pintarBoton('Subiendo ' + hechas + '/' + total + '…');
    }
    progreso();
    setEstado('Subiendo ' + total + (total === 1 ? ' foto' : ' fotos') + ' a ' + nombreEvento() + '…');

    // De a 3 en paralelo: rápido sin ahogar la señal del celular de Fer.
    var i = 0;
    function siguiente() {
      if (i >= lote.length) return Promise.resolve();
      var f = lote[i]; i += 1;
      return subirArchivo(f, tag).then(function (ok) {
        if (ok) subidas += 1; else fallidas += 1;
        hechas += 1;
        progreso();
        return siguiente();
      });
    }
    Promise.all([siguiente(), siguiente(), siguiente()]).then(function () {
      ocupado(false);
      pintarBoton();
      setEstado('');
      mostrarResultado(subidas, fallidas);
    });
  }

  function initUpload() {
    // El input de archivos nace ACÁ, al cargar, no en el click (ver crearInputArchivos).
    inputArchivos = crearInputArchivos();
    vigilarCierre(el('exito'));

    // "Subir más" promete acción (Cani 2026-09-02): cierra el modal de éxito
    // Y abre el selector con el tipo vigente, en el mismo gesto. El click del
    // usuario es lo que habilita input.click(): tiene que ser sincrónico, así
    // que el <dialog> se cierra nativo YA (la animación de Lumos corre igual,
    // de fondo, y deja su timeline lista para la próxima apertura).
    var subirMas = el('exito-subir-mas');
    if (subirMas) {
      subirMas.addEventListener('click', function (ev) {
        ev.preventDefault();
        var modal = el('exito');
        cerrarModal(modal);
        if (modal && modal.tagName === 'DIALOG' && modal.open) {
          modal.close();
          document.body.style.overflow = '';
        }
        abrirSelector(el('tipo-' + state.tipo) || el('subir-btn'));
      });
    }

    // CTA legacy (si el botón "Subir" viejo sigue en la página, abre con el
    // tipo actual — se borra del Designer sin tocar código).
    var btn = el('subir-btn');
    if (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        abrirSelector(btn);
      });
    }
  }

  function init() {
    initPin();
    initEventoNuevo();
    initFecha();
    initTipo();
    initBorrar();
    initUpload();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window, document);
