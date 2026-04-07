/**
 * selfie-sheets-live.js
 * Fetch eventos activos (activo=SI) desde Google Sheets (CSV).
 * Si hay uno activo, muestra la sección #section_eventos-en-vivo y llena los datos.
 * Si no hay evento activo, oculta la sección.
 */
(function () {
  'use strict';

  var CSV_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQOhU1olZb4klwB2qK-lxDn6FN-3RIRFkjZ5IDHedKw_MthNOdfV3dlvu__izfFLupRgcegFM2JUpDM/pub?gid=0&single=true&output=csv';

  var DRIVE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzTT1ggtYTqj9MAhMTG8mQPmga1FMmzSiump-LAZrF6VPbpve8g3Zo4XzVzPksLchZpDQ/exec';
  var DRIVE_FOLDER_ID = '1J5qvFBJWX__2eYnlNFzBXN4qlieQr44U';

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

  function fillLiveSection(evento) {
    var section = document.getElementById('section_eventos-en-vivo');
    if (!section) return;

    var nombre = evento.nombre || 'Evento en vivo';
    var lugar = evento.lugar || '';
    var fecha = formatDate(evento.fecha);
    var slug = evento.slug || '';

    // Fill title
    var titleEl = section.querySelector('[data-selfie="live-title"]');
    if (titleEl) titleEl.textContent = nombre;

    // Fill subtitle
    var subtitleEl = section.querySelector('[data-selfie="live-subtitle"]');
    if (subtitleEl) {
      var parts = [];
      if (lugar) parts.push(lugar);
      if (fecha) parts.push(fecha);
      subtitleEl.textContent = parts.join(' · ');
    }

    // Show the section
    section.style.display = '';

    // Load photos into the slider/card
    if (slug) {
      loadPhotos(slug, section);
    }
  }

  function hideLiveSection() {
    var section = document.getElementById('section_eventos-en-vivo');
    if (section) section.style.display = 'none';
  }

  function loadPhotos(slug, section) {
    var url = DRIVE_SCRIPT_URL + '?folder=' + encodeURIComponent(DRIVE_FOLDER_ID) + '&sub=' + encodeURIComponent(slug);
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.fotos || data.fotos.length === 0) return;

        // Set the first photo as cover on the card image
        var imgEl = section.querySelector('[data-selfie="live-image"]');
        if (imgEl && data.fotos[0]) {
          fetch(data.fotos[0].url)
            .then(function (r) { return r.text(); })
            .then(function (b64) {
              if (b64) imgEl.src = 'data:image/jpeg;base64,' + b64;
            })
            .catch(function () {});
        }

        // If there's a slider, clone cards for additional photos
        var sliderList = section.querySelector('.slider_list');
        if (sliderList && data.fotos.length > 1) {
          var templateCard = sliderList.querySelector('.card_primary_wrap');
          if (templateCard) {
            for (var i = 1; i < data.fotos.length; i++) {
              var card = templateCard.cloneNode(true);
              var cardImg = card.querySelector('[data-selfie="live-image"]') || card.querySelector('img');
              if (cardImg) {
                (function (img, foto) {
                  fetch(foto.url)
                    .then(function (r) { return r.text(); })
                    .then(function (b64) {
                      if (b64) img.src = 'data:image/jpeg;base64,' + b64;
                    })
                    .catch(function () {});
                })(cardImg, data.fotos[i]);
              }
              sliderList.appendChild(card);
            }
            // Update Swiper
            var swiperEl = section.querySelector('.swiper');
            if (swiperEl && swiperEl.swiper) {
              swiperEl.swiper.update();
            }
          }
        }
      })
      .catch(function (err) {
        console.warn('[selfie-sheets-live] Photos fetch failed:', err.message);
      });
  }

  function init() {
    // Hide the section by default until we know if there's an active event
    hideLiveSection();

    fetch(CSV_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('Google Sheets response ' + res.status);
        return res.text();
      })
      .then(function (csvText) {
        var rows = parseCSV(csvText);
        var activeEvent = null;

        for (var i = 0; i < rows.length; i++) {
          if ((rows[i].activo || '').toUpperCase().trim() === 'SI') {
            activeEvent = rows[i];
            break;
          }
        }

        if (activeEvent) {
          fillLiveSection(activeEvent);
        }
        // If no active event, section stays hidden
      })
      .catch(function (err) {
        console.warn('[selfie-sheets-live] Fetch failed:', err.message);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
