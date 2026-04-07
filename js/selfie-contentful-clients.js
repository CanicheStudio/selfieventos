/**
 * selfie-contentful-clients.js
 * Fetch clientes desde Contentful y reemplaza los tags en la sección marquee.
 * Fallback: si falla, deja el contenido hardcoded.
 */
(function () {
  'use strict';

  var SPACE_ID = 'wivpi7tzjj0l';
  var ACCESS_TOKEN = 'P9QQTUYheneNvdqf5uCsTtVR9kHzV4LvTL5WS58Ghts';
  var CONTENT_TYPE = 'cliente';
  var API_URL =
    'https://cdn.contentful.com/spaces/' + SPACE_ID +
    '/environments/master/entries?access_token=' + ACCESS_TOKEN +
    '&content_type=' + CONTENT_TYPE +
    '&order=fields.orden' +
    '&limit=100';

  function buildTag(nombre) {
    var tag = document.createElement('div');
    tag.className = 'tag_wrap';
    tag.textContent = nombre;
    return tag;
  }

  function renderClients(items) {
    var section = document.getElementById('section_marquee');
    if (!section) {
      console.warn('[selfie-contentful-clients] section_marquee not found');
      return;
    }

    // The client tags live inside u-layout-column-2 within the section
    var container = section.querySelector('.u-layout-column-2');
    if (!container) {
      console.warn('[selfie-contentful-clients] tag container not found');
      return;
    }

    // Clear existing tags
    container.innerHTML = '';

    items.forEach(function (item) {
      var nombre = item.fields.nombre;
      if (nombre) {
        container.appendChild(buildTag(nombre));
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    fetch(API_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('Contentful response ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data.items && data.items.length > 0) {
          renderClients(data.items);
        }
        // If no items, keep the hardcoded content
      })
      .catch(function (err) {
        console.warn('[selfie-contentful-clients] Fetch failed, keeping fallback:', err.message);
      });
  });
})();
