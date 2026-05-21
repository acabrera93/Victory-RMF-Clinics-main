// ════════════════════════════════════════════════════════════════════════════════
// GOOGLE APPS SCRIPT — Upload de Documentos y Comprobantes
// ════════════════════════════════════════════════════════════════════════════════
// INSTALACIÓN:
// 1. Ve a Google Drive
// 2. Crea una nueva carpeta llamada "RMF_Clinic_2026_Uploads"
// 3. Copia su ID de la URL: https://drive.google.com/drive/folders/FOLDER_ID
// 4. Ve a https://script.google.com
// 5. Crea nuevo proyecto
// 6. Pega este código
// 7. Guarda el proyecto
// 8. Click en "Implementar" → "Nueva implementación" → Tipo "Aplicación web"
// 9. Ejecutar como: TU CUENTA
// 10. Quién puede acceder: Cualquiera
// 11. Copia la URL de implementación y úsala abajo

// ───── CONFIG ──────────────────────────────────────────────────────────────────
const PARENT_FOLDER_ID = "1E_7wpNt-KgEKyVL9Za2h3J-ne0IXYRUh"; // ID de carpeta "RMF_Clinic_2026_Uploads"
const SHEET_ID = "1y5dB0eD4bpJ7NahLFMB5HqOAp3cYTZDeBTHINot5wss"; // Tu Google Sheet actual

const FOTOS_FOLDER_ID = "1VZxd3FdN8YLU2MpM-CJJIpy2IAb6FCFE"; // Carpeta fotos del viaje en Drive
const SABER_FOLDER_ID = "REEMPLAZAR_CON_ID_CARPETA_SABER"; // Carpeta "RMF_Clinic_2026_Saber"
const MEMORIAS_FOLDER_ID = "1Przikh__b-4CEhcR738XmhQLNdFgBoce"; // Carpeta galería memorias (ediciones anteriores)
const BUDGET_SHEET_ID = "1nMPrqnDUVwaoG42B84T8rCBvE7hKLo5nFLbrYWb58XQ"; // Sheet presupuesto/finanzas

// ───── GET HANDLER (fotos, saber, comunicaciones) ──────────────────────────────
function doGet(e) {
  const params = e.parameter || {};
  const action = params.action || '';
  Logger.log('doGet action=' + action + ' params=' + JSON.stringify(params));
  try {
    if (action === 'fotos') return listFiles(FOTOS_FOLDER_ID, 'image');
    if (action === 'memorias') return listFiles(MEMORIAS_FOLDER_ID, 'image');
    if (action === 'saber') {
      if (!SABER_FOLDER_ID || SABER_FOLDER_ID.indexOf('REEMPLAZAR') >= 0)
        return ContentService.createTextOutput('[]').setMimeType(ContentService.MimeType.JSON);
      return listFiles(SABER_FOLDER_ID, 'all');
    }
    if (action === 'comunicaciones') return getComunicaciones();
    if (action === 'buscar') return buscarParticipantes(params.email || '');
    if (action === 'admin_participantes') return getAdminParticipantes();
    if (action === 'admin_financiero') return getAdminFinanciero();
    if (action === 'admin_acceso') return getAdminAcceso();
    if (action === 'admin_acceso_check') return checkAdminAcceso(params.email || '');
    // Si llegamos aquí, action no fue reconocida — devolver debug
    return ContentService.createTextOutput(JSON.stringify({ _debug: true, msg: 'accion_no_reconocida', action: action, params: params }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('doGet error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ _debug: true, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function buscarParticipantes(email) {
  try {
    const emailNorm = email.toString().toLowerCase().trim();
    if (!emailNorm) return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);

    // Usar siempre la primera hoja (hoja principal de participantes)
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);

    const headers = data[0];

    // Encontrar columna email por nombre de cabecera
    let emailCol = -1;
    for (let j = 0; j < headers.length; j++) {
      const h = String(headers[j]).toLowerCase().trim();
      if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico' || h === 'e-mail') {
        emailCol = j;
        break;
      }
    }
    // Fallback a columna D (índice 3) si no se encontró por cabecera
    if (emailCol < 0) emailCol = 3;
    Logger.log('buscarParticipantes: emailCol=' + emailCol + ' buscando: ' + emailNorm);

    const participants = [];
    for (let i = 1; i < data.length; i++) {
      if (!data[i][emailCol]) continue;
      if (data[i][emailCol].toString().toLowerCase().trim() !== emailNorm) continue;
      const participant = {};
      for (let j = 0; j < headers.length; j++) {
        if (!headers[j]) continue;
        let val = data[i][j];
        if (val instanceof Date) {
          const yyyy = val.getFullYear();
          const mm = String(val.getMonth() + 1).padStart(2, '0');
          const dd = String(val.getDate()).padStart(2, '0');
          val = yyyy + '-' + mm + '-' + dd;
        } else {
          val = String(val == null ? '' : val);
        }
        participant[String(headers[j])] = val;
      }
      // Incluir paso_actual (col V = índice 21) aunque no tenga cabecera
      if (!participant['paso_actual']) {
        const pv = data[i][21];
        if (pv != null && pv !== '') participant['paso_actual'] = String(pv);
      }
      participants.push(participant);
    }

    Logger.log('buscarParticipantes: encontrados=' + participants.length);
    if (participants.length === 0) {
      // Debug temporal: devolver qué hay en las primeras filas
      const sample = data.slice(1, 6).map(row => row[emailCol] ? String(row[emailCol]).toLowerCase().trim() : '(vacio)');
      return ContentService.createTextOutput(JSON.stringify({ _debug: true, buscando: emailNorm, emailCol: emailCol, encabezado: String(headers[emailCol]), muestras: sample }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify(participants))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('buscarParticipantes error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ _debug: true, catch_error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function listFiles(folderId, filter) {
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  const result = [];
  while (files.hasNext()) {
    const f = files.next();
    const mime = f.getMimeType();
    if (filter === 'image' && !mime.startsWith('image/')) continue;
    result.push({
      id: f.getId(),
      name: f.getName(),
      mimeType: mime,
      url: f.getUrl(),
      viewUrl: 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w800'
    });
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function getComunicaciones() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Comunicaciones');
  if (!sheet) return ContentService.createTextOutput(JSON.stringify([]))
    .setMimeType(ContentService.MimeType.JSON);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return ContentService.createTextOutput(JSON.stringify([]))
    .setMimeType(ContentService.MimeType.JSON);
  const result = data.slice(1).reverse()
    .filter(r => r[0])
    .map(r => ({ fecha: String(r[0]), titulo: String(r[1] || ''), mensaje: String(r[2] || ''), destinatario: String(r[3] || 'todos') }));
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ───── SETUP TRIGGER (ejecutar UNA VEZ desde el editor) ──────────────────────
// Selecciona esta función y haz clic en ▶ Run para crear el trigger automáticamente
function crearTriggerComunicados() {
  // Eliminar trigger anterior si existe
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'notificarNuevoComunicado') ScriptApp.deleteTrigger(t);
  });
  // Crear trigger de edición sobre el Sheet
  ScriptApp.newTrigger('notificarNuevoComunicado')
    .forSpreadsheet(SHEET_ID)
    .onEdit()
    .create();
  Logger.log('Trigger creado correctamente.');
}

// ───── NOTIFICAR NUEVO COMUNICADO ─────────────────────────────────────────────
function notificarNuevoComunicado(e) {
  try {
    // Solo actuar si el edit fue en la columna C (Mensaje) de la hoja Comunicaciones
    if (!e || !e.range) return;
    if (e.range.getSheet().getName() !== 'Comunicaciones') return;
    if (e.range.getColumn() !== 3) return; // columna C = índice 3

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName('Comunicaciones');
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return;

    // Tomar los datos de la fila editada (no siempre la última)
    const editedRow = e.range.getRow();
    const rowData = data[editedRow - 1]; // -1 porque data es 0-indexed
    if (!rowData) return;
    const fecha  = String(rowData[0] || '');
    const titulo = String(rowData[1] || '').trim();
    const mensaje = String(rowData[2] || '').trim();
    if (!titulo || !mensaje) return;

    // Control de deduplicación por contenido — evita reenviar el mismo comunicado
    const props = PropertiesService.getScriptProperties();
    const currentHash = titulo + '|||' + mensaje;
    const lastHash = props.getProperty('comun_last_hash') || '';
    if (currentHash === lastHash) return;

    // Obtener emails únicos de participantes desde la hoja principal
    const mainSheet = ss.getSheets()[0];
    const mainData  = mainSheet.getDataRange().getValues();
    const headers   = mainData[0] || [];
    let emailCol = -1;
    for (let j = 0; j < headers.length; j++) {
      const h = String(headers[j]).toLowerCase().trim();
      if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico' || h === 'e-mail') {
        emailCol = j; break;
      }
    }
    if (emailCol < 0) emailCol = 3;

    const emails = [];
    const seen = new Set();
    for (let i = 1; i < mainData.length; i++) {
      const em = String(mainData[i][emailCol] || '').toLowerCase().trim();
      if (em && em.includes('@') && !seen.has(em)) { seen.add(em); emails.push(em); }
    }

    const link = 'https://victory-rmf-clinics.netlify.app/areapersonal.html?tab=comunicaciones';
    const subject = '⚠ Nuevo comunicado';
    const preview = mensaje.length > 180 ? mensaje.substring(0, 180).trim() + '...' : mensaje;
    const htmlBody = buildComunicadoHtml(fecha, titulo, preview, link);
    const adminEmail = 'alejandro.cabrera@fundacionrevel.net';
    emails.forEach(function(em) {
      try { GmailApp.sendEmail(em, subject, 'Tienes un nuevo comunicado: ' + link, { htmlBody: htmlBody, replyTo: adminEmail, name: 'Real Madrid Foundation Clinic' }); }
      catch(err) { Logger.log('Error enviando a ' + em + ': ' + err); }
    });
    GmailApp.sendEmail(adminEmail, '[Admin] Comunicado enviado — ' + titulo, '', { htmlBody: htmlBody, name: 'Real Madrid Foundation Clinic' });
    props.setProperty('comun_last_hash', currentHash);
  } catch(err) {
    Logger.log('notificarNuevoComunicado error: ' + err);
  }
}

// ───── ACTUALIZAR PASO (todas las filas del mismo email) ───────────────────────
function actualizarPasoTodos(email, pasoActual) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    const emailCol = 3;  // Columna D (índice 0)
    const pasoCol  = 21; // Columna V (índice 0) = paso_actual
    const emailNorm = email.toString().toLowerCase().trim();
    let updated = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i][emailCol].toString().toLowerCase().trim() === emailNorm) {
        const pasoActual_num = parseInt(pasoActual) || 0;
        const pasoActualSheet = parseInt(data[i][pasoCol]) || 0;
        if (pasoActual_num <= pasoActualSheet) continue; // nunca retroceder
        sheet.getRange(i + 1, pasoCol + 1).setValue(pasoActual);
        updated++;
      }
    }
    return sendResponse(200, { ok: true, updated });
  } catch (err) {
    Logger.log('actualizarPasoTodos error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// ───── MAIN HANDLER ────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const contentType = (e.contentType || '');

    // text/plain se usa para evitar CORS preflight desde el browser
    if (contentType.includes('multipart/form-data')) {
      return handleMultipartUpload(e);
    }

    // Intentar parsear body como JSON (application/json o text/plain)
    const body = e.postData ? e.postData.contents : '';
    if (body) {
      try {
        const parsed = JSON.parse(body);
        if (parsed.action === 'actualizar_paso' && parsed.email && parsed.paso_actual) {
          return actualizarPasoTodos(parsed.email, parsed.paso_actual);
        }
        if (parsed.action === 'publicar_comunicado') return publicarComunicado(parsed);
        if (parsed.action === 'eliminar_comunicado') return eliminarComunicado(parsed);
        if (parsed.action === 'actualizar_participante') return actualizarParticipante(parsed);
        if (parsed.action === 'registrar_pago') return registrarPago(parsed);
        if (parsed.action === 'sincronizar_participantes') return sincronizarParticipantes();
        if (parsed.action === 'admin_acceso_guardar') return guardarAdminAcceso(parsed);
        if (parsed.action === 'guardar_comercial') return guardarComercial(parsed);
        if (parsed.action === 'subir_foto_drive') return subirFotoDrive(parsed);
        if (parsed.action === 'eliminar_foto_drive') return eliminarFotoDrive(parsed);
        if (parsed.base64 || parsed.email) return handleJsonUpload(e);
      } catch (_) {}
    }

    return sendResponse(400, { ok: false, error: 'No se pudo procesar la solicitud' });
  } catch (err) {
    Logger.log('Error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// ───── HANDLE MULTIPART (archivos reales) ──────────────────────────────────────
function handleMultipartUpload(e) {
  const params = e.parameter || {};
  const email = (params.email || '').toLowerCase().trim();
  const tipo_documento = params.tipo_documento || 'otro';
  const tipo_pago = params.tipo_pago || '';
  const nombre = params.nombre || 'sin nombre';

  if (!email) {
    return sendResponse(400, { ok: false, error: 'Email requerido' });
  }

  // Obtener archivo desde blob
  let fileBlob = null;
  if (e.parameter.file) {
    fileBlob = e.parameter.file;
  } else if (e.getBlob) {
    fileBlob = e.getBlob();
  }

  if (!fileBlob) {
    return sendResponse(400, { ok: false, error: 'No file provided' });
  }

  try {
    // Crear estructura de carpetas
    const parentFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
    const emailFolderName = 'Participante_' + email.replace('@', '_').replace(/\./g, '_');
    let emailFolder = null;
    const emailFolders = parentFolder.getFoldersByName(emailFolderName);
    if (emailFolders.hasNext()) {
      emailFolder = emailFolders.next();
    } else {
      emailFolder = parentFolder.createFolder(emailFolderName);
    }

    // Crear subcarpeta según tipo
    const tipoFolder = tipo_pago
      ? 'Comprobantes_Pago_' + tipo_pago
      : 'Documentos_' + tipo_documento;
    let docFolder = null;
    const docFolders = emailFolder.getFoldersByName(tipoFolder);
    if (docFolders.hasNext()) {
      docFolder = docFolders.next();
    } else {
      docFolder = emailFolder.createFolder(tipoFolder);
    }

    // Guardar archivo
    const timestamp = new Date().getTime();
    const fileName = tipo_pago
      ? `Comprobante_${tipo_pago}_${timestamp}.${getExtension(fileBlob.getName())}`
      : `${tipo_documento}_${timestamp}.${getExtension(fileBlob.getName())}`;

    const file = docFolder.createFile(fileBlob);
    file.setName(fileName);

    // Compartir con usuario (solo lectura)
    try {
      file.addEditor(email);
    } catch (e) {
      Logger.log('No se pudo compartir con el usuario: ' + e);
    }

    const fileUrl = file.getUrl();
    const fileId = file.getId();

    // Actualizar Sheets
    updateSheetWithUpload(email, tipo_documento, tipo_pago, fileName, fileUrl, fileId);

    return sendResponse(200, {
      ok: true,
      filename: fileName,
      url: fileUrl,
      id: fileId,
      message: 'Archivo guardado exitosamente'
    });
  } catch (err) {
    Logger.log('Upload error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// ───── HANDLE JSON (base64 encoded) ────────────────────────────────────────────
function handleJsonUpload(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const email = (data.email || '').toLowerCase().trim();
    const tipo_documento = data.tipo_documento || 'otro';
    const tipo_pago = data.tipo_pago || '';
    const base64Data = data.base64 || '';
    const fileName = data.fileName || 'documento';
    const nombre = data.nombre || 'sin nombre';

    if (!email || !base64Data) {
      return sendResponse(400, { ok: false, error: 'Email y base64 requeridos' });
    }

    // Decodificar base64
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), getMimeType(fileName), fileName);

    // Crear estructura de carpetas
    const parentFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
    const emailFolderName = 'Participante_' + email.replace('@', '_').replace(/\./g, '_');
    let emailFolder = null;
    const emailFolders = parentFolder.getFoldersByName(emailFolderName);
    if (emailFolders.hasNext()) {
      emailFolder = emailFolders.next();
    } else {
      emailFolder = parentFolder.createFolder(emailFolderName);
    }

    // Crear subcarpeta
    const tipoFolder = tipo_pago
      ? 'Comprobantes_Pago_' + tipo_pago
      : 'Documentos_' + tipo_documento;
    let docFolder = null;
    const docFolders = emailFolder.getFoldersByName(tipoFolder);
    if (docFolders.hasNext()) {
      docFolder = docFolders.next();
    } else {
      docFolder = emailFolder.createFolder(tipoFolder);
    }

    // Guardar archivo
    const timestamp = new Date().getTime();
    const finalFileName = tipo_pago
      ? `Comprobante_${tipo_pago}_${timestamp}_${fileName}`
      : `${tipo_documento}_${timestamp}_${fileName}`;

    const file = docFolder.createFile(blob);
    file.setName(finalFileName);

    const fileUrl = file.getUrl();
    const fileId = file.getId();

    // Actualizar Sheets
    updateSheetWithUpload(email, tipo_documento, tipo_pago, finalFileName, fileUrl, fileId);

    return sendResponse(200, {
      ok: true,
      filename: finalFileName,
      url: fileUrl,
      id: fileId,
      message: 'Archivo guardado exitosamente'
    });
  } catch (err) {
    Logger.log('JSON upload error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// ───── ACTUALIZAR SHEETS ───────────────────────────────────────────────────────
function updateSheetWithUpload(email, tipoDoc, tipoPago, fileName, fileUrl, fileId) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Documentos');
    if (!sheet) return; // Si no existe la hoja, no falla

    const data = sheet.getDataRange().getValues();
    const headers = data[0] || [];

    // Buscar email en la hoja
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]?.toString().toLowerCase() === email) {
        rowIndex = i + 1; // +1 porque Sheets es 1-indexed
        break;
      }
    }

    if (rowIndex > 0) {
      // Encontrar columna según tipo de documento/pago
      let colName = '';
      if (tipoPago === 'reserva') colName = 'comprobante_reserva';
      else if (tipoPago === 'tiquete') colName = 'comprobante_tiquete';
      else if (tipoPago === 'final') colName = 'comprobante_final';
      else if (tipoDoc === 'pasaporte') colName = 'doc_pasaporte';
      else if (tipoDoc === 'permiso') colName = 'doc_permiso';
      else if (tipoDoc === 'registro_civil') colName = 'doc_registro_civil';

      const colIndex = headers.indexOf(colName);
      if (colIndex >= 0) {
        const formula = `=HYPERLINK("${fileUrl}","${fileName}")`;
        sheet.getRange(rowIndex, colIndex + 1).setValue(formula);
      }
    }
  } catch (err) {
    Logger.log('Sheet update error: ' + err);
  }
}

// ───── HELPER FUNCTIONS ────────────────────────────────────────────────────────
function getExtension(fileName) {
  const match = fileName.match(/\.([^.]+)$/);
  return match ? match[1] : 'bin';
}

function getMimeType(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  const mimeTypes = {
    'pdf': 'application/pdf',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function sendResponse(statusCode, data) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ───── ADMIN FUNCTIONS ─────────────────────────────────────────────────────────
function getAdminParticipantes() {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return sendResponse(200, []);
    const headers = data[0];
    const result = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row.every(function(c) { return c === '' || c === null; })) continue;
      const obj = { _row: i + 1 };
      for (let j = 0; j < headers.length; j++) {
        const h = String(headers[j]);
        let val = row[j];
        if (val instanceof Date) {
          val = val.getFullYear() + '-' + String(val.getMonth()+1).padStart(2,'0') + '-' + String(val.getDate()).padStart(2,'0');
        } else {
          val = String(val == null ? '' : val);
        }
        obj[h] = val;
      }
      result.push(obj);
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('getAdminParticipantes error: ' + err);
    return sendResponse(500, { error: err.toString() });
  }
}

function publicarComunicado(data) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Comunicaciones');
    if (!sheet) return sendResponse(404, { ok: false, error: 'Hoja Comunicaciones no encontrada' });
    const fecha = data.fecha || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const titulo = String(data.titulo || '').trim();
    const mensaje = String(data.mensaje || '').trim();
    const destinatario = String(data.destinatario || 'todos').trim();
    if (!titulo || !mensaje) return sendResponse(400, { ok: false, error: 'Titulo y mensaje requeridos' });
    // Save to sheet (col D = destinatario)
    sheet.appendRow([fecha, titulo, mensaje, destinatario]);
    // Send emails directly with filter
    var sent = enviarEmailsComunicado({ fecha: fecha, titulo: titulo, mensaje: mensaje, destinatario: destinatario });
    return sendResponse(200, { ok: true, enviados: sent });
  } catch (err) {
    Logger.log('publicarComunicado error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function enviarEmailsComunicado(params) {
  try {
    var fecha = params.fecha || '';
    var titulo = params.titulo || '';
    var mensaje = params.mensaje || '';
    var destinatario = params.destinatario || 'todos';

    var ss = SpreadsheetApp.openById(SHEET_ID);
    var mainSheet = ss.getSheets()[0];
    var mainData = mainSheet.getDataRange().getValues();
    var headers = mainData[0] || [];

    // Find email and tiquete columns by header
    var emailCol = 3;
    var tiqCol = 13;
    for (var j = 0; j < headers.length; j++) {
      var h = String(headers[j]).toLowerCase().trim();
      if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico') emailCol = j;
      if (h.indexOf('tiquete') >= 0 || h.indexOf('vuelo') >= 0) tiqCol = j;
    }

    var emails = [];
    var seen = {};

    // Individual: destinatario is one or more comma-separated email addresses
    if (destinatario !== 'todos' && destinatario !== 'con_tiquete' && destinatario !== 'sin_tiquete') {
      destinatario.split(',').forEach(function(em) {
        em = em.trim();
        if (em.indexOf('@') >= 0 && !seen[em]) { seen[em] = true; emails.push(em); }
      });
    } else {
      for (var i = 1; i < mainData.length; i++) {
        var em = String(mainData[i][emailCol] || '').toLowerCase().trim();
        if (!em || em.indexOf('@') < 0 || seen[em]) continue;
        if (destinatario === 'con_tiquete') {
          var tiq = String(mainData[i][tiqCol] || '').toLowerCase();
          if (tiq.indexOf('con') < 0) continue;
        } else if (destinatario === 'sin_tiquete') {
          var tiq2 = String(mainData[i][tiqCol] || '').toLowerCase();
          if (tiq2.indexOf('con') >= 0) continue;
        }
        seen[em] = true;
        emails.push(em);
      }
    }

    var link = 'https://victory-rmf-clinics.netlify.app/areapersonal.html?tab=comunicaciones';
    var subject = '⚠ Nuevo comunicado';
    var preview = mensaje.length > 180 ? mensaje.substring(0, 180).trim() + '...' : mensaje;
    var htmlBody = buildComunicadoHtml(fecha, titulo, preview, link);
    var adminEmail = 'alejandro.cabrera@fundacionrevel.net';

    emails.forEach(function(em) {
      try { GmailApp.sendEmail(em, subject, 'Tienes un nuevo comunicado: ' + link, { htmlBody: htmlBody, replyTo: adminEmail, name: 'Real Madrid Foundation Clinic' }); }
      catch(e2) { Logger.log('Error enviando a ' + em + ': ' + e2); }
    });

    // Admin confirmation
    try {
      GmailApp.sendEmail(adminEmail, '[Admin] Comunicado enviado (' + emails.length + ' dest.) — ' + titulo, '', { htmlBody: htmlBody, name: 'Real Madrid Foundation Clinic' });
    } catch(e3) { Logger.log('Error enviando admin: ' + e3); }

    return emails.length;
  } catch(err) {
    Logger.log('enviarEmailsComunicado error: ' + err);
    return 0;
  }
}

function buildComunicadoHtml(fecha, titulo, preview, link) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">'
    + '<div style="background:#1e5ba8;padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">'
    + '<table cellpadding="0" cellspacing="0" style="margin:0 auto 12px auto"><tr>'
    + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1USK2ut3e0f1VwBbQ8uNqVSD517KtdZZQ" alt="Real Madrid Foundation" height="48" style="display:block;height:48px;width:auto"></td>'
    + '<td style="vertical-align:middle;padding:0 14px"><div style="width:1px;height:36px;background:rgba(255,255,255,0.45)"></div></td>'
    + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1XfpwTY8c5GDI4ssInLnIKxJ37UOPKKmO" alt="Fundacion Revel" height="40" style="display:block;height:40px;width:auto"></td>'
    + '</tr></table>'
    + '<h2 style="color:#fff;margin:0;font-size:18px">Real Madrid Foundation Clinic 2026</h2></div>'
    + '<div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">'
    + '<p style="color:#334155;margin-top:0">Tienes un nuevo comunicado del equipo Revel:</p>'
    + '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:16px 0">'
    + '<p style="font-size:12px;color:#94a3b8;margin:0 0 4px">' + fecha + '</p>'
    + '<h3 style="color:#1e3a5f;margin:0 0 12px;font-size:16px">' + titulo + '</h3>'
    + '<p style="color:#334155;margin:0;line-height:1.6;white-space:pre-wrap">' + preview + '</p></div>'
    + '<a href="' + link + '" style="display:inline-block;background:#1e5ba8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:4px">Ver mensaje completo en tu área personal →</a>'
    + '<p style="color:#94a3b8;font-size:12px;margin-top:20px">Equipo Revel · Real Madrid Foundation Clinic 2026</p></div></div>';
}

function eliminarComunicado(data) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Comunicaciones');
    if (!sheet) return sendResponse(404, { ok: false, error: 'Hoja no encontrada' });
    const sheetData = sheet.getDataRange().getValues();
    const titulo = String(data.titulo || '').trim();
    const fecha = String(data.fecha || '').trim();
    // Find matching row (skip header row 0)
    for (let i = 1; i < sheetData.length; i++) {
      const rowFecha = String(sheetData[i][0] || '').trim();
      const rowTitulo = String(sheetData[i][1] || '').trim();
      if (rowTitulo === titulo && rowFecha === fecha) {
        sheet.deleteRow(i + 1); // +1 because sheet rows are 1-indexed
        return sendResponse(200, { ok: true });
      }
    }
    return sendResponse(404, { ok: false, error: 'Comunicado no encontrado' });
  } catch (err) {
    Logger.log('eliminarComunicado error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function actualizarParticipante(data) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    const rowNum = parseInt(data._row);
    if (!rowNum || rowNum < 2) return sendResponse(400, { ok: false, error: 'Fila invalida: ' + data._row });
    const numColMapByIdx = {
      1:'tipo', 2:'nombre', 3:'email', 4:'phone', 5:'pais', 6:'pasaporte',
      7:'fecha_nacimiento', 8:'posicion', 9:'club_colegio', 10:'ciudad',
      11:'salud_alergias', 12:'acudiente', 13:'relacion', 14:'tiquete_aereo',
      15:'programa', 16:'habitacion', 22:'paso_actual'
    };
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    let updated = 0;
    for (let j = 0; j < headers.length; j++) {
      const h = String(headers[j]);
      const hLower = h.toLowerCase();
      const normalizedName = numColMapByIdx[j + 1] || hLower;
      let val = null;
      if (data[h] !== undefined) val = data[h];
      else if (data[hLower] !== undefined) val = data[hLower];
      else if (data[normalizedName] !== undefined) val = data[normalizedName];
      if (val !== null) {
        sheet.getRange(rowNum, j + 1).setValue(val);
        updated++;
      }
    }
    return sendResponse(200, { ok: true, updated: updated });
  } catch (err) {
    Logger.log('actualizarParticipante error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function guardarComercial(data) {
  try {
    var ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    var comSheet = getSheetCI(ss, 'Comisiones');
    if (!comSheet) return sendResponse(404, { ok: false, error: 'Hoja Comisiones no encontrada' });

    var comercial = String(data.comercial || '').trim();
    if (!comercial) return sendResponse(400, { ok: false, error: 'Nombre del comercial requerido' });

    var rowNum = parseInt(data._row) || 0;
    var seccion = String(data.seccion || 'jugadores').trim();
    var newRow;

    if (seccion === 'acompanantes') {
      var comDoble = parseFloat(data.com_doble) || 0;
      var comSencilla = parseFloat(data.com_sencilla) || 0;
      var acompDoble = parseInt(data.acomp_doble) || 0;
      var acompSencilla = parseInt(data.acomp_sencilla) || 0;
      var total = comDoble * acompDoble + comSencilla * acompSencilla;
      newRow = [comercial, comDoble, comSencilla, acompDoble, acompSencilla, total];
    } else {
      var comisionJugador = parseFloat(data.comision_jugador) || 0;
      var jugadores = parseInt(data.jugadores) || 0;
      var estado = String(data.estado || 'Pendiente').trim();
      var notas = String(data.notas || '').trim();
      var total = comisionJugador * jugadores;
      newRow = [comercial, comisionJugador, jugadores, total, estado, notas];
    }

    if (rowNum >= 6) {
      // Update existing row
      comSheet.getRange(rowNum, 1, 1, 6).setValues([newRow]);
    } else {
      // New row — insert before the TOTAL row of the target section
      var lastComRow = comSheet.getLastRow();
      var colAData = lastComRow >= 6 ? comSheet.getRange('A6:A' + lastComRow).getValues() : [];
      var inTargetSection = (seccion === 'jugadores');
      var summaryRow = -1;

      for (var i = 0; i < colAData.length; i++) {
        var cellA = String(colAData[i][0] || '').trim().toLowerCase();
        if (!inTargetSection && cellA.indexOf('acomp') >= 0) {
          if (seccion === 'acompanantes') inTargetSection = true;
        }
        if (inTargetSection && cellA.indexOf('total') >= 0) {
          summaryRow = 6 + i;
          break;
        }
      }

      if (summaryRow >= 6) {
        comSheet.insertRowsBefore(summaryRow, 1);
        comSheet.getRange(summaryRow, 1, 1, 6).setValues([newRow]);
      } else {
        // Fallback: append at end
        comSheet.getRange(Math.max(comSheet.getLastRow(), 5) + 1, 1, 1, 6).setValues([newRow]);
      }
    }

    return sendResponse(200, { ok: true });
  } catch (err) {
    Logger.log('guardarComercial error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function getSheetCI(ss, name) {
  var nl = name.toLowerCase();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().toLowerCase() === nl) return sheets[i];
  }
  return null;
}

function getAdminFinanciero() {
  try {
    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);

    const str = function(v) { return String(v == null ? '' : v).trim(); };
    const num = function(v) {
      if (typeof v === 'number') return v;
      var s = str(v).replace(/[€$\s]/g,'').replace(/\.(?=\d{3})/g,'').replace(',','.');
      return parseFloat(s) || 0;
    };
    const fmtDate = function(v) {
      if (v instanceof Date) return String(v.getDate()).padStart(2,'0') + '/' + String(v.getMonth()+1).padStart(2,'0') + '/' + v.getFullYear();
      return str(v);
    };

    const result = { kpis: {}, pagos_recibidos: {}, paquetes: [], comisiones: [], pagos_lista: [] };

    // ── KPIs — hoja "Dashboard" fila 6: A=participantes, B=ingresos, C=costos, D=beneficio, E=margen
    var dashSheet = getSheetCI(ss, 'Dashboard');
    if (dashSheet) {
      var kpi = dashSheet.getRange('A6:E6').getValues()[0];
      var rawMargen = kpi[4];
      result.kpis = {
        participantes: num(kpi[0]),
        ingresos:      num(kpi[1]),
        costos:        num(kpi[2]),
        beneficio:     num(kpi[3]),
        margen: typeof rawMargen === 'number'
          ? (rawMargen > 1 ? rawMargen / 100 : rawMargen)
          : (parseFloat(str(rawMargen).replace(',','.').replace('%','')) / 100 || 0)
      };
    }

    // ── Jugadores: celda B6 de hoja Jugadores
    // ── Acompañantes: suma B6+C6+D6 — buscar por nombre parcial por si la ñ tiene codificación diferente
    var jugSheet = getSheetCI(ss, 'Jugadores');
    var acompSheet = null;
    var allSheets = ss.getSheets();
    for (var si = 0; si < allSheets.length; si++) {
      var sn = allSheets[si].getName().toLowerCase();
      if (sn.indexOf('acomp') === 0) { acompSheet = allSheets[si]; break; }
    }
    result.kpis.jugadores    = jugSheet   ? num(jugSheet.getRange('B6').getValue())   : 0;
    result.kpis.acompanantes = acompSheet ? (num(acompSheet.getRange('B6').getValue())
                                           + num(acompSheet.getRange('C6').getValue())
                                           + num(acompSheet.getRange('D6').getValue())) : 0;

    // ── Pagos recibidos + pagos individuales — hoja "Pagos"
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (pagosSheet) {
      // Resumen fila 32: C=COP, D=EUR, F32=completos, F33=parciales
      result.pagos_recibidos = {
        total_eur:  num(pagosSheet.getRange('D32').getValue()),
        total_cop:  num(pagosSheet.getRange('C32').getValue()),
        completos:  num(pagosSheet.getRange('F32').getValue()),
        parciales:  num(pagosSheet.getRange('F33').getValue())
      };
      // Pagos individuales desde fila 6: A=nombre, B=fecha, C=COP, D=EUR, E=estado, F=paquete, G=concepto
      var lastPagRow = pagosSheet.getLastRow();
      if (lastPagRow >= 6) {
        var pagData = pagosSheet.getRange('A6:G' + lastPagRow).getValues();
        for (var i = 0; i < pagData.length; i++) {
          var r = pagData[i];
          var nombre = str(r[0]);
          var eurAmt = num(r[3]);
          if (!nombre || eurAmt <= 0) continue;
          var fechaVal = r[1];
          if (!fechaVal || (!(fechaVal instanceof Date) && !str(fechaVal).match(/\d/))) continue;
          result.pagos_lista.push({
            nombre: nombre, fecha: fmtDate(fechaVal),
            cop: num(r[2]), eur: eurAmt,
            estado: str(r[4]), paquete: str(r[5]), notas: str(r[6])
          });
        }
      }
      // Recalcular totales sumando todos los pagos (completos + parciales)
      // D32/C32 solo cuentan "Completo" — usar suma real de pagos_lista
      var sumEur = 0, sumCop = 0;
      for (var pi = 0; pi < result.pagos_lista.length; pi++) {
        sumEur += result.pagos_lista[pi].eur;
        sumCop += result.pagos_lista[pi].cop;
      }
      if (sumEur > 0) result.pagos_recibidos.total_eur = sumEur;
      if (sumCop > 0) result.pagos_recibidos.total_cop = sumCop;

      // Recopilar todos los nombres únicos de la hoja Pagos (incluso sin pago aún)
      var pagosNombres = [];
      var seenPN = {};
      for (var i = 0; i < pagData.length; i++) {
        var cellA = str(pagData[i][0]);
        if (cellA && !seenPN[cellA.toLowerCase()]) {
          seenPN[cellA.toLowerCase()] = true;
          pagosNombres.push(cellA);
        }
      }
      result.pagos_nombres = pagosNombres;
    }

    // ── Comisiones — hoja "Comisiones" desde fila 6
    // Secciones detectadas dinámicamente por col A:
    //   - Filas con "acomp" → marca inicio de sección acompañantes
    //   - Filas con "total" → fila resumen (skip)
    //   - Filas vacías → skip
    //   - Resto → fila de comercial
    var comSheet = getSheetCI(ss, 'Comisiones');
    if (comSheet) {
      var lastComRow = comSheet.getLastRow();
      if (lastComRow >= 6) {
        var comData = comSheet.getRange('A6:F' + lastComRow).getValues();
        var seccionActual = 'jugadores';
        for (var i = 0; i < comData.length; i++) {
          var r = comData[i];
          var colA = str(r[0]);
          var colALow = colA.toLowerCase();
          if (!colA) continue;
          if (colALow.indexOf('acomp') >= 0) { seccionActual = 'acompanantes'; continue; }
          if (colALow.indexOf('total') >= 0) continue;
          if (colALow === 'comercial') continue; // sub-header dentro de la sección
          if (seccionActual === 'jugadores') {
            result.comisiones.push({
              _row: 6 + i, seccion: 'jugadores',
              comercial: colA, comision_jugador: num(r[1]),
              jugadores: num(r[2]), total: num(r[3]),
              estado: str(r[4]), notas: str(r[5])
            });
          } else {
            // Acompañantes: B=com_doble, C=com_sencilla, D=acomp_doble, E=acomp_sencilla, F=total
            result.comisiones.push({
              _row: 6 + i, seccion: 'acompanantes',
              comercial: colA,
              com_doble: num(r[1]), com_sencilla: num(r[2]),
              acomp_doble: num(r[3]), acomp_sencilla: num(r[4]),
              total: num(r[5])
            });
          }
        }
      }
    }

    // ── Paquetes — buscar filas Redcol/Paquete en todas las hojas
    ss.getSheets().forEach(function(sh) {
      var sv = sh.getDataRange().getValues();
      sv.forEach(function(row) {
        for (var j = 0; j < row.length; j++) {
          var cj = str(row[j]);
          if ((cj.indexOf('Redcol') === 0 || cj.indexOf('Paquete') === 0) && num(row[j+1]) > 0 && num(row[j+2]) > 0) {
            result.paquetes.push({ nombre: cj, precio: num(row[j+1]), cantidad: num(row[j+2]), total: num(row[j+3]) });
            break;
          }
        }
      });
    });

    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    Logger.log('getAdminFinanciero error: ' + err);
    return sendResponse(500, { error: err.toString() });
  }
}

// ───── REGISTRAR PAGO EN HOJA PAGOS ──────────────────────────────────────────
function registrarPago(data) {
  try {
    var nombre  = String(data.nombre  || '').trim();
    var tipo    = String(data.tipo    || '').trim(); // Reserva | Tiquete | Pago Final
    var fecha   = String(data.fecha   || '').trim(); // YYYY-MM-DD
    var eur     = parseFloat(data.eur)  || 0;
    var cop     = parseFloat(data.cop)  || 0;
    var estado  = String(data.estado  || 'Parcial').trim();
    var paquete = String(data.paquete || 'Estándar').trim();

    if (!nombre || !tipo || !fecha || eur <= 0)
      return sendResponse(400, { ok: false, error: 'nombre, tipo, fecha y eur son requeridos' });

    var ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return sendResponse(404, { ok: false, error: 'Hoja Pagos no encontrada' });

    var parts = fecha.split('-');
    var fechaDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));

    var lastRow = pagosSheet.getLastRow();
    var startRow = 6;
    var numRows = lastRow - startRow + 1;
    var allData = numRows > 0 ? pagosSheet.getRange(startRow, 1, numRows, 7).getValues() : [];

    var nombreLower = nombre.toLowerCase();
    var tipoLower   = tipo.toLowerCase();
    var inBlock = false;
    var targetSheetRow = -1;
    var blockPagoFinalRow = -1; // tracks Pago Final row within this participant's block

    for (var i = 0; i < allData.length; i++) {
      var cellA = String(allData[i][0] || '').trim();
      var cellG = String(allData[i][6] || '').trim();

      if (cellA) {
        if (cellA.toLowerCase() === nombreLower) {
          inBlock = true;
        } else if (inBlock) {
          break; // otro participante → bloque terminó sin match
        }
      }

      if (inBlock) {
        if (cellG.toLowerCase() === tipoLower) {
          targetSheetRow = startRow + i;
          break;
        }
        if (cellG.toLowerCase() === 'pago final') {
          blockPagoFinalRow = startRow + i;
        }
      }
    }

    var newRow = [nombre, fechaDate, cop > 0 ? cop : '', eur, estado, paquete, tipo];

    if (targetSheetRow > 0) {
      // Row already exists — update it
      pagosSheet.getRange(targetSheetRow, 1, 1, 7).setValues([newRow]);
    } else if (blockPagoFinalRow > 0) {
      // Participant found but this tipo has no row yet — insert before Pago Final
      pagosSheet.insertRowsBefore(blockPagoFinalRow, 1);
      pagosSheet.getRange(blockPagoFinalRow, 1, 1, 7).setValues([newRow]);
    } else {
      // Participant not in sheet at all — insert before summary row
      var tiposValidos = { 'reserva': true, 'tiquete': true, 'pago final': true };
      var lastDataRow = startRow - 1;
      for (var k = 0; k < allData.length; k++) {
        var gv = String(allData[k][6] || '').trim().toLowerCase();
        if (tiposValidos[gv]) lastDataRow = startRow + k;
      }
      var insertRow = lastDataRow + 1;
      pagosSheet.insertRowsBefore(insertRow, 1);
      pagosSheet.getRange(insertRow, 1, 1, 7).setValues([newRow]);
    }

    return sendResponse(200, { ok: true, mode: targetSheetRow > 0 ? 'updated' : 'appended' });
  } catch (err) {
    Logger.log('registrarPago error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// ───── SINCRONIZAR PARTICIPANTES (inscripción → Pagos) ────────────────────────
function sincronizarParticipantes() {
  try {
    var mainSheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var mainData = mainSheet.getDataRange().getValues();
    var headers = mainData[0] || [];
    var nombreCol = 1, tiqueteCol = 13;
    for (var j = 0; j < headers.length; j++) {
      var h = String(headers[j]).toLowerCase();
      if ((h === 'nombre' || h.includes('nombre')) && h.indexOf('acudiente') < 0) nombreCol = j;
      if (h.includes('tiquete') || h.includes('vuelo')) tiqueteCol = j;
    }

    var ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return sendResponse(404, { ok: false, error: 'Hoja Pagos no encontrada' });

    var lastRow = pagosSheet.getLastRow();
    var existingNames = {};
    if (lastRow >= 6) {
      var existingData = pagosSheet.getRange(6, 1, lastRow - 5, 1).getValues();
      existingData.forEach(function(row) {
        var n = String(row[0] || '').trim().toLowerCase();
        if (n) existingNames[n] = true;
      });
    }

    // Find insert point: last row with a known tipo (Reserva/Tiquete/Pago Final) in col G
    // Ignores summary row and any other non-participant content below
    var insertRow = 6;
    if (lastRow >= 6) {
      var colGData = pagosSheet.getRange(6, 7, lastRow - 5, 1).getValues();
      var lastGRow = 5;
      var tiposValidos2 = { 'reserva': true, 'tiquete': true, 'pago final': true };
      for (var k = 0; k < colGData.length; k++) {
        var gv2 = String(colGData[k][0] || '').trim().toLowerCase();
        if (tiposValidos2[gv2]) lastGRow = 6 + k;
      }
      insertRow = lastGRow + 1;
    }

    // Build all new participant rows, then insert in a single batch
    var newRows = [];
    var added = 0;
    for (var i = 1; i < mainData.length; i++) {
      var nombre = String(mainData[i][nombreCol] || '').trim();
      if (!nombre || existingNames[nombre.toLowerCase()]) continue;
      var tieneTiquete = String(mainData[i][tiqueteCol] || '').toLowerCase().indexOf('con') >= 0;
      newRows.push([nombre, '', '', 0, 'Pendiente', '', 'Reserva']);
      if (tieneTiquete) newRows.push(['', '', '', 0, '', '', 'Tiquete']);
      newRows.push(['', '', '', 0, '', '', 'Pago Final']);
      existingNames[nombre.toLowerCase()] = true;
      added++;
    }
    if (newRows.length > 0) {
      pagosSheet.insertRowsBefore(insertRow, newRows.length);
      pagosSheet.getRange(insertRow, 1, newRows.length, 7).setValues(newRows);
    }
    return sendResponse(200, { ok: true, added: added });
  } catch (err) {
    Logger.log('sincronizarParticipantes error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// ───── ADMIN ACCESO ────────────────────────────────────────────────────────────

function getAdminAccesoSheet(create) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('AdminAcceso');
  if (!sheet && create) {
    sheet = ss.insertSheet('AdminAcceso');
    sheet.getRange(1, 1, 1, 3).setValues([['email', 'rol', 'nombre']]);
  }
  return sheet;
}

function getAdminAcceso() {
  try {
    const sheet = getAdminAccesoSheet(false);
    if (!sheet) return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
    const result = data.slice(1).filter(function(r){ return r[0]; }).map(function(r){
      return { email: String(r[0]).toLowerCase().trim(), rol: String(r[1]||'ver').toLowerCase().trim(), nombre: String(r[2]||'') };
    });
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function checkAdminAcceso(email) {
  try {
    const emailNorm = email.toString().toLowerCase().trim();
    const sheet = getAdminAccesoSheet(false);
    if (!sheet) return ContentService.createTextOutput(JSON.stringify({ found: false })).setMimeType(ContentService.MimeType.JSON);
    const data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase().trim() === emailNorm) {
        return ContentService.createTextOutput(JSON.stringify({ found: true, rol: String(data[i][1]||'ver') })).setMimeType(ContentService.MimeType.JSON);
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ found: false })).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ found: false, error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function guardarAdminAcceso(data) {
  try {
    const sheet = getAdminAccesoSheet(true);
    const accion = data.accion || 'add';
    const emailTarget = (data.email || '').toString().toLowerCase().trim();
    if (!emailTarget) return sendResponse(400, { ok: false, error: 'email requerido' });
    const vals = sheet.getDataRange().getValues();
    var rowIdx = -1;
    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][0]).toLowerCase().trim() === emailTarget) { rowIdx = i + 1; break; }
    }
    if (accion === 'remove') {
      if (rowIdx > 0) sheet.deleteRow(rowIdx);
    } else if (accion === 'update' && rowIdx > 0) {
      sheet.getRange(rowIdx, 2).setValue(data.rol || 'ver');
    } else if (accion === 'add') {
      if (rowIdx < 0) {
        sheet.appendRow([emailTarget, data.rol || 'ver', data.nombre || '']);
      } else {
        sheet.getRange(rowIdx, 2).setValue(data.rol || 'ver');
        if (data.nombre) sheet.getRange(rowIdx, 3).setValue(data.nombre);
      }
    }
    return sendResponse(200, { ok: true });
  } catch(err) {
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function subirFotoDrive(data) {
  try {
    if (!data.base64 || !data.fileName) return sendResponse(400, { ok: false, error: 'base64 y fileName requeridos' });
    const mime = data.mimeType || getMimeType(data.fileName);
    const blob = Utilities.newBlob(Utilities.base64Decode(data.base64), mime, data.fileName);
    const folder = DriveApp.getFolderById(FOTOS_FOLDER_ID);
    const file = folder.createFile(blob);
    file.setName(data.fileName);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return sendResponse(200, { ok: true, url: file.getUrl(), id: file.getId() });
  } catch (err) {
    Logger.log('subirFotoDrive error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function eliminarFotoDrive(data) {
  try {
    if (!data.fileId) return sendResponse(400, { ok: false, error: 'fileId requerido' });
    const file = DriveApp.getFileById(data.fileId);
    file.setTrashed(true);
    return sendResponse(200, { ok: true });
  } catch (err) {
    Logger.log('eliminarFotoDrive error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}
