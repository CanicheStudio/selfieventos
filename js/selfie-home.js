/**
 * selfie-home.js — Hidrata el home desde el Worker (reemplaza los sheets-*.js)
 * ---------------------------------------------------------------------------
 * Spec v5 SELLADA · md5 aced02b998c6bc9d794d22aedad43c3d · §5
 *
 * ARCHIVO NUEVO. NO toca ni reemplaza a selfie-sheets-live.js /
 * selfie-sheets-eventos.js, que prod carga HOY. El swap se hace en V3 (Bridge).
 *
 * 🔴 REGLA DE CONTINUIDAD: se preservan EXACTAMENTE el contrato y la estructura
 * vivos que dejaron los scripts v1 —los mismos data-selfie, el mismo
 * #section_eventos-en-vivo, el mismo clonado de .card_primary_wrap dentro de
 * .slider_list, la misma combo .is-en-vivo y el update de Swiper—. Lo ÚNICO que
 * cambia es la FUENTE DE DATOS: antes CSV de Google, ahora GET /api/eventos.
 * No se toca el markup que migró Cani (las 6 cards de servicios no se rozan).
 */
(function (window, document) {
  'use strict';

  var CFG = window.SELFIE_CONFIG;
  if (!CFG) { console.error('[selfie-home] falta selfie-config.js'); return; }

  var SECTION_LIVE = 'section_eventos-en-vivo';

  function texto(node, valor) {
    // textContent (no innerHTML): el contenido viene de datos, nunca se
    // interpreta como markup.
    if (node && typeof valor === 'string') node.textContent = valor;
  }

  /* ─────────────────────────── EN VIVO (activo) ──────────────────────────── */

  function pintarLive(evento) {
    var section = document.getElementById(SECTION_LIVE);
    if (!section) return;

    if (!evento) { section.style.display = 'none'; return; }

    texto(section.querySelector('[data-selfie="live-title"]'), evento.nombre);
    texto(section.querySelector('[data-selfie="live-subtitle"]'), evento.lugar || '');

    var img = section.querySelector('[data-selfie="live-image"]');
    if (img && evento.imagen) {
      // `imagen` es un public_id de Cloudinary; la URL la arma la config.
      img.src = CFG.fotoUrl(evento.imagen, 'c_fill,w_1200,q_auto,f_auto');
      img.alt = 'Foto de ' + evento.nombre;
    }
    section.style.display = '';
  }

  /* ──────────────────────── EVENTOS PASADOS (cards) ──────────────────────── */

  /**
   * Molde de card: se clona la card EXISTENTE, así el markup del rediseño de
   * Cani manda sobre cualquier HTML nuestro.
   *
   * 🔴 EL MOLDE SE BUSCA DENTRO DEL slider_list, NO EN LA SECCIÓN ENTERA.
   * Medido en la home viva (2026-07-31): hay **9** `.card_primary_wrap` y las
   * **6 primeras NO son eventos** — son las cards de TIPOS DE EVENTO
   * (Cumpleaños, Bar/Bat Mitzvah, Bodas, Quinceañeras, Corporativos, Fiestas)
   * que viven en un `u-grid` aparte y aparecen ANTES en el DOM. Solo las 3
   * últimas están dentro del slider.
   * Un `querySelector` sobre la sección entera devolvería la PRIMERA => clonaría
   * una card de tipo-de-evento como molde de "eventos pasados". Acotar al
   * slider_list es lo que evita ese bug silencioso (se vería "bien" hasta que
   * alguien note que el molde no es el correcto).
   */
  function templateDesde(sliderList) {
    var wrap = sliderList.querySelector('.card_primary_wrap');
    return wrap ? wrap.cloneNode(true) : null;
  }

  function pintarCard(card, evento) {
    texto(card.querySelector('[data-selfie="title"]'), evento.nombre);
    texto(card.querySelector('[data-selfie="text"]'), evento.lugar || evento.tipo || '');

    var img = card.querySelector('[data-selfie="image"]');
    if (img && evento.imagen) {
      img.src = CFG.fotoUrl(evento.imagen, 'c_fill,w_800,q_auto,f_auto');
      img.alt = 'Foto de ' + evento.nombre;
    }
    var link = card.querySelector('[data-selfie="link"]');
    if (link) link.href = '/album?evento=' + encodeURIComponent(evento.slug);

    if (evento.activo === 1) card.classList.add('is-en-vivo');
    return card;
  }

  function pintarPasados(eventos) {
    var section = document.getElementById('section_eventos') ||
                  document.querySelector('[data-selfie="eventos-section"]');
    if (!section) return;

    var sliderList = section.querySelector('.slider_list');
    if (!sliderList) { console.warn('[selfie-home] slider_list not found'); return; }

    // El molde sale del slider_list, NUNCA de la sección entera (ver templateDesde).
    var template = templateDesde(sliderList);
    if (!template) { console.warn('[selfie-home] card_primary_wrap not found dentro de slider_list'); return; }

    sliderList.innerHTML = '';
    eventos.forEach(function (ev) {
      sliderList.appendChild(pintarCard(template.cloneNode(true), ev));
    });

    // Swiper necesita recalcular tras inyectar slides (si no, no desliza).
    var swiperEl = section.querySelector('.swiper');
    if (swiperEl && swiperEl.swiper) swiperEl.swiper.update();
  }

  /* ──────────────────────────────── arranque ─────────────────────────────── */

  function init() {
    fetch(CFG.api('/api/eventos'))
      .then(function (r) {
        if (!r.ok) throw new Error('eventos http ' + r.status);
        return r.json();
      })
      .then(function (d) {
        var eventos = d.eventos || [];

        // El backend NO fuerza un único activo (spec §2): el front elige el
        // más reciente. Con 0 activos la sección se oculta y nada queda roto.
        var activos = eventos.filter(function (e) { return e.activo === 1; });
        activos.sort(function (a, b) { return String(b.fecha || '').localeCompare(String(a.fecha || '')); });
        pintarLive(activos[0] || null);

        var pasados = eventos.filter(function (e) { return e.activo !== 1; });
        pintarPasados(pasados);
      })
      .catch(function (err) {
        // Falla silenciosa hacia el usuario: el home sigue mostrando su
        // contenido estático. Nunca romper la portada por un fetch caído.
        console.error('[selfie-home]', err);
        var section = document.getElementById(SECTION_LIVE);
        if (section) section.style.display = 'none';
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window, document);
