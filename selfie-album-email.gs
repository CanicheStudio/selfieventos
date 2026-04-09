/**
 * selfie-album-email.gs
 * Google Apps Script - Web App para registrar emails de visitantes del album.
 *
 * Deploy: Extensions > Apps Script > Deploy as Web App
 * - Execute as: Me
 * - Who has access: Anyone
 *
 * Endpoints:
 *   POST /exec  - Registra email { email, evento, timestamp }
 *   GET  /exec  - Devuelve todos los registros como JSON
 */

var SHEET_NAME = 'Emails Album';

/**
 * Get or create the sheet.
 */
function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Email', 'Evento', 'Timestamp', 'Registrado']);
    sheet.getRange('1:1').setFontWeight('bold');
    sheet.setColumnWidth(1, 280);
    sheet.setColumnWidth(2, 200);
    sheet.setColumnWidth(3, 220);
    sheet.setColumnWidth(4, 220);
  }

  return sheet;
}

/**
 * POST handler - receives JSON { email, evento, timestamp }
 * Appends a row to the Emails Album sheet.
 */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var email = (data.email || '').trim();
    var evento = (data.evento || '').trim();
    var timestamp = data.timestamp || new Date().toISOString();

    if (!email) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: 'Email requerido' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var sheet = getOrCreateSheet();
    var registrado = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

    sheet.appendRow([email, evento, timestamp, registrado]);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * GET handler - returns all email records as JSON.
 * Use ?evento=slug to filter by event.
 */
function doGet(e) {
  try {
    var sheet = getOrCreateSheet();
    var data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, count: 0, records: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var headers = data[0];
    var records = [];
    var filterEvento = (e && e.parameter && e.parameter.evento) ? e.parameter.evento.trim() : '';

    for (var i = 1; i < data.length; i++) {
      var row = {};
      for (var j = 0; j < headers.length; j++) {
        row[headers[j]] = data[i][j] !== undefined ? String(data[i][j]) : '';
      }

      if (filterEvento && row['Evento'] !== filterEvento) continue;

      records.push(row);
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        success: true,
        count: records.length,
        records: records
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
