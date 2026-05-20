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

// ───── GET HANDLER (fotos, saber, comunicaciones) ──────────────────────────────
function doGet(e) {
  const params = e.parameter || {};
  const action = params.action || '';
  Logger.log('doGet action=' + action + ' params=' + JSON.stringify(params));
  try {
    if (action === 'fotos') return listFiles(FOTOS_FOLDER_ID, 'image');
    if (action === 'saber') return listFiles(SABER_FOLDER_ID, 'all');
    if (action === 'comunicaciones') return getComunicaciones();
    if (action === 'buscar') return buscarParticipantes(params.email || '');
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
    .map(r => ({ fecha: String(r[0]), titulo: String(r[1] || ''), mensaje: String(r[2] || '') }));
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
    const htmlBody = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">'
      + '<div style="background:#1e5ba8;padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">'
      + '<table cellpadding="0" cellspacing="0" style="margin:0 auto 12px auto">'
      + '<tr>'
      + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1USK2ut3e0f1VwBbQ8uNqVSD517KtdZZQ" alt="Real Madrid Foundation" height="48" style="display:block;height:48px;width:auto"></td>'
      + '<td style="vertical-align:middle;padding:0 14px"><div style="width:1px;height:36px;background:rgba(255,255,255,0.45)"></div></td>'
      + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1XfpwTY8c5GDI4ssInLnIKxJ37UOPKKmO" alt="Fundacion Revel" height="48" style="display:block;height:48px;width:auto"></td>'
      + '</tr>'
      + '</table>'
      + '<h2 style="color:#fff;margin:0;font-size:18px">Real Madrid Foundation Clinic 2026</h2></div>'
      + '<div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">'
      + '<p style="color:#334155;margin-top:0">Tienes un nuevo comunicado del equipo Revel:</p>'
      + '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:16px 0">'
      + '<p style="font-size:12px;color:#94a3b8;margin:0 0 4px">' + fecha + '</p>'
      + '<h3 style="color:#1e3a5f;margin:0 0 12px;font-size:16px">' + titulo + '</h3>'
      + '<p style="color:#334155;margin:0;line-height:1.6;white-space:pre-wrap">' + preview + '</p></div>'
      + '<a href="' + link + '" style="display:inline-block;background:#1e5ba8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:4px">Ver mensaje completo en tu área personal →</a>'
      + '<p style="color:#94a3b8;font-size:12px;margin-top:20px">Equipo Revel · Real Madrid Foundation Clinic 2026</p></div></div>';

    const adminEmail = 'alejandro.cabrera@fundacionrevel.net';
    emails.forEach(function(em) {
      try { GmailApp.sendEmail(em, subject, 'Tienes un nuevo comunicado: ' + link, { htmlBody: htmlBody, replyTo: adminEmail, name: 'Real Madrid Foundation Clinic' }); }
      catch(err) { Logger.log('Error enviando a ' + em + ': ' + err); }
    });

    // Email al admin
    const adminHtml = htmlBody;
    GmailApp.sendEmail(adminEmail, '[Admin] Comunicado enviado — ' + titulo, '', { htmlBody: adminHtml, name: 'Real Madrid Foundation Clinic' });

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
