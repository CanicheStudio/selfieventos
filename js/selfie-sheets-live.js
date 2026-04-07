/**
 * selfie-sheets-live.js
 * Fetch eventos activos (activo=SI) desde Google Sheets (CSV).
 * Si hay uno activo, inserta una sección "En Vivo" justo después del hero.
 */
(function () {
  'use strict';

  var CSV_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQOhU1olZb4klwB2qK-lxDn6FN-3RIRFkjZ5IDHedKw_MthNOdfV3dlvu__izfFLupRgcegFM2JUpDM/pub?gid=0&single=true&output=csv';

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
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('es-AR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  function buildLiveSection(evento) {
    var section = document.createElement('section');
    section.id = 'section_en-vivo';
    section.className = 'u-section';
    section.setAttribute('data-wf--section--variant', 'dark');

    var nombre = evento.nombre || 'Evento en vivo';
    var lugar = evento.lugar || '';
    var fecha = formatDate(evento.fecha);
    var slug = evento.slug || '';

    section.innerHTML =
      '<div data-wf--spacer--variant="small" class="u-section-spacer u-ignore-trim"></div>' +
      '<div class="u-container">' +
        '<div class="u-flex-vertical-nowrap u-gap-4" style="align-items:center;text-align:center;">' +
          '<div class="u-flex-horizontal-wrap u-gap-2" style="align-items:center;justify-content:center;">' +
            '<span style="display:inline-block;width:12px;height:12px;background:#e53e3e;border-radius:50%;animation:selfie-pulse 1.5s ease-in-out infinite;"></span>' +
            '<span class="u-text-style-small" style="text-transform:uppercase;letter-spacing:0.1em;font-weight:700;">En Vivo</span>' +
          '</div>' +
          '<div class="u-heading u-text-style-h2" style="margin:0;">' + escapeHtml(nombre) + '</div>' +
          (lugar ? '<div class="u-text u-text-style-main">' + escapeHtml(lugar) + (fecha ? ' &middot; ' + escapeHtml(fecha) : '') + '</div>' : '') +
          '<div id="live-photos-container" class="u-grid-wrapper" style="width:100%;min-height:0;" data-evento-slug="' + escapeHtml(slug) + '"></div>' +
        '</div>' +
      '</div>' +
      '<div data-wf--spacer--variant="small" class="u-section-spacer u-ignore-trim"></div>';

    if (!document.getElementById('selfie-pulse-style')) {
      var style = document.createElement('style');
      style.id = 'selfie-pulse-style';
      style.textContent = '@keyframes selfie-pulse{0%,100%{opacity:1}50%{opacity:.4}}';
      document.head.appendChild(style);
    }

    return section;
  }

  var DRIVE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzTT1ggtYTqj9MAhMTG8mQPmga1FMmzSiump-LAZrF6VPbpve8g3Zo4XzVzPksLchZpDQ/exec';
  var DRIVE_FOLDER_ID = '1J5qvFBJWX__2eYnlNFzBXN4qlieQr44U';

  function loadPhotos(slug) {
    var url = DRIVE_SCRIPT_URL + '?folder=' + encodeURIComponent(DRIVE_FOLDER_ID) + '&sub=' + encodeURIComponent(slug);
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.fotos || data.fotos.length === 0) return;
        var container = document.getElementById('live-photos-container');
        if (!container) return;
        container.style.display = 'grid';
        container.style.gridTemplateColumns = 'repeat(auto-fill, minmax(250px, 1fr))';
        container.style.gap = 'var(--space--3, 1rem)';
        container.style.marginTop = 'var(--space--4, 1.5rem)';
        data.fotos.forEach(function (foto) {
          var img = document.createElement('img');
          img.alt = foto.name;
          img.loading = 'lazy';
          img.style.cssText = 'width:100%;height:auto;border-radius:var(--radius--med,0.5rem);aspect-ratio:4/3;object-fit:cover;';
          container.appendChild(img);
          fetch(foto.url)
            .then(function (r) { return r.text(); })
            .then(function (b64) {
              if (b64) img.src = 'data:image/jpeg;base64,' + b64;
            })
            .catch(function () {});
        });
      })
      .catch(function (err) {
        console.warn('[selfie-sheets-live] Photos fetch failed:', err.message);
      });
  }

  function insertAfterHero(section) {
    var hero = document.querySelector('.hero_wrap');
    if (hero && hero.nextSibling) {
      hero.parentNode.insertBefore(section, hero.nextSibling);
    } else if (hero) {
      hero.parentNode.appendChild(section);
    } else {
      console.warn('[selfie-sheets-live] hero_wrap not found');
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
        var activeEvent = null;

        for (var i = 0; i < rows.length; i++) {
          if ((rows[i].activo || '').toUpperCase().trim() === 'SI') {
            activeEvent = rows[i];
            break;
          }
        }

        if (activeEvent) {
          var section = buildLiveSection(activeEvent);
          insertAfterHero(section);
          if (activeEvent.slug) {
            loadPhotos(activeEvent.slug);
          }
        }
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
