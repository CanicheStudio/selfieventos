/**
 * selfie-config.js v2 — Fuente ÚNICA de configuración de Selfie Eventos
 * ---------------------------------------------------------------------
 * Spec v5 SELLADA · md5 aced02b998c6bc9d794d22aedad43c3d · §5
 * Renace del sellado por Ester `4b9b2f304c11b8ff69583fac75114dcc`.
 *
 * ARQUITECTURA NUEVA (opción B): el backend es un Cloudflare Worker propio.
 * CERO Google: no hay CSV publicado, no hay Apps Script, no hay Drive.
 *
 * SE PORTA del sellado:  tagFor() con su falla ruidosa · baseUrl() · assertReady()
 * MUERE:                 CSV_EVENTOS · CSV_EMAILS · EMAIL_SCRIPT_URL · listUrl()
 *
 * ¿Por qué muere listUrl()? Porque el browser NO puede listar en Cloudinary:
 * la Admin API bloquea el preflight por CORS (medido con control positivo — el
 * list público desde el mismo browser sí responde 200). Ahora lista el Worker.
 */
(function (window) {
  'use strict';

  var CONFIG = {

    /* ─────────────────────────── WORKER (backend) ─────────────────────────── */

    // <<<PENDIENTE H2>>> URL del Worker deployado. Custodiado por assertReady().
    WORKER_URL: 'https://selfie-worker.dantrinchero.workers.dev',

    /* ────────────────────────────── CLOUDINARY ────────────────────────────── */

    // <<<PENDIENTE H1>>> cuenta NUEVA Caniche→Fer.
    // 🔴 'dcjutekja' (cloud legacy de Fer) es un valor PROHIBIDO acá, no un default:
    // funciona, y por eso es el falso verde perfecto (el álbum leyendo del cloud
    // viejo mientras la migración está a medias). assertReady() lo rechaza por nombre.
    CLOUD_NAME: 'selfieeventos',

    // Preset unsigned (config sellada: sin svg, 10 MB, disallow_public_id).
    UPLOAD_PRESET: 'selfie_subir_unsigned',

    CLOUDINARY_FOLDER: 'eventos',

    /* ──────────────── TAGS — contrato compartido SUBIR ↔ LISTAR ────────────── */

    /**
     * evt-<slug>-<suelta|tira>. Es el MISMO contrato que usa el Worker para
     * consultar la Admin API: si quien sube y quien lista no coinciden, el
     * álbum queda vacío. Por eso vive en un solo lugar.
     *
     * 🔴 Falla RUIDOSA ante mal uso (regresión sellada): sin esto, tagFor(tag)
     * devolvía 'evt-evt-...-undefined', una string PLAUSIBLE que se cuela hasta
     * un 404 y hace parecer que el bug está en Cloudinary. Origen real: en el
     * gate de V1 el validador llamó listUrl(tag) y casi reporta un falso positivo.
     */
    tagFor: function (slug, tipo) {
      if (tipo !== 'suelta' && tipo !== 'tira') {
        throw new Error(
          "[selfie-config] tagFor(slug, tipo): 'tipo' debe ser 'suelta' o 'tira'. " +
          'Recibí: ' + JSON.stringify(tipo) + '. ¿Pasaste el TAG ya armado en vez de (slug, tipo)?'
        );
      }
      return 'evt-' + slug + '-' + tipo;
    },

    /** Base de ENTREGA de imágenes (mostrar). Listar es tarea del Worker. */
    baseUrl: function () {
      return 'https://res.cloudinary.com/' + CONFIG.CLOUD_NAME + '/image/upload';
    },

    /** URL de una foto por public_id, con transformación opcional. */
    fotoUrl: function (publicId, transform) {
      var t = transform ? transform + '/' : '';
      return CONFIG.baseUrl() + '/' + t + publicId;
    },

    /** Endpoint del Worker. Único lugar donde se arma la URL de la API. */
    api: function (path) {
      return String(CONFIG.WORKER_URL).replace(/\/+$/, '') + path;
    },

    /**
     * 🔴 GUARDA ANTI-FALSO-VERDE (criterio de cierre hecho código, V2.1).
     * Devuelve las claves que siguen sin valor real. El gate NO se cierra hasta
     * que devuelva []. Se verifica CORRIÉNDOLO, no leyendo el archivo.
     *
     *   node -e "global.window={};require('./js/selfie-config.js');
     *            console.log(window.SELFIE_CONFIG.assertReady())"
     */
    assertReady: function () {
      var pendientes = [];
      ['WORKER_URL', 'CLOUD_NAME', 'UPLOAD_PRESET'].forEach(function (k) {
        var v = CONFIG[k];
        if (typeof v !== 'string' || v.indexOf('<<<') !== -1 || v === '') pendientes.push(k);
      });
      // El cloud legacy NO es un valor válido de cierre: degrada en silencio.
      if (CONFIG.CLOUD_NAME === 'dcjutekja') pendientes.push('CLOUD_NAME(legacy dcjutekja)');
      return pendientes;
    }
  };

  window.SELFIE_CONFIG = CONFIG;

})(typeof window !== 'undefined' ? window : this);
