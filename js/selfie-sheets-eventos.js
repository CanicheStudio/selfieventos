/**
 * selfie-sheets-eventos.js
 * Fetch eventos pasados (activo != "SI") desde Google Sheets (CSV)
 * y genera las cards del slider en la seccion de eventos pasados.
 * Fallback: si no hay eventos o falla, deja el contenido actual.
 */
(function () {
  'use strict';

  var CSV_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQOhU1olZb4klwB2qK-lxDn6FN-3RIRFkjZ5IDHedKw_MthNOdfV3dlvu__izfFLupRgcegFM2JUpDM/pub?gid=0&single=true&output=csv';

  var CARD_VARIANT = 'w-variant-51efa20c-c7be-48fe-973a-11367f19d622';
  var DRIVE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzTT1ggtYTqj9MAhMTG8mQPmga1FMmzSiump-LAZrF6VPbpve8g3Zo4XzVzPksLchZpDQ/exec';
  var DRIVE_FOLDER_ID = '1J5qvFBJWX__2eYnlNFzBXN4qlieQr44U';

  /**
   * Parse CSV text into an array of objects.
   * Single-pass parser that handles quoted fields with commas and newlines.
   */
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i, ch;

    for (i = 0; i < text.length; i++) {
      ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          row.push(field.trim());
          field = '';
        } else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') i++;
          row.push(field.trim());
          rows.push(row);
          row = [];
          field = '';
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field.trim());
      rows.push(row);
    }

    if (rows.length < 2) return [];

    var headers = rows[0];
    var results = [];
    for (var j = 1; j < rows.length; j++) {
      if (rows[j].join('').trim() === '') continue;
      var obj = {};
      for (var k = 0; k < headers.length; k++) {
        obj[headers[k]] = (rows[j][k] !== undefined) ? rows[j][k] : '';
      }
      results.push(obj);
    }
    return results;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    var parts = dateStr.split('-');
    if (parts.length === 3) {
      var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString('es-AR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
    }
    return dateStr;
  }

  var templateCard = null;

  function captureTemplate() {
    if (templateCard) return;
    var section = document.getElementById('section_eventos-pasados');
    if (!section) return;
    var card = section.querySelector('[data-selfie="title"]');
    if (!card) {
      // Fallback: find any card_primary_wrap
      var wrap = section.querySelector('.card_primary_wrap');
      if (wrap) {
        templateCard = wrap.cloneNode(true);
        return;
      }
      return;
    }
    var wrap = card.closest('.card_primary_wrap');
    if (!wrap) return;
    templateCard = wrap.cloneNode(true);
  }

  function buildCard(evento) {
    captureTemplate();
    if (!templateCard) return null;

    var card = templateCard.cloneNode(true);
    var nombre = evento.nombre || 'Evento';
    var tipo = evento.tipo || '';
    var lugar = evento.lugar || '';
    var fecha = formatDate(evento.fecha);
    var slug = evento.slug || '';
    var albumUrl = '/album?evento=' + encodeURIComponent(slug);

    var subtitleParts = [];
    if (tipo) subtitleParts.push(tipo);
    if (fecha) subtitleParts.push(fecha);
    if (lugar) subtitleParts.push(lugar);
    var subtitle = subtitleParts.join(' · ');

    // Fill data-selfie elements
    var titleEl = card.querySelector('[data-selfie="title"]');
    if (titleEl) titleEl.textContent = nombre;

    var textEl = card.querySelector('[data-selfie="text"]');
    if (textEl) textEl.textContent = subtitle || '';

    var imgEl = card.querySelector('[data-selfie="image"]');
    if (imgEl) {
      imgEl.setAttribute('data-evento-slug', slug);
      imgEl.alt = nombre;
      imgEl.loading = 'lazy';
    }

    var linkEl = card.querySelector('[data-selfie="link"]');
    if (linkEl) {
      linkEl.href = albumUrl;
      linkEl.setAttribute('aria-label', 'Ver album de ' + nombre);
    }

    return card;
  }

  function loadCoverPhoto(slug) {
    var url = DRIVE_SCRIPT_URL + '?folder=' + encodeURIComponent(DRIVE_FOLDER_ID) + '&sub=' + encodeURIComponent(slug);
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.fotos || data.fotos.length === 0) return;
        var photoUrl = data.fotos[0].url;
        fetch(photoUrl)
          .then(function (r) { return r.text(); })
          .then(function (b64) {
            if (!b64) return;
            var src = 'data:image/jpeg;base64,' + b64;
            var imgs = document.querySelectorAll('[data-evento-slug="' + slug + '"]');
            for (var i = 0; i < imgs.length; i++) {
              imgs[i].src = src;
            }
          });
      })
      .catch(function () {});
  }

  function renderEventos(items) {
    var section = document.getElementById('section_eventos-pasados');
    if (!section) {
      console.warn('[selfie-sheets-eventos] section_eventos-pasados not found');
      return;
    }

    var sliderList = section.querySelector('.slider_list');
    if (!sliderList) {
      console.warn('[selfie-sheets-eventos] slider_list not found');
      return;
    }

    sliderList.innerHTML = '';

    for (var i = 0; i < items.length; i++) {
      var card = buildCard(items[i]);
      if (card) sliderList.appendChild(card);
    }

    // Re-initialize Swiper if it exists (Webflow/Lumos slider)
    var swiperEl = section.querySelector('.swiper');
    if (swiperEl && swiperEl.swiper) {
      swiperEl.swiper.update();
    }
  }

  function init() {
    fetch(CSV_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('Google Sheets response ' + res.status);
        return res.text();
      })
      .then(function (csvText) {
        var rows = parseCSV(csvText);

        // Filter: only past events (activo is NOT "SI")
        var pastEvents = [];
        for (var i = 0; i < rows.length; i++) {
          if ((rows[i].activo || '').toUpperCase().trim() !== 'SI') {
            pastEvents.push(rows[i]);
          }
        }

        // Sort by fecha descending
        pastEvents.sort(function (a, b) {
          var dateA = new Date(a.fecha || 0);
          var dateB = new Date(b.fecha || 0);
          return dateB.getTime() - dateA.getTime();
        });

        if (pastEvents.length > 0) {
          renderEventos(pastEvents);
          // Load cover photo for each event from Drive
          for (var j = 0; j < pastEvents.length; j++) {
            if (pastEvents[j].slug) {
              loadCoverPhoto(pastEvents[j].slug);
            }
          }
        }
        // If no items, keep the hardcoded content as fallback
      })
      .catch(function (err) {
        console.warn('[selfie-sheets-eventos] Fetch failed, keeping fallback:', err.message);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
