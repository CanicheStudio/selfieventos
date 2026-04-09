/**
 * selfie-sheets-live.js
 * Fetch eventos activos (activo=SI) desde Google Sheets (CSV).
 * Si hay uno activo, muestra la sección #section_eventos-en-vivo y llena los datos.
 * Si no hay evento activo, oculta la sección.
 * Cover photo: caratula.jpg desde Cloudinary.
 */
(function () {
  'use strict';

  var CSV_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRBA0AENnlRUR_ABS-z8Sh1yHZXCkVAj_32v8QPcsSANlpqUq9ZOL1wW1YHCEhsBP11UbwGw2sFZpwm/pub?gid=0&single=true&output=csv';

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

    var titleEl = section.querySelector('[data-selfie="live-title"]');
    if (titleEl) titleEl.textContent = nombre;

    var subtitleEl = section.querySelector('[data-selfie="live-subtitle"]');
    if (subtitleEl) {
      var parts = [];
      if (lugar) parts.push(lugar);
      if (fecha) parts.push(fecha);
      subtitleEl.textContent = parts.join(' · ');
    }

    // Load cover image from Sheet's imagen column
    var imagenUrl = evento.imagen ? evento.imagen.trim() : '';
    if (imagenUrl) {
      var imgEl = section.querySelector('[data-selfie="live-image"]');
      if (imgEl) {
        imgEl.src = imagenUrl;
        imgEl.onerror = function () { this.onerror = null; };
      }
    }

    section.style.display = '';
  }

  function hideLiveSection() {
    var section = document.getElementById('section_eventos-en-vivo');
    if (section) section.style.display = 'none';
  }

  function init() {
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
