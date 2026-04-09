/**
 * selfie-album.js
 * Album privado para invitados de eventos Selfie Eventos.
 * Lee ?evento={slug} de la URL, muestra gate de email,
 * luego carga fotos desde Cloudinary y permite descarga en ZIP.
 */
(function () {
  'use strict';

  /* ── Config ───────────────────────────────────────────── */
  var CLOUD_NAME = 'dcjutekja';
  var CLOUDINARY_BASE = 'https://res.cloudinary.com/' + CLOUD_NAME + '/image/upload';
  var CLOUDINARY_LIST = 'https://res.cloudinary.com/' + CLOUD_NAME + '/image/list/v2/';
  var CLOUDINARY_FOLDER = 'eventos';
  var EMAIL_SCRIPT_URL = ''; // Google Apps Script web app URL
  var CSV_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRBA0AENnlRUR_ABS-z8Sh1yHZXCkVAj_32v8QPcsSANlpqUq9ZOL1wW1YHCEhsBP11UbwGw2sFZpwm/pub?gid=0&single=true&output=csv';

  /* ── State ────────────────────────────────────────────── */
  var slug = '';
  var evento = null;
  var fotosData = [];
  var tirasData = [];
  var activeTab = 'fotos';
  var selectedFotos = {};
  var selectedTiras = {};

  /* ── Helpers ──────────────────────────────────────────── */

  function getParam(name) {
    var url = new URL(window.location.href);
    return url.searchParams.get(name) || '';
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

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

  function $(id) {
    return document.getElementById(id);
  }

  function show(el) { if (el) el.style.display = ''; }
  function hide(el) { if (el) el.style.display = 'none'; }

  /* ── localStorage for email ──────────────────────────── */

  function getStoredEmail() {
    try {
      return localStorage.getItem('selfie_album_email') || '';
    } catch (e) {
      return '';
    }
  }

  function storeEmail(email) {
    try {
      localStorage.setItem('selfie_album_email', email);
    } catch (e) { /* silent */ }
  }

  /* ── Cloudinary fetch ────────────────────────────────── */

  function fetchResourceList(folder) {
    var url = CLOUDINARY_BASE + '/list/' + folder + '.json';
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('Cloudinary ' + res.status);
        return res.json();
      })
      .then(function (data) {
        return (data.resources || []).map(function (r) {
          return {
            public_id: r.public_id,
            format: r.format || 'jpg',
            width: r.width || 0,
            height: r.height || 0,
            url: CLOUDINARY_BASE + '/' + r.public_id + '.' + (r.format || 'jpg'),
            thumb: CLOUDINARY_BASE + '/c_fill,w_400,q_auto,f_auto/' + r.public_id + '.' + (r.format || 'jpg'),
            full: CLOUDINARY_BASE + '/q_auto,f_auto/' + r.public_id + '.' + (r.format || 'jpg'),
            download: CLOUDINARY_BASE + '/fl_attachment/' + r.public_id + '.' + (r.format || 'jpg')
          };
        });
      })
      .catch(function () {
        return [];
      });
  }

  /* ── Email submission ────────────────────────────────── */

  function submitEmail(email) {
    if (!EMAIL_SCRIPT_URL) {
      console.warn('[selfie-album] EMAIL_SCRIPT_URL not configured');
      return Promise.resolve({ success: true });
    }
    return fetch(EMAIL_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        email: email,
        evento: slug,
        timestamp: new Date().toISOString()
      })
    })
      .then(function (res) { return res.json(); })
      .catch(function (err) {
        console.warn('[selfie-album] Email submit error:', err.message);
        return { success: false };
      });
  }

  /* ── Render gallery ──────────────────────────────────── */

  function getCurrentPhotos() {
    return activeTab === 'fotos' ? fotosData : tirasData;
  }

  function getSelectedMap() {
    return activeTab === 'fotos' ? selectedFotos : selectedTiras;
  }

  function renderGallery() {
    var grid = $('album-grid');
    if (!grid) return;

    var photos = getCurrentPhotos();
    var selected = getSelectedMap();

    if (photos.length === 0) {
      grid.innerHTML =
        '<div class="album-empty">' +
        '<p>No hay fotos disponibles todav\u00eda.</p>' +
        '<p>Si el evento fue reciente, las fotos pueden tardar unas horas en cargarse.</p>' +
        '</div>';
      updateActionBar();
      return;
    }

    var html = '';
    for (var i = 0; i < photos.length; i++) {
      var photo = photos[i];
      var isSelected = !!selected[photo.public_id];
      html +=
        '<div class="album-item' + (isSelected ? ' selected' : '') + '" data-index="' + i + '">' +
        '<div class="album-item-inner">' +
        '<img src="' + escapeHtml(photo.thumb) + '" alt="Foto ' + (i + 1) + '" loading="lazy" class="album-img" data-index="' + i + '">' +
        '<label class="album-checkbox-wrap">' +
        '<input type="checkbox" class="album-checkbox" data-id="' + escapeHtml(photo.public_id) + '"' + (isSelected ? ' checked' : '') + '>' +
        '<span class="album-checkbox-custom"></span>' +
        '</label>' +
        '</div>' +
        '</div>';
    }
    grid.innerHTML = html;
    updateActionBar();
  }

  function updateActionBar() {
    var selected = getSelectedMap();
    var count = Object.keys(selected).length;
    var photos = getCurrentPhotos();

    var countEl = $('album-selected-count');
    if (countEl) {
      countEl.textContent = count > 0 ? count + ' seleccionada' + (count !== 1 ? 's' : '') : '';
    }

    var btnDownloadSelected = $('album-btn-download-selected');
    if (btnDownloadSelected) {
      btnDownloadSelected.disabled = count === 0;
      btnDownloadSelected.textContent = count > 0
        ? 'Descargar seleccionadas (' + count + ')'
        : 'Descargar seleccionadas';
    }

    var selectAllCheckbox = $('album-select-all');
    if (selectAllCheckbox) {
      selectAllCheckbox.checked = photos.length > 0 && count === photos.length;
      selectAllCheckbox.indeterminate = count > 0 && count < photos.length;
    }

    // Show/hide action bar
    var actionBar = $('album-action-bar');
    if (actionBar) {
      if (photos.length > 0) {
        show(actionBar);
      } else {
        hide(actionBar);
      }
    }
  }

  function updateTabCounts() {
    var fotosCount = $('album-fotos-count');
    var tirasCount = $('album-tiras-count');
    if (fotosCount) fotosCount.textContent = fotosData.length > 0 ? ' (' + fotosData.length + ')' : '';
    if (tirasCount) tirasCount.textContent = tirasData.length > 0 ? ' (' + tirasData.length + ')' : '';
  }

  /* ── Download as ZIP ─────────────────────────────────── */

  function downloadZip(photos, filename) {
    var progressEl = $('album-download-progress');
    if (progressEl) {
      show(progressEl);
      progressEl.textContent = 'Preparando descarga...';
    }

    var zip = new JSZip();
    var promises = [];
    var loaded = 0;
    var total = photos.length;

    for (var i = 0; i < photos.length; i++) {
      (function (photo, idx) {
        var p = fetch(photo.full)
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.blob();
          })
          .then(function (blob) {
            loaded++;
            if (progressEl) {
              progressEl.textContent = 'Descargando ' + loaded + ' de ' + total + '...';
            }
            var name = photo.public_id.split('/').pop() + '.' + photo.format;
            zip.file(name, blob);
          })
          .catch(function (err) {
            loaded++;
            console.warn('[selfie-album] Failed to fetch:', photo.public_id, err.message);
          });
        promises.push(p);
      })(photos[i], i);
    }

    Promise.all(promises)
      .then(function () {
        if (progressEl) progressEl.textContent = 'Generando ZIP...';
        return zip.generateAsync({ type: 'blob' });
      })
      .then(function (blob) {
        saveAs(blob, filename);
        if (progressEl) {
          progressEl.textContent = 'Descarga lista!';
          setTimeout(function () { hide(progressEl); }, 3000);
        }
      })
      .catch(function (err) {
        console.error('[selfie-album] ZIP error:', err);
        if (progressEl) {
          progressEl.textContent = 'Error al generar la descarga.';
          setTimeout(function () { hide(progressEl); }, 4000);
        }
      });
  }

  /* ── Event binding ───────────────────────────────────── */

  function bindEvents() {
    // Email form
    var emailForm = $('album-email-form');
    if (emailForm) {
      emailForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = $('album-email-input');
        var email = (input ? input.value : '').trim();
        if (!email) return;

        var btn = emailForm.querySelector('button[type="submit"]');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Entrando...';
        }

        storeEmail(email);
        submitEmail(email).then(function () {
          hide($('album-gate'));
          show($('album-gallery-section'));
          loadPhotos();
        });
      });
    }

    // Tabs
    var tabFotos = $('album-tab-fotos');
    var tabTiras = $('album-tab-tiras');

    if (tabFotos) {
      tabFotos.addEventListener('click', function () {
        activeTab = 'fotos';
        tabFotos.classList.add('active');
        if (tabTiras) tabTiras.classList.remove('active');
        renderGallery();
      });
    }

    if (tabTiras) {
      tabTiras.addEventListener('click', function () {
        activeTab = 'tiras';
        tabTiras.classList.add('active');
        if (tabFotos) tabFotos.classList.remove('active');
        renderGallery();
      });
    }

    // Select all
    var selectAll = $('album-select-all');
    if (selectAll) {
      selectAll.addEventListener('change', function () {
        var photos = getCurrentPhotos();
        var selected = getSelectedMap();
        var checked = this.checked;

        for (var i = 0; i < photos.length; i++) {
          if (checked) {
            selected[photos[i].public_id] = true;
          } else {
            delete selected[photos[i].public_id];
          }
        }
        renderGallery();
      });
    }

    // Photo grid - click on checkbox and image
    var grid = $('album-grid');
    if (grid) {
      grid.addEventListener('change', function (e) {
        if (e.target.classList.contains('album-checkbox')) {
          var id = e.target.getAttribute('data-id');
          var selected = getSelectedMap();
          if (e.target.checked) {
            selected[id] = true;
          } else {
            delete selected[id];
          }
          // Update parent item class
          var item = e.target.closest('.album-item');
          if (item) {
            if (e.target.checked) {
              item.classList.add('selected');
            } else {
              item.classList.remove('selected');
            }
          }
          updateActionBar();
        }
      });

      grid.addEventListener('click', function (e) {
        if (e.target.classList.contains('album-img')) {
          var index = parseInt(e.target.getAttribute('data-index'), 10);
          openLightbox(index);
        }
      });
    }

    // Download selected
    var btnDownloadSelected = $('album-btn-download-selected');
    if (btnDownloadSelected) {
      btnDownloadSelected.addEventListener('click', function () {
        var photos = getCurrentPhotos();
        var selected = getSelectedMap();
        var ids = Object.keys(selected);
        if (ids.length === 0) return;

        var toDownload = photos.filter(function (p) {
          return !!selected[p.public_id];
        });

        var eventoName = (evento ? evento.nombre : slug).replace(/\s+/g, '-').toLowerCase();
        var suffix = activeTab === 'fotos' ? 'fotos' : 'tiras';
        downloadZip(toDownload, eventoName + '-' + suffix + '.zip');
      });
    }

    // Download all
    var btnDownloadAll = $('album-btn-download-all');
    if (btnDownloadAll) {
      btnDownloadAll.addEventListener('click', function () {
        var photos = getCurrentPhotos();
        if (photos.length === 0) return;

        var eventoName = (evento ? evento.nombre : slug).replace(/\s+/g, '-').toLowerCase();
        var suffix = activeTab === 'fotos' ? 'fotos' : 'tiras';
        downloadZip(photos, eventoName + '-' + suffix + '.zip');
      });
    }

    // Lightbox
    var lightbox = $('album-lightbox');
    if (lightbox) {
      lightbox.addEventListener('click', function (e) {
        if (e.target === lightbox || e.target.classList.contains('lightbox-close')) {
          closeLightbox();
        }
      });
    }

    var lightboxPrev = $('lightbox-prev');
    var lightboxNext = $('lightbox-next');
    if (lightboxPrev) lightboxPrev.addEventListener('click', function (e) { e.stopPropagation(); navigateLightbox(-1); });
    if (lightboxNext) lightboxNext.addEventListener('click', function (e) { e.stopPropagation(); navigateLightbox(1); });

    // Lightbox download single
    var lightboxDownload = $('lightbox-download');
    if (lightboxDownload) {
      lightboxDownload.addEventListener('click', function (e) {
        e.stopPropagation();
        var photos = getCurrentPhotos();
        if (currentLightboxIndex >= 0 && currentLightboxIndex < photos.length) {
          var photo = photos[currentLightboxIndex];
          var a = document.createElement('a');
          a.href = photo.download;
          a.download = photo.public_id.split('/').pop() + '.' + photo.format;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
      });
    }

    // Keyboard navigation
    document.addEventListener('keydown', function (e) {
      var lightbox = $('album-lightbox');
      if (!lightbox || lightbox.style.display === 'none') return;

      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') navigateLightbox(-1);
      if (e.key === 'ArrowRight') navigateLightbox(1);
    });
  }

  /* ── Lightbox ────────────────────────────────────────── */

  var currentLightboxIndex = -1;

  function openLightbox(index) {
    var photos = getCurrentPhotos();
    if (index < 0 || index >= photos.length) return;

    currentLightboxIndex = index;
    var lightbox = $('album-lightbox');
    var img = $('lightbox-img');
    var counter = $('lightbox-counter');

    if (img) {
      img.src = photos[index].full;
      img.alt = 'Foto ' + (index + 1);
    }
    if (counter) counter.textContent = (index + 1) + ' / ' + photos.length;
    if (lightbox) {
      lightbox.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    }
  }

  function closeLightbox() {
    var lightbox = $('album-lightbox');
    if (lightbox) {
      lightbox.style.display = 'none';
      document.body.style.overflow = '';
    }
    currentLightboxIndex = -1;
  }

  function navigateLightbox(dir) {
    var photos = getCurrentPhotos();
    var next = currentLightboxIndex + dir;
    if (next < 0) next = photos.length - 1;
    if (next >= photos.length) next = 0;
    openLightbox(next);
  }

  /* ── Load photos ─────────────────────────────────────── */

  function loadPhotos() {
    var spinner = $('album-spinner');
    if (spinner) show(spinner);

    var folderSuelta = CLOUDINARY_FOLDER + '/' + slug + '/suelta';
    var folderTira = CLOUDINARY_FOLDER + '/' + slug + '/tira';

    Promise.all([
      fetchResourceList(folderSuelta),
      fetchResourceList(folderTira)
    ]).then(function (results) {
      fotosData = results[0];
      tirasData = results[1];

      if (spinner) hide(spinner);

      updateTabCounts();

      // Hide tiras tab if no strips available
      var tabTiras = $('album-tab-tiras');
      if (tabTiras) {
        tabTiras.style.display = tirasData.length > 0 ? '' : 'none';
      }

      renderGallery();
    });
  }

  /* ── Load event info ─────────────────────────────────── */

  function loadEventInfo() {
    return fetch(CSV_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('CSV response ' + res.status);
        return res.text();
      })
      .then(function (csvText) {
        var rows = parseCSV(csvText);
        for (var i = 0; i < rows.length; i++) {
          if ((rows[i].slug || '').trim() === slug) {
            evento = rows[i];
            break;
          }
        }
        renderEventHeader();
      })
      .catch(function (err) {
        console.warn('[selfie-album] CSV fetch failed:', err.message);
        renderEventHeader();
      });
  }

  function renderEventHeader() {
    var nameEl = $('album-event-name');
    var detailsEl = $('album-event-details');

    if (evento) {
      if (nameEl) nameEl.textContent = evento.nombre || slug;
      var parts = [];
      if (evento.tipo) parts.push(evento.tipo);
      if (evento.fecha) parts.push(formatDate(evento.fecha));
      if (evento.lugar) parts.push(evento.lugar);
      if (detailsEl) detailsEl.textContent = parts.join(' \u00B7 ');
    } else {
      if (nameEl) nameEl.textContent = slug;
      if (detailsEl) detailsEl.textContent = '';
    }
  }

  /* ── Init ─────────────────────────────────────────────── */

  function init() {
    slug = getParam('evento');

    if (!slug) {
      var gate = $('album-gate');
      if (gate) {
        gate.innerHTML =
          '<div class="gate-card">' +
          '<h2>Evento no encontrado</h2>' +
          '<p>Necesit\u00e1s un enlace v\u00e1lido para acceder al \u00e1lbum.</p>' +
          '</div>';
        show(gate);
      }
      return;
    }

    loadEventInfo();
    bindEvents();

    // Check if email already stored
    var storedEmail = getStoredEmail();
    if (storedEmail) {
      hide($('album-gate'));
      show($('album-gallery-section'));
      loadPhotos();
    } else {
      show($('album-gate'));
      hide($('album-gallery-section'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
