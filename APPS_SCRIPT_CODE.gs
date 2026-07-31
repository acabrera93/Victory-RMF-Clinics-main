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

const ADMIN_EMAILS_LIST = ['alejandro.cabrera@fundacionrevel.net','presidente@fundacionrevel.net','andres.dewasseige@fundacionrevel.net'];

function getAnthropicApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('anthropic_api_key') || '';
}

// Ejecutar UNA VEZ desde el editor de Apps Script para guardar la key (nunca en el código):
function configurarAnthropicApiKey() {
  PropertiesService.getScriptProperties().setProperty('anthropic_api_key', 'sk-ant-...PEGAR_AQUI...');
}

// Contraseña inicial leída desde PropertiesService (nunca en código).
// Configurar ejecutando configurarContraseniaInicial() UNA VEZ desde el editor de Apps Script.
function getDefaultPassword() {
  return PropertiesService.getScriptProperties().getProperty('default_password') || '';
}

// ───── TOKENS DE SESIÓN (firmados con HMAC, sin estado en servidor) ────────────
// El panel admin/comercial no tiene sesiones de servidor: en su lugar, tras validar
// la contraseña se emite un token firmado (email+rol+expiración) que el cliente debe
// reenviar en cada acción sensible. Sin un token válido con el rol requerido, el
// backend rechaza la acción — así una llamada directa al endpoint sin pasar por el
// login no puede leer ni modificar datos de participantes.
function getTokenSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('token_secret');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('token_secret', secret);
  }
  return secret;
}

function generarSesionToken(email, rol) {
  const payload = JSON.stringify({
    email: String(email || '').toLowerCase().trim(),
    rol: rol,
    exp: Date.now() + 12 * 3600000 // 12 horas
  });
  const payloadB64 = Utilities.base64EncodeWebSafe(payload);
  const sig = Utilities.computeHmacSha256Signature(payloadB64, getTokenSecret_());
  const sigB64 = Utilities.base64EncodeWebSafe(sig);
  return payloadB64 + '.' + sigB64;
}

function verificarSesionToken(token) {
  try {
    if (!token || token.indexOf('.') < 0) return null;
    const parts = token.split('.');
    const payloadB64 = parts[0], sigB64 = parts[1];
    const expectedSigB64 = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payloadB64, getTokenSecret_()));
    if (expectedSigB64 !== sigB64) return null; // firma inválida o token manipulado
    const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadB64)).getDataAsString());
    if (!payload.exp || Date.now() > payload.exp) return null; // expirado
    return payload; // { email, rol, exp }
  } catch (err) {
    return null;
  }
}

// Resuelve el rol de administrador de un email: 'superadmin' (ADMIN_EMAILS_LIST),
// 'editor'/'viewer' (hoja AdminAcceso), o null si no tiene acceso registrado.
function resolverRolAdmin(email) {
  const emailNorm = String(email || '').toLowerCase().trim();
  if (!emailNorm) return null;
  if (ADMIN_EMAILS_LIST.map(function(e) { return e.toLowerCase(); }).indexOf(emailNorm) >= 0) return 'superadmin';
  try {
    const sheet = getAdminAccesoSheet(false);
    if (!sheet) return null;
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase().trim() === emailNorm) {
        const rol = String(data[i][1] || 'ver').toLowerCase().trim();
        return rol === 'editar' ? 'editor' : 'viewer';
      }
    }
  } catch (_) {}
  return null;
}

// Verifica que `data.token` sea válido y que su rol esté en `rolesPermitidos`.
// Devuelve el payload {email, rol} si es válido, o null si no autorizado.
function autorizar(data, rolesPermitidos) {
  const payload = verificarSesionToken((data && data.token) || '');
  if (!payload) return null;
  if (rolesPermitidos && rolesPermitidos.indexOf(payload.rol) < 0) return null;
  return payload;
}

// ───── HASH DE CONTRASEÑAS (SHA-256 + salt, sin dependencias externas) ─────────
// Las contraseñas de admin/comercial se guardaban en texto plano en
// PropertiesService/Sheets — cualquiera con acceso de editor al proyecto o al
// Sheet las veía directamente. A partir de ahora se guarda solo el hash; el
// texto plano legado se admite en lectura (passwordMatches_) y se re-hashea
// automáticamente la próxima vez que ese usuario cambie o valide su contraseña.
function getPasswordSalt_() {
  const props = PropertiesService.getScriptProperties();
  let salt = props.getProperty('password_salt');
  if (!salt) {
    salt = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('password_salt', salt);
  }
  return salt;
}

function hashPassword_(password) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password || '') + getPasswordSalt_());
  return bytes.map(function(b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

// Compara `plain` contra `stored`, que puede ser un hash (64 hex chars) o,
// para cuentas aún no migradas, el texto plano histórico.
function passwordMatches_(plain, stored) {
  if (!stored) return false;
  if (/^[0-9a-f]{64}$/i.test(stored)) return hashPassword_(plain) === stored;
  return String(plain == null ? '' : plain) === stored;
}

// ── Ejecutar UNA VEZ para conectar tasa EUR→COP al promedio real de pagos ─────
// 1. Selecciona esta función y pulsa ▶ Run
// 2. Escribe la fórmula en Dashboard!F6 del sheet de presupuesto
// 3. En las demás celdas que muestran "1 EUR = X COP", cámbialas por: =Dashboard!F6
function configurarTasaSheet() {
  var ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
  var dashSheet = getSheetCI(ss, 'Dashboard');
  if (!dashSheet) throw new Error('No se encontró la hoja "Dashboard" en el sheet de presupuesto.');
  // Fórmula: promedio de COP/EUR de todos los pagos con ambos valores (cols D y E de Pagos, fila 6 en adelante)
  dashSheet.getRange('F6').setFormula(
    '=IFERROR(ROUND(AVERAGE(ARRAYFORMULA(IF((Pagos!D6:D2000>0)*(Pagos!E6:E2000>0),Pagos!D6:D2000/Pagos!E6:E2000))),0),4350)'
  );
  // Etiqueta en F5 para identificar la celda
  dashSheet.getRange('F5').setValue('Tasa EUR/COP (media pagos)');
  Logger.log('Fórmula de tasa EUR→COP escrita en Dashboard!F6. Referencia esa celda desde las demás hojas con =Dashboard!F6');
}

// ── Ejecutar UNA VEZ desde el editor para establecer la contraseña inicial ────
// 1. Cambia el valor de 'nuevaContrasenia' por la contraseña que quieras usar
// 2. Selecciona esta función y pulsa ▶ Run
// 3. Borra o comenta el valor antes de hacer commit
function configurarContraseniaInicial() {
  const nuevaContrasenia = 'CAMBIAR_ANTES_DE_EJECUTAR';
  if (!nuevaContrasenia || nuevaContrasenia === 'CAMBIAR_ANTES_DE_EJECUTAR')
    throw new Error('Escribe la contraseña real antes de ejecutar esta función.');
  PropertiesService.getScriptProperties().setProperty('default_password', nuevaContrasenia);
  Logger.log('Contraseña inicial guardada en PropertiesService.');
}
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
    if (action === 'comercial_login') return getComercialData(params.email || '');
    if (action === 'buscar') return buscarParticipantes(params.email || '');
    if (action === 'mis_pagos') return getMisPagos(params.nombre || '');
    if (action === 'admin_participantes') return getAdminParticipantes(params);
    if (action === 'admin_financiero') return getAdminFinanciero(params);
    if (action === 'admin_categorias') return getAdminCategorias(params);
    if (action === 'admin_acceso') return getAdminAcceso(params);
    if (action === 'admin_acceso_check') return checkAdminAcceso(params.email || '');
    if (action === 'verify_reset_token') {
      const token = params.token || '';
      const isAdmin = (params.type || '') === 'admin';
      if (!token) return ContentService.createTextOutput(JSON.stringify({ valid: false })).setMimeType(ContentService.MimeType.JSON);
      try {
        const props = PropertiesService.getScriptProperties();
        const propKey = isAdmin ? ('reset_admin_' + token) : ('reset_' + token);
        const val = props.getProperty(propKey);
        if (!val) return ContentService.createTextOutput(JSON.stringify({ valid: false })).setMimeType(ContentService.MimeType.JSON);
        const parts = val.split('|');
        if (Date.now() > parseInt(parts[1])) {
          props.deleteProperty(propKey);
          return ContentService.createTextOutput(JSON.stringify({ valid: false, reason: 'expired' })).setMimeType(ContentService.MimeType.JSON);
        }
        return ContentService.createTextOutput(JSON.stringify({ valid: true, email: parts[0], type: isAdmin ? 'admin' : 'comercial' })).setMimeType(ContentService.MimeType.JSON);
      } catch(e2) {
        return ContentService.createTextOutput(JSON.stringify({ valid: false })).setMimeType(ContentService.MimeType.JSON);
      }
    }
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
      // Incluir paso_actual (col U = índice 20) aunque no tenga cabecera
      if (!participant['paso_actual']) {
        const pv = data[i][20];
        if (pv != null && pv !== '') participant['paso_actual'] = String(pv);
      }
      participants.push(participant);
    }

    Logger.log('buscarParticipantes: encontrados=' + participants.length);
    if (participants.length > 0) notificarAccesoAreaPersonal(emailNorm, participants);
    return ContentService.createTextOutput(JSON.stringify(participants))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('buscarParticipantes error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ _debug: true, catch_error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Devuelve al propio participante (por nombre, sin token — mismo nivel de
// exposición que buscarParticipantes) el estado real de sus pagos de Reserva/
// Tiquete/Pago Final según quedaron registrados en la hoja Pagos. Se usa para
// que el área personal muestre "lo que efectivamente pagó" solo cuando el
// admin ya validó el pago (estado Completo o Parcial) — mientras esté
// "Pendiente de confirmar", el frontend sigue mostrando su propio cálculo.
function getMisPagos(nombre) {
  try {
    const nombreNorm = String(nombre || '').toLowerCase().trim();
    if (!nombreNorm) return ContentService.createTextOutput(JSON.stringify({})).setMimeType(ContentService.MimeType.JSON);

    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return ContentService.createTextOutput(JSON.stringify({})).setMimeType(ContentService.MimeType.JSON);

    const startRow = 6;
    const lastRow = pagosSheet.getLastRow();
    const numRows = lastRow - startRow + 1;
    const allData = numRows > 0 ? pagosSheet.getRange(startRow, 1, numRows, 8).getValues() : [];

    const conceptoKey = { 'reserva': 'reserva', 'tiquete': 'tiquete', 'pago final': 'final' };
    let inBlock = false;
    const resultado = {};

    for (let i = 0; i < allData.length; i++) {
      const cellB = String(allData[i][1] || '').trim(); // col B = nombre
      const cellH = String(allData[i][7] || '').trim(); // col H = concepto

      if (cellB) {
        if (cellB.toLowerCase() === nombreNorm) { inBlock = true; }
        else if (inBlock) { break; }
      }

      if (inBlock) {
        const key = conceptoKey[cellH.toLowerCase()];
        if (key) {
          resultado[key] = {
            estado: String(allData[i][5] || '').trim(), // col F = estado
            eur: parseFloat(allData[i][4]) || 0,        // col E = eur
            cop: parseFloat(allData[i][3]) || 0         // col D = cop
          };
        }
      }
    }

    return ContentService.createTextOutput(JSON.stringify(resultado)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('getMisPagos error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({})).setMimeType(ContentService.MimeType.JSON);
  }
}

// ───── NOTIFICAR ACCESO AL ÁREA PERSONAL ───────────────────────────────────────
function notificarAccesoAreaPersonal(email, participants) {
  try {
    const nombres = participants.map(function(p) {
      for (const k in p) { if (String(k).toLowerCase().trim() === 'nombre') return p[k]; }
      return '';
    }).filter(function(n) { return n; });
    const quien = nombres.length ? (nombres.join(' + ') + ' (' + email + ')') : email;
    const fecha = Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy HH:mm');
    GmailApp.sendEmail('alejandro.cabrera@fundacionrevel.net', '[Área Personal] Acceso — ' + (nombres[0] || email),
      quien + ' entró a su área personal.\n\nFecha: ' + fecha, { name: 'Real Madrid Foundation Clinic' });
  } catch (err) {
    Logger.log('notificarAccesoAreaPersonal error: ' + err);
  }
}

// ───── NOTIFICAR SELECCIÓN DE MÉTODO DE PAGO (tarjeta/Bold o transferencia) ────
function notificarClickBold(data) {
  try {
    const email = String(data.email || '').trim();
    const nombre = String(data.nombre || '').trim();
    const panelLabels = { reserva: 'Reserva', tiquete: 'Tiquete aéreo', final: 'Pago Final' };
    const panelLabel = panelLabels[String(data.panel || '').trim()] || String(data.panel || 'Pago');
    const esTarjeta = String(data.tipo || '').trim() === 'tc';
    const metodoLabel = esTarjeta ? 'Tarjeta (Bold)' : 'Transferencia bancaria';
    const monto = String(data.monto || '').trim();
    const quien = nombre ? (nombre + ' (' + email + ')') : email;
    const fecha = Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy HH:mm');
    const subject = '[Área Personal] Seleccionó método de pago — ' + (nombre || email) + ' · ' + panelLabel;
    const body = quien + ' seleccionó pagar por "' + metodoLabel + '" para ' + panelLabel + '.\n\n' +
      'Monto mostrado: ' + (monto || 'no disponible') + '\n' +
      'Fecha: ' + fecha;
    GmailApp.sendEmail('alejandro.cabrera@fundacionrevel.net', subject, body, { name: 'Real Madrid Foundation Clinic' });
    return sendResponse(200, { ok: true });
  } catch (err) {
    Logger.log('notificarClickBold error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
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
    // Ensure publicly accessible regardless of how the file was uploaded
    try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(_) {}
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
    const headers = data[0] || [];
    let emailCol = -1, pasoCol = -1;
    for (let j = 0; j < headers.length; j++) {
      const h = String(headers[j]).toLowerCase().trim();
      if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico' || h === 'e-mail') emailCol = j;
      if (h === 'paso_actual' || h === 'paso actual') pasoCol = j;
    }
    if (emailCol < 0) emailCol = 3;  // Fallback: Columna D (índice 0)
    if (pasoCol < 0) pasoCol = 20;   // Fallback: Columna U (índice 0)
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
        if (parsed.action === 'notificar_click_bold') return notificarClickBold(parsed);
        if (parsed.action === 'marcar_comprobante_pendiente') return marcarComprobanteSubido(parsed);
        if (parsed.action === 'publicar_comunicado') return publicarComunicado(parsed);
        if (parsed.action === 'eliminar_comunicado') return eliminarComunicado(parsed);
        if (parsed.action === 'actualizar_participante') return actualizarParticipante(parsed);
        if (parsed.action === 'registrar_pago') return registrarPago(parsed);
        if (parsed.action === 'sincronizar_participantes') return sincronizarParticipantes(parsed);
        if (parsed.action === 'admin_acceso_guardar') return guardarAdminAcceso(parsed);
        if (parsed.action === 'guardar_comercial') return guardarComercial(parsed);
        if (parsed.action === 'check_admin_password') return checkAdminPassword(parsed);
        if (parsed.action === 'set_admin_password') return setAdminPassword(parsed);
        if (parsed.action === 'forgot_admin_password') return forgotAdminPassword(parsed);
        if (parsed.action === 'check_comercial_password') return checkComercialPassword(parsed);
        if (parsed.action === 'set_comercial_password') return setComercialPassword(parsed);
        if (parsed.action === 'forgot_comercial_password') return forgotComercialPassword(parsed);
        if (parsed.action === 'subir_foto_drive') return subirFotoDrive(parsed);
        if (parsed.action === 'eliminar_foto_drive') return eliminarFotoDrive(parsed);
        if (parsed.action === 'agregar_participante') return agregarParticipante(parsed);
        if (parsed.action === 'contacto_institucional') return contactoInstitucional(parsed);
        if (parsed.base64 || parsed.email) return handleJsonUpload(e);
      } catch (_) {}
    }

    return sendResponse(400, { ok: false, error: 'No se pudo procesar la solicitud' });
  } catch (err) {
    Logger.log('Error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// Confirma que el email corresponda a un participante real de la hoja principal
// antes de crear/compartir carpetas de Drive o escribir en Documentos — evita que
// cualquiera suba archivos a la carpeta de otra persona con solo saber su email.
function emailEsParticipante_(email) {
  const emailNorm = String(email || '').toLowerCase().trim();
  if (!emailNorm) return false;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const headers = data[0] || [];
  let emailCol = -1;
  for (let j = 0; j < headers.length; j++) {
    const h = String(headers[j]).toLowerCase().trim();
    if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico' || h === 'e-mail') { emailCol = j; break; }
  }
  if (emailCol < 0) emailCol = 3;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][emailCol] || '').toLowerCase().trim() === emailNorm) return true;
  }
  return false;
}

// Busca el email de un participante por nombre exacto en la hoja principal
// (misma lógica de columnas que emailEsParticipante_, pero devuelve el email
// en vez de un booleano). Usada para notificar confirmación de pago.
function buscarEmailPorNombre_(nombre) {
  const nombreNorm = String(nombre || '').toLowerCase().trim();
  if (!nombreNorm) return '';
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const headers = data[0] || [];
  let emailCol = -1, nombreCol = -1;
  for (let j = 0; j < headers.length; j++) {
    const h = String(headers[j]).toLowerCase().trim();
    if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico' || h === 'e-mail') emailCol = j;
    if ((h === 'nombre' || h.includes('nombre')) && h.indexOf('acudiente') < 0 && nombreCol < 0) nombreCol = j;
  }
  if (emailCol < 0 || nombreCol < 0) return '';
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][nombreCol] || '').toLowerCase().trim() === nombreNorm) {
      return String(data[i][emailCol] || '').trim();
    }
  }
  return '';
}

// Envía al participante la confirmación de que su pago quedó registrado.
// `estado` determina el texto y color: "Completo" = verde/confirmado,
// "Parcial" = ámbar/abono (sin mencionar cuánto falta por pagar, ese dato
// no siempre es fijo y no queremos arriesgarnos a mostrar un número incorrecto).
// Se llama en CADA registro desde registrarPago(), incluyendo abonos repetidos
// al mismo concepto — cada uno deja su propio correo como comprobante.
function notificarPagoConfirmado(nombre, tipo, eur, cop, estado) {
  try {
    const email = buscarEmailPorNombre_(nombre);
    if (!email) {
      Logger.log('notificarPagoConfirmado: no se encontró email para ' + nombre);
      return;
    }
    const esCompleto = String(estado || '').toLowerCase().trim() === 'completo';
    const tipoLabels = { 'reserva': 'la Reserva', 'tiquete': 'el Tiquete Aéreo', 'pago final': 'el Pago Final' };
    const tipoLabel = tipoLabels[String(tipo || '').toLowerCase().trim()] || tipo;
    const montoTexto = (cop > 0 ? '$' + Math.round(cop).toLocaleString('es-CO') + ' COP' : '')
      + (cop > 0 && eur > 0 ? ' · ' : '')
      + (eur > 0 ? eur.toLocaleString('es-CO') + ' €' : '');
    const link = 'https://victory-rmf-clinics.netlify.app/areapersonal.html';
    const colorHeader = esCompleto ? '#166534' : '#854f0b';
    const colorMonto  = esCompleto ? '#166534' : '#854f0b';
    const tituloHeader = esCompleto ? 'Pago confirmado' : 'Abono registrado';
    const montoLabel = esCompleto ? 'Monto confirmado' : 'Abono recibido';
    const cuerpoTexto = esCompleto
      ? 'Confirmamos que tu pago correspondiente a <strong>' + tipoLabel + '</strong> ha sido registrado correctamente.'
      : 'Registramos un abono a cuenta de <strong>' + tipoLabel + '</strong>. Este pago queda guardado en tu historial de pagos.';
    const subject = (esCompleto ? '✅ Pago confirmado — ' : '💰 Abono registrado — ') + tipoLabel + ' · RMF Clinic 2026';
    const htmlBody = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">'
      + '<div style="background:' + colorHeader + ';padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">'
      + '<table cellpadding="0" cellspacing="0" style="margin:0 auto 12px auto"><tr>'
      + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1USK2ut3e0f1VwBbQ8uNqVSD517KtdZZQ" alt="Real Madrid Foundation" height="48" style="display:block;height:48px;width:auto"></td>'
      + '<td style="vertical-align:middle;padding:0 14px"><div style="width:1px;height:36px;background:rgba(255,255,255,0.45)"></div></td>'
      + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1XfpwTY8c5GDI4ssInLnIKxJ37UOPKKmO" alt="Fundacion Revel" height="40" style="display:block;height:40px;width:auto"></td>'
      + '</tr></table>'
      + '<h2 style="color:#fff;margin:0 0 4px;font-size:18px">Real Madrid Foundation Clinic 2026</h2>'
      + '<p style="color:rgba(255,255,255,.85);margin:0;font-size:13px;font-weight:600">' + tituloHeader + '</p></div>'
      + '<div style="background:#f8fafc;padding:28px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">'
      + '<p style="color:#334155;margin-top:0">Hola ' + nombre + ',</p>'
      + '<p style="color:#334155">' + cuerpoTexto + '</p>'
      + '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin:18px 0">'
      + '<p style="font-size:12px;color:#94a3b8;margin:0 0 4px">' + montoLabel + '</p>'
      + '<p style="font-size:18px;color:' + colorMonto + ';font-weight:600;margin:0">' + montoTexto + '</p></div>'
      + '<a href="' + link + '" style="display:inline-block;background:#1e5ba8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Ver mi área personal →</a>'
      + '<p style="color:#94a3b8;font-size:12px;margin-top:20px">Si tienes dudas, escríbenos por WhatsApp o al correo alejandro.cabrera@fundacionrevel.net.</p>'
      + '<p style="color:#94a3b8;font-size:12px">Equipo Revel · Real Madrid Foundation Clinic 2026</p></div></div>';
    GmailApp.sendEmail(email, subject, (esCompleto ? 'Tu pago' : 'Tu abono') + ' de ' + tipoLabel + ' ha sido registrado: ' + link, {
      htmlBody: htmlBody,
      replyTo: 'alejandro.cabrera@fundacionrevel.net',
      name: 'Real Madrid Foundation Clinic'
    });
  } catch (err) {
    Logger.log('notificarPagoConfirmado error: ' + err);
  }
}

// ───── HANDLE MULTIPART (archivos reales) ──────────────────────────────────────
function handleMultipartUpload(e) {
  const params = e.parameter || {};
  const email = (params.email || '').toLowerCase().trim();
  const tipo_documento = params.tipo_documento || 'otro';
  const tipo_pago = params.tipo_pago || '';

  if (!email) {
    return sendResponse(400, { ok: false, error: 'Email requerido' });
  }
  if (!emailEsParticipante_(email)) {
    return sendResponse(403, { ok: false, error: 'Email no encontrado entre los participantes registrados' });
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
    } catch (shareErr) {
      Logger.log('No se pudo compartir con el usuario: ' + shareErr);
    }

    const fileUrl = file.getUrl();
    const fileId = file.getId();

    // Actualizar Sheets
    updateSheetWithUpload(email, tipo_documento, tipo_pago, fileName, fileUrl, fileId);
    notificarDocumentoSubido(email, tipo_documento, tipo_pago, fileName, fileUrl);

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

    if (!email || !base64Data) {
      return sendResponse(400, { ok: false, error: 'Email y base64 requeridos' });
    }
    if (!emailEsParticipante_(email)) {
      return sendResponse(403, { ok: false, error: 'Email no encontrado entre los participantes registrados' });
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
    notificarDocumentoSubido(email, tipo_documento, tipo_pago, finalFileName, fileUrl);

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

// ───── NOTIFICAR SUBIDA DE DOCUMENTO ───────────────────────────────────────────
function notificarDocumentoSubido(email, tipoDoc, tipoPago, fileName, fileUrl) {
  try {
    var notifyEmail = 'alejandro.cabrera@fundacionrevel.net';

    // Buscar nombre del participante en la hoja principal
    var nombre = '';
    try {
      var mainSheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
      var mainData = mainSheet.getDataRange().getValues();
      var headers = mainData[0] || [];
      var emailCol = -1, nombreCol = -1;
      for (var j = 0; j < headers.length; j++) {
        var h = String(headers[j]).toLowerCase();
        if (h === 'email' && emailCol < 0) emailCol = j;
        if ((h === 'nombre' || h.includes('nombre')) && h.indexOf('acudiente') < 0 && nombreCol < 0) nombreCol = j;
      }
      if (emailCol >= 0) {
        for (var i = 1; i < mainData.length; i++) {
          if (String(mainData[i][emailCol] || '').toLowerCase().trim() === email) {
            nombre = nombreCol >= 0 ? String(mainData[i][nombreCol] || '') : '';
            break;
          }
        }
      }
    } catch (lookupErr) {
      Logger.log('notificarDocumentoSubido lookup error: ' + lookupErr);
    }

    var quien = nombre ? (nombre + ' (' + email + ')') : email;
    var tipoDescripcion = tipoPago
      ? 'comprobante de pago (' + tipoPago + ')'
      : 'documento (' + tipoDoc + ')';

    var subject = '[Área Personal] Nuevo documento subido — ' + (nombre || email);
    var body = quien + ' ha subido un ' + tipoDescripcion + ':\n\n' +
      'Archivo: ' + fileName + '\n' +
      'Enlace: ' + fileUrl;

    GmailApp.sendEmail(notifyEmail, subject, body, { name: 'Real Madrid Foundation Clinic' });
  } catch (err) {
    Logger.log('notificarDocumentoSubido error: ' + err);
  }
}

// ───── ACTUALIZAR SHEETS ───────────────────────────────────────────────────────
function updateSheetWithUpload(email, tipoDoc, tipoPago, fileName, fileUrl, fileId) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Documentos');
    if (!sheet) return; // Si no existe la hoja, no falla

    const data = sheet.getDataRange().getValues();
    const headers = data[0] || [];

    // Buscar columna de email por nombre de cabecera (fallback a columna A si no se encuentra)
    let emailColDocs = -1;
    for (let j = 0; j < headers.length; j++) {
      const h = String(headers[j]).toLowerCase().trim();
      if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico' || h === 'e-mail') { emailColDocs = j; break; }
    }
    if (emailColDocs < 0) emailColDocs = 0;

    // Buscar email en la hoja
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][emailColDocs] || '').toLowerCase().trim() === email) {
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

      // Solo para documentos de identidad (pasaporte/permiso/registro_civil), no
      // comprobantes de pago: recalcular y escribir el contador "X/Y" en Inscripciones.
      if (!tipoPago) {
        const rowValues = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
        const requeridos = getDocumentosRequeridos(email);
        const colsRequeridas = requeridos === 3
          ? ['doc_pasaporte', 'doc_permiso', 'doc_registro_civil']
          : ['doc_pasaporte'];
        let subidos = 0;
        colsRequeridas.forEach(function (cn) {
          const idx = headers.indexOf(cn);
          if (idx >= 0 && rowValues[idx] !== '' && rowValues[idx] !== null) subidos++;
        });
        actualizarContadorDocumentos(email, subidos, requeridos);
      }
    } else {
      Logger.log('updateSheetWithUpload: email no encontrado en la hoja Documentos: ' + email);
    }
  } catch (err) {
    Logger.log('Sheet update error: ' + err);
  }
}

// ───── DOCUMENTOS REQUERIDOS POR PARTICIPANTE ──────────────────────────────────
// Regla: se requieren 3 documentos (pasaporte + permiso de salida + registro
// civil) solo si el participante tiene tiquete aéreo Y además es menor de edad
// (edad de referencia al 2 de octubre de 2026, inicio del programa — misma
// fórmula que calcEdadRef/parseFechaNacimiento, ya usadas en getAdminCategorias).
// En cualquier otro caso (sin tiquete, o mayor de edad) solo se requiere 1
// (pasaporte).
function getDocumentosRequeridos(email) {
  try {
    const emailNorm = String(email || '').toLowerCase().trim();
    if (!emailNorm) return 1;
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    const headers = data[0] || [];
    let emailCol = -1, tiqueteCol = -1, fechaCol = -1;
    for (let j = 0; j < headers.length; j++) {
      const h = String(headers[j]).toLowerCase().trim();
      if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico' || h === 'e-mail') emailCol = j;
      if (h === 'tiquete aereo' || h === 'tiquete aéreo') tiqueteCol = j;
      if (h.indexOf('fecha') >= 0 && h.indexOf('nac') >= 0) fechaCol = j;
    }
    if (emailCol < 0) { Logger.log('getDocumentosRequeridos: columna Email no encontrada'); return 1; }

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][emailCol] || '').toLowerCase().trim() === emailNorm) {
        const tieneTiquete = tiqueteCol >= 0 && String(data[i][tiqueteCol] || '').toLowerCase().indexOf('con') >= 0;
        const fechaObj = fechaCol >= 0 ? parseFechaNacimiento(data[i][fechaCol]) : null;
        const edad = calcEdadRef(fechaObj);
        const esMenor = edad !== null && edad < 18;
        return (tieneTiquete && esMenor) ? 3 : 1;
      }
    }
    Logger.log('getDocumentosRequeridos: email no encontrado en Inscripciones: ' + email);
    return 1;
  } catch (err) {
    Logger.log('getDocumentosRequeridos error: ' + err);
    return 1;
  }
}

// ───── ACTUALIZAR CONTADOR "X/Y" EN INSCRIPCIONES ──────────────────────────────
// Escribe en la columna "Documentos" (Inscripciones) el texto "X/Y": X = cuántos
// de los documentos requeridos ya fueron subidos, Y = total requerido (ver
// getDocumentosRequeridos). Busca ambas columnas por nombre de cabecera.
function actualizarContadorDocumentos(email, subidos, requeridos) {
  try {
    const emailNorm = String(email || '').toLowerCase().trim();
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    const headers = data[0] || [];
    let emailCol = -1, docsCol = -1;
    for (let j = 0; j < headers.length; j++) {
      const h = String(headers[j]).toLowerCase().trim();
      if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico' || h === 'e-mail') emailCol = j;
      if (h === 'documentos') docsCol = j;
    }
    if (emailCol < 0) { Logger.log('actualizarContadorDocumentos: columna Email no encontrada'); return; }
    if (docsCol < 0) { Logger.log('actualizarContadorDocumentos: columna "Documentos" no encontrada en Inscripciones'); return; }

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][emailCol] || '').toLowerCase().trim() === emailNorm) {
        sheet.getRange(i + 1, docsCol + 1).setValue(subidos + '/' + requeridos);
        return;
      }
    }
    Logger.log('actualizarContadorDocumentos: email no encontrado en Inscripciones: ' + email);
  } catch (err) {
    Logger.log('actualizarContadorDocumentos error: ' + err);
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
function getAdminParticipantes(params) {
  try {
    if (!autorizar(params, ['superadmin', 'editor', 'viewer'])) return sendResponse(403, { error: 'No autorizado' });
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
      // Garantizar paso_actual desde columna U (índice 20) si no vino por cabecera
      if (!obj['paso_actual']) {
        const pv = row[20];
        if (pv != null && pv !== '') obj['paso_actual'] = String(pv);
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
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
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
      if ((h.indexOf('tiquete') >= 0 && h.indexOf('actualizado') < 0) || h.indexOf('vuelo') >= 0) tiqCol = j;
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
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
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
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    const rowNum = parseInt(data._row);
    if (!rowNum || rowNum < 2) return sendResponse(400, { ok: false, error: 'Fila invalida: ' + data._row });
    // Mapeo posicional SOLO para campos donde la cabecera del Sheet no coincide
    // con la clave que envía el formulario (ej. WhatsApp ↔ phone). NO incluir aquí
    // campos cuya cabecera ya coincide por nombre (como paso_actual), para evitar
    // que un índice desactualizado escriba en la columna equivocada.
    const numColMapByIdx = {
      1:'tipo', 2:'nombre', 3:'email', 4:'phone', 5:'pais', 6:'pasaporte',
      7:'fecha_nacimiento', 8:'posicion', 9:'club_colegio', 10:'ciudad',
      11:'salud_alergias', 12:'acudiente', 13:'relacion', 14:'tiquete_aereo',
      15:'programa', 16:'habitacion'
    };
    const normFieldKey = function(s) {
      return String(s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_]+/g, '_');
    };
    const dataByNorm = {};
    Object.keys(data).forEach(function(k) { dataByNorm[normFieldKey(k)] = data[k]; });

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    let updated = 0;
    for (let j = 0; j < headers.length; j++) {
      const h = String(headers[j]);
      let val = null;
      // Primero la clave normalizada: resuelve correctamente cuando el payload
      // trae tanto la clave original del Sheet ('Tiquete Aéreo') como la del
      // formulario ('tiquete_aereo') — el normFieldKey da prioridad al último
      // valor escrito, que es siempre el editado por el usuario.
      if (dataByNorm[normFieldKey(h)] !== undefined) val = dataByNorm[normFieldKey(h)];
      else if (data[h] !== undefined) val = data[h];
      else {
        const posKey = numColMapByIdx[j + 1];
        if (posKey && data[posKey] !== undefined) val = data[posKey];
      }
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
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
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

// ───── CONTACTO INSTITUCIONAL (formulario index.html) ─────────────────────────
function contactoInstitucional(data) {
  try {
    var nombre = String(data.nombre || '').trim();
    var org = String(data.organizacion || '').trim();
    var pais = String(data.pais || '').trim();
    var email = String(data.email || '').trim();
    var tipo = String(data.tipo || '').trim();
    var mensaje = String(data.mensaje || '').trim();
    if (!nombre || !org || !pais || !email) return sendResponse(400, { ok: false, error: 'Faltan campos requeridos' });

    var destino = 'alejandro.cabrera@victory.com.es';
    var subject = 'Contacto institucional — ' + org;
    var body = 'Nombre: ' + nombre + '\nOrganización: ' + org + '\nPaís: ' + pais + '\nEmail: ' + email
      + '\nTipo de proyecto: ' + tipo + '\nMensaje: ' + mensaje;
    GmailApp.sendEmail(destino, subject, body, { replyTo: email, name: 'Victory Sports - Web' });
    return sendResponse(200, { ok: true });
  } catch (err) {
    Logger.log('contactoInstitucional error: ' + err);
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

function getAdminFinanciero(params) {
  try {
    if (!autorizar(params, ['superadmin', 'editor', 'viewer'])) return sendResponse(403, { error: 'No autorizado' });
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
      // Resumen fila 32: D=COP, E=EUR, G32=completos, G33=parciales (col A=tipo agregada)
      result.pagos_recibidos = {
        total_eur:  num(pagosSheet.getRange('E32').getValue()),
        total_cop:  num(pagosSheet.getRange('D32').getValue()),
        completos:  num(pagosSheet.getRange('G32').getValue()),
        parciales:  num(pagosSheet.getRange('G33').getValue())
      };
      // Pagos individuales desde fila 6: A=tipo, B=nombre, C=fecha, D=COP, E=EUR, F=estado, G=paquete, H=concepto
      var lastPagRow = pagosSheet.getLastRow();
      var pagData = [];
      if (lastPagRow >= 6) {
        pagData = pagosSheet.getRange('A6:K' + lastPagRow).getValues();
        var tiposValidos3 = { 'reserva': true, 'tiquete': true, 'pago final': true };
        var currentNombre = '';
        var currentTipo   = '';
        for (var i = 0; i < pagData.length; i++) {
          var r = pagData[i];
          var rowNombre = str(r[1]); // col B = nombre (puede estar vacío en sub-filas)
          var rowTipo   = str(r[0]); // col A = tipo participante
          // Actualizar bloque actual cuando hay nombre en col B
          if (rowNombre) {
            if (rowNombre.toLowerCase().indexOf('total') >= 0) { currentNombre = ''; continue; }
            currentNombre = rowNombre;
            if (rowTipo) currentTipo = rowTipo;
          }
          if (!currentNombre) continue;
          var eurAmt = num(r[4]);  // col E = EUR
          if (eurAmt <= 0) continue;
          var tipoG = str(r[7]).toLowerCase();  // col H = concepto
          if (tipoG && !tiposValidos3[tipoG]) continue;
          var fechaVal = r[2];  // col C = fecha
          if (!fechaVal || (!(fechaVal instanceof Date) && !str(fechaVal).match(/\d/))) continue;
          result.pagos_lista.push({
            tipo: currentTipo, nombre: currentNombre, fecha: fmtDate(fechaVal),
            cop: num(r[3]), eur: eurAmt,
            estado: str(r[5]), paquete: str(r[6]), notas: str(r[7]),
            comprobante_url: str(r[8]),
            ia_status: str(r[9]), ia_detalle: str(r[10])
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
        var cellB = str(pagData[i][1]); // col B = nombre (solo filas con nombre)
        if (!cellB || cellB.toLowerCase().indexOf('total') >= 0) continue;
        if (!seenPN[cellB.toLowerCase()]) {
          seenPN[cellB.toLowerCase()] = true;
          pagosNombres.push(cellB);
        }
      }
      result.pagos_nombres = pagosNombres;
    }

    // ── Gastos — hoja "Gastos": B=presupuestado€, C=pagado€, D=pagadoCOP, F=% pagado
    var gastosSheet = getSheetCI(ss, 'Gastos');
    if (gastosSheet) {
      var lastGastoRow = gastosSheet.getLastRow();
      if (lastGastoRow >= 5) {
        var gastosData = gastosSheet.getRange(5, 1, lastGastoRow - 4, 6).getValues();
        // Calcular tasa media propia de gastos: COP/EUR para filas con ambos valores
        var tasaSuma = 0, tasaCount = 0;
        for (var gi = 0; gi < gastosData.length; gi++) {
          var eur = num(gastosData[gi][2]), cop = num(gastosData[gi][3]);
          if (eur > 0 && cop > 0) { tasaSuma += cop / eur; tasaCount++; }
        }
        var tasaGastos = tasaCount > 0 ? Math.round(tasaSuma / tasaCount) : 0;
        // Leer fila TOTAL
        for (var gi = 0; gi < gastosData.length; gi++) {
          if (String(gastosData[gi][0] || '').toLowerCase().trim() === 'total') {
            result.gastos = {
              presupuestado: num(gastosData[gi][1]), // col B — Total presupuestado (€)
              pagado:        num(gastosData[gi][2]), // col C — Pagado (€)
              pagado_cop:    num(gastosData[gi][3]), // col D — Pagado (COP) valor real
              pct:           num(gastosData[gi][5]), // col F — % Pagado
              tasa_media:    tasaGastos              // Tasa COP/EUR calculada de filas reales
            };
            break;
          }
        }
      }
    }
    if (!result.gastos) result.gastos = { presupuestado: 0, pagado: 0, pagado_cop: 0, pct: 0, tasa_media: 0 };

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
          if ((cj.indexOf('Redcol') === 0 || cj.indexOf('Paquete') === 0 || cj.indexOf('Acomp.') === 0) && num(row[j+1]) > 0 && num(row[j+2]) > 0) {
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
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
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
    var allData = numRows > 0 ? pagosSheet.getRange(startRow, 1, numRows, 8).getValues() : [];

    var nombreLower = nombre.toLowerCase();
    var tipoLower   = tipo.toLowerCase();
    var inBlock = false;
    var targetSheetRow = -1;
    var blockPagoFinalRow = -1;
    var tipoParticipante = String(data.tipo_participante || '').trim();

    for (var i = 0; i < allData.length; i++) {
      var cellB = String(allData[i][1] || '').trim(); // col B = nombre
      var cellH = String(allData[i][7] || '').trim(); // col H = concepto

      if (cellB) {
        if (cellB.toLowerCase() === nombreLower) {
          inBlock = true;
          if (!tipoParticipante) tipoParticipante = String(allData[i][0] || '').trim();
        } else if (inBlock) {
          break;
        }
      }

      if (inBlock) {
        if (cellH.toLowerCase() === tipoLower) {
          targetSheetRow = startRow + i;
          break;
        }
        if (cellH.toLowerCase() === 'pago final') {
          blockPagoFinalRow = startRow + i;
        }
      }
    }

    var newRow = [tipoParticipante, nombre, fechaDate, cop > 0 ? cop : '', eur, estado, paquete, tipo];

    if (targetSheetRow > 0) {
      // Row already exists — update it
      pagosSheet.getRange(targetSheetRow, 1, 1, 8).setValues([newRow]);
    } else if (blockPagoFinalRow > 0) {
      // Participant found but this tipo has no row yet — insert before Pago Final
      pagosSheet.insertRowsBefore(blockPagoFinalRow, 1);
      pagosSheet.getRange(blockPagoFinalRow, 1, 1, 8).setValues([newRow]);
    } else {
      // Participant not in sheet at all — insert before summary row
      var tiposValidos = { 'reserva': true, 'tiquete': true, 'pago final': true };
      var lastDataRow = startRow - 1;
      for (var k = 0; k < allData.length; k++) {
        var gv = String(allData[k][7] || '').trim().toLowerCase(); // col H = concepto
        if (tiposValidos[gv]) lastDataRow = startRow + k;
      }
      var insertRow = lastDataRow + 1;
      pagosSheet.insertRowsBefore(insertRow, 1);
      pagosSheet.getRange(insertRow, 1, 1, 8).setValues([newRow]);
    }

    // Sync paquete across all rows of this participant if paquete changed
    // Re-read data after possible insertions to get updated row positions
    var lastRow2 = pagosSheet.getLastRow();
    var numRows2 = lastRow2 - startRow + 1;
    if (numRows2 > 0) {
      var allData2 = pagosSheet.getRange(startRow, 1, numRows2, 8).getValues();
      var inBlock2 = false;
      for (var j = 0; j < allData2.length; j++) {
        var cellB2 = String(allData2[j][1] || '').trim(); // col B = nombre
        if (cellB2) {
          if (cellB2.toLowerCase() === nombreLower) { inBlock2 = true; }
          else if (inBlock2) { break; }
        }
        if (inBlock2 && String(allData2[j][6] || '').trim() !== paquete) { // col G = paquete
          pagosSheet.getRange(startRow + j, 7).setValue(paquete); // col G = column 7
        }
      }
    }

    if (estado.toLowerCase().trim() === 'completo' || estado.toLowerCase().trim() === 'parcial') {
      notificarPagoConfirmado(nombre, tipo, eur, cop, estado);
    }

    actualizarResumenPagos(pagosSheet);
    return sendResponse(200, { ok: true, mode: targetSheetRow > 0 ? 'updated' : 'appended' });
  } catch (err) {
    Logger.log('registrarPago error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// ───── MARCAR COMPROBANTE SUBIDO (participante) → "Pendiente de confirmar" ────
// Se llama automáticamente cuando el participante confirma la subida de su
// comprobante (enviarComprobante() en el frontend), SIN pasar por el panel
// admin. Solo cambia el estado a "Pendiente de confirmar" — nunca sobreescribe
// un pago que el admin ya marcó "Completo" o "Parcial" manualmente. Reutiliza
// el mismo patrón de búsqueda/inserción de fila que registrarPago().
// ───── VERIFICACIÓN IA DE COMPROBANTES ─────────────────────────────────────────
function verificarComprobanteIA_(fileId, eurEsperado, copEsperado, metodoPago) {
  try {
    const apiKey = getAnthropicApiKey_();
    if (!apiKey) return { status: 'manual', detalle: 'IA no configurada' };
    if (!fileId) return { status: 'manual', detalle: 'Sin archivo para leer' };

    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const mimeType = blob.getContentType();
    const base64 = Utilities.base64Encode(blob.getBytes());

    const esPdf = mimeType === 'application/pdf';
    const contentBlock = esPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };

    const prompt = 'Este es un comprobante de pago (transferencia bancaria o recibo de tarjeta). '
      + 'Extrae el monto total pagado y la moneda. Responde SOLO con JSON, sin texto adicional, '
      + 'con este formato exacto: {"monto": <numero o null>, "moneda": "COP"|"EUR"|"USD"|"OTRA"|null, '
      + '"confianza": "alta"|"media"|"baja", "nota": "<breve razon si la confianza no es alta>"}';

    const payload = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
    };

    const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      Logger.log('Anthropic API error: ' + response.getContentText());
      return { status: 'manual', detalle: 'Error IA (' + response.getResponseCode() + ')' };
    }

    const result = JSON.parse(response.getContentText());
    const textBlock = (result.content || []).find(function (b) { return b.type === 'text'; });
    if (!textBlock) return { status: 'manual', detalle: 'IA no devolvió lectura' };

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
    } catch (e) {
      return { status: 'manual', detalle: 'Respuesta IA no interpretable' };
    }

    return evaluarComprobante_(parsed, eurEsperado, copEsperado, metodoPago);
  } catch (err) {
    Logger.log('verificarComprobanteIA_ error: ' + err);
    return { status: 'manual', detalle: 'Error técnico al verificar' };
  }
}

// Compara lo leído por la IA contra el monto esperado, con tolerancia según método de pago:
// 0.3% para transferencia (debe calzar casi exacto), 1% para tarjeta (redondeo del procesador Bold).
function evaluarComprobante_(parsed, eurEsperado, copEsperado, metodoPago) {
  const monto = parseFloat(parsed.monto);
  const moneda = String(parsed.moneda || '').toUpperCase();
  const confianza = String(parsed.confianza || '').toLowerCase();

  if (!monto || isNaN(monto) || confianza === 'baja') {
    return { status: 'manual', detalle: 'Imagen ilegible o monto no detectado' };
  }

  const porcentajeTolerancia = (metodoPago === 'tarjeta') ? 0.01 : 0.003;

  let esperado = 0, monedaLabel = '';
  if (moneda === 'COP' && copEsperado > 0) {
    esperado = copEsperado; monedaLabel = 'COP';
  } else if ((moneda === 'EUR' || moneda === 'USD') && eurEsperado > 0) {
    esperado = eurEsperado; monedaLabel = moneda;
  } else {
    return { status: 'revisar', detalle: 'Moneda detectada (' + moneda + ') no coincide con lo esperado' };
  }

  const tolerancia = Math.max(esperado * porcentajeTolerancia, monedaLabel === 'COP' ? 1000 : 1);
  const diff = Math.abs(monto - esperado);

  if (diff <= tolerancia) {
    return { status: 'coincide', detalle: 'Coincide · ' + monedaLabel + ' ' + monto.toLocaleString('es-CO') };
  }
  return { status: 'revisar', detalle: 'Detectó ' + monedaLabel + ' ' + monto.toLocaleString('es-CO') + ', se esperaba ' + esperado.toLocaleString('es-CO') };
}

function marcarComprobanteSubido(data) {
  try {
    var nombre = String(data.nombre || '').trim();
    var tipo = String(data.tipo || '').trim(); // Reserva | Tiquete | Pago Final
    if (!nombre || !tipo) return sendResponse(400, { ok: false, error: 'nombre y tipo requeridos' });
    var eur = parseFloat(data.eur) || 0;
    var cop = parseFloat(data.cop) || 0;
    var comprobanteUrl = String(data.comprobante_url || '').trim();
    var fileId = String(data.file_id || '').trim();
    var metodoPago = String(data.metodo_pago || 'transferencia').trim();
    var fechaStr = String(data.fecha || '').trim();
    var fechaDate = new Date();
    if (fechaStr) {
      var fp = fechaStr.split('-');
      if (fp.length === 3) fechaDate = new Date(parseInt(fp[0]), parseInt(fp[1]) - 1, parseInt(fp[2]));
    }

    var ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return sendResponse(404, { ok: false, error: 'Hoja Pagos no encontrada' });

    var lastRow = pagosSheet.getLastRow();
    var startRow = 6;
    var numRows = lastRow - startRow + 1;
    var allData = numRows > 0 ? pagosSheet.getRange(startRow, 1, numRows, 8).getValues() : [];

    var nombreLower = nombre.toLowerCase();
    var tipoLower = tipo.toLowerCase();
    var inBlock = false;
    var targetSheetRow = -1;
    var blockPagoFinalRow = -1;
    var tipoParticipante = String(data.tipo_participante || '').trim();

    for (var i = 0; i < allData.length; i++) {
      var cellB = String(allData[i][1] || '').trim(); // col B = nombre
      var cellH = String(allData[i][7] || '').trim(); // col H = concepto

      if (cellB) {
        if (cellB.toLowerCase() === nombreLower) {
          inBlock = true;
          if (!tipoParticipante) tipoParticipante = String(allData[i][0] || '').trim();
        } else if (inBlock) {
          break;
        }
      }

      if (inBlock) {
        if (cellH.toLowerCase() === tipoLower) {
          targetSheetRow = startRow + i;
          break;
        }
        if (cellH.toLowerCase() === 'pago final') {
          blockPagoFinalRow = startRow + i;
        }
      }
    }

    var resultadoIA = verificarComprobanteIA_(fileId, eur, cop, metodoPago);

    if (targetSheetRow > 0) {
      var estadoActual = String(pagosSheet.getRange(targetSheetRow, 6).getValue() || '').trim().toLowerCase();
      if (estadoActual === 'completo' || estadoActual === 'parcial') {
        return sendResponse(200, { ok: true, skipped: true }); // nunca pisar un pago ya confirmado por el admin
      }
      pagosSheet.getRange(targetSheetRow, 3).setValue(fechaDate); // col C = fecha
      if (cop > 0) pagosSheet.getRange(targetSheetRow, 4).setValue(cop); // col D = cop
      if (eur > 0) pagosSheet.getRange(targetSheetRow, 5).setValue(eur); // col E = eur
      pagosSheet.getRange(targetSheetRow, 6).setValue('Pendiente de confirmar'); // col F = estado
      if (comprobanteUrl) pagosSheet.getRange(targetSheetRow, 9).setValue(comprobanteUrl); // col I = link al comprobante en Drive
      pagosSheet.getRange(targetSheetRow, 10).setValue(resultadoIA.status);  // col J = estado IA
      pagosSheet.getRange(targetSheetRow, 11).setValue(resultadoIA.detalle); // col K = detalle IA
    } else {
      var newRow = [tipoParticipante, nombre, fechaDate, cop > 0 ? cop : '', eur, 'Pendiente de confirmar', '', tipo, comprobanteUrl, resultadoIA.status, resultadoIA.detalle];
      var filaInsertada = -1;
      if (blockPagoFinalRow > 0) {
        pagosSheet.insertRowsBefore(blockPagoFinalRow, 1);
        filaInsertada = blockPagoFinalRow;
      } else {
        var tiposValidos = { 'reserva': true, 'tiquete': true, 'pago final': true };
        var lastDataRow = startRow - 1;
        for (var k = 0; k < allData.length; k++) {
          var gv = String(allData[k][7] || '').trim().toLowerCase();
          if (tiposValidos[gv]) lastDataRow = startRow + k;
        }
        filaInsertada = lastDataRow + 1;
        pagosSheet.insertRowsBefore(filaInsertada, 1);
      }
      pagosSheet.getRange(filaInsertada, 1, 1, 11).setValues([newRow]);
    }

    return sendResponse(200, { ok: true });
  } catch (err) {
    Logger.log('marcarComprobanteSubido error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// ───── ACTUALIZAR FÓRMULAS FILA RESUMEN (Pagos) ──────────────────────────────
function actualizarResumenPagos(pagosSheet) {
  try {
    var lastRow = pagosSheet.getLastRow();
    if (lastRow < 7) return;
    // Buscar fila resumen: col B contiene "TOTAL"
    var colB = pagosSheet.getRange('B6:B' + lastRow).getValues();
    var summaryRow = -1;
    for (var i = 0; i < colB.length; i++) {
      if (String(colB[i][0]).toUpperCase().indexOf('TOTAL') >= 0) {
        summaryRow = 6 + i;
        break;
      }
    }
    if (summaryRow < 7) return;
    var sr = summaryRow;
    var dataEnd = sr - 1;
    // D = suma COP, E = suma EUR, G = completos, H = parciales
    pagosSheet.getRange(sr, 4).setFormulaLocal('=SUMA(D6:D' + dataEnd + ')');
    pagosSheet.getRange(sr, 5).setFormulaLocal('=SUMA(E6:E' + dataEnd + ')');
    pagosSheet.getRange(sr, 7).setFormulaLocal('=CONTAR.SI(F6:F' + dataEnd + ';"Completo")');
    pagosSheet.getRange(sr, 8).setFormulaLocal('=CONTAR.SI(F6:F' + dataEnd + ';"Parcial")');
    Logger.log('actualizarResumenPagos: fórmulas actualizadas en fila ' + sr);
  } catch (err) {
    Logger.log('actualizarResumenPagos error: ' + err);
  }
}

// ───── SINCRONIZAR PARTICIPANTES (inscripción → Pagos) ────────────────────────
function sincronizarParticipantes(params) {
  try {
    if (!autorizar(params, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
    var mainSheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var mainData = mainSheet.getDataRange().getValues();
    var headers = mainData[0] || [];
    var nombreCol = 1, tiqueteCol = 13;
    for (var j = 0; j < headers.length; j++) {
      var h = String(headers[j]).toLowerCase();
      if ((h === 'nombre' || h.includes('nombre')) && h.indexOf('acudiente') < 0) nombreCol = j;
      if ((h.includes('tiquete') && !h.includes('actualizado')) || h.includes('vuelo')) tiqueteCol = j;
    }

    var ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return sendResponse(404, { ok: false, error: 'Hoja Pagos no encontrada' });

    var lastRow = pagosSheet.getLastRow();
    var existingNames = {};
    if (lastRow >= 6) {
      var existingData = pagosSheet.getRange(6, 2, lastRow - 5, 1).getValues(); // col B = nombre
      existingData.forEach(function(row) {
        var n = String(row[0] || '').trim().toLowerCase();
        if (n) existingNames[n] = true;
      });
    }

    // Find insert point: last row with a known tipo (Reserva/Tiquete/Pago Final) in col H
    var insertRow = 6;
    if (lastRow >= 6) {
      var colHData = pagosSheet.getRange(6, 8, lastRow - 5, 1).getValues(); // col H = concepto
      var lastGRow = 5;
      var tiposValidos2 = { 'reserva': true, 'tiquete': true, 'pago final': true };
      for (var k = 0; k < colHData.length; k++) {
        var gv2 = String(colHData[k][0] || '').trim().toLowerCase();
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
      var tipoP = String(mainData[i][0] || 'Jugador').trim() || 'Jugador'; // col A main = tipo
      newRows.push([tipoP, nombre, '', '', 0, 'Pendiente', '', 'Reserva']);
      if (tieneTiquete) newRows.push([tipoP, '', '', '', 0, '', '', 'Tiquete']);
      newRows.push([tipoP, '', '', '', 0, '', '', 'Pago Final']);
      existingNames[nombre.toLowerCase()] = true;
      added++;
    }
    if (newRows.length > 0) {
      pagosSheet.insertRowsBefore(insertRow, newRows.length);
      pagosSheet.getRange(insertRow, 1, newRows.length, 8).setValues(newRows);
    }
    actualizarResumenPagos(pagosSheet);
    return sendResponse(200, { ok: true, added: added });
  } catch (err) {
    Logger.log('sincronizarParticipantes error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// ── Ejecutar UNA VEZ para sincronizar paso_actual con pagos YA registrados ────
// Útil ahora que el bug de columnas de actualizarPasoTodos quedó corregido:
// recorre los pagos marcados "Completo" en el Sheet de presupuesto y avanza el
// paso_actual en Pre-inscripción para los que quedaron desactualizados.
// 1. Selecciona esta función y pulsa ▶ Run
// 2. Revisa el Log (Ver → Registros) para ver cuántos se actualizaron y si hay
//    nombres sin coincidencia (probablemente con el mismo problema de nombres
//    abreviados que ya corregiste antes)
function sincronizarPasosDesdePagos() {
  function normNombreGS(s) {
    return String(s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  const mainSheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const mainData = mainSheet.getDataRange().getValues();
  const headers = mainData[0] || [];
  let nombreCol = -1, pasoCol = -1, tiqueteCol = -1;
  for (let j = 0; j < headers.length; j++) {
    const h = String(headers[j]).toLowerCase().trim();
    if (h === 'nombre' && nombreCol < 0) nombreCol = j;
    if (h === 'paso_actual' || h === 'paso actual') pasoCol = j;
    if ((h.indexOf('tiquete') >= 0 && h.indexOf('actualizado') < 0) || h.indexOf('vuelo') >= 0) tiqueteCol = j;
  }
  if (nombreCol < 0) nombreCol = 1;
  if (pasoCol < 0) pasoCol = 20;

  // Mapa nombre_normalizado → índice de fila en mainData
  const filaPorNombre = {};
  for (let i = 1; i < mainData.length; i++) {
    const nombre = String(mainData[i][nombreCol] || '').trim();
    if (!nombre) continue;
    filaPorNombre[normNombreGS(nombre)] = i;
  }

  const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
  const pagosSheet = getSheetCI(ss, 'Pagos');
  if (!pagosSheet) throw new Error('No se encontró la hoja "Pagos" en el sheet de presupuesto.');
  const lastRow = pagosSheet.getLastRow();
  if (lastRow < 6) { Logger.log('Sin datos en Pagos.'); return; }
  const pagData = pagosSheet.getRange('A6:H' + lastRow).getValues();

  const pasoMap = { 'reserva': 4, 'tiquete': 5, 'pago final': 6 };
  const mejorPasoPorNombre = {};
  let currentNombre = '';

  pagData.forEach(function(r) {
    const rowNombre = String(r[1] || '').trim();
    if (rowNombre) {
      if (rowNombre.toLowerCase().indexOf('total') >= 0) { currentNombre = ''; return; }
      currentNombre = rowNombre;
    }
    if (!currentNombre) return;
    const estado = String(r[5] || '').trim().toLowerCase();
    const concepto = String(r[7] || '').trim().toLowerCase();
    if (estado !== 'completo') return;
    let pasoCandidato = pasoMap[concepto];
    if (!pasoCandidato) return;
    const key = normNombreGS(currentNombre);
    // Reserva completa sin tiquete incluido → salta directo a paso 5 (paso 4 solo aplica a quien debe pagar tiquete)
    if (concepto === 'reserva' && tiqueteCol >= 0) {
      const filaIdx = filaPorNombre[key];
      if (filaIdx !== undefined) {
        const tieneTiquete = String(mainData[filaIdx][tiqueteCol] || '').toLowerCase().indexOf('con') >= 0;
        if (!tieneTiquete) pasoCandidato = 5;
      }
    }
    if (!mejorPasoPorNombre[key] || pasoCandidato > mejorPasoPorNombre[key]) {
      mejorPasoPorNombre[key] = pasoCandidato;
    }
  });

  let actualizados = 0;
  const noEncontrados = [];
  Object.keys(mejorPasoPorNombre).forEach(function(key) {
    const filaIdx = filaPorNombre[key];
    if (filaIdx === undefined) { noEncontrados.push(key); return; }
    const nuevoPaso = mejorPasoPorNombre[key];
    const pasoActualSheet = parseInt(mainData[filaIdx][pasoCol]) || 0;
    if (nuevoPaso <= pasoActualSheet) return; // nunca retroceder
    mainSheet.getRange(filaIdx + 1, pasoCol + 1).setValue(nuevoPaso);
    actualizados++;
  });

  Logger.log('Pasos actualizados: ' + actualizados);
  if (noEncontrados.length) Logger.log('Sin coincidencia en Pre-inscripción (revisar nombres): ' + noEncontrados.join(', '));
}

// ── Ejecutar UNA VEZ para corregir el bug de columna "Tiquete Actualizado" ────
// La detección de columna de tiquete leía por error "Tiquete Actualizado" en vez
// de "Tiquete Aéreo", causando que participantes CON tiquete (aún sin pagarlo)
// quedaran marcados en paso 5 en vez de paso 4. Esta función SOLO corrige ese
// caso puntual: baja de 5 a 4 únicamente cuando el participante tiene tiquete
// incluido, su Reserva está Completa, pero su Tiquete y Pago Final NO lo están.
// No toca a nadie en paso 6 o 7, ni a quienes legítimamente no tienen tiquete.
// 1. Selecciona esta función y pulsa ▶ Run
// 2. Revisa el Log para ver a quién corrigió
function corregirPasoBugTiquete() {
  function normNombreGS(s) {
    return String(s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  const mainSheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const mainData = mainSheet.getDataRange().getValues();
  const headers = mainData[0] || [];
  let nombreCol = -1, pasoCol = -1, tiqueteCol = -1;
  for (let j = 0; j < headers.length; j++) {
    const h = String(headers[j]).toLowerCase().trim();
    if (h === 'nombre' && nombreCol < 0) nombreCol = j;
    if (h === 'paso_actual' || h === 'paso actual') pasoCol = j;
    if ((h.indexOf('tiquete') >= 0 && h.indexOf('actualizado') < 0) || h.indexOf('vuelo') >= 0) tiqueteCol = j;
  }
  if (nombreCol < 0) nombreCol = 1;
  if (pasoCol < 0) pasoCol = 20;
  if (tiqueteCol < 0) throw new Error('No se encontró la columna "Tiquete Aéreo".');

  const filaPorNombre = {};
  for (let i = 1; i < mainData.length; i++) {
    const nombre = String(mainData[i][nombreCol] || '').trim();
    if (!nombre) continue;
    filaPorNombre[normNombreGS(nombre)] = i;
  }

  const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
  const pagosSheet = getSheetCI(ss, 'Pagos');
  if (!pagosSheet) throw new Error('No se encontró la hoja "Pagos".');
  const lastRow = pagosSheet.getLastRow();
  if (lastRow < 6) { Logger.log('Sin datos en Pagos.'); return; }
  const pagData = pagosSheet.getRange('A6:H' + lastRow).getValues();

  // Por participante: qué conceptos tiene Completo
  const completoPorNombre = {};
  let currentNombre = '';
  pagData.forEach(function(r) {
    const rowNombre = String(r[1] || '').trim();
    if (rowNombre) {
      if (rowNombre.toLowerCase().indexOf('total') >= 0) { currentNombre = ''; return; }
      currentNombre = rowNombre;
    }
    if (!currentNombre) return;
    const estado = String(r[5] || '').trim().toLowerCase();
    const concepto = String(r[7] || '').trim().toLowerCase();
    if (estado !== 'completo') return;
    const key = normNombreGS(currentNombre);
    if (!completoPorNombre[key]) completoPorNombre[key] = {};
    completoPorNombre[key][concepto] = true;
  });

  let corregidos = 0;
  Object.keys(completoPorNombre).forEach(function(key) {
    const filaIdx = filaPorNombre[key];
    if (filaIdx === undefined) return;
    const pasoActualSheet = parseInt(mainData[filaIdx][pasoCol]) || 0;
    if (pasoActualSheet !== 5) return; // solo corrige el caso exacto del bug
    const tieneTiquete = String(mainData[filaIdx][tiqueteCol] || '').toLowerCase().indexOf('con') >= 0;
    if (!tieneTiquete) return; // si legítimamente no tiene tiquete, paso 5 es correcto
    const c = completoPorNombre[key];
    const reservaOk = !!c['reserva'];
    const tiqueteOk = !!c['tiquete'];
    const finalOk = !!c['pago final'];
    if (reservaOk && !tiqueteOk && !finalOk) {
      mainSheet.getRange(filaIdx + 1, pasoCol + 1).setValue(4);
      corregidos++;
      Logger.log('Corregido a paso 4: ' + mainData[filaIdx][nombreCol]);
    }
  });

  Logger.log('Total corregidos: ' + corregidos);
}

// ───── AGREGAR PARTICIPANTE MANUALMENTE ──────────────────────────────────────
function agregarParticipante(data) {
  try {
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    const normFieldKey = function(s) {
      return String(s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_]+/g, '_');
    };

    // Mapeo posicional para campos con discrepancia clave↔cabecera
    const posColMap = { 4: 'phone' }; // WhatsApp (col 4) ↔ 'phone'

    // Construir dataByNorm: la clave del formulario (tiquete_aereo) gana sobre la del Sheet (Tiquete Aéreo)
    const dataByNorm = {};
    Object.keys(data).forEach(function(k) { dataByNorm[normFieldKey(k)] = data[k]; });

    // Forzar valores predeterminados si no vienen
    if (!dataByNorm['paso_actual']) dataByNorm['paso_actual'] = '1';
    if (!dataByNorm['fuente'])      dataByNorm['fuente']      = 'Panel Admin';
    if (!dataByNorm['tc_aceptado']) dataByNorm['tc_aceptado'] = 'No';
    // Timestamp (col A) siempre generado por el servidor: el panel admin no lo envía,
    // y si esta columna queda vacía, el escenario de Make que agrega inscripciones del
    // formulario público pierde la referencia de "última fila" y escribe sobre el encabezado.
    dataByNorm['timestamp'] = new Date().toISOString();

    // Construir fila alineada con cabeceras del Sheet
    const newRow = headers.map(function(h, j) {
      if (!h) return '';
      const norm = normFieldKey(String(h));
      if (dataByNorm[norm] !== undefined) return dataByNorm[norm];
      const posKey = posColMap[j + 1];
      if (posKey && data[posKey] !== undefined) return data[posKey];
      return '';
    });

    sheet.appendRow(newRow);
    const newRowNum = sheet.getLastRow();
    Logger.log('agregarParticipante: fila ' + newRowNum + ' creada para ' + (data.nombre || ''));
    return sendResponse(200, { ok: true, _row: newRowNum });
  } catch(err) {
    Logger.log('agregarParticipante error: ' + err);
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

function getAdminAcceso(params) {
  try {
    if (!autorizar(params, ['superadmin', 'editor', 'viewer'])) return ContentService.createTextOutput(JSON.stringify({ error: 'No autorizado' })).setMimeType(ContentService.MimeType.JSON);
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
    if (!autorizar(data, ['superadmin'])) return sendResponse(403, { ok: false, error: 'Solo el super admin puede gestionar accesos' });
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

// ───── CONTRASEÑAS ────────────────────────────────────────────────────────────
function checkAdminPassword(data) {
  try {
    const defaultPwd = getDefaultPassword();
    const stored = PropertiesService.getScriptProperties().getProperty('admin_password') || defaultPwd;
    const ok = passwordMatches_(data.password, stored);
    if (!ok) return sendResponse(200, { ok: false });
    const rol = resolverRolAdmin(data.email || '');
    if (!rol) return sendResponse(200, { ok: false, error: 'Tu correo no tiene acceso registrado al panel de administración.' });
    return sendResponse(200, {
      ok: true,
      rol: rol,
      must_change: !!defaultPwd && passwordMatches_(defaultPwd, stored),
      token: generarSesionToken(data.email, rol)
    });
  } catch(err) {
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function setAdminPassword(data) {
  try {
    const props = PropertiesService.getScriptProperties();
    const defaultPwd = getDefaultPassword();
    const stored = props.getProperty('admin_password') || defaultPwd;
    const usingDefault = !!defaultPwd && passwordMatches_(defaultPwd, stored);
    // Validate reset token if provided
    const resetTokenKey = data.reset_token ? ('reset_admin_' + data.reset_token) : null;
    const usingToken = resetTokenKey ? (function() {
      const raw = props.getProperty(resetTokenKey);
      if (!raw) return false;
      const parts = raw.split('|');
      return parts[1] && Date.now() < parseInt(parts[1]);
    })() : false;
    // Require current password unless on default or using valid reset token
    if (!usingDefault && !usingToken) {
      if (!passwordMatches_(data.current_password, stored))
        return sendResponse(403, { ok: false, error: 'Contraseña actual incorrecta' });
    }
    const newPwd = String(data.new_password || '').trim();
    if (newPwd.length < 6)
      return sendResponse(400, { ok: false, error: 'Mínimo 6 caracteres' });
    const defaultPwdCheck = getDefaultPassword();
    if (defaultPwdCheck && newPwd === defaultPwdCheck)
      return sendResponse(400, { ok: false, error: 'Elige una contraseña diferente a la inicial' });
    props.setProperty('admin_password', hashPassword_(newPwd));
    if (resetTokenKey) { try { props.deleteProperty(resetTokenKey); } catch(_) {} }
    const rol = resolverRolAdmin(data.email || '') || 'viewer';
    return sendResponse(200, { ok: true, token: generarSesionToken(data.email || '', rol) });
  } catch(err) {
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function forgotAdminPassword(data) {
  try {
    const email = String(data.email || '').toLowerCase().trim();
    const resetUrl = String(data.reset_url || 'https://victory-rmf-clinics.netlify.app/areapersonal.html');
    const adminList = ADMIN_EMAILS_LIST.map(e => e.toLowerCase());
    // Always return ok to prevent email enumeration
    if (!adminList.includes(email)) return sendResponse(200, { ok: true });
    const token = Utilities.getUuid().replace(/-/g, '');
    const expiry = Date.now() + 3600000; // 1 hora
    PropertiesService.getScriptProperties().setProperty('reset_admin_' + token, email + '|' + expiry);
    const link = resetUrl + '?reset_admin=' + token;
    GmailApp.sendEmail(email, 'Restablecer contraseña — Panel de Administración RMF Clinic',
      'Para restablecer tu contraseña accede a: ' + link, {
        htmlBody: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">'
          + '<div style="background:#1e5ba8;padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">'
          + '<h2 style="color:#fff;margin:0;font-size:18px">Real Madrid Foundation Clinic 2026</h2></div>'
          + '<div style="background:#f8fafc;padding:28px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">'
          + '<p style="color:#334155;margin-top:0">Hola,</p>'
          + '<p style="color:#334155">Recibimos una solicitud para restablecer la contraseña del panel de administración.</p>'
          + '<p style="text-align:center;margin:24px 0">'
          + '<a href="' + link + '" style="display:inline-block;background:#1e5ba8;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">Restablecer contraseña →</a></p>'
          + '<p style="color:#94a3b8;font-size:12px">Este enlace expira en <strong>1 hora</strong>. Si no lo solicitaste, ignora este correo.</p>'
          + '<p style="color:#94a3b8;font-size:12px">Equipo Revel · Real Madrid Foundation Clinic 2026</p>'
          + '</div></div>',
        replyTo: 'alejandro.cabrera@fundacionrevel.net', name: 'Real Madrid Foundation Clinic'
      });
    return sendResponse(200, { ok: true });
  } catch(err) {
    Logger.log('forgotAdminPassword error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function setComercialPassword(data) {
  try {
    const emailNorm = String(data.email || '').toLowerCase().trim();
    if (!emailNorm) return sendResponse(400, { ok: false, error: 'email requerido' });
    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const comSheet = getSheetCI(ss, 'Comisiones');
    if (!comSheet) return sendResponse(404, { ok: false, error: 'Hoja Comisiones no encontrada' });
    const lastRow = comSheet.getLastRow();
    if (lastRow < 6) return sendResponse(404, { ok: false, error: 'Sin datos' });
    const hiData = comSheet.getRange('H6:J' + lastRow).getValues();
    let rowOffset = -1, stored = '';
    for (let i = 0; i < hiData.length; i++) {
      if (String(hiData[i][1] || '').toLowerCase().trim() === emailNorm) { rowOffset = i; stored = String(hiData[i][2] || ''); break; }
    }
    if (rowOffset < 0) return sendResponse(404, { ok: false, error: 'Comercial no encontrado' });

    // Autorización: primera vez (sin contraseña aún), usando la contraseña
    // compartida por defecto (debe cambiarla), token de reset válido para este
    // email, o sesión comercial ya autenticada + contraseña actual correcta.
    const defaultPwd = getDefaultPassword();
    const usingDefault = !!defaultPwd && passwordMatches_(defaultPwd, stored);
    let autorizado = !stored || usingDefault;
    if (!autorizado && data.reset_token) {
      const raw = PropertiesService.getScriptProperties().getProperty('reset_' + data.reset_token);
      if (raw) {
        const parts = raw.split('|');
        if (parts[0] === emailNorm && Date.now() < parseInt(parts[1])) autorizado = true;
      }
    }
    if (!autorizado) {
      const payload = verificarSesionToken(data.token || '');
      if (payload && payload.rol === 'comercial' && payload.email === emailNorm && passwordMatches_(data.current_password, stored)) autorizado = true;
    }
    if (!autorizado) return sendResponse(403, { ok: false, error: 'No autorizado' });

    const newPwd = String(data.new_password || '').trim();
    if (newPwd.length < 6) return sendResponse(400, { ok: false, error: 'Mínimo 6 caracteres' });
    comSheet.getRange(6 + rowOffset, 10).setValue(hashPassword_(newPwd)); // Columna J
    if (data.reset_token) {
      try { PropertiesService.getScriptProperties().deleteProperty('reset_' + data.reset_token); } catch(_) {}
    }
    return sendResponse(200, { ok: true, token: generarSesionToken(emailNorm, 'comercial') });
  } catch(err) {
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function checkComercialPassword(data) {
  try {
    const emailNorm = String(data.email || '').toLowerCase().trim();
    const pwd = String(data.password || '');
    if (!emailNorm || !pwd) return sendResponse(400, { ok: false, error: 'Email y contraseña requeridos' });
    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const comSheet = getSheetCI(ss, 'Comisiones');
    if (!comSheet) return sendResponse(404, { ok: false, error: 'No encontrado' });
    const lastRow = comSheet.getLastRow();
    if (lastRow < 6) return sendResponse(404, { ok: false, error: 'No encontrado' });
    const hiData = comSheet.getRange('H6:J' + lastRow).getValues();
    for (let i = 0; i < hiData.length; i++) {
      if (String(hiData[i][1] || '').toLowerCase().trim() === emailNorm) {
        const stored = String(hiData[i][2] || '');
        if (!passwordMatches_(pwd, stored)) return sendResponse(200, { ok: false });
        const defaultPwd = getDefaultPassword();
        const mustChange = !!defaultPwd && passwordMatches_(defaultPwd, stored);
        return sendResponse(200, { ok: true, must_change: mustChange, token: generarSesionToken(emailNorm, 'comercial') });
      }
    }
    return sendResponse(404, { ok: false, error: 'Comercial no encontrado' });
  } catch(err) {
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function forgotComercialPassword(data) {
  try {
    const emailNorm = String(data.email || '').toLowerCase().trim();
    if (!emailNorm || emailNorm.indexOf('@') < 0) return sendResponse(400, { ok: false, error: 'Email requerido' });
    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const comSheet = getSheetCI(ss, 'Comisiones');
    if (!comSheet) return sendResponse(404, { ok: false, error: 'No encontrado' });
    const lastRow = comSheet.getLastRow();
    if (lastRow < 6) return sendResponse(404, { ok: false, error: 'No encontrado' });
    const hiData = comSheet.getRange('H6:I' + lastRow).getValues();
    let found = false;
    for (let i = 0; i < hiData.length; i++) {
      if (String(hiData[i][1] || '').toLowerCase().trim() === emailNorm) { found = true; break; }
    }
    // Devolver ok:true aunque no se encuentre (no revelar si el email existe o no)
    if (!found) return sendResponse(200, { ok: true });
    const token = Utilities.getUuid().replace(/-/g, '');
    const expiry = Date.now() + 3600000; // 1 hora
    PropertiesService.getScriptProperties().setProperty('reset_' + token, emailNorm + '|' + expiry);
    const resetUrl = String(data.reset_url || 'https://victory-rmf-clinics.netlify.app/areapersonal.html');
    const link = resetUrl + '?reset=' + token;
    const adminEmail = 'alejandro.cabrera@fundacionrevel.net';
    GmailApp.sendEmail(emailNorm, 'Recupera tu contraseña — Área Comercial RMF Clinic',
      'Para restablecer tu contraseña accede a: ' + link, {
        htmlBody: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">'
          + '<div style="background:#1e5ba8;padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">'
          + '<h2 style="color:#fff;margin:0;font-size:18px">Real Madrid Foundation Clinic 2026</h2></div>'
          + '<div style="background:#f8fafc;padding:28px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">'
          + '<p style="color:#334155;margin-top:0">Hola,</p>'
          + '<p style="color:#334155">Recibimos una solicitud para restablecer la contraseña de tu área comercial.</p>'
          + '<p style="text-align:center;margin:24px 0">'
          + '<a href="' + link + '" style="display:inline-block;background:#1e5ba8;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">Restablecer contraseña →</a></p>'
          + '<p style="color:#94a3b8;font-size:12px">Este enlace expira en <strong>1 hora</strong>. Si no lo solicitaste, ignora este correo.</p>'
          + '<p style="color:#94a3b8;font-size:12px">Equipo Revel · Real Madrid Foundation Clinic 2026</p>'
          + '</div></div>',
        replyTo: adminEmail, name: 'Real Madrid Foundation Clinic'
      });
    return sendResponse(200, { ok: true });
  } catch(err) {
    Logger.log('forgotComercialPassword error: ' + err);
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

// ───── CATEGORÍAS DE JUGADORES ────────────────────────────────────────────────

function parseFechaNacimiento(valor) {
  if (valor instanceof Date) {
    return { anio: valor.getFullYear(), mes: valor.getMonth() + 1, dia: valor.getDate() };
  }
  var s = String(valor || '').trim();
  if (!s) return null;
  // Formato aaaa-mm-dd
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    var p = s.split('-');
    return { anio: parseInt(p[0]), mes: parseInt(p[1]), dia: parseInt(p[2]) };
  }
  // Formato dd/mm/aaaa
  if (s.indexOf('/') >= 0) {
    var p2 = s.split('/');
    if (p2.length === 3) {
      var a = parseInt(p2[2]), m = parseInt(p2[1]), d = parseInt(p2[0]);
      if (a > 1900) return { anio: a, mes: m, dia: d };
    }
  }
  return null;
}

function calcEdadRef(fechaObj) {
  if (!fechaObj) return null;
  var edad = 2026 - fechaObj.anio;
  // Si el cumpleaños es posterior al 2 de octubre, aún no lo ha cumplido
  if (fechaObj.mes > 10 || (fechaObj.mes === 10 && fechaObj.dia > 2)) edad -= 1;
  return edad;
}

function getAdminCategorias(params) {
  try {
    if (!autorizar(params, ['superadmin', 'editor', 'viewer'])) return sendResponse(403, { error: 'No autorizado' });
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var data = sheet.getDataRange().getValues();
    var headers = data[0];

    // Buscar columnas por cabecera
    var tipoCol = -1, nombreCol = -1, fechaCol = -1;
    for (var j = 0; j < headers.length; j++) {
      var h = String(headers[j]).toLowerCase().trim();
      if (h === 'tipo') tipoCol = j;
      if ((h === 'nombre' || h === 'nombre completo') && nombreCol < 0) nombreCol = j;
      if (h.indexOf('fecha') >= 0 && (h.indexOf('nac') >= 0 || h.indexOf('nacim') >= 0)) fechaCol = j;
    }
    if (tipoCol < 0)   tipoCol = 0;
    if (nombreCol < 0) nombreCol = 1;
    if (fechaCol < 0)  fechaCol = 6;

    var catMap = { 'Sub 18': [], 'Sub 16': [], 'Sub 14': [], 'Sub 12': [], 'Sub 10': [] };

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (row.every(function(c) { return c === '' || c === null; })) continue;
      var tipo = String(row[tipoCol] || '').toLowerCase().trim();
      if (tipo.indexOf('jug') < 0) continue; // Solo jugadores

      var nombre = String(row[nombreCol] || '').trim();
      if (!nombre) continue;

      var fechaObj = parseFechaNacimiento(row[fechaCol]);
      var edad = calcEdadRef(fechaObj);

      var fechaDisplay = '—';
      if (fechaObj) {
        fechaDisplay = String(fechaObj.dia).padStart(2,'0') + '/' +
                       String(fechaObj.mes).padStart(2,'0') + '/' + fechaObj.anio;
      }

      var cat;
      if (edad === null || edad >= 16) cat = 'Sub 18';
      else if (edad >= 14) cat = 'Sub 16';
      else if (edad >= 12) cat = 'Sub 14';
      else if (edad >= 10) cat = 'Sub 12';
      else cat = 'Sub 10';

      catMap[cat].push({
        nombre: nombre,
        fecha:  fechaDisplay,
        _sort:  fechaObj ? (fechaObj.anio * 10000 + fechaObj.mes * 100 + fechaObj.dia) : 0
      });
    }

    var catOrder = ['Sub 18', 'Sub 16', 'Sub 14', 'Sub 12', 'Sub 10'];
    var result = catOrder.map(function(cat) {
      var jugadores = catMap[cat];
      jugadores.sort(function(a, b) { return a._sort - b._sort; }); // más viejo primero
      return {
        categoria: cat,
        jugadores: jugadores.map(function(j) { return { nombre: j.nombre, fecha: j.fecha }; })
      };
    });

    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    Logger.log('getAdminCategorias error: ' + err);
    return sendResponse(500, { error: err.toString() });
  }
}

// ───── ÁREA COMERCIAL ──────────────────────────────────────────────────────────
function getComercialData(email) {
  try {
    const emailNorm = email.toString().toLowerCase().trim();
    if (!emailNorm) return ContentService.createTextOutput(JSON.stringify({ found: false }))
      .setMimeType(ContentService.MimeType.JSON);

    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const comSheet = getSheetCI(ss, 'Comisiones');
    if (!comSheet) return ContentService.createTextOutput(JSON.stringify({ found: false }))
      .setMimeType(ContentService.MimeType.JSON);

    const lastRow = comSheet.getLastRow();
    if (lastRow < 6) return ContentService.createTextOutput(JSON.stringify({ found: false }))
      .setMimeType(ContentService.MimeType.JSON);

    const str = function(v) { return String(v == null ? '' : v).trim(); };
    const num = function(v) {
      if (typeof v === 'number') return v;
      var s = str(v).replace(/[€$\s]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
      return parseFloat(s) || 0;
    };

    // Find comercial name by email in H:J (H=nombre, I=email, J=password)
    const hiData = comSheet.getRange('H6:J' + lastRow).getValues();
    let nombre = null;
    let storedPwd = '';
    for (let i = 0; i < hiData.length; i++) {
      if (str(hiData[i][1]).toLowerCase() === emailNorm) {
        nombre = str(hiData[i][0]);
        storedPwd = str(hiData[i][2]);
        break;
      }
    }
    if (!nombre) return ContentService.createTextOutput(JSON.stringify({ found: false }))
      .setMimeType(ContentService.MimeType.JSON);

    // Read commission data from A:F, filtered by this comercial's name
    const comData = comSheet.getRange('A6:F' + lastRow).getValues();
    const nombreLower = nombre.toLowerCase();
    const jugadores = [];
    const acompanantes = [];
    let seccion = 'jugadores';

    for (let i = 0; i < comData.length; i++) {
      const r = comData[i];
      const colA = str(r[0]);
      const colALow = colA.toLowerCase();
      if (!colA) continue;
      if (colALow.indexOf('acomp') >= 0) { seccion = 'acompanantes'; continue; }
      if (colALow.indexOf('total') >= 0) continue;
      if (colALow === 'comercial') continue;
      if (colALow !== nombreLower) continue;

      if (seccion === 'jugadores') {
        jugadores.push({
          comision_jugador: num(r[1]),
          jugadores: num(r[2]),
          total: num(r[3]),
          estado: str(r[4]),
          notas: str(r[5])
        });
      } else {
        acompanantes.push({
          com_doble:    num(r[1]),
          com_sencilla: num(r[2]),
          acomp_doble:  num(r[3]),
          acomp_sencilla: num(r[4]),
          total: num(r[5])
        });
      }
    }

    return ContentService.createTextOutput(JSON.stringify({
      found: true,
      nombre: nombre,
      has_password: !!storedPwd,
      jugadores: jugadores,
      acompanantes: acompanantes
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('getComercialData error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ found: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
