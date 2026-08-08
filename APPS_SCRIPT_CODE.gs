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
const PARENT_FOLDER_ID = "1E_7wpNt-KgEKyVL9Za2h3J-ne0IXYRUh"; // ID de carpeta "Document_Uploads" (Clinic)
const PARENT_FOLDER_ID_WORLD_CHALLENGE = "1S-45lTj8G7f-mVV-SWSZjwRks8gcyZKN"; // ID de carpeta "Document_Uploads_WCH_2027"
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

// ───── PROGRAMA: REAL MADRID FOUNDATION WORLD CHALLENGE ───────────────────────
// Segundo programa (además del Clinic de octubre) con sus propios sheets de
// inscripción y presupuesto. Las funciones de login/pagos/participantes buscan
// en ambos pares de sheets según corresponda — ver esWorldChallenge_() y
// resolverSheets_().
const SHEET_ID_WORLD_CHALLENGE = "1-9WepBAmmLbLY09yb1EZ0VkUzmIg3cAhYp5y4KpN-dg"; // Sheet Inscripciones World Challenge 2027
const BUDGET_SHEET_ID_WORLD_CHALLENGE = "1vqmm9em3DKNZdhlZ7hfjlFJfGiL83bTell0izCCHvPY"; // Sheet presupuesto World Challenge 2027

// Recargo que cobra Bold por pago con tarjeta. El comprobante/monto de un pago
// con tarjeta trae este recargo incluido, pero no es parte del programa (es la
// comisión del procesador) — no cuenta para el saldo del cliente. Se separa en
// getAbonosValidados_() y se usa como referencia en evaluarComprobante_().
// Debe coincidir con el 0.035 usado en areapersonal.html.
var RECARGO_TARJETA_PCT = 0.035;

// Lee la celda "Metodo de pago" de una fila de Pagos y devuelve el % de
// recargo de tarjeta a aplicar, o null si la fila no es un pago con tarjeta.
// Normalmente la celda solo dice "tarjeta" → usa el recargo vigente
// (RECARGO_TARJETA_PCT). Para casos puntuales donde el recargo real cobrado
// fue distinto (ej. pagos antiguos hechos cuando Bold cobraba 3% en vez del
// 3.5% actual), se puede escribir "tarjeta 3%" en esa misma celda para esa
// fila específica, sin afectar el recargo estándar de las demás filas.
function recargoTarjetaDeCelda_(valorCelda) {
  var s = String(valorCelda || '').trim().toLowerCase();
  if (s.indexOf('tarjeta') !== 0) return null; // no es un pago con tarjeta
  var m = s.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (m) return parseFloat(m[1].replace(',', '.')) / 100;
  return RECARGO_TARJETA_PCT;
}

function esWorldChallenge_(programa) {
  // Acepta tanto el texto libre ("Real Madrid Foundation World Challenge")
  // como el program_key interno ("world_challenge") — normaliza guiones
  // bajos a espacios para que ambos formatos calcen con la misma búsqueda.
  return String(programa || '').toLowerCase().replace(/_/g, ' ').indexOf('world challenge') >= 0;
}

// Devuelve { sheetId, budgetSheetId, programKey } para el programa dado.
// programa puede ser el string completo ("Real Madrid Foundation World Challenge")
// o ya la programKey ('world_challenge'/'clinic') — ambos casos funcionan porque
// esWorldChallenge_ solo busca la subcadena 'world challenge'.
function resolverSheets_(programa) {
  if (esWorldChallenge_(programa)) {
    return { sheetId: SHEET_ID_WORLD_CHALLENGE, budgetSheetId: BUDGET_SHEET_ID_WORLD_CHALLENGE, programKey: 'world_challenge' };
  }
  return { sheetId: SHEET_ID, budgetSheetId: BUDGET_SHEET_ID, programKey: 'clinic' };
}

// Carpeta de Drive donde se guardan documentos/comprobantes subidos, según programa.
function resolverParentFolderId_(programa) {
  return esWorldChallenge_(programa) ? PARENT_FOLDER_ID_WORLD_CHALLENGE : PARENT_FOLDER_ID;
}

// Todas las hojas de presupuesto (una por programa) — usado por el área
// comercial, que busca/gestiona comisiones de un comercial a través de
// ambos programas a la vez (un comercial puede vender Clinic y World
// Challenge con la misma cuenta).
function getBudgetSheetIds_() {
  return [
    { budgetSheetId: BUDGET_SHEET_ID, programKey: 'clinic' },
    { budgetSheetId: BUDGET_SHEET_ID_WORLD_CHALLENGE, programKey: 'world_challenge' }
  ];
}

// ───── GET HANDLER (fotos, saber, comunicaciones) ──────────────────────────────
function doGet(e) {
  const params = e.parameter || {};
  const action = params.action || '';
  Logger.log('doGet action=' + action + ' params=' + JSON.stringify(params));
  try {
    if (action === 'getAnalyticsSummary') return obtenerResumenAnalytics_(e);
    if (action === 'fotos') return listFiles(FOTOS_FOLDER_ID, 'image');
    if (action === 'memorias') return listFiles(MEMORIAS_FOLDER_ID, 'image');
    if (action === 'saber') {
      if (!SABER_FOLDER_ID || SABER_FOLDER_ID.indexOf('REEMPLAZAR') >= 0)
        return ContentService.createTextOutput('[]').setMimeType(ContentService.MimeType.JSON);
      return listFiles(SABER_FOLDER_ID, 'all');
    }
    if (action === 'comunicaciones') return getComunicaciones(params.email || '', params.programa || '');
    if (action === 'marcar_comunicados_vistos') return marcarComunicadosVistos(params.email || '', params.count || '0', params.programa || '');
    if (action === 'comercial_login') return getComercialData(params.email || '');
    if (action === 'buscar') return buscarParticipantes(params.email || '');
    if (action === 'mis_pagos') return getMisPagos(params.nombre || '', params.programa || '');
    if (action === 'tasa_wise') return getTasaWise_();
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

function getAbonosValidados_(nombre, budgetSheetId) {
  function normNombreGS(s) {
    return String(s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function fmtDateGS(v) {
    if (v instanceof Date) return String(v.getDate()).padStart(2,'0') + '/' + String(v.getMonth()+1).padStart(2,'0') + '/' + v.getFullYear();
    return String(v == null ? '' : v).trim();
  }
  const resultado = {
    reserva: 0, tiquete: 0, final: 0,
    reserva_fecha: '', tiquete_fecha: '', final_fecha: '',
    // *_comision = parte de lo pagado que es el recargo del 3.5% de Bold (pago
    // con tarjeta) — no cuenta para el saldo del programa (ver reserva/tiquete/
    // final arriba, que ya vienen SIN esa comisión). *_bruto = lo realmente
    // pagado incluyendo la comisión, para mostrarle al cliente y al admin el
    // total real que salió de su bolsillo. reserva = reserva_bruto - reserva_comision.
    reserva_comision: 0, tiquete_comision: 0, final_comision: 0,
    reserva_bruto: 0, tiquete_bruto: 0, final_bruto: 0,
    // *_cop_bruto = el equivalente en COP de *_bruto (lo realmente pagado,
    // tomado directo del Valor COP de la hoja / cada entrada del historial) —
    // para mostrarle al cliente el abono recibido también en COP, igual que
    // ya se le muestra en EUR.
    reserva_cop_bruto: 0, tiquete_cop_bruto: 0, final_cop_bruto: 0,
    // *_estado = el estado (Completo/Parcial/Pendiente de confirmar/...) de la
    // fila PROPIA de este participante para ese concepto — a diferencia de
    // reserva/tiquete/final arriba (que suman TODOS los abonos validados del
    // grupo), esto es SOLO de esta persona. Se usa para exigir que cada
    // participante del grupo esté individualmente en Completo antes de dar
    // por pagado el concepto — no basta con que la suma del grupo alcance.
    reserva_estado: '', tiquete_estado: '', final_estado: ''
  };
  try {
    const nombreNorm = normNombreGS(nombre);
    if (!nombreNorm) return resultado;
    const ss = SpreadsheetApp.openById(budgetSheetId || BUDGET_SHEET_ID);
    const pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return resultado;
    const lastRow = pagosSheet.getLastRow();
    if (lastRow < 6) return resultado;
    const pc = getPagosColMap_(pagosSheet);
    const metodoCol = pc.metodo_de_pago || 0; // columna opcional — 0 si la hoja aún no la tiene
    const historialCol = pc.historial_de_abonos || 0;
    const lastCol = Math.max(11, metodoCol, historialCol);
    const data = pagosSheet.getRange(6, 1, lastRow - 5, lastCol).getValues();
    const num = function(v) {
      if (typeof v === 'number') return v;
      var s = String(v == null ? '' : v).trim().replace(/[€$\s]/g,'').replace(/\.(?=\d{3})/g,'').replace(',','.');
      return parseFloat(s) || 0;
    };
    const fechaMasReciente = { reserva: null, tiquete: null, final: null };
    let currentNombre = '';
    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      const rowNombre = String(r[1] || '').trim();
      if (rowNombre) {
        if (rowNombre.toLowerCase().indexOf('total') >= 0) { currentNombre = ''; continue; }
        currentNombre = rowNombre;
      }
      if (!currentNombre || normNombreGS(currentNombre) !== nombreNorm) continue;
      const estado = String(r[5] || '').toLowerCase().trim();
      const conceptoRaw = String(r[7] || '').toLowerCase().trim();
      const concepto = conceptoRaw === 'pago final' ? 'final' : conceptoRaw;
      if (concepto !== 'reserva' && concepto !== 'tiquete' && concepto !== 'final') continue;
      // Guardar el estado de ESTA fila siempre, sin importar el filtro de abono
      // de abajo — así se sabe si esta persona en particular ya quedó Completo.
      resultado[concepto + '_estado'] = estado;
      if (estado !== 'completo' && estado !== 'parcial') continue; // solo suma abonos validados
      const eurBruto = num(r[4]);
      if (eurBruto <= 0) continue;
      const copBrutoFila = num(r[3]);
      // Valor EUR en la hoja = lo REALMENTE pagado (bruto). Si fue con tarjeta,
      // ese bruto trae el recargo de Bold incluido — se separa aquí para que
      // "concepto" (reserva/tiquete/final) quede SIEMPRE en base, sin comisión,
      // que es lo que cuenta contra el saldo del programa. El % de recargo
      // normalmente es el vigente (RECARGO_TARJETA_PCT), salvo que la celda
      // tenga un % puntual distinto (ver recargoTarjetaDeCelda_).
      const metodoRowRaw = metodoCol ? String(r[metodoCol - 1] || '') : '';
      // Si el concepto se pagó en varios abonos (ej. primero transferencia,
      // luego un segundo abono con tarjeta), cada entrada del historial puede
      // tener su propio método — se calcula base/comisión ENTRADA POR ENTRADA,
      // no sobre el total sumado de la fila, para no aplicarle el recargo a
      // dinero que nunca pasó por tarjeta. Una entrada sin método propio (o
      // sin historial en absoluto — pago único, o registrado antes de que
      // existiera esta columna) usa el método de la fila como respaldo.
      const historialRaw = historialCol ? String(r[historialCol - 1] || '') : '';
      const entradasFila = parseHistorialAbonos_(historialRaw);
      const abonos = entradasFila.length > 0
        ? entradasFila.map(function(en) { return { eur: en.eur, cop: en.cop, metodo: en.metodo || metodoRowRaw }; })
        : [{ eur: eurBruto, cop: copBrutoFila, metodo: metodoRowRaw }];
      abonos.forEach(function(abono) {
        const recargoAbono = recargoTarjetaDeCelda_(abono.metodo);
        let eurBase = abono.eur, eurComision = 0;
        if (recargoAbono !== null) {
          // Redondeado a 2 decimales — dividir por (1+recargo) produce
          // decimales largos (ej. 389.417475728155) que luego, si se vuelven
          // a escribir en el Sheet, pueden causar #ERROR por el separador
          // decimal del locale en español (ver sumHistorial_).
          eurBase = Math.round((abono.eur / (1 + recargoAbono)) * 100) / 100;
          eurComision = Math.round((abono.eur - eurBase) * 100) / 100;
        }
        resultado[concepto] += eurBase;
        resultado[concepto + '_comision'] += eurComision;
        resultado[concepto + '_bruto'] += abono.eur;
        resultado[concepto + '_cop_bruto'] += (abono.cop || 0);
      });
      const fechaCelda = r[2];
      const fechaComparable = (fechaCelda instanceof Date) ? fechaCelda : new Date(String(fechaCelda));
      if (!isNaN(fechaComparable.getTime()) && (!fechaMasReciente[concepto] || fechaComparable > fechaMasReciente[concepto])) {
        fechaMasReciente[concepto] = fechaComparable;
        resultado[concepto + '_fecha'] = fmtDateGS(fechaCelda);
      }
    }
  } catch (err) {
    Logger.log('getAbonosValidados_ error: ' + err);
  }
  return resultado;
}

// Busca participantes por email en la hoja principal (índice [0]) de UN sheet
// de inscripción, y adjunta sus abonos validados desde su sheet de presupuesto
// correspondiente. Se llama una vez por programa desde buscarParticipantes().
function buscarParticipantesEnHoja_(emailNorm, fuente) {
  const out = [];
  try {
    const sheet = SpreadsheetApp.openById(fuente.sheetId).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return out;

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
      // Marca de qué programa/sheet viene esta fila — el frontend la usa para
      // rutear al área personal correcta y para saber a qué presupuesto
      // apuntar en las llamadas de pago (registrar_pago, etc.)
      participant['_program_key'] = fuente.programKey;
      // Adjuntar abonos validados (Completo/Parcial) por concepto, desde el
      // sheet de presupuesto del MISMO programa que este participante.
      const nombreParaAbonos = participant['Nombre completo'] || participant['nombre'] || participant['Nombre'] || '';
      const abonos = getAbonosValidados_(nombreParaAbonos, fuente.budgetSheetId);
      participant['abono_reserva'] = String(abonos.reserva);
      participant['abono_tiquete'] = String(abonos.tiquete);
      participant['abono_final'] = String(abonos.final);
      participant['abono_reserva_fecha'] = abonos.reserva_fecha;
      participant['abono_tiquete_fecha'] = abonos.tiquete_fecha;
      participant['abono_final_fecha'] = abonos.final_fecha;
      // Comisión de tarjeta (3.5% Bold) y bruto real pagado — abono_* de arriba
      // ya viene SIN esta comisión (es lo que cuenta para el saldo); estos campos
      // son solo para mostrarle al cliente/admin el desglose de lo pagado.
      participant['abono_reserva_comision'] = String(abonos.reserva_comision);
      participant['abono_tiquete_comision'] = String(abonos.tiquete_comision);
      participant['abono_final_comision'] = String(abonos.final_comision);
      participant['abono_reserva_bruto'] = String(abonos.reserva_bruto);
      participant['abono_tiquete_bruto'] = String(abonos.tiquete_bruto);
      participant['abono_final_bruto'] = String(abonos.final_bruto);
      // Equivalente en COP de lo realmente pagado (bruto) — para mostrar el
      // abono recibido también en COP en el área personal.
      participant['abono_reserva_cop_bruto'] = String(abonos.reserva_cop_bruto);
      participant['abono_tiquete_cop_bruto'] = String(abonos.tiquete_cop_bruto);
      participant['abono_final_cop_bruto'] = String(abonos.final_cop_bruto);
      // Estado de la fila PROPIA de este participante (no del grupo) — usado
      // para exigir que cada quien esté individualmente Completo.
      participant['abono_reserva_estado'] = abonos.reserva_estado;
      participant['abono_tiquete_estado'] = abonos.tiquete_estado;
      participant['abono_final_estado'] = abonos.final_estado;
      out.push(participant);
    }
  } catch (err) {
    Logger.log('buscarParticipantesEnHoja_ error (' + fuente.programKey + '): ' + err);
  }
  return out;
}

function buscarParticipantes(email) {
  try {
    const emailNorm = email.toString().toLowerCase().trim();
    if (!emailNorm) return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);

    // Busca en los dos programas — Clinic y World Challenge — y combina los
    // resultados. Cada fila queda marcada con _program_key para que el área
    // personal sepa a cuál pertenece.
    const fuentes = [
      { sheetId: SHEET_ID, budgetSheetId: BUDGET_SHEET_ID, programKey: 'clinic' },
      { sheetId: SHEET_ID_WORLD_CHALLENGE, budgetSheetId: BUDGET_SHEET_ID_WORLD_CHALLENGE, programKey: 'world_challenge' }
    ];
    let participants = [];
    for (let f = 0; f < fuentes.length; f++) {
      participants = participants.concat(buscarParticipantesEnHoja_(emailNorm, fuentes[f]));
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

// Proxy server-side de la tasa mid-market de Wise (EUR->COP). El endpoint público de
// Wise no tiene CORS habilitado, así que el navegador nunca puede leerlo directamente
// desde areapersonal.html — UrlFetchApp sí puede, porque corre en el servidor y no
// está sujeto a la política CORS del navegador.
function getTasaWise_() {
  try {
    const response = UrlFetchApp.fetch(
      'https://wise.com/rates/history+live?source=EUR&target=COP&length=1&resolution=daily&unit=day',
      { muteHttpExceptions: true }
    );
    if (response.getResponseCode() !== 200) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false })).setMimeType(ContentService.MimeType.JSON);
    }
    const data = JSON.parse(response.getContentText());
    const ultimo = Array.isArray(data) ? data[data.length - 1] : null;
    if (!ultimo || !ultimo.value) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, value: ultimo.value })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('getTasaWise_ error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ ok: false })).setMimeType(ContentService.MimeType.JSON);
  }
}

// Devuelve al propio participante (por nombre, sin token — mismo nivel de
// exposición que buscarParticipantes) el estado real de sus pagos de Reserva/
// Tiquete/Pago Final según quedaron registrados en la hoja Pagos. Se usa para
// que el área personal muestre "lo que efectivamente pagó" solo cuando el
// admin ya validó el pago (estado Completo o Parcial) — mientras esté
// "Pendiente de confirmar", el frontend sigue mostrando su propio cálculo.
function getMisPagos(nombre, programa) {
  try {
    const nombreNorm = String(nombre || '').toLowerCase().trim();
    if (!nombreNorm) return ContentService.createTextOutput(JSON.stringify({})).setMimeType(ContentService.MimeType.JSON);

    const ss = SpreadsheetApp.openById(resolverSheets_(programa).budgetSheetId);
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
    const eur = String(data.eur || '').trim();
    const tasa = String(data.tasa || '').trim();
    const quien = nombre ? (nombre + ' (' + email + ')') : email;
    const fecha = Utilities.formatDate(new Date(), 'America/Bogota', 'dd/MM/yyyy HH:mm');
    const subject = '[Área Personal] Seleccionó método de pago — ' + (nombre || email) + ' · ' + panelLabel;
    const body = quien + ' seleccionó pagar por "' + metodoLabel + '" para ' + panelLabel + '.\n\n' +
      'Monto mostrado: ' + (monto || 'no disponible') + '\n' +
      'Monto en euros: ' + (eur || 'no disponible') + '\n' +
      'Tasa de cambio pagada: ' + (tasa || 'no disponible') + '\n' +
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

function getComunicaciones(email, programa) {
  const fuente = resolverSheets_(programa);
  const sheet = SpreadsheetApp.openById(fuente.sheetId).getSheetByName('Comunicaciones');
  const emailNorm = String(email || '').toLowerCase().trim();
  const seen = emailNorm ? (parseInt(PropertiesService.getScriptProperties().getProperty('comun_seen_' + fuente.programKey + '_' + emailNorm)) || 0) : 0;
  if (!sheet) return ContentService.createTextOutput(JSON.stringify({ mensajes: [], seen: seen }))
    .setMimeType(ContentService.MimeType.JSON);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return ContentService.createTextOutput(JSON.stringify({ mensajes: [], seen: seen }))
    .setMimeType(ContentService.MimeType.JSON);
  const result = data.slice(1).reverse()
    .filter(r => r[0])
    .map(r => ({ fecha: String(r[0]), titulo: String(r[1] || ''), mensaje: String(r[2] || ''), destinatario: String(r[3] || 'todos') }));
  return ContentService.createTextOutput(JSON.stringify({ mensajes: result, seen: seen }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Guarda cuántos comunicados ha visto ya un participante (por email), para que
// el aviso de "nuevo mensaje" al iniciar sesión sobreviva a cambios de
// navegador/dispositivo o modo incógnito (a diferencia de localStorage).
function marcarComunicadosVistos(email, count, programa) {
  try {
    const emailNorm = String(email || '').toLowerCase().trim();
    if (emailNorm) {
      const programKey = resolverSheets_(programa).programKey;
      PropertiesService.getScriptProperties().setProperty('comun_seen_' + programKey + '_' + emailNorm, String(parseInt(count) || 0));
    }
  } catch (err) {
    Logger.log('marcarComunicadosVistos error: ' + err);
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
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

// ── Ejecutar UNA VEZ desde el editor para instalar el trigger (World Challenge) ─
function crearTriggerComunicadosWorldChallenge() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'notificarNuevoComunicadoWorldChallenge') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('notificarNuevoComunicadoWorldChallenge')
    .forSpreadsheet(SHEET_ID_WORLD_CHALLENGE)
    .onEdit()
    .create();
  Logger.log('Trigger creado correctamente (World Challenge).');
}

// ───── NOTIFICAR NUEVO COMUNICADO ─────────────────────────────────────────────
// Función compartida por ambos programas — sourceSheetId es el sheet de
// Inscripciones/Comunicaciones a leer, propKey separa el hash de
// deduplicación de cada programa (para que publicar en uno no bloquee el
// mismo título+mensaje publicado luego en el otro).
function notificarNuevoComunicadoDesde_(e, sourceSheetId, propKey) {
  try {
    // Solo actuar si el edit fue en la columna C (Mensaje) de la hoja Comunicaciones
    if (!e || !e.range) return;
    if (e.range.getSheet().getName() !== 'Comunicaciones') return;
    if (e.range.getColumn() !== 3) return; // columna C = índice 3

    const ss = SpreadsheetApp.openById(sourceSheetId);
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
    const lastHash = props.getProperty(propKey) || '';
    if (currentHash === lastHash) return;

    const nombreProgramaCorto = sourceSheetId === SHEET_ID_WORLD_CHALLENGE ? 'Real Madrid Foundation World Challenge' : 'Real Madrid Foundation Clinic';

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

    const link = 'https://victory.com.es/areapersonal.html?tab=comunicaciones';
    const subject = '⚠ Nuevo comunicado';
    const preview = mensaje.length > 180 ? mensaje.substring(0, 180).trim() + '...' : mensaje;
    const htmlBody = buildComunicadoHtml(fecha, titulo, preview, link, sourceSheetId === SHEET_ID_WORLD_CHALLENGE ? 'world_challenge' : 'clinic');
    const adminEmail = 'alejandro.cabrera@fundacionrevel.net';
    emails.forEach(function(em) {
      try { GmailApp.sendEmail(em, subject, 'Tienes un nuevo comunicado: ' + link, { htmlBody: htmlBody, replyTo: adminEmail, name: nombreProgramaCorto }); }
      catch(err) { Logger.log('Error enviando a ' + em + ': ' + err); }
    });
    GmailApp.sendEmail(adminEmail, '[Admin] Comunicado enviado — ' + titulo, '', { htmlBody: htmlBody, name: nombreProgramaCorto });
    props.setProperty(propKey, currentHash);
  } catch(err) {
    Logger.log('notificarNuevoComunicadoDesde_ error (' + sourceSheetId + '): ' + err);
  }
}

function notificarNuevoComunicado(e) {
  notificarNuevoComunicadoDesde_(e, SHEET_ID, 'comun_last_hash');
}

function notificarNuevoComunicadoWorldChallenge(e) {
  notificarNuevoComunicadoDesde_(e, SHEET_ID_WORLD_CHALLENGE, 'comun_last_hash_wc');
}

// ───── ACTUALIZAR PASO (todas las filas del mismo email) ───────────────────────
function actualizarPasoTodos(email, pasoActual, programa) {
  try {
    const sheet = SpreadsheetApp.openById(resolverSheets_(programa).sheetId).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    const headers = data[0] || [];
    let emailCol = -1, pasoCol = -1, nombreCol = -1;
    for (let j = 0; j < headers.length; j++) {
      const h = String(headers[j]).toLowerCase().trim();
      if (h === 'email' || h === 'correo' || h === 'correo electrónico' || h === 'correo electronico' || h === 'e-mail') emailCol = j;
      if (h === 'paso_actual' || h === 'paso actual') pasoCol = j;
      if (h === 'nombre') nombreCol = j;
    }
    if (emailCol < 0) emailCol = 3;  // Fallback: Columna D (índice 0)
    if (pasoCol < 0) pasoCol = 20;   // Fallback: Columna U (índice 0)
    if (nombreCol < 0) nombreCol = 2;
    const emailNorm = email.toString().toLowerCase().trim();
    let updated = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i][emailCol].toString().toLowerCase().trim() === emailNorm) {
        const pasoActual_num = parseInt(pasoActual) || 0;
        const pasoActualSheet = parseInt(data[i][pasoCol]) || 0;
        if (pasoActual_num <= pasoActualSheet) continue; // nunca retroceder
        sheet.getRange(i + 1, pasoCol + 1).setValue(pasoActual);
        updated++;
        // Proceso 100% completo (paso 7): enviar correo de bienvenida final +
        // aviso interno, solo la primera vez que se cruza este umbral.
        if (pasoActual_num === 7 && pasoActualSheet < 7) {
          const nombreParticipante = String(data[i][nombreCol] || '').trim();
          if (nombreParticipante) enviarCorreoProcesoCompletado_(emailNorm, nombreParticipante, programa);
        }
      }
    }
    return sendResponse(200, { ok: true, updated });
  } catch (err) {
    Logger.log('actualizarPasoTodos error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function buildProcesoCompletadoHtml_(nombreCompleto, programa) {
  const primerNombre = obtenerNombrePila_(nombreCompleto) || nombreCompleto;
  const esWC = esWorldChallenge_(programa);
  const nombrePrograma = esWC ? 'Real Madrid Foundation World Challenge 2027' : 'Real Madrid Foundation Clinic 2026';
  const nombreProgramaCorto = esWC ? 'Real Madrid Foundation World Challenge' : 'Real Madrid Foundation Clinic';
  const parrafoIntro = esWC
    ? 'Ahora solo queda contar los días para vivir esta experiencia única en la Ciudad Deportiva del Real Madrid. Nuestro equipo ya tiene todo tu registro listo para el Real Madrid Foundation World Challenge 2027.'
    : 'Ahora solo queda contar los días para vivir esta experiencia única en la Ciudad Deportiva del Real Madrid. Nuestro equipo ya tiene todo tu registro listo para el Real Madrid Foundation Clinic 2026.';
  const parrafoComunicados = esWC
    ? 'Puedes volver a tu área personal cuando quieras para ver los detalles de tu viaje, el álbum de fotos (disponible durante y después del programa), y cualquier comunicado que enviemos antes de marzo.'
    : 'Puedes volver a tu área personal cuando quieras para ver los detalles de tu viaje, el álbum de fotos (disponible durante y después del programa), y cualquier comunicado que enviemos antes de octubre.';
  return `
<div style="margin:0;padding:0;background:#eef1f5;font-family:'DM Sans',Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;">
    <div style="background:#0b1f3a;padding:32px 30px 26px;text-align:center;">
      <img src="https://lh3.googleusercontent.com/d/1Ve6IkxqSoXZWQM9triDoYm0FJ2aF4Ub6" alt="Victory" style="height:34px;margin:0 8px;">
      <img src="https://lh3.googleusercontent.com/d/1USK2ut3e0f1VwBbQ8uNqVSD517KtdZZQ" alt="RMF" style="height:34px;margin:0 8px;">
      <img src="https://lh3.googleusercontent.com/d/1XfpwTY8c5GDI4ssInLnIKxJ37UOPKKmO" alt="Revel" style="height:34px;margin:0 8px;">
    </div>
    <div style="background:#0b1f3a;padding:0 30px 40px;text-align:center;">
      <div style="font-size:52px;line-height:1;margin-bottom:6px;">&#x1F389;\u{2705}</div>
      <h1 style="font-family:'Bebas Neue',sans-serif;color:#fff;font-size:32px;letter-spacing:1px;margin:0 0 6px;line-height:1.2;">¡Todo listo, ${primerNombre}!</h1>
      <div style="color:rgba(255,255,255,.75);font-size:14px;">Tu proceso de inscripción está 100% completo</div>
    </div>
    <div style="padding:34px 34px 10px;color:#1a2c4a;">
      <p style="font-size:18px;font-weight:500;color:#0b1f3a;margin:0 0 18px;">Ya completaste cada paso del proceso — pagos, documentos, todo en orden.</p>
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">${parrafoIntro}</p>
      <div style="background:#f4f7fb;border-radius:10px;padding:18px 20px;margin:22px 0;">
        <div style="display:flex;align-items:center;gap:10px;font-size:14px;color:#1a2c4a;padding:6px 0;"><span style="color:#00a86b;font-weight:700;">✓</span> Términos y condiciones aceptados</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:14px;color:#1a2c4a;padding:6px 0;"><span style="color:#00a86b;font-weight:700;">✓</span> Pago de reserva confirmado</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:14px;color:#1a2c4a;padding:6px 0;"><span style="color:#00a86b;font-weight:700;">✓</span> Pago final confirmado</div>
        <div style="display:flex;align-items:center;gap:10px;font-size:14px;color:#1a2c4a;padding:6px 0;"><span style="color:#00a86b;font-weight:700;">✓</span> Documentación validada</div>
      </div>
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">${parrafoComunicados}</p>
      <div style="text-align:center;margin:28px 0 8px;">
        <a href="https://victory.com.es/areapersonal.html?goto=done" style="display:inline-block;background:#1e5ba8;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 30px;border-radius:8px;">Ver mi Bienvenida →</a>
      </div>
      <p style="text-align:center;font-size:13px;color:#6b7688;margin-top:6px;">Te lleva directo a tu pantalla de bienvenida al programa.</p>
    </div>
    <div style="padding:10px 34px 30px;color:#1a2c4a;">
      <p style="margin:2px 0;font-size:14px;font-weight:700;color:#0b1f3a;margin-top:14px;">Con emoción por lo que viene,</p>
      <p style="margin:2px 0;font-size:14px;">Equipo Victory Sports · Fundación Revel</p>
      <p style="margin:2px 0;font-size:14px;">${nombrePrograma}</p>
    </div>
    <div style="background:#f4f7fb;padding:20px 30px;text-align:center;font-size:12px;color:#8a93a6;">
      ¿Dudas? Escríbenos por WhatsApp o a <a href="mailto:alejandro.cabrera@fundacionrevel.net" style="color:#1e5ba8;text-decoration:none;">alejandro.cabrera@fundacionrevel.net</a>
    </div>
  </div>
</div>`;
}

function enviarCorreoProcesoCompletado_(email, nombreCompleto, programa) {
  try {
    if (!email || !nombreCompleto) return;
    const esWC = esWorldChallenge_(programa);
    const nombreProgramaCorto = esWC ? 'Real Madrid Foundation World Challenge' : 'Real Madrid Foundation Clinic';
    const primerNombre = obtenerNombrePila_(nombreCompleto) || nombreCompleto;
    const asunto = '\u{2705} ¡Todo listo, ' + primerNombre + '!';
    const htmlBody = buildProcesoCompletadoHtml_(nombreCompleto, programa);
    GmailApp.sendEmail(email, asunto, 'Has completado tu proceso de inscripción. Ingresa a tu área personal para ver los detalles: https://victory.com.es/areapersonal.html?goto=done', {
      htmlBody: htmlBody,
      name: nombreProgramaCorto
    });
    try {
      GmailApp.sendEmail(
        'alejandro.cabrera@fundacionrevel.net',
        '[Recordatorio] Proceso completado: ' + nombreCompleto,
        nombreCompleto + ' completó el 100% de su proceso (pagos + documentación).\n\n' +
        'Correo del acudiente: ' + email + '\n' +
        'Ya se le envió automáticamente el correo de bienvenida.',
        { name: nombreProgramaCorto }
      );
    } catch (notifErr) {
      Logger.log('Aviso interno proceso completado error: ' + notifErr);
    }
  } catch (err) {
    Logger.log('enviarCorreoProcesoCompletado_ error: ' + err);
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
        if (parsed.action === 'track') return registrarEventoAnalytics_(parsed);
        if (parsed.action === 'actualizar_paso' && parsed.email && parsed.paso_actual) {
          return actualizarPasoTodos(parsed.email, parsed.paso_actual, parsed.programa);
        }
        if (parsed.action === 'notificar_click_bold') return notificarClickBold(parsed);
        if (parsed.action === 'marcar_comprobante_pendiente') return marcarComprobanteSubido(parsed);
        if (parsed.action === 'publicar_comunicado') return publicarComunicado(parsed);
        if (parsed.action === 'eliminar_comunicado') return eliminarComunicado(parsed);
        if (parsed.action === 'actualizar_participante') return actualizarParticipante(parsed);
        if (parsed.action === 'registrar_pago') return registrarPago(parsed);
        if (parsed.action === 'agregar_abono_pago') return agregarAbonoPago(parsed);
        if (parsed.action === 'confirmar_pago_pendiente') return confirmarPagoPendiente(parsed);
        if (parsed.action === 'actualizar_estado_pago') return actualizarEstadoPago(parsed);
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
function emailEsParticipante_(email, programa) {
  const emailNorm = String(email || '').toLowerCase().trim();
  if (!emailNorm) return false;
  const sheet = SpreadsheetApp.openById(resolverSheets_(programa).sheetId).getSheets()[0];
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
function buscarEmailPorNombre_(nombre, programa) {
  const nombreNorm = String(nombre || '').toLowerCase().trim();
  if (!nombreNorm) return '';
  const sheet = SpreadsheetApp.openById(resolverSheets_(programa).sheetId).getSheets()[0];
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
function notificarPagoConfirmado(nombre, tipo, eur, cop, estado, programa, metodoPago, esperadoEur, historialEntradas) {
  try {
    const email = buscarEmailPorNombre_(nombre, programa);
    if (!email) {
      Logger.log('notificarPagoConfirmado: no se encontró email para ' + nombre);
      return;
    }
    const esWC = esWorldChallenge_(programa);
    const nombrePrograma = esWC ? 'Real Madrid Foundation World Challenge 2027' : 'Real Madrid Foundation Clinic 2026';
    const nombreProgramaCorto = esWC ? 'Real Madrid Foundation World Challenge' : 'Real Madrid Foundation Clinic';
    const esCompleto = String(estado || '').toLowerCase().trim() === 'completo';
    const tipoLabels = { 'reserva': 'la Reserva', 'tiquete': 'el Tiquete Aéreo', 'pago final': 'el Pago Final' };
    const tipoLabel = tipoLabels[String(tipo || '').toLowerCase().trim()] || tipo;
    const montoTexto = (cop > 0 ? '$' + Math.round(cop).toLocaleString('es-CO') + ' COP' : '')
      + (cop > 0 && eur > 0 ? ' · ' : '')
      + (eur > 0 ? eur.toLocaleString('es-CO') + ' €' : '');
    // Saldo pendiente: `esperadoEur` es el total BASE (sin recargo) que le
    // corresponde a este participante para este concepto — lo calcula el
    // frontend (montoEsperadoEur_) porque ahí vive toda la tabla de precios
    // por tipo/habitación/programa. `eur` en cambio es el monto BRUTO (con
    // recargo de tarjeta incluido si aplica) — hay que quitarle el recargo
    // antes de restar, para no dejar un saldo pendiente artificialmente alto.
    const metodo = String(metodoPago || '').toLowerCase();
    const recargo = metodo.indexOf('tarjeta') === 0 ? RECARGO_TARJETA_PCT : 0;
    const baseEur = recargo ? Math.round((eur / (1 + recargo)) * 100) / 100 : eur;
    const restanteEur = (typeof esperadoEur === 'number' && esperadoEur > 0)
      ? Math.max(0, Math.round((esperadoEur - baseEur) * 100) / 100)
      : null;
    const link = 'https://victory.com.es/areapersonal.html';
    const colorHeader = esCompleto ? '#166534' : '#854f0b';
    const colorMonto  = esCompleto ? '#166534' : '#854f0b';
    const tituloHeader = esCompleto ? 'Pago confirmado' : 'Abono registrado';
    const montoLabel = esCompleto ? 'Monto confirmado' : 'Abono recibido';
    const cuerpoTexto = esCompleto
      ? 'Confirmamos que tu pago correspondiente a <strong>' + tipoLabel + '</strong> ha sido registrado correctamente.'
      : 'Registramos un abono a cuenta de <strong>' + tipoLabel + '</strong>. Este pago queda guardado en tu historial de pagos.';
    const subject = (esCompleto ? '✅ Pago confirmado — ' : '💰 Abono registrado — ') + tipoLabel + ' · ' + (esWC ? 'RMF World Challenge 2027' : 'RMF Clinic 2026');
    const saldoBox = restanteEur === null ? '' : (
      '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin:18px 0">'
      + '<p style="font-size:12px;color:#94a3b8;margin:0 0 4px">Saldo pendiente de ' + tipoLabel + '</p>'
      + '<p style="font-size:18px;color:' + (restanteEur > 0 ? '#92400e' : '#166534') + ';font-weight:600;margin:0">'
      + (restanteEur > 0 ? restanteEur.toLocaleString('es-CO') + ' €' : '0 € — sin saldo pendiente') + '</p></div>'
    );
    // Si hay 2+ abonos registrados para este concepto, el correo muestra el
    // desglose completo (abonos anteriores + el nuevo) en vez de solo el
    // total — así el participante ve exactamente qué se sumó, no solo el
    // resultado final.
    const entradasHist = Array.isArray(historialEntradas) ? historialEntradas : [];
    const tieneVariasEntradas = entradasHist.length > 1;
    const fmtEntradaAbono = function(en) {
      return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:13px;color:#334155;padding:4px 0">'
        + '<span>' + (en.fecha || '') + '</span>'
        + '<span>' + (en.eur || 0).toLocaleString('es-CO') + ' €' + (en.cop ? ' · $' + Math.round(en.cop).toLocaleString('es-CO') + ' COP' : '') + '</span></div>';
    };
    const montoBox = tieneVariasEntradas
      ? ('<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin:18px 0">'
        + '<p style="font-size:12px;color:#94a3b8;margin:0 0 6px">Abonos anteriores</p>'
        + entradasHist.slice(0, -1).map(fmtEntradaAbono).join('')
        + '<p style="font-size:12px;color:#94a3b8;margin:12px 0 6px;padding-top:8px;border-top:1px dashed #e2e8f0">Nuevo abono</p>'
        + fmtEntradaAbono(entradasHist[entradasHist.length - 1])
        + '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:baseline">'
        + '<span style="font-size:12px;color:#94a3b8;font-weight:600">Total abonado</span>'
        + '<span style="font-size:18px;color:' + colorMonto + ';font-weight:600">' + montoTexto + '</span></div></div>')
      : ('<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin:18px 0">'
        + '<p style="font-size:12px;color:#94a3b8;margin:0 0 4px">' + montoLabel + '</p>'
        + '<p style="font-size:18px;color:' + colorMonto + ';font-weight:600;margin:0">' + montoTexto + '</p></div>');
    const htmlBody = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">'
      + '<div style="background:' + colorHeader + ';padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">'
      + '<table cellpadding="0" cellspacing="0" style="margin:0 auto 12px auto"><tr>'
      + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1USK2ut3e0f1VwBbQ8uNqVSD517KtdZZQ" alt="Real Madrid Foundation" height="48" style="display:block;height:48px;width:auto"></td>'
      + '<td style="vertical-align:middle;padding:0 14px"><div style="width:1px;height:36px;background:rgba(255,255,255,0.45)"></div></td>'
      + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1XfpwTY8c5GDI4ssInLnIKxJ37UOPKKmO" alt="Fundacion Revel" height="40" style="display:block;height:40px;width:auto"></td>'
      + '</tr></table>'
      + '<h2 style="color:#fff;margin:0 0 4px;font-size:18px">' + nombrePrograma + '</h2>'
      + '<p style="color:rgba(255,255,255,.85);margin:0;font-size:13px;font-weight:600">' + tituloHeader + '</p></div>'
      + '<div style="background:#f8fafc;padding:28px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">'
      + '<p style="color:#334155;margin-top:0">Hola ' + nombre + ',</p>'
      + '<p style="color:#334155">' + cuerpoTexto + '</p>'
      + montoBox
      + saldoBox
      + '<a href="' + link + '" style="display:inline-block;background:#1e5ba8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Ver mi área personal →</a>'
      + '<p style="color:#94a3b8;font-size:12px;margin-top:20px">Si tienes dudas, escríbenos por WhatsApp o al correo alejandro.cabrera@fundacionrevel.net.</p>'
      + '<p style="color:#94a3b8;font-size:12px">Equipo Revel · ' + nombrePrograma + '</p></div></div>';
    GmailApp.sendEmail(email, subject, (esCompleto ? 'Tu pago' : 'Tu abono') + ' de ' + tipoLabel + ' ha sido registrado: ' + link, {
      htmlBody: htmlBody,
      replyTo: 'alejandro.cabrera@fundacionrevel.net',
      name: nombreProgramaCorto
    });
    // Copia al admin de lo enviado al participante, para que quede constancia
    // sin tener que ir a revisar el Sheet — falla en try/catch propio para no
    // afectar el correo ya enviado al participante si esta parte falla.
    try {
      GmailApp.sendEmail('alejandro.cabrera@fundacionrevel.net', '[Admin] Copia — ' + subject, '', {
        htmlBody: '<p style="font-family:Arial,sans-serif;font-size:13px;color:#64748b;margin:0 0 12px">Copia del correo enviado a <strong>' + nombre + '</strong> (' + email + ').</p>' + htmlBody,
        name: nombreProgramaCorto
      });
    } catch (errAdmin) {
      Logger.log('notificarPagoConfirmado (copia admin) error: ' + errAdmin);
    }
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
  const programa = params.programa || '';

  if (!email) {
    return sendResponse(400, { ok: false, error: 'Email requerido' });
  }
  if (!emailEsParticipante_(email, programa)) {
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
    const parentFolder = DriveApp.getFolderById(resolverParentFolderId_(programa));
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
    updateSheetWithUpload(email, tipo_documento, tipo_pago, fileName, fileUrl, fileId, programa);
    notificarDocumentoSubido(email, tipo_documento, tipo_pago, fileName, fileUrl, programa);

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
    const programa = data.programa || '';

    if (!email || !base64Data) {
      return sendResponse(400, { ok: false, error: 'Email y base64 requeridos' });
    }
    if (!emailEsParticipante_(email, programa)) {
      return sendResponse(403, { ok: false, error: 'Email no encontrado entre los participantes registrados' });
    }

    // Decodificar base64
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), getMimeType(fileName), fileName);

    // Crear estructura de carpetas
    const parentFolder = DriveApp.getFolderById(resolverParentFolderId_(programa));
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
    updateSheetWithUpload(email, tipo_documento, tipo_pago, finalFileName, fileUrl, fileId, programa);
    notificarDocumentoSubido(email, tipo_documento, tipo_pago, finalFileName, fileUrl, programa);

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
function notificarDocumentoSubido(email, tipoDoc, tipoPago, fileName, fileUrl, programa) {
  try {
    var notifyEmail = 'alejandro.cabrera@fundacionrevel.net';
    var nombreProgramaCorto = esWorldChallenge_(programa) ? 'Real Madrid Foundation World Challenge' : 'Real Madrid Foundation Clinic';

    // Buscar nombre del participante en la hoja principal
    var nombre = '';
    try {
      var mainSheet = SpreadsheetApp.openById(resolverSheets_(programa).sheetId).getSheets()[0];
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

    GmailApp.sendEmail(notifyEmail, subject, body, { name: nombreProgramaCorto });
  } catch (err) {
    Logger.log('notificarDocumentoSubido error: ' + err);
  }
}

// ───── ACTUALIZAR SHEETS ───────────────────────────────────────────────────────
function updateSheetWithUpload(email, tipoDoc, tipoPago, fileName, fileUrl, fileId, programa) {
  try {
    const sheet = SpreadsheetApp.openById(resolverSheets_(programa).sheetId).getSheetByName('Documentos');
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
        const requeridos = getDocumentosRequeridos(email, programa);
        const colsRequeridas = requeridos === 3
          ? ['doc_pasaporte', 'doc_permiso', 'doc_registro_civil']
          : ['doc_pasaporte'];
        let subidos = 0;
        colsRequeridas.forEach(function (cn) {
          const idx = headers.indexOf(cn);
          if (idx >= 0 && rowValues[idx] !== '' && rowValues[idx] !== null) subidos++;
        });
        actualizarContadorDocumentos(email, subidos, requeridos, programa);
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
function getDocumentosRequeridos(email, programa) {
  try {
    const emailNorm = String(email || '').toLowerCase().trim();
    if (!emailNorm) return 1;
    const sheet = SpreadsheetApp.openById(resolverSheets_(programa).sheetId).getSheets()[0];
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
function actualizarContadorDocumentos(email, subidos, requeridos, programa) {
  try {
    const emailNorm = String(email || '').toLowerCase().trim();
    const sheet = SpreadsheetApp.openById(resolverSheets_(programa).sheetId).getSheets()[0];
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
    const fuente = resolverSheets_(params.programa);
    const sheet = SpreadsheetApp.openById(fuente.sheetId).getSheets()[0];
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return sendResponse(200, []);
    const headers = data[0];
    const result = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row.every(function(c) { return c === '' || c === null; })) continue;
      const obj = { _row: i + 1, _program_key: fuente.programKey };
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

// Devuelve la hoja "Comunicaciones" del programa dado, creándola con sus
// cabeceras si aún no existe (World Challenge parte de un sheet nuevo y puede
// no tenerla todavía).
function getComunicacionesSheet_(programa, create) {
  const ss = SpreadsheetApp.openById(resolverSheets_(programa).sheetId);
  let sheet = ss.getSheetByName('Comunicaciones');
  if (!sheet && create) {
    sheet = ss.insertSheet('Comunicaciones');
    sheet.getRange(1, 1, 1, 4).setValues([['Fecha', 'Título', 'Mensaje', 'Destinatario']]);
  }
  return sheet;
}

function publicarComunicado(data) {
  try {
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
    const sheet = getComunicacionesSheet_(data.programa, true);
    const fecha = data.fecha || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const titulo = String(data.titulo || '').trim();
    const mensaje = String(data.mensaje || '').trim();
    const destinatario = String(data.destinatario || 'todos').trim();
    if (!titulo || !mensaje) return sendResponse(400, { ok: false, error: 'Titulo y mensaje requeridos' });
    // Save to sheet (col D = destinatario)
    sheet.appendRow([fecha, titulo, mensaje, destinatario]);
    // Send emails directly with filter — solo a participantes de ESTE programa
    var sent = enviarEmailsComunicado({ fecha: fecha, titulo: titulo, mensaje: mensaje, destinatario: destinatario, programa: data.programa });
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
    var programa = params.programa || '';
    var nombreProgramaCorto = esWorldChallenge_(programa) ? 'Real Madrid Foundation World Challenge' : 'Real Madrid Foundation Clinic';

    var ss = SpreadsheetApp.openById(resolverSheets_(programa).sheetId);
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

    var link = 'https://victory.com.es/areapersonal.html?tab=comunicaciones';
    var subject = '⚠ Nuevo comunicado';
    var preview = mensaje.length > 180 ? mensaje.substring(0, 180).trim() + '...' : mensaje;
    var htmlBody = buildComunicadoHtml(fecha, titulo, preview, link, programa);
    var adminEmail = 'alejandro.cabrera@fundacionrevel.net';

    emails.forEach(function(em) {
      try { GmailApp.sendEmail(em, subject, 'Tienes un nuevo comunicado: ' + link, { htmlBody: htmlBody, replyTo: adminEmail, name: nombreProgramaCorto }); }
      catch(e2) { Logger.log('Error enviando a ' + em + ': ' + e2); }
    });

    // Admin confirmation
    try {
      GmailApp.sendEmail(adminEmail, '[Admin] Comunicado enviado (' + emails.length + ' dest.) — ' + titulo, '', { htmlBody: htmlBody, name: nombreProgramaCorto });
    } catch(e3) { Logger.log('Error enviando admin: ' + e3); }

    return emails.length;
  } catch(err) {
    Logger.log('enviarEmailsComunicado error: ' + err);
    return 0;
  }
}

function buildComunicadoHtml(fecha, titulo, preview, link, programa) {
  const nombrePrograma = esWorldChallenge_(programa) ? 'Real Madrid Foundation World Challenge 2027' : 'Real Madrid Foundation Clinic 2026';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">'
    + '<div style="background:#1e5ba8;padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">'
    + '<table cellpadding="0" cellspacing="0" style="margin:0 auto 12px auto"><tr>'
    + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1USK2ut3e0f1VwBbQ8uNqVSD517KtdZZQ" alt="Real Madrid Foundation" height="48" style="display:block;height:48px;width:auto"></td>'
    + '<td style="vertical-align:middle;padding:0 14px"><div style="width:1px;height:36px;background:rgba(255,255,255,0.45)"></div></td>'
    + '<td style="vertical-align:middle;padding:0"><img src="https://drive.google.com/uc?export=view&id=1XfpwTY8c5GDI4ssInLnIKxJ37UOPKKmO" alt="Fundacion Revel" height="40" style="display:block;height:40px;width:auto"></td>'
    + '</tr></table>'
    + '<h2 style="color:#fff;margin:0;font-size:18px">' + nombrePrograma + '</h2></div>'
    + '<div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">'
    + '<p style="color:#334155;margin-top:0">Tienes un nuevo comunicado del equipo Revel:</p>'
    + '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:16px 0">'
    + '<p style="font-size:12px;color:#94a3b8;margin:0 0 4px">' + fecha + '</p>'
    + '<h3 style="color:#1e3a5f;margin:0 0 12px;font-size:16px">' + titulo + '</h3>'
    + '<p style="color:#334155;margin:0;line-height:1.6;white-space:pre-wrap">' + preview + '</p></div>'
    + '<a href="' + link + '" style="display:inline-block;background:#1e5ba8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:4px">Ver mensaje completo en tu área personal →</a>'
    + '<p style="color:#94a3b8;font-size:12px;margin-top:20px">Equipo Revel · ' + nombrePrograma + '</p></div></div>';
}

function eliminarComunicado(data) {
  try {
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
    const sheet = getComunicacionesSheet_(data.programa, false);
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
    const sheet = SpreadsheetApp.openById(resolverSheets_(data.programa).sheetId).getSheets()[0];
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
    var ss = SpreadsheetApp.openById(resolverSheets_(data.programa).budgetSheetId);
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
    const ss = SpreadsheetApp.openById(resolverSheets_(params.programa).budgetSheetId);

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
      var pc = getPagosColMap_(pagosSheet);
      result.pagos_recibidos = {
        total_eur:  num(pagosSheet.getRange('E32').getValue()),
        total_cop:  num(pagosSheet.getRange('D32').getValue()),
        completos:  num(pagosSheet.getRange('G32').getValue()),
        parciales:  num(pagosSheet.getRange('G33').getValue())
      };
      var lastPagRow = pagosSheet.getLastRow();
      var pagData = [];
      var readWidth = Math.max(pc.jugador_acompanante, pc.nombre_familia, pc.fecha_pago, pc.valor_cop, pc.valor_eur, pc.estado, pc.paquete, pc.notas, pc.comprobante, pc.historial_de_abonos, pc.verificacion_ia, pc.detalle_ia, pc.metodo_de_pago || 0);
      if (lastPagRow >= 6) {
        pagData = pagosSheet.getRange(6, 1, lastPagRow - 5, readWidth).getValues();
        var tiposValidos3 = { 'reserva': true, 'tiquete': true, 'pago final': true };
        var currentNombre = '';
        var currentTipo   = '';
        for (var i = 0; i < pagData.length; i++) {
          var r = pagData[i];
          var rowNombre = str(r[pc.nombre_familia - 1]);
          var rowTipo   = str(r[pc.jugador_acompanante - 1]);
          if (rowNombre) {
            if (rowNombre.toLowerCase().indexOf('total') >= 0) { currentNombre = ''; continue; }
            currentNombre = rowNombre;
            if (rowTipo) currentTipo = rowTipo;
          }
          if (!currentNombre) continue;
          var eurAmt = num(r[pc.valor_eur - 1]);
          var copAmt = num(r[pc.valor_cop - 1]);
          // Antes solo exigía eurAmt > 0 — si por cualquier motivo el EUR de
          // una fila queda en 0 mientras el COP sí tiene un monto real (ej.
          // un envío con el campo EUR vacío), la fila desaparecía del panel
          // sin dejar rastro para revisión. Ahora basta con que CUALQUIERA de
          // los dos tenga monto para que el admin la vea y pueda corregirla.
          if (eurAmt <= 0 && copAmt <= 0) continue;
          var tipoG = str(r[pc.notas - 1]).toLowerCase();
          if (tipoG && !tiposValidos3[tipoG]) continue;
          var fechaVal = r[pc.fecha_pago - 1];
          if (!fechaVal || (!(fechaVal instanceof Date) && !str(fechaVal).match(/\d/))) continue;
          result.pagos_lista.push({
            tipo: currentTipo, nombre: currentNombre, fecha: fmtDate(fechaVal),
            cop: num(r[pc.valor_cop - 1]), eur: eurAmt,
            estado: str(r[pc.estado - 1]), paquete: str(r[pc.paquete - 1]), notas: str(r[pc.notas - 1]),
            comprobante_url: str(r[pc.comprobante - 1]),
            historial_abonos: str(r[pc.historial_de_abonos - 1]),
            ia_status: str(r[pc.verificacion_ia - 1]), ia_detalle: str(r[pc.detalle_ia - 1]),
            metodo_pago: pc.metodo_de_pago ? str(r[pc.metodo_de_pago - 1]) : ''
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

// ── Mapa de columnas de la hoja Pagos por nombre de encabezado (fila 5) ────
// Evita depender de posiciones fijas: si alguien reordena o inserta una
// columna en Pagos, este mapa se recalcula solo con que el texto del
// encabezado en fila 5 no cambie. Devuelve { clave_normalizada: numColumna1Based }.
function normPagosHeaderKey_(s) {
  return String(s || '')
    .toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getPagosColMap_(pagosSheet) {
  var headers = pagosSheet.getRange(5, 1, 1, pagosSheet.getLastColumn()).getValues()[0];
  var map = {};
  headers.forEach(function(h, idx) { map[normPagosHeaderKey_(h)] = idx + 1; });
  return map;
}

// ── Historial de abonos (columna "Historial de abonos") ───────────────────
// Formato: "dd/mm/yyyy:eur:cop:metodo;dd/mm/yyyy:eur:cop:metodo;..." — cada
// abono es una entrada independiente, con su propio método de pago (4to
// campo, opcional — entradas viejas sin él quedan con metodo=''). Esto
// permite que un mismo concepto (ej. Pago Final) se pague en varios abonos
// con métodos distintos (primero transferencia, después tarjeta) y que
// getAbonosValidados_() calcule la comisión SOLO sobre la parte que
// realmente se pagó con tarjeta, no sobre el total de la fila. Las columnas
// Valor COP / Valor EUR se reconstruyen como fórmulas de suma (=1000+300) a
// partir de este historial, para que el propio Sheet quede auditable en vez
// de mostrar solo un total plano.
function parseHistorialAbonos_(str) {
  if (!str) return [];
  return String(str).split(';').map(function(s) {
    var parts = s.trim().split(':');
    if (parts.length < 2) return null;
    return { fecha: parts[0], eur: parseFloat(parts[1]) || 0, cop: parseFloat(parts[2]) || 0, metodo: parts[3] || '' };
  }).filter(Boolean);
}

function buildHistorialString_(entradas) {
  return entradas.map(function(e) { return e.fecha + ':' + e.eur + ':' + (e.cop || 0) + ':' + (e.metodo || ''); }).join(';');
}

// Antes esto generaba una fórmula de texto ("=690.29+389.42...") con
// setFormula() para que el Sheet quedara auditable. Pero con montos que
// vienen de dividir por el recargo de tarjeta (ej. 389.417475728155, muchos
// decimales), esa fórmula usa punto decimal y el Sheet en español (que
// espera coma) la interpreta como #ERROR — así fue como el pago de Andrea
// terminó en 0 EUR. Ahora se suma el valor en Apps Script (que no depende de
// locale) y se escribe el número ya calculado con setValue() — la
// auditabilidad de "quién pagó qué" sigue disponible en la columna Historial
// de abonos, que guarda cada entrada por separado como texto.
function sumHistorial_(entradas, campo) {
  var suma = entradas.reduce(function(s, e) { return s + (e[campo] || 0); }, 0);
  return campo === 'cop' ? Math.round(suma) : Math.round(suma * 100) / 100;
}

// Cuando hay 2+ abonos, arma una fórmula de suma auditable (ej. "=500+500")
// para escribir en Valor EUR/COP con setFormulaLocal() — a diferencia del
// setFormula() que rompía antes (#ERROR bajo locale español, porque esperaba
// coma decimal y se le pasaba con punto), setFormulaLocal() SÍ respeta el
// locale del Sheet, así que aquí los números se formatean con coma decimal a
// propósito. Con un solo abono no tiene sentido mostrar "=500" — se deja como
// número plano (ver sumHistorial_ + setValue en cada punto de escritura).
function formulaLocalDesdeHistorial_(entradas, campo) {
  var valores = entradas
    .map(function(e) { return campo === 'cop' ? Math.round(e[campo] || 0) : Math.round((e[campo] || 0) * 100) / 100; })
    .filter(function(v) { return v !== 0; });
  if (valores.length < 2) return null;
  return '=' + valores.map(function(v) { return String(v).replace('.', ','); }).join('+');
}

// Escribe Valor EUR/COP a partir del historial acumulado — como fórmula
// auditable (=500+500) si hay 2+ abonos, o como número plano si es el único.
// SpreadsheetApp.flush() fuerza el recálculo antes de devolver el control,
// para que una lectura posterior de esta misma celda EN LA MISMA EJECUCIÓN
// (ej. otro abono llegando justo después) no encuentre un valor sin refrescar.
function escribirTotalesHistorial_(pagosSheet, pc, targetSheetRow, historialActual, sumaEur, sumaCop) {
  var formulaEur = formulaLocalDesdeHistorial_(historialActual, 'eur');
  var formulaCop = formulaLocalDesdeHistorial_(historialActual, 'cop');
  if (formulaEur) pagosSheet.getRange(targetSheetRow, pc.valor_eur).setFormulaLocal(formulaEur);
  else if (sumaEur > 0) pagosSheet.getRange(targetSheetRow, pc.valor_eur).setValue(sumaEur);
  if (formulaCop) pagosSheet.getRange(targetSheetRow, pc.valor_cop).setFormulaLocal(formulaCop);
  else if (sumaCop > 0) pagosSheet.getRange(targetSheetRow, pc.valor_cop).setValue(sumaCop);
  if (formulaEur || formulaCop) SpreadsheetApp.flush();
}

function formatFechaDDMMYYYY_(dateObj) {
  return String(dateObj.getDate()).padStart(2, '0') + '/' + String(dateObj.getMonth() + 1).padStart(2, '0') + '/' + dateObj.getFullYear();
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
    var metodoPago = String(data.metodo_pago || '').trim().toLowerCase();

    if (!nombre || !tipo || !fecha || eur <= 0)
      return sendResponse(400, { ok: false, error: 'nombre, tipo, fecha y eur son requeridos' });

    var ss = SpreadsheetApp.openById(resolverSheets_(data.programa).budgetSheetId);
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return sendResponse(404, { ok: false, error: 'Hoja Pagos no encontrada' });
    var pc = getPagosColMap_(pagosSheet);
    var idxNombre = pc.nombre_familia - 1;
    var idxNotas  = pc.notas - 1;
    var idxTipoP  = pc.jugador_acompanante - 1;

    var parts = fecha.split('-');
    var fechaDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);

    var startRow = 6;
    var lastRow = pagosSheet.getLastRow();
    var numRows = lastRow - startRow + 1;
    var readWidth = Math.max(pc.jugador_acompanante, pc.nombre_familia, pc.notas);
    var allData = numRows > 0 ? pagosSheet.getRange(startRow, 1, numRows, readWidth).getValues() : [];

    var nombreLower = nombre.toLowerCase();
    var tipoLower   = tipo.toLowerCase();
    var inBlock = false;
    var targetSheetRow = -1;
    var blockPagoFinalRow = -1;
    var tipoParticipante = String(data.tipo_participante || '').trim();

    for (var i = 0; i < allData.length; i++) {
      var cellB = String(allData[i][idxNombre] || '').trim();
      var cellH = String(allData[i][idxNotas] || '').trim();

      if (cellB) {
        if (cellB.toLowerCase() === nombreLower) {
          inBlock = true;
          if (!tipoParticipante) tipoParticipante = String(allData[i][idxTipoP] || '').trim();
        } else if (inBlock) {
          break;
        }
      }

      if (inBlock) {
        if (cellH.toLowerCase() === tipoLower) { targetSheetRow = startRow + i; break; }
        if (cellH.toLowerCase() === 'pago final') blockPagoFinalRow = startRow + i;
      }
    }

    var writeWidth = Math.max(pc.jugador_acompanante, pc.nombre_familia, pc.fecha_pago, pc.valor_cop, pc.valor_eur, pc.estado, pc.paquete, pc.notas, pc.metodo_de_pago || 0);
    var newRow = new Array(writeWidth).fill('');
    newRow[pc.jugador_acompanante - 1] = tipoParticipante;
    newRow[pc.nombre_familia - 1] = nombre;
    newRow[pc.fecha_pago - 1] = fechaDate;
    newRow[pc.valor_cop - 1] = cop > 0 ? cop : '';
    newRow[pc.valor_eur - 1] = eur;
    newRow[pc.estado - 1] = estado;
    newRow[pc.paquete - 1] = paquete;
    newRow[pc.notas - 1] = tipo;
    if (pc.metodo_de_pago && metodoPago) newRow[pc.metodo_de_pago - 1] = metodoPago;
    var finalRow = -1;

    if (targetSheetRow > 0) {
      pagosSheet.getRange(targetSheetRow, 1, 1, writeWidth).setValues([newRow]);
      finalRow = targetSheetRow;
    } else if (blockPagoFinalRow > 0) {
      pagosSheet.insertRowsBefore(blockPagoFinalRow, 1);
      pagosSheet.getRange(blockPagoFinalRow, 1, 1, writeWidth).setValues([newRow]);
      finalRow = blockPagoFinalRow;
    } else {
      var tiposValidos = { 'reserva': true, 'tiquete': true, 'pago final': true };
      var lastDataRow = startRow - 1;
      for (var k = 0; k < allData.length; k++) {
        var gv = String(allData[k][idxNotas] || '').trim().toLowerCase();
        if (tiposValidos[gv]) lastDataRow = startRow + k;
      }
      var insertRow = lastDataRow + 1;
      pagosSheet.insertRowsBefore(insertRow, 1);
      pagosSheet.getRange(insertRow, 1, 1, writeWidth).setValues([newRow]);
      finalRow = insertRow;
    }

    // Historial de abonos: esta función se usa para el PRIMER pago de un
    // concepto (o para sobrescribir por completo), así que inicializa el
    // historial con esta única entrada.
    pagosSheet.getRange(finalRow, pc.historial_de_abonos).setValue(
      buildHistorialString_([{ fecha: formatFechaDDMMYYYY_(fechaDate), eur: eur, cop: cop, metodo: metodoPago }])
    );

    // Sync paquete across all rows of this participant if paquete changed
    var lastRow2 = pagosSheet.getLastRow();
    var numRows2 = lastRow2 - startRow + 1;
    if (numRows2 > 0) {
      var allData2 = pagosSheet.getRange(startRow, 1, numRows2, readWidth).getValues();
      var inBlock2 = false;
      for (var j = 0; j < allData2.length; j++) {
        var cellB2 = String(allData2[j][idxNombre] || '').trim();
        if (cellB2) {
          if (cellB2.toLowerCase() === nombreLower) { inBlock2 = true; }
          else if (inBlock2) { break; }
        }
        if (inBlock2 && String(allData2[j][pc.paquete - 1] || '').trim() !== paquete) {
          pagosSheet.getRange(startRow + j, pc.paquete).setValue(paquete);
        }
      }
    }

    if (estado.toLowerCase().trim() === 'completo' || estado.toLowerCase().trim() === 'parcial') {
      notificarPagoConfirmado(nombre, tipo, eur, cop, estado, data.programa, metodoPago, parseFloat(data.esperado_eur));
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

// Compara lo leído por la IA contra el monto esperado. `eurEsperado`/
// `copEsperado` ya vienen en bruto (con el recargo de tarjeta incluido si
// metodoPago === 'tarjeta' — ver marcarComprobantePendiente() en el
// frontend), así que el comprobante SIEMPRE debe calzar contra ese esperado
// directamente: para transferencia con tolerancia ajustada (0.3%, solo
// redondeos); para tarjeta con más margen (1%), porque Bold puede redondear
// distinto al convertir. El detalle deja claro cuándo el monto incluye el
// recargo, para que el admin sepa que esa parte no cuenta para el saldo.
function evaluarComprobante_(parsed, eurEsperado, copEsperado, metodoPago) {
  const monto = parseFloat(parsed.monto);
  const moneda = String(parsed.moneda || '').toUpperCase();
  const confianza = String(parsed.confianza || '').toLowerCase();

  if (!monto || isNaN(monto) || confianza === 'baja') {
    return { status: 'manual', detalle: 'Imagen ilegible o monto no detectado' };
  }

  let esperado = 0, monedaLabel = '';
  if (moneda === 'COP' && copEsperado > 0) {
    esperado = copEsperado; monedaLabel = 'COP';
  } else if ((moneda === 'EUR' || moneda === 'USD') && eurEsperado > 0) {
    esperado = eurEsperado; monedaLabel = moneda;
  } else {
    return { status: 'revisar', detalle: 'Moneda detectada (' + moneda + ') no coincide con lo esperado' };
  }

  const esTarjeta = metodoPago === 'tarjeta';
  const porcentajeTolerancia = esTarjeta ? 0.01 : 0.003;
  const tolerancia = Math.max(esperado * porcentajeTolerancia, monedaLabel === 'COP' ? 1000 : 1);
  const diff = Math.abs(monto - esperado);

  if (diff <= tolerancia) {
    return {
      status: 'coincide',
      detalle: 'Coincide · ' + monedaLabel + ' ' + monto.toLocaleString('es-CO')
        + (esTarjeta ? ' (incluye 3.5% de recargo Bold — no cuenta para el saldo)' : ''),
      monedaDetectada: monedaLabel, montoDetectado: monto
    };
  }

  return {
    status: 'revisar',
    detalle: 'Detectó ' + monedaLabel + ' ' + monto.toLocaleString('es-CO') + ', se esperaba ' + esperado.toLocaleString('es-CO')
      + (esTarjeta ? ' (con recargo de tarjeta incluido)' : ''),
    monedaDetectada: monedaLabel, montoDetectado: monto
  };
}

// Aplica un abono (eur/cop/metodo ya definidos) a la fila de UN participante
// para un concepto dado — agregándolo al historial existente (nunca
// sobrescribe lo ya confirmado) y reabriendo el estado a "Pendiente de
// confirmar" para revisión. Antes marcarComprobanteSubido() tenía esta misma
// lógica inline para UN solo nombre; se extrajo aquí porque ahora un mismo
// comprobante puede repartirse entre varios participantes del mismo grupo
// (ver `distribucion` en marcarComprobanteSubido) — el pago que ve el
// cliente es un saldo combinado, pero cada participante tiene su propia fila
// independiente en Pagos, así que cada porción debe aplicarse a la fila de
// SU propio dueño, no a la de quien subió el comprobante.
function aplicarPagoAFilaParticipante_(pagosSheet, pc, nombreParticipante, tipo, tipoParticipanteHint, fechaDate, fechaFmt, eur, cop, metodoPago, comprobanteUrl, resultadoIA) {
  var idxNombre = pc.nombre_familia - 1;
  var idxNotas  = pc.notas - 1;
  var idxTipoP  = pc.jugador_acompanante - 1;

  var startRow = 6;
  var lastRow = pagosSheet.getLastRow();
  var numRows = lastRow - startRow + 1;
  var readWidth = Math.max(pc.jugador_acompanante, pc.nombre_familia, pc.notas);
  var allData = numRows > 0 ? pagosSheet.getRange(startRow, 1, numRows, readWidth).getValues() : [];

  var nombreLower = nombreParticipante.toLowerCase();
  var tipoLower = tipo.toLowerCase();
  var inBlock = false;
  var targetSheetRow = -1;
  var blockPagoFinalRow = -1;
  var tipoParticipante = String(tipoParticipanteHint || '').trim();

  for (var i = 0; i < allData.length; i++) {
    var cellB = String(allData[i][idxNombre] || '').trim();
    var cellH = String(allData[i][idxNotas] || '').trim();
    if (cellB) {
      if (cellB.toLowerCase() === nombreLower) {
        inBlock = true;
        if (!tipoParticipante) tipoParticipante = String(allData[i][idxTipoP] || '').trim();
      } else if (inBlock) { break; }
    }
    if (inBlock) {
      if (cellH.toLowerCase() === tipoLower) { targetSheetRow = startRow + i; break; }
      if (cellH.toLowerCase() === 'pago final') blockPagoFinalRow = startRow + i;
    }
  }

  if (targetSheetRow > 0) {
    // Antes: si la fila ya estaba "Completo" el envío se ignoraba por
    // completo (return skipped:true) — pensado para no dejar que un reenvío
    // tardío/duplicado pisara un pago ya confirmado por el admin. Pero si
    // después se agrega un participante al grupo y aparece saldo nuevo, el
    // participante SÍ puede volver a deber y su comprobante del abono
    // adicional se perdía en silencio: la app decía "enviado" pero nunca
    // llegaba a Pagos para revisión. Ahora el envío SIEMPRE se registra,
    // como un abono nuevo AGREGADO al historial (nunca sobrescribe lo ya
    // confirmado) y el estado vuelve a "Pendiente de confirmar" para que el
    // admin lo revise — igual de seguro ante duplicados (el admin ve las
    // entradas y decide), pero ya no pierde pagos reales.
    // Si la fila TODAVÍA está "Pendiente de confirmar" (nadie la validó),
    // este envío no es un abono adicional — es una CORRECCIÓN/reemplazo del
    // mismo comprobante pendiente (ej. el participante subió un comprobante
    // equivocado, lo borró y subió el correcto). Reconstruir el Valor EUR/COP
    // ya existente como una entrada "previa" y sumarle la nueva duplicaba el
    // monto (500 ya guardado + 500 del reenvío = 1.000, aunque solo se pagó
    // una vez). Solo se reconstruye y se ACUMULA cuando la fila ya estaba
    // Completo/Parcial — ahí sí es un abono nuevo sobre un pago ya validado.
    var estadoActualFila = String(pagosSheet.getRange(targetSheetRow, pc.estado).getValue() || '').trim().toLowerCase();
    var historialActual = parseHistorialAbonos_(pagosSheet.getRange(targetSheetRow, pc.historial_de_abonos).getValue());
    if (estadoActualFila === 'pendiente de confirmar') {
      historialActual = [{ fecha: fechaFmt, eur: eur, cop: cop, metodo: metodoPago }];
    } else {
      if (historialActual.length === 0) {
        // Fila con monto ya confirmado pero sin historial desglosado (pago
        // único, o registrado antes de que existiera esta columna) — se
        // reconstruye una primera entrada con lo que ya había, para no
        // perderlo al pasar al modo aditivo.
        var eurPrevio = parseFloat(pagosSheet.getRange(targetSheetRow, pc.valor_eur).getValue()) || 0;
        if (eurPrevio > 0) {
          var copPrevio = parseFloat(pagosSheet.getRange(targetSheetRow, pc.valor_cop).getValue()) || 0;
          var fechaPrevia = pagosSheet.getRange(targetSheetRow, pc.fecha_pago).getValue();
          var metodoPrevio = pc.metodo_de_pago ? String(pagosSheet.getRange(targetSheetRow, pc.metodo_de_pago).getValue() || '') : '';
          historialActual.push({
            fecha: fechaPrevia instanceof Date ? formatFechaDDMMYYYY_(fechaPrevia) : String(fechaPrevia || fechaFmt),
            eur: eurPrevio, cop: copPrevio, metodo: metodoPrevio
          });
        }
      }
      historialActual.push({ fecha: fechaFmt, eur: eur, cop: cop, metodo: metodoPago });
    }

    pagosSheet.getRange(targetSheetRow, pc.fecha_pago).setValue(fechaDate);
    var sumaEur = sumHistorial_(historialActual, 'eur');
    var sumaCop = sumHistorial_(historialActual, 'cop');
    escribirTotalesHistorial_(pagosSheet, pc, targetSheetRow, historialActual, sumaEur, sumaCop);
    pagosSheet.getRange(targetSheetRow, pc.estado).setValue('Pendiente de confirmar');
    pagosSheet.getRange(targetSheetRow, pc.historial_de_abonos).setValue(buildHistorialString_(historialActual));
    if (comprobanteUrl) {
      var urlExistente = String(pagosSheet.getRange(targetSheetRow, pc.comprobante).getValue() || '').trim();
      var urlFinal = urlExistente ? (urlExistente + '\n' + comprobanteUrl) : comprobanteUrl;
      pagosSheet.getRange(targetSheetRow, pc.comprobante).setValue(urlFinal);
    }
    pagosSheet.getRange(targetSheetRow, pc.verificacion_ia).setValue(resultadoIA.status);
    pagosSheet.getRange(targetSheetRow, pc.detalle_ia).setValue(resultadoIA.detalle);
    // Columna opcional: si no existe todavía en la hoja Pagos (fila 5, header
    // "Metodo de pago"), pc.metodo_de_pago queda undefined y esto no hace nada.
    if (pc.metodo_de_pago) pagosSheet.getRange(targetSheetRow, pc.metodo_de_pago).setValue(metodoPago);
  } else {
    var writeWidth = Math.max(pc.jugador_acompanante, pc.nombre_familia, pc.fecha_pago, pc.valor_cop, pc.valor_eur, pc.estado, pc.paquete, pc.notas, pc.comprobante, pc.historial_de_abonos, pc.verificacion_ia, pc.detalle_ia, pc.metodo_de_pago || 0);
    var newRow = new Array(writeWidth).fill('');
    newRow[pc.jugador_acompanante - 1] = tipoParticipante;
    newRow[pc.nombre_familia - 1] = nombreParticipante;
    newRow[pc.fecha_pago - 1] = fechaDate;
    newRow[pc.valor_cop - 1] = cop > 0 ? cop : '';
    newRow[pc.valor_eur - 1] = eur;
    newRow[pc.estado - 1] = 'Pendiente de confirmar';
    newRow[pc.notas - 1] = tipo;
    newRow[pc.comprobante - 1] = comprobanteUrl;
    newRow[pc.verificacion_ia - 1] = resultadoIA.status;
    newRow[pc.detalle_ia - 1] = resultadoIA.detalle;
    if (pc.metodo_de_pago) newRow[pc.metodo_de_pago - 1] = metodoPago;
    // Bug: esta rama (fila nueva) nunca escribía el Historial de abonos —
    // solo la rama de "fila existente" lo hacía. Una fila nueva se quedaba
    // con Valor EUR/COP correctos pero el historial vacío, obligando a que
    // el próximo abono reconstruyera una entrada sintética en vez de tener
    // el registro real desde el primer pago.
    newRow[pc.historial_de_abonos - 1] = buildHistorialString_([{ fecha: fechaFmt, eur: eur, cop: cop, metodo: metodoPago }]);

    var filaInsertada = -1;
    if (blockPagoFinalRow > 0) {
      pagosSheet.insertRowsBefore(blockPagoFinalRow, 1);
      filaInsertada = blockPagoFinalRow;
    } else {
      var tiposValidos = { 'reserva': true, 'tiquete': true, 'pago final': true };
      var lastDataRow = startRow - 1;
      for (var k = 0; k < allData.length; k++) {
        var gv = String(allData[k][idxNotas] || '').trim().toLowerCase();
        if (tiposValidos[gv]) lastDataRow = startRow + k;
      }
      filaInsertada = lastDataRow + 1;
      pagosSheet.insertRowsBefore(filaInsertada, 1);
    }
    pagosSheet.getRange(filaInsertada, 1, 1, writeWidth).setValues([newRow]);
  }
}

function marcarComprobanteSubido(data) {
  try {
    var nombre = String(data.nombre || '').trim();
    var tipo = String(data.tipo || '').trim();
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
      if (fp.length === 3) fechaDate = new Date(parseInt(fp[0]), parseInt(fp[1]) - 1, parseInt(fp[2]), 12, 0, 0);
    }

    var ss = SpreadsheetApp.openById(resolverSheets_(data.programa).budgetSheetId);
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return sendResponse(404, { ok: false, error: 'Hoja Pagos no encontrada' });
    var pc = getPagosColMap_(pagosSheet);

    // El monto mostrado en pantalla (eur/cop) es el TOTAL esperado del
    // comprobante — se usa tal cual para verificar contra la IA, que lee UN
    // solo recibo. Si el participante subió VARIOS comprobantes en la misma
    // tanda (ej. dos abonos separados que juntos completan el pago), fileId
    // solo apunta al último que terminó de subir — compararlo a solas contra
    // el total combinado casi siempre daría "no coincide" y activaría la
    // auto-corrección de más abajo, que entonces REDUCIRÍA mal un pago que en
    // realidad sí está completo entre los dos recibos. En ese caso se salta
    // la verificación IA por completo y queda en revisión manual.
    var comprobanteCount = parseInt(data.comprobante_count) || 1;
    var resultadoIA = comprobanteCount > 1
      ? { status: 'manual', detalle: 'Se subieron ' + comprobanteCount + ' comprobantes en el mismo envío — revisar el monto combinado manualmente.' }
      : verificarComprobanteIA_(fileId, eur, cop, metodoPago);
    var fechaFmt = formatFechaDDMMYYYY_(fechaDate);

    // Si el correo tiene varios participantes vinculados, el saldo que ve el
    // cliente es la suma de todos — pero cada uno tiene su propia fila en
    // Pagos. El frontend calcula cómo repartir el monto entre quienes
    // realmente todavía deban (ver calcularDistribucionPago_ en
    // areapersonal.html) y lo manda en `distribucion`. Si no viene (llamada
    // antigua, o un solo participante), se aplica todo a `nombre` como antes.
    var distribucion = Array.isArray(data.distribucion) && data.distribucion.length
      ? data.distribucion
      : [{ nombre: nombre, eur: eur, cop: cop }];

    // Si la IA detectó un monto DISTINTO al esperado en UNA sola moneda (ej.
    // el participante subió un comprobante de un abono parcial, menor a lo
    // que se mostraba en pantalla), el total que hay que registrar no es el
    // esperado sino el realmente recibido — se recalcula con la TRM
    // implícita en lo que el frontend ya había calculado (cop/eur
    // esperados guardan la misma proporción), y ese factor de corrección se
    // aplica por igual a cada porción de `distribucion`, para que la hoja
    // quede con el monto REAL desde el primer registro sin depender de que
    // el admin lo corrija a mano.
    var factorDistribucion = 1;
    if (resultadoIA.status === 'revisar' && resultadoIA.montoDetectado > 0 && resultadoIA.monedaDetectada) {
      if (resultadoIA.monedaDetectada === 'COP' && cop > 0) {
        factorDistribucion = resultadoIA.montoDetectado / cop;
      } else if (resultadoIA.monedaDetectada !== 'COP' && eur > 0) {
        factorDistribucion = resultadoIA.montoDetectado / eur;
      }
    }

    var tipoParticipanteHint = String(data.tipo_participante || '').trim();
    distribucion.forEach(function(item) {
      var itemNombre = String((item && item.nombre) || '').trim();
      if (!itemNombre) return;
      var itemEur = Math.round((parseFloat(item.eur) || 0) * factorDistribucion * 100) / 100;
      var itemCop = Math.round((parseFloat(item.cop) || 0) * factorDistribucion);
      if (itemEur <= 0 && itemCop <= 0) return;
      aplicarPagoAFilaParticipante_(
        pagosSheet, pc, itemNombre, tipo,
        itemNombre === nombre ? tipoParticipanteHint : '',
        fechaDate, fechaFmt, itemEur, itemCop, metodoPago, comprobanteUrl, resultadoIA
      );
    });

    return sendResponse(200, { ok: true });
  } catch (err) {
    Logger.log('marcarComprobanteSubido error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function agregarAbonoPago(data) {
  try {
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
    var nombre = String(data.nombre || '').trim();
    var tipo = String(data.tipo || '').trim();
    var fecha = String(data.fecha || '').trim();
    var eur = parseFloat(data.eur) || 0;
    var cop = parseFloat(data.cop) || 0;
    var metodoPago = String(data.metodo_pago || '').trim().toLowerCase();
    if (!nombre || !tipo || !fecha || eur <= 0)
      return sendResponse(400, { ok: false, error: 'nombre, tipo, fecha y eur son requeridos' });

    var ss = SpreadsheetApp.openById(resolverSheets_(data.programa).budgetSheetId);
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return sendResponse(404, { ok: false, error: 'Hoja Pagos no encontrada' });
    var pc = getPagosColMap_(pagosSheet);
    var idxNombre = pc.nombre_familia - 1;
    var idxNotas  = pc.notas - 1;

    var parts = fecha.split('-');
    var fechaDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
    var fechaFmt = formatFechaDDMMYYYY_(fechaDate);

    var startRow = 6;
    var lastRow = pagosSheet.getLastRow();
    var numRows = lastRow - startRow + 1;
    var readWidth = Math.max(pc.nombre_familia, pc.notas);
    var allData = numRows > 0 ? pagosSheet.getRange(startRow, 1, numRows, readWidth).getValues() : [];
    var nombreLower = nombre.toLowerCase();
    var tipoLower = tipo.toLowerCase();
    var inBlock = false;
    var targetSheetRow = -1;

    for (var i = 0; i < allData.length; i++) {
      var cellB = String(allData[i][idxNombre] || '').trim();
      var cellH = String(allData[i][idxNotas] || '').trim();
      if (cellB) {
        if (cellB.toLowerCase() === nombreLower) inBlock = true;
        else if (inBlock) break;
      }
      if (inBlock && cellH.toLowerCase() === tipoLower) { targetSheetRow = startRow + i; break; }
    }

    if (targetSheetRow < 0) {
      return sendResponse(404, { ok: false, error: 'No existe un pago previo para este concepto. Usa "Registrar pago" para el primer abono.' });
    }

    var estadoActual = String(pagosSheet.getRange(targetSheetRow, pc.estado).getValue() || '').trim().toLowerCase();
    if (estadoActual === 'completo') {
      return sendResponse(400, { ok: false, error: 'Este pago ya está marcado como Completo — no se pueden agregar más abonos.' });
    }

    var historialActual = parseHistorialAbonos_(pagosSheet.getRange(targetSheetRow, pc.historial_de_abonos).getValue());
    if (historialActual.length === 0) {
      // Fila con dinero ya en Valor EUR pero sin historial desglosado (ej.
      // un monto que el admin escribió directo en la celda) — se reconstruye
      // una primera entrada con lo que ya había, para no perderlo al sumar
      // el abono nuevo (si no, sumaEur/sumaCop de abajo solo contarían la
      // entrada nueva y se perdería lo que ya estaba registrado).
      var eurPrevio = parseFloat(pagosSheet.getRange(targetSheetRow, pc.valor_eur).getValue()) || 0;
      if (eurPrevio > 0) {
        var copPrevio = parseFloat(pagosSheet.getRange(targetSheetRow, pc.valor_cop).getValue()) || 0;
        var fechaPrevia = pagosSheet.getRange(targetSheetRow, pc.fecha_pago).getValue();
        var metodoPrevio = pc.metodo_de_pago ? String(pagosSheet.getRange(targetSheetRow, pc.metodo_de_pago).getValue() || '') : '';
        historialActual.push({
          fecha: fechaPrevia instanceof Date ? formatFechaDDMMYYYY_(fechaPrevia) : String(fechaPrevia || fechaFmt),
          eur: eurPrevio, cop: copPrevio, metodo: metodoPrevio
        });
      }
    }
    historialActual.push({ fecha: fechaFmt, eur: eur, cop: cop, metodo: metodoPago });

    pagosSheet.getRange(targetSheetRow, pc.fecha_pago).setValue(fechaDate);
    var sumaCop = sumHistorial_(historialActual, 'cop');
    var sumaEur = sumHistorial_(historialActual, 'eur');
    escribirTotalesHistorial_(pagosSheet, pc, targetSheetRow, historialActual, sumaEur, sumaCop);
    pagosSheet.getRange(targetSheetRow, pc.estado).setValue('Parcial');
    pagosSheet.getRange(targetSheetRow, pc.historial_de_abonos).setValue(buildHistorialString_(historialActual));
    if (pc.metodo_de_pago && metodoPago) pagosSheet.getRange(targetSheetRow, pc.metodo_de_pago).setValue(metodoPago);

    // Antes esta acción ("+ Agregar abono") no avisaba nada al participante —
    // el correo con el desglose (abonos anteriores + nuevo + total + saldo)
    // se manda aquí también, no solo al confirmar un pago pendiente.
    notificarPagoConfirmado(nombre, tipo, sumaEur, sumaCop, 'Parcial', data.programa, metodoPago, parseFloat(data.esperado_eur), historialActual);

    actualizarResumenPagos(pagosSheet);
    return sendResponse(200, { ok: true });
  } catch (err) {
    Logger.log('agregarAbonoPago error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

// Confirma un pago que quedó "Pendiente de confirmar" tras la subida de un
// comprobante (ver aplicarPagoAFilaParticipante_). A diferencia de
// agregarAbonoPago (que SIEMPRE agrega una entrada nueva al historial, para
// abonos genuinamente adicionales), esta acción CORRIGE la última entrada
// del historial — la que quedó pendiente — con los valores finales que el
// admin dejó en el modal, ya sea el mismo monto recibido o una corrección
// manual (ej. el comprobante detectado por la IA no coincidía con lo
// esperado). Antes, el botón "Confirmar pago" reutilizaba agregarAbonoPago y
// ADICIONABA una segunda entrada encima de la primera, duplicando el monto
// tanto en la hoja como en el correo de confirmación.
function confirmarPagoPendiente(data) {
  try {
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
    var nombre = String(data.nombre || '').trim();
    var tipo = String(data.tipo || '').trim();
    var fecha = String(data.fecha || '').trim();
    var eur = parseFloat(data.eur) || 0;
    var cop = parseFloat(data.cop) || 0;
    var estado = String(data.estado || '').trim();
    var paquete = String(data.paquete || '').trim();
    var metodoPago = String(data.metodo_pago || '').trim().toLowerCase();
    var esperadoEur = parseFloat(data.esperado_eur);
    if (!nombre || !tipo || !fecha || eur <= 0 || !estado)
      return sendResponse(400, { ok: false, error: 'nombre, tipo, fecha, eur y estado son requeridos' });

    var ss = SpreadsheetApp.openById(resolverSheets_(data.programa).budgetSheetId);
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return sendResponse(404, { ok: false, error: 'Hoja Pagos no encontrada' });
    var pc = getPagosColMap_(pagosSheet);
    var idxNombre = pc.nombre_familia - 1;
    var idxNotas  = pc.notas - 1;

    var parts = fecha.split('-');
    var fechaDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
    var fechaFmt = formatFechaDDMMYYYY_(fechaDate);

    var startRow = 6;
    var lastRow = pagosSheet.getLastRow();
    var numRows = lastRow - startRow + 1;
    var readWidth = Math.max(pc.nombre_familia, pc.notas);
    var allData = numRows > 0 ? pagosSheet.getRange(startRow, 1, numRows, readWidth).getValues() : [];
    var nombreLower = nombre.toLowerCase();
    var tipoLower = tipo.toLowerCase();
    var inBlock = false;
    var targetSheetRow = -1;
    for (var i = 0; i < allData.length; i++) {
      var cellB = String(allData[i][idxNombre] || '').trim();
      var cellH = String(allData[i][idxNotas] || '').trim();
      if (cellB) {
        if (cellB.toLowerCase() === nombreLower) inBlock = true;
        else if (inBlock) break;
      }
      if (inBlock && cellH.toLowerCase() === tipoLower) { targetSheetRow = startRow + i; break; }
    }
    if (targetSheetRow < 0) return sendResponse(404, { ok: false, error: 'No se encontró el pago a confirmar' });

    var historialActual = parseHistorialAbonos_(pagosSheet.getRange(targetSheetRow, pc.historial_de_abonos).getValue());
    if (historialActual.length > 1) {
      // El modal ya muestra (y por tanto envía) el TOTAL acumulado — suma de
      // todos los abonos, no solo el último — para que el admin decida
      // Completo/Parcial mirando el saldo real. Aquí se corrige SOLO la
      // última entrada restándole lo que ya sumaban las anteriores (que
      // quedan intactas), en vez de reemplazarla por el total completo —
      // si no, cada confirmación pisaría el total anterior y lo duplicaría.
      var sumaPreviasEur = sumHistorial_(historialActual.slice(0, -1), 'eur');
      var sumaPreviasCop = sumHistorial_(historialActual.slice(0, -1), 'cop');
      historialActual[historialActual.length - 1] = {
        fecha: fechaFmt,
        eur: Math.round((eur - sumaPreviasEur) * 100) / 100,
        cop: Math.round(cop - sumaPreviasCop),
        metodo: metodoPago
      };
    } else if (historialActual.length === 1) {
      historialActual[0] = { fecha: fechaFmt, eur: eur, cop: cop, metodo: metodoPago };
    } else {
      historialActual.push({ fecha: fechaFmt, eur: eur, cop: cop, metodo: metodoPago });
    }

    pagosSheet.getRange(targetSheetRow, pc.fecha_pago).setValue(fechaDate);
    var sumaEur = sumHistorial_(historialActual, 'eur');
    var sumaCop = sumHistorial_(historialActual, 'cop');
    escribirTotalesHistorial_(pagosSheet, pc, targetSheetRow, historialActual, sumaEur, sumaCop);
    pagosSheet.getRange(targetSheetRow, pc.estado).setValue(estado);
    pagosSheet.getRange(targetSheetRow, pc.historial_de_abonos).setValue(buildHistorialString_(historialActual));
    if (paquete) pagosSheet.getRange(targetSheetRow, pc.paquete).setValue(paquete);
    if (pc.metodo_de_pago && metodoPago) pagosSheet.getRange(targetSheetRow, pc.metodo_de_pago).setValue(metodoPago);

    if (estado.toLowerCase() === 'completo' || estado.toLowerCase() === 'parcial') {
      notificarPagoConfirmado(nombre, tipo, sumaEur, sumaCop, estado, data.programa, metodoPago, esperadoEur, historialActual);
    }

    actualizarResumenPagos(pagosSheet);
    return sendResponse(200, { ok: true });
  } catch (err) {
    Logger.log('confirmarPagoPendiente error: ' + err);
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function actualizarEstadoPago(data) {
  try {
    if (!autorizar(data, ['superadmin', 'editor'])) return sendResponse(403, { ok: false, error: 'No autorizado' });
    var nombre = String(data.nombre || '').trim();
    var tipo = String(data.tipo || '').trim();
    var estado = String(data.estado || '').trim();
    var paquete = String(data.paquete || '').trim();
    if (!nombre || !tipo || !estado) return sendResponse(400, { ok: false, error: 'nombre, tipo y estado son requeridos' });

    var ss = SpreadsheetApp.openById(resolverSheets_(data.programa).budgetSheetId);
    var pagosSheet = getSheetCI(ss, 'Pagos');
    if (!pagosSheet) return sendResponse(404, { ok: false, error: 'Hoja Pagos no encontrada' });
    var pc = getPagosColMap_(pagosSheet);
    var idxNombre = pc.nombre_familia - 1;
    var idxNotas  = pc.notas - 1;

    var startRow = 6;
    var lastRow = pagosSheet.getLastRow();
    var numRows = lastRow - startRow + 1;
    var readWidth = Math.max(pc.nombre_familia, pc.notas);
    var allData = numRows > 0 ? pagosSheet.getRange(startRow, 1, numRows, readWidth).getValues() : [];
    var nombreLower = nombre.toLowerCase();
    var tipoLower = tipo.toLowerCase();
    var inBlock = false;
    var targetSheetRow = -1;
    for (var i = 0; i < allData.length; i++) {
      var cellB = String(allData[i][idxNombre] || '').trim();
      var cellH = String(allData[i][idxNotas] || '').trim();
      if (cellB) {
        if (cellB.toLowerCase() === nombreLower) inBlock = true;
        else if (inBlock) break;
      }
      if (inBlock && cellH.toLowerCase() === tipoLower) { targetSheetRow = startRow + i; break; }
    }
    if (targetSheetRow < 0) return sendResponse(404, { ok: false, error: 'No se encontró el pago a actualizar' });

    pagosSheet.getRange(targetSheetRow, pc.estado).setValue(estado);
    if (paquete) pagosSheet.getRange(targetSheetRow, pc.paquete).setValue(paquete);

    var eur = parseFloat(pagosSheet.getRange(targetSheetRow, pc.valor_eur).getValue()) || 0;
    var cop = parseFloat(pagosSheet.getRange(targetSheetRow, pc.valor_cop).getValue()) || 0;
    var metodoPagoActual = pc.metodo_de_pago ? String(pagosSheet.getRange(targetSheetRow, pc.metodo_de_pago).getValue() || '').toLowerCase() : '';
    var esperadoEur = parseFloat(data.esperado_eur);
    if (estado.toLowerCase() === 'completo' || estado.toLowerCase() === 'parcial') {
      notificarPagoConfirmado(nombre, tipo, eur, cop, estado, data.programa, metodoPagoActual, esperadoEur);
    }

    actualizarResumenPagos(pagosSheet);
    return sendResponse(200, { ok: true });
  } catch (err) {
    Logger.log('actualizarEstadoPago error: ' + err);
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
    const sheet = SpreadsheetApp.openById(resolverSheets_(data.programa).sheetId).getSheets()[0];
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
    const resetUrl = String(data.reset_url || 'https://victory.com.es/areapersonal.html');
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
    const encontrados = buscarComercialEnTodosLosProgramas_(emailNorm);
    if (!encontrados.length) return sendResponse(404, { ok: false, error: 'Comercial no encontrado' });

    // Autorización: primera vez (sin contraseña aún en ningún programa),
    // usando la contraseña compartida por defecto en cualquiera de los
    // programas (debe cambiarla), token de reset válido para este email, o
    // sesión comercial ya autenticada + contraseña actual correcta en
    // cualquiera de los programas donde exista esta cuenta.
    const defaultPwd = getDefaultPassword();
    const sinContrasena = encontrados.every(function(e) { return !e.storedPwd; });
    const usandoDefault = encontrados.some(function(e) { return !!defaultPwd && passwordMatches_(defaultPwd, e.storedPwd); });
    let autorizado = sinContrasena || usandoDefault;
    if (!autorizado && data.reset_token) {
      const raw = PropertiesService.getScriptProperties().getProperty('reset_' + data.reset_token);
      if (raw) {
        const parts = raw.split('|');
        if (parts[0] === emailNorm && Date.now() < parseInt(parts[1])) autorizado = true;
      }
    }
    if (!autorizado) {
      const payload = verificarSesionToken(data.token || '');
      if (payload && payload.rol === 'comercial' && payload.email === emailNorm &&
          encontrados.some(function(e) { return passwordMatches_(data.current_password, e.storedPwd); })) autorizado = true;
    }
    if (!autorizado) return sendResponse(403, { ok: false, error: 'No autorizado' });

    const newPwd = String(data.new_password || '').trim();
    if (newPwd.length < 6) return sendResponse(400, { ok: false, error: 'Mínimo 6 caracteres' });
    const newHash = hashPassword_(newPwd);
    encontrados.forEach(function(e) { e.comSheet.getRange(6 + e.rowOffset, 10).setValue(newHash); }); // Columna J, en cada programa
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
    const encontrados = buscarComercialEnTodosLosProgramas_(emailNorm);
    if (!encontrados.length) return sendResponse(404, { ok: false, error: 'Comercial no encontrado' });

    // Basta con que la contraseña coincida en cualquiera de los programas
    // donde exista esta cuenta (la contraseña se mantiene sincronizada entre
    // ambas hojas al cambiarla — ver setComercialPassword).
    const coincide = encontrados.find(function(e) { return passwordMatches_(pwd, e.storedPwd); });
    if (!coincide) return sendResponse(200, { ok: false });
    const defaultPwd = getDefaultPassword();
    const mustChange = !!defaultPwd && passwordMatches_(defaultPwd, coincide.storedPwd);
    return sendResponse(200, { ok: true, must_change: mustChange, token: generarSesionToken(emailNorm, 'comercial') });
  } catch(err) {
    return sendResponse(500, { ok: false, error: err.toString() });
  }
}

function forgotComercialPassword(data) {
  try {
    const emailNorm = String(data.email || '').toLowerCase().trim();
    if (!emailNorm || emailNorm.indexOf('@') < 0) return sendResponse(400, { ok: false, error: 'Email requerido' });
    const encontrados = buscarComercialEnTodosLosProgramas_(emailNorm);
    // Devolver ok:true aunque no se encuentre (no revelar si el email existe o no)
    if (!encontrados.length) return sendResponse(200, { ok: true });
    const token = Utilities.getUuid().replace(/-/g, '');
    const expiry = Date.now() + 3600000; // 1 hora
    PropertiesService.getScriptProperties().setProperty('reset_' + token, emailNorm + '|' + expiry);
    const resetUrl = String(data.reset_url || 'https://victory.com.es/areapersonal.html');
    const link = resetUrl + '?reset=' + token;
    const adminEmail = 'alejandro.cabrera@fundacionrevel.net';
    GmailApp.sendEmail(emailNorm, 'Recupera tu contraseña — Área Comercial Victory',
      'Para restablecer tu contraseña accede a: ' + link, {
        htmlBody: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">'
          + '<div style="background:#1e5ba8;padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">'
          + '<h2 style="color:#fff;margin:0;font-size:18px">Victory Sports · Área Comercial</h2></div>'
          + '<div style="background:#f8fafc;padding:28px 24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">'
          + '<p style="color:#334155;margin-top:0">Hola,</p>'
          + '<p style="color:#334155">Recibimos una solicitud para restablecer la contraseña de tu área comercial.</p>'
          + '<p style="text-align:center;margin:24px 0">'
          + '<a href="' + link + '" style="display:inline-block;background:#1e5ba8;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">Restablecer contraseña →</a></p>'
          + '<p style="color:#94a3b8;font-size:12px">Este enlace expira en <strong>1 hora</strong>. Si no lo solicitaste, ignora este correo.</p>'
          + '<p style="color:#94a3b8;font-size:12px">Equipo Revel · Victory Sports</p>'
          + '</div></div>',
        replyTo: adminEmail, name: 'Victory Sports'
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
    var sheet = SpreadsheetApp.openById(resolverSheets_(params.programa).sheetId).getSheets()[0];
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
const COMERCIAL_STR_ = function(v) { return String(v == null ? '' : v).trim(); };
const COMERCIAL_NUM_ = function(v) {
  if (typeof v === 'number') return v;
  var s = COMERCIAL_STR_(v).replace(/[€$\s]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
  return parseFloat(s) || 0;
};

// Busca el email de un comercial en la hoja Comisiones de UN programa.
// Devuelve null si no está, o { nombre, storedPwd, comSheet, rowOffset, programKey }.
function buscarComercialEnPresupuesto_(emailNorm, budgetSheetId, programKey) {
  const ss = SpreadsheetApp.openById(budgetSheetId);
  const comSheet = getSheetCI(ss, 'Comisiones');
  if (!comSheet) return null;
  const lastRow = comSheet.getLastRow();
  if (lastRow < 6) return null;
  const hiData = comSheet.getRange('H6:J' + lastRow).getValues();
  for (let i = 0; i < hiData.length; i++) {
    if (COMERCIAL_STR_(hiData[i][1]).toLowerCase() === emailNorm) {
      return {
        nombre: COMERCIAL_STR_(hiData[i][0]),
        storedPwd: COMERCIAL_STR_(hiData[i][2]),
        comSheet: comSheet,
        rowOffset: i,
        programKey: programKey
      };
    }
  }
  return null;
}

// Un comercial puede vender ambos programas con la misma cuenta — busca en
// las dos hojas de presupuesto y devuelve todas las coincidencias encontradas.
function buscarComercialEnTodosLosProgramas_(emailNorm) {
  const resultados = [];
  getBudgetSheetIds_().forEach(function(fuente) {
    const encontrado = buscarComercialEnPresupuesto_(emailNorm, fuente.budgetSheetId, fuente.programKey);
    if (encontrado) resultados.push(encontrado);
  });
  return resultados;
}

// Lee las filas de comisión (A:F) de un comercial dentro de una hoja Comisiones ya localizada.
function leerComisionesDeHoja_(comSheet, nombre) {
  const lastRow = comSheet.getLastRow();
  const comData = comSheet.getRange('A6:F' + lastRow).getValues();
  const nombreLower = nombre.toLowerCase();
  const jugadores = [];
  const acompanantes = [];
  let seccion = 'jugadores';

  for (let i = 0; i < comData.length; i++) {
    const r = comData[i];
    const colA = COMERCIAL_STR_(r[0]);
    const colALow = colA.toLowerCase();
    if (!colA) continue;
    if (colALow.indexOf('acomp') >= 0) { seccion = 'acompanantes'; continue; }
    if (colALow.indexOf('total') >= 0) continue;
    if (colALow === 'comercial') continue;
    if (colALow !== nombreLower) continue;

    if (seccion === 'jugadores') {
      jugadores.push({
        comision_jugador: COMERCIAL_NUM_(r[1]),
        jugadores: COMERCIAL_NUM_(r[2]),
        total: COMERCIAL_NUM_(r[3]),
        estado: COMERCIAL_STR_(r[4]),
        notas: COMERCIAL_STR_(r[5])
      });
    } else {
      acompanantes.push({
        com_doble:    COMERCIAL_NUM_(r[1]),
        com_sencilla: COMERCIAL_NUM_(r[2]),
        acomp_doble:  COMERCIAL_NUM_(r[3]),
        acomp_sencilla: COMERCIAL_NUM_(r[4]),
        total: COMERCIAL_NUM_(r[5])
      });
    }
  }
  return { jugadores: jugadores, acompanantes: acompanantes };
}

function getComercialData(email) {
  try {
    const emailNorm = email.toString().toLowerCase().trim();
    if (!emailNorm) return ContentService.createTextOutput(JSON.stringify({ found: false }))
      .setMimeType(ContentService.MimeType.JSON);

    const encontrados = buscarComercialEnTodosLosProgramas_(emailNorm);
    if (!encontrados.length) return ContentService.createTextOutput(JSON.stringify({ found: false }))
      .setMimeType(ContentService.MimeType.JSON);

    const nombre = encontrados[0].nombre;
    const hasPassword = encontrados.some(function(e) { return !!e.storedPwd; });
    let jugadores = [];
    let acompanantes = [];
    encontrados.forEach(function(e) {
      const datos = leerComisionesDeHoja_(e.comSheet, e.nombre);
      jugadores = jugadores.concat(datos.jugadores);
      acompanantes = acompanantes.concat(datos.acompanantes);
    });

    return ContentService.createTextOutput(JSON.stringify({
      found: true,
      nombre: nombre,
      has_password: hasPassword,
      jugadores: jugadores,
      acompanantes: acompanantes
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('getComercialData error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ found: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC INSCRIPCIONES (solo Jugadores) → LEADS
// ═══════════════════════════════════════════════════════════════════════

const LEADS_SHEET_ID = '1uIsD7vjvZh0AqQ76lcgLPBpca29lDeDrIQieCM7s0S8';
const LEADS_TAB_NAME = 'Leads';

// Mapa: encabezado normalizado de LEADS → clave normalizada de Inscripciones
// (null = no tiene fuente en Inscripciones, se deja vacío)
const LEADS_FIELD_MAP = {
  'timestamp': 'timestamp',
  'nombre': 'nombre',
  'fecha_de_nacimiento': 'fecha_nacimiento',
  'pais': 'pais',
  'whatsapp': 'whatsapp',
  'email': 'email',
  'programa': 'programa',
  'pdf_link': null
};

function normHeaderKey_(s) {
  return String(s || '')
    .toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\s_\-]+/g, '_');
}

function normText_(s) {
  return String(s || '')
    .toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function getLeadsSheet_() {
  const ss = SpreadsheetApp.openById(LEADS_SHEET_ID);
  let sheet = ss.getSheetByName(LEADS_TAB_NAME);
  if (!sheet) sheet = ss.getSheets()[0];
  return sheet;
}

// ── Trigger onChange: dispara con cada fila nueva agregada a Inscripciones ──
// Función compartida por ambos programas — sourceSheetId indica de qué sheet
// de inscripción leer, propKey es la clave de PropertiesService donde se
// guarda "hasta qué fila ya se sincronizó" (una por programa, para no mezclar
// el avance de Clinic con el de World Challenge).
function sincronizarLeadsDesdeInscripciones_(e, sourceSheetId, propKey) {
  try {
    if (e && e.changeType &&
        ['INSERT_ROW', 'EDIT', 'INSERT_GRID', 'OTHER'].indexOf(e.changeType) === -1) return;

    const mainSheet = SpreadsheetApp.openById(sourceSheetId).getSheets()[0];
    const lastRow = mainSheet.getLastRow();
    if (lastRow < 2) return;

    const props = PropertiesService.getScriptProperties();
    let lastSynced = parseInt(props.getProperty(propKey)) || 1;
    if (lastRow <= lastSynced) return;

    const headers = mainSheet.getRange(1, 1, 1, mainSheet.getLastColumn()).getValues()[0];
    const normHeaders = headers.map(normHeaderKey_);
    const newRowsValues = mainSheet.getRange(lastSynced + 1, 1, lastRow - lastSynced, mainSheet.getLastColumn()).getValues();

    const leadsSheet = getLeadsSheet_();
    const leadsHeaders = leadsSheet.getRange(1, 1, 1, leadsSheet.getLastColumn()).getValues()[0];
    const emailColIdx = leadsHeaders.findIndex(h => normHeaderKey_(h) === 'email');
    const nombreColIdx = leadsHeaders.findIndex(h => normHeaderKey_(h) === 'nombre');

    // existingKeys[clave] guarda la fila de Leads (1-based) donde ya está ese
    // email+nombre, o 'queued' si un lead nuevo de este mismo batch ya se
    // encoló para insertar (evita duplicarlo si aparece dos veces seguidas).
    const existingKeys = {};
    const leadsLastRow = leadsSheet.getLastRow();
    if (leadsLastRow >= 2 && emailColIdx >= 0) {
      const leadsData = leadsSheet.getRange(2, 1, leadsLastRow - 1, leadsHeaders.length).getValues();
      leadsData.forEach(function(r, idx) {
        const em = normText_(r[emailColIdx]);
        const nm = nombreColIdx >= 0 ? normText_(r[nombreColIdx]) : '';
        if (em) existingKeys[em + '|||' + nm] = idx + 2; // +2: fila de cabecera + índice 1-based
      });
    }

    const rowsToAppend = [];
    const rowsToUpdate = [];
    newRowsValues.forEach(function(rowValues) {
      const tieneAlgo = rowValues.some(v => String(v || '').trim() !== '');
      if (!tieneAlgo) return;

      const dataByNorm = {};
      normHeaders.forEach(function(nh, idx) { dataByNorm[nh] = rowValues[idx]; });

      const tipo = normText_(dataByNorm['tipo']);
      if (!tipo.includes('jugador')) return;

      const email = normText_(dataByNorm['email']);
      const nombre = normText_(dataByNorm['nombre']);
      const key = email + '|||' + nombre;
      const newLeadRow = leadsHeaders.map(function(h) {
        const sourceKey = LEADS_FIELD_MAP[normHeaderKey_(h)];
        if (!sourceKey) return '';
        return dataByNorm[sourceKey] !== undefined ? dataByNorm[sourceKey] : '';
      });

      const existente = email ? existingKeys[key] : undefined;
      if (typeof existente === 'number') {
        // Este lead ya estaba en Leads (llegó primero por "más información")
        // — se actualiza con los datos reales de la inscripción, para que el
        // Programa (y demás campos) queden correctos y el correo de
        // cumpleaños salga con la marca correcta. No pisa columnas sin
        // fuente en Inscripciones (ej. pdf_link) — ver merge más abajo.
        rowsToUpdate.push({ rowIndex: existente, values: newLeadRow });
        existingKeys[key] = 'done';
        return;
      }
      if (existente === 'done' || existente === 'queued') return; // ya procesado en este mismo batch

      if (email) existingKeys[key] = 'queued';
      rowsToAppend.push(newLeadRow);
    });

    if (rowsToAppend.length > 0) {
      leadsSheet.getRange(leadsSheet.getLastRow() + 1, 1, rowsToAppend.length, leadsHeaders.length).setValues(rowsToAppend);
      Logger.log('Sincronizadas ' + rowsToAppend.length + ' fila(s) nueva(s) de Jugadores a Leads desde ' + sourceSheetId + '.');
    }
    if (rowsToUpdate.length > 0) {
      rowsToUpdate.forEach(function(u) {
        const filaActual = leadsSheet.getRange(u.rowIndex, 1, 1, leadsHeaders.length).getValues()[0];
        const merged = filaActual.map(function(valorActual, idx) {
          const valorNuevo = u.values[idx];
          return (valorNuevo !== '' && valorNuevo !== null && valorNuevo !== undefined) ? valorNuevo : valorActual;
        });
        leadsSheet.getRange(u.rowIndex, 1, 1, leadsHeaders.length).setValues([merged]);
      });
      Logger.log('Actualizadas ' + rowsToUpdate.length + ' fila(s) existentes en Leads con datos de inscripción desde ' + sourceSheetId + '.');
    }

    props.setProperty(propKey, String(lastRow));
  } catch (err) {
    Logger.log('sincronizarLeadsDesdeInscripciones_ error (' + sourceSheetId + '): ' + err);
  }
}

function onChangeInscripciones(e) {
  sincronizarLeadsDesdeInscripciones_(e, SHEET_ID, 'leads_last_synced_row');
}

function onChangeInscripcionesWorldChallenge(e) {
  sincronizarLeadsDesdeInscripciones_(e, SHEET_ID_WORLD_CHALLENGE, 'leads_last_synced_row_wc');
}

// ── Ejecutar UNA VEZ desde el editor para instalar el trigger (Clinic) ─────
function crearTriggerSyncLeads() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'onChangeInscripciones') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onChangeInscripciones')
    .forSpreadsheet(SHEET_ID)
    .onChange()
    .create();

  const mainSheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  PropertiesService.getScriptProperties().setProperty('leads_last_synced_row', String(mainSheet.getLastRow()));
  Logger.log('Trigger de sincronización a Leads (Clinic) creado correctamente.');
}

// ── Ejecutar UNA VEZ desde el editor para instalar el trigger (World Challenge) ─
function crearTriggerSyncLeadsWorldChallenge() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'onChangeInscripcionesWorldChallenge') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onChangeInscripcionesWorldChallenge')
    .forSpreadsheet(SHEET_ID_WORLD_CHALLENGE)
    .onChange()
    .create();

  const mainSheet = SpreadsheetApp.openById(SHEET_ID_WORLD_CHALLENGE).getSheets()[0];
  PropertiesService.getScriptProperties().setProperty('leads_last_synced_row_wc', String(mainSheet.getLastRow()));
  Logger.log('Trigger de sincronización a Leads (World Challenge) creado correctamente.');
}

// ═══════════════════════════════════════════════════════════════════════
// CORREO DE CUMPLEAÑOS AUTOMÁTICO (solo Jugadores, hasta los 18 años)
// ═══════════════════════════════════════════════════════════════════════

function obtenerNombrePila_(nombreCompleto) {
  const partes = String(nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length <= 2) return partes[0] || '';
  return partes.slice(0, 2).join(' ');
}

function buildCumpleanosHtml_(nombreCompleto, edad, programa) {
  const primerNombre = obtenerNombrePila_(nombreCompleto) || nombreCompleto;
  const esWC = esWorldChallenge_(programa);
  const nombrePrograma = esWC ? 'Real Madrid Foundation World Challenge 2027' : 'Real Madrid Foundation Clinic 2026';
  const nombreProgramaCorto = esWC ? 'Real Madrid Foundation World Challenge' : 'Real Madrid Foundation Clinic';
  return `
<div style="margin:0;padding:0;background:#eef1f5;font-family:'DM Sans',Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;">
    <div style="background:#0b1f3a;padding:32px 30px 26px;text-align:center;">
      <img src="https://lh3.googleusercontent.com/d/1Ve6IkxqSoXZWQM9triDoYm0FJ2aF4Ub6" alt="Victory" style="height:34px;margin:0 8px;">
      <img src="https://lh3.googleusercontent.com/d/1USK2ut3e0f1VwBbQ8uNqVSD517KtdZZQ" alt="RMF" style="height:34px;margin:0 8px;">
      <img src="https://lh3.googleusercontent.com/d/1XfpwTY8c5GDI4ssInLnIKxJ37UOPKKmO" alt="Revel" style="height:34px;margin:0 8px;">
    </div>
    <div style="background:#0b1f3a;padding:0 30px 40px;text-align:center;">
      <div style="font-size:52px;line-height:1;margin-bottom:6px;">&#x1F389;\u{26BD}</div>
      <h1 style="font-family:'Bebas Neue',sans-serif;color:#fff;font-size:38px;letter-spacing:1px;margin:0 0 6px;">¡Feliz cumpleaños, ${primerNombre}!</h1>
      <span style="display:inline-block;background:#d4a017;color:#0b1f3a;font-weight:700;font-size:16px;padding:6px 18px;border-radius:30px;margin-top:6px;">Hoy cumples ${edad} años</span>
    </div>
    <div style="padding:34px 34px 10px;color:#1a2c4a;">
      <p style="font-size:18px;font-weight:500;color:#0b1f3a;margin:0 0 18px;">Hoy es un día especial, y todo el equipo de ${nombreProgramaCorto} quiere ser parte de tu celebración.</p>
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">Cada año que cumples es un paso más cerca de tus sueños, dentro y fuera de la cancha. Nos llena de orgullo saber que haces parte de esta familia, y no podemos esperar a verte entrenar en la Ciudad del Fútbol del Real Madrid, dando lo mejor de ti en el campo y en cada meta que te propongas en la vida.</p>
      <div style="background:#f4f7fb;border-left:4px solid #1e5ba8;border-radius:0 10px 10px 0;padding:16px 20px;margin:22px 0;font-style:italic;color:#1e5ba8;font-size:15px;">
        "Los sueños no son lo que ves mientras duermes, son las cosas que no te dejan dormir." — Cristiano Ronaldo
      </div>
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">Que este nuevo año esté lleno de goles, aprendizajes y momentos inolvidables junto a tu familia y tus compañeros de equipo, dentro y fuera del fútbol. Sigue soñando en grande, ${primerNombre} — nosotros seguimos aquí para acompañarte en cada paso del camino.</p>
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">¡Feliz cumpleaños, campeón! &#x1F382;\u{26BD}</p>
    </div>
    <div style="padding:0 34px 30px;color:#1a2c4a;">
      <p style="margin:2px 0;font-size:14px;font-weight:700;color:#0b1f3a;margin-top:14px;">Con cariño,</p>
      <p style="margin:2px 0;font-size:14px;">Equipo Victory Sports · Fundación Revel</p>
      <p style="margin:2px 0;font-size:14px;">${nombrePrograma}</p>
    </div>
    <div style="background:#f4f7fb;padding:20px 30px;text-align:center;font-size:12px;color:#8a93a6;">
      ¿Dudas? Escríbenos por WhatsApp o a <a href="mailto:alejandro.cabrera@fundacionrevel.net" style="color:#1e5ba8;text-decoration:none;">alejandro.cabrera@fundacionrevel.net</a>
    </div>
  </div>
</div>`;
}

// Revisa diariamente el Sheet de LEADS (no Inscripciones) y envía el correo
// a cada lead cuyo cumpleaños sea HOY, al correo registrado. Se usa Leads —
// no Inscripciones — porque ahí quedan agrupados los jugadores de AMBOS
// programas (gracias a sincronizarLeadsDesdeInscripciones_, que solo empuja
// filas de tipo Jugador) además de quienes solo llenaron "más información"
// sin haberse inscrito todavía — así el saludo de cumpleaños empieza desde
// el primer contacto, no solo tras completar la inscripción. SOLO envía si
// cumple 18 años o menos — a partir de los 19 deja de recibirlo. Deduplica
// con PropertiesService para no reenviar el mismo cumpleaños dos veces el
// mismo año. La marca del correo (Clinic/World Challenge) sale de la propia
// columna "Programa" de Leads.
function enviarCorreosCumpleanos() {
  try {
    const tz = 'America/Bogota';
    const hoy = new Date();
    const hoyMes = parseInt(Utilities.formatDate(hoy, tz, 'M'));
    const hoyDia = parseInt(Utilities.formatDate(hoy, tz, 'd'));
    const anioActual = parseInt(Utilities.formatDate(hoy, tz, 'yyyy'));

    const sheet = getLeadsSheet_();
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) { Logger.log('enviarCorreosCumpleanos: sin datos en Leads.'); return; }
    const headers = data[0] || [];
    const normHeaders = headers.map(normHeaderKey_);

    const nombreCol = normHeaders.indexOf('nombre');
    const fechaCol = normHeaders.indexOf('fecha_de_nacimiento');
    const emailCol = normHeaders.indexOf('email');
    const programaCol = normHeaders.indexOf('programa');
    if (nombreCol < 0 || fechaCol < 0 || emailCol < 0) {
      Logger.log('enviarCorreosCumpleanos: no se encontraron todas las columnas necesarias en Leads.');
      return;
    }

    const props = PropertiesService.getScriptProperties();
    let enviados = 0;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fechaObj = parseFechaNacimiento(row[fechaCol]);
      if (!fechaObj) continue;
      if (fechaObj.mes !== hoyMes || fechaObj.dia !== hoyDia) continue;

      const nombre = String(row[nombreCol] || '').trim();
      const email = String(row[emailCol] || '').trim();
      if (!nombre || !email) continue;

      const edad = anioActual - fechaObj.anio;
      if (edad <= 0 || edad > 18) continue; // solo hasta los 18 años

      const dedupKey = 'bday_' + anioActual + '_' + normText_(email) + '_' + normText_(nombre);
      if (props.getProperty(dedupKey)) continue;

      const programa = programaCol >= 0 ? String(row[programaCol] || '') : '';
      const nombreProgramaCorto = esWorldChallenge_(programa) ? 'Real Madrid Foundation World Challenge' : 'Real Madrid Foundation Clinic';
      const asunto = '\u{2728}\u{26BD} ¡Feliz cumpleaños, ' + obtenerNombrePila_(nombre) + '!';
      const htmlBody = buildCumpleanosHtml_(nombre, edad, programa);

      GmailApp.sendEmail(email, asunto, 'Feliz cumpleaños ' + nombre + '! Hoy cumples ' + edad + ' años.', {
        htmlBody: htmlBody,
        name: nombreProgramaCorto
      });

      // Recordatorio interno: aviso al equipo cada vez que se envía un
      // correo de cumpleaños, para tener el dato presente aunque no se
      // revise el Log de ejecuciones.
      try {
        GmailApp.sendEmail(
          'alejandro.cabrera@fundacionrevel.net',
          '[Recordatorio] Hoy cumple años: ' + nombre + ' (' + edad + ' años)',
          nombre + ' cumple ' + edad + ' años hoy.\n\n' +
          'Correo del acudiente: ' + email + '\n' +
          'Ya se le envió automáticamente el correo de felicitación.',
          { name: nombreProgramaCorto }
        );
      } catch (notifErr) {
        Logger.log('Aviso interno de cumpleaños error: ' + notifErr);
      }

      props.setProperty(dedupKey, 'sent');
      enviados++;
    }

    Logger.log('enviarCorreosCumpleanos: ' + enviados + ' correo(s) de cumpleaños enviados.');
  } catch (err) {
    Logger.log('enviarCorreosCumpleanos error: ' + err);
  }
}

// ── Ejecutar UNA VEZ desde el editor para instalar el trigger diario ────────
function crearTriggerCumpleanos() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'enviarCorreosCumpleanos') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('enviarCorreosCumpleanos')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .inTimezone('America/Bogota')
    .create();
  Logger.log('Trigger de cumpleaños creado: correrá todos los días a las 8am (Bogotá).');
}

// ---- Config ----
var ANALYTICS_SPREADSHEET_ID = '1f8NA3zZk-Xr_zG_Ufvhfbfdvl8zu7oDV6RQ4W9XeKgE';
var ANALYTICS_SHEET_NAME = "Analytics";
var ANALYTICS_HEADERS = [
  "Timestamp", "VisitorID", "SessionID", "FirstSeen", "Page", "FullURL", "Referrer",
  "UTM_Source", "UTM_Medium", "UTM_Campaign", "Device", "Browser",
  "Language", "Timezone", "Country", "City", "EventType", "EventData"
];

var FUNNEL_INSCRIPCIONES_SHEET_ID = '1y5dB0eD4bpJ7NahLFMB5HqOAp3cYTZDeBTHINot5wss';
var FUNNEL_PASO_COLUMNA = 'Paso Actual';
var FUNNEL_PASO_PAGO_MINIMO = 4;

var RESUMEN_EMAIL_DESTINO = 'alejandro.cabrera@fundacionrevel.net';

function registrarEventoAnalytics_(data) {
  try {
    var sheet = obtenerOCrearHojaAnalytics_();
    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      data.visitorId || "",
      data.sessionId || "",
      data.firstSeen || "",
      data.page || "",
      data.fullUrl || "",
      data.referrer || "",
      data.utm_source || "",
      data.utm_medium || "",
      data.utm_campaign || "",
      data.device || "",
      data.browser || "",
      data.language || "",
      data.timezone || "",
      data.country || "",
      data.city || "",
      data.eventType || "",
      data.eventData || ""
    ]);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function obtenerOCrearHojaAnalytics_() {
  var ss = SpreadsheetApp.openById(ANALYTICS_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(ANALYTICS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ANALYTICS_SHEET_NAME);
    sheet.appendRow(ANALYTICS_HEADERS);
    sheet.setFrozenRows(1);
    return sheet;
  }
  var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  ANALYTICS_HEADERS.forEach(function (h) {
    if (headerRow.indexOf(h) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
    }
  });
  return sheet;
}

function leerFilasAnalytics_(sheet) {
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });
  var rows = values.slice(1).map(function (row) {
    return {
      timestamp: new Date(row[idx["Timestamp"]]),
      visitorId: row[idx["VisitorID"]] || "",
      firstSeen: row[idx["FirstSeen"]] ? new Date(row[idx["FirstSeen"]]) : null,
      page: row[idx["Page"]] || "(desconocida)",
      referrer: row[idx["Referrer"]] || "(directo)",
      utm_source: row[idx["UTM_Source"]] || "",
      device: row[idx["Device"]] || "desconocido",
      browser: row[idx["Browser"]] || "desconocido",
      country: row[idx["Country"]] || "Desconocido",
      city: row[idx["City"]] || "Desconocida",
      eventType: row[idx["EventType"]] || "",
    };
  });
  return rows;
}

function calcularRango_(days) {
  if (isNaN(days)) return null;
  var end = new Date();
  var start = new Date();
  start.setDate(start.getDate() - days);
  return { start: start, end: end };
}

function calcularRangoPrevio_(rango) {
  var durationMs = rango.end.getTime() - rango.start.getTime();
  return {
    start: new Date(rango.start.getTime() - durationMs),
    end: new Date(rango.start.getTime())
  };
}

function calcularResumen_(rows, rango) {
  var pageviewsByDay = {};
  var pagesCount = {};
  var referrersCount = {};
  var utmSourceCount = {};
  var deviceCount = {};
  var browserCount = {};
  var eventCount = {};
  var countryCount = {};
  var cityCount = {};
  var visitorSet = {};
  var newVisitorSet = {};
  var returningVisitorSet = {};
  var utmStats = {};
  var totalPageviews = 0;

  rows.forEach(function (row) {
    if (rango && (row.timestamp < rango.start || row.timestamp > rango.end)) return;

    visitorSet[row.visitorId] = true;

    if (row.firstSeen) {
      var esNuevo = !rango || row.firstSeen >= rango.start;
      if (esNuevo) newVisitorSet[row.visitorId] = true;
      else returningVisitorSet[row.visitorId] = true;
    }

    var src = row.utm_source || "(sin utm)";
    if (!utmStats[src]) utmStats[src] = { pageviews: 0, clicks: 0, forms: 0 };

    if (row.eventType === "pageview") {
      totalPageviews++;
      var day = Utilities.formatDate(row.timestamp, Session.getScriptTimeZone(), "yyyy-MM-dd");
      pageviewsByDay[day] = (pageviewsByDay[day] || 0) + 1;
      pagesCount[row.page] = (pagesCount[row.page] || 0) + 1;
      referrersCount[row.referrer] = (referrersCount[row.referrer] || 0) + 1;
      if (row.utm_source) utmSourceCount[row.utm_source] = (utmSourceCount[row.utm_source] || 0) + 1;
      deviceCount[row.device] = (deviceCount[row.device] || 0) + 1;
      browserCount[row.browser] = (browserCount[row.browser] || 0) + 1;
      countryCount[row.country] = (countryCount[row.country] || 0) + 1;
      cityCount[row.city] = (cityCount[row.city] || 0) + 1;
      utmStats[src].pageviews++;
    } else if (row.eventType && row.eventType !== "time_on_page") {
      eventCount[row.eventType] = (eventCount[row.eventType] || 0) + 1;
      if (row.eventType === "click_inscribirse") utmStats[src].clicks++;
      if (row.eventType === "formulario_enviado") utmStats[src].forms++;
    }
  });

  var utmConversion = Object.keys(utmStats).map(function (src) {
    var s = utmStats[src];
    return {
      source: src,
      pageviews: s.pageviews,
      clicks: s.clicks,
      forms: s.forms,
      conversionRate: s.pageviews > 0 ? Math.round((s.forms / s.pageviews) * 1000) / 10 : 0
    };
  }).sort(function (a, b) { return b.pageviews - a.pageviews; });

  return {
    totalPageviews: totalPageviews,
    uniqueVisitors: Object.keys(visitorSet).length,
    newVisitors: Object.keys(newVisitorSet).length,
    returningVisitors: Object.keys(returningVisitorSet).length,
    pageviewsByDay: pageviewsByDay,
    topPages: pagesCount,
    referrers: referrersCount,
    utmSources: utmSourceCount,
    devices: deviceCount,
    browsers: browserCount,
    countries: countryCount,
    cities: cityCount,
    customEvents: eventCount,
    utmConversion: utmConversion
  };
}

function calcularFunnel_(resumen) {
  var pageviews = resumen.totalPageviews;
  var clicks = (resumen.customEvents && resumen.customEvents['click_inscribirse']) || 0;
  var formsStarted = (resumen.customEvents && resumen.customEvents['formulario_iniciado']) || 0;
  var formsSubmitted = (resumen.customEvents && resumen.customEvents['formulario_enviado']) || 0;
  var paid = 0;

  try {
    var insSs = SpreadsheetApp.openById(FUNNEL_INSCRIPCIONES_SHEET_ID);
    var insSheet = insSs.getSheets()[0];
    var insValues = insSheet.getDataRange().getValues();
    var insHeaders = insValues[0];
    var pasoIdx = insHeaders.indexOf(FUNNEL_PASO_COLUMNA);
    if (pasoIdx !== -1) {
      for (var i = 1; i < insValues.length; i++) {
        var paso = parseInt(insValues[i][pasoIdx], 10);
        if (!isNaN(paso) && paso >= FUNNEL_PASO_PAGO_MINIMO) paid++;
      }
    }
  } catch (err) {
    paid = null;
  }

  return {
    pageviews: pageviews,
    clicks: clicks,
    formsStarted: formsStarted,
    formsSubmitted: formsSubmitted,
    paid: paid
  };
}

function obtenerResumenAnalytics_(e) {
  var providedToken = e.parameter.token || '';
  var props = PropertiesService.getScriptProperties();
  var storedToken = props.getProperty("ANALYTICS_TOKEN");
  var autorizado = !!storedToken && providedToken === storedToken;
  if (!autorizado) {
    var payload = verificarSesionToken(providedToken);
    autorizado = !!payload && ['superadmin', 'editor', 'viewer'].indexOf(payload.rol) >= 0;
  }
  if (!autorizado) {
    return ContentService.createTextOutput(JSON.stringify({ error: "No autorizado" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = obtenerOCrearHojaAnalytics_();
  var allRows = leerFilasAnalytics_(sheet);

  var daysParam = parseInt(e.parameter.days, 10);
  var rango = calcularRango_(daysParam);

  var resumen = calcularResumen_(allRows, rango);
  resumen.funnel = calcularFunnel_(resumen);

  if (rango) {
    var rangoPrevio = calcularRangoPrevio_(rango);
    var resumenPrevio = calcularResumen_(allRows, rangoPrevio);
    resumen.comparacionPeriodoAnterior = {
      totalPageviews: resumenPrevio.totalPageviews,
      uniqueVisitors: resumenPrevio.uniqueVisitors,
      clicks: (resumenPrevio.customEvents && resumenPrevio.customEvents['click_inscribirse']) || 0,
      forms: (resumenPrevio.customEvents && resumenPrevio.customEvents['formulario_enviado']) || 0
    };
  } else {
    resumen.comparacionPeriodoAnterior = null;
  }

  return ContentService.createTextOutput(JSON.stringify(resumen))
    .setMimeType(ContentService.MimeType.JSON);
}

function enviarResumenSemanal_() {
  var sheet = obtenerOCrearHojaAnalytics_();
  var allRows = leerFilasAnalytics_(sheet);
  var rango = calcularRango_(7);
  var resumen = calcularResumen_(allRows, rango);
  resumen.funnel = calcularFunnel_(resumen);

  var topPagina = Object.keys(resumen.topPages).sort(function (a, b) {
    return resumen.topPages[b] - resumen.topPages[a];
  })[0] || "—";

  var cuerpo =
    "Resumen de analytics — últimos 7 días\n\n" +
    "Visitas totales: " + resumen.totalPageviews + "\n" +
    "Visitantes únicos: " + resumen.uniqueVisitors + " (" + resumen.newVisitors + " nuevos, " + resumen.returningVisitors + " recurrentes)\n" +
    "Clics en 'Inscribirse': " + resumen.funnel.clicks + "\n" +
    "Formularios iniciados: " + resumen.funnel.formsStarted + "\n" +
    "Formularios enviados: " + resumen.funnel.formsSubmitted + "\n" +
    (resumen.funnel.paid !== null ? "Pagos confirmados (histórico): " + resumen.funnel.paid + "\n" : "") +
    "Página más visitada: " + topPagina + "\n";

  GmailApp.sendEmail(RESUMEN_EMAIL_DESTINO, "Victory Analytics — Resumen semanal", cuerpo);
}

function configurarTriggerResumenSemanal() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'enviarResumenSemanal_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('enviarResumenSemanal_')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.TUESDAY)
    .atHour(8)
    .create();
  Logger.log("Trigger configurado: enviarResumenSemanal_ correrá todos los martes a las 8am.");
}

function testCrearHojaAnalytics() {
  var sheet = obtenerOCrearHojaAnalytics_();
  Logger.log("Hoja lista: " + sheet.getName() + " — filas: " + sheet.getLastRow());
}

