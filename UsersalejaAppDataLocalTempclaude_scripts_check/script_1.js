
// ── CONFIG (mismo webhook que inscripción; Make filtra por body.action) ───
const WEBHOOK_URL = 'https://hook.us2.make.com/8mktm4zb9ag3ok257n5vhwwhdy371cju';

// APPS_SCRIPT_URL viene de config.js (compartido entre todas las páginas)
const ADMIN_EMAILS = ['alejandro.cabrera@fundacionrevel.net','presidente@fundacionrevel.net','andres.dewasseige@fundacionrevel.net'];
const SUPER_ADMIN = 'alejandro.cabrera@fundacionrevel.net';
// Las contraseñas se gestionan desde la propia app (admin → panel acceso; comercial → panel comercial)
// (Después de desplegar tu Apps Script, copia la URL de implementación aquí)

/** Mismo criterio que inscripcion.html: evita preflight CORS desde GitHub Pages. */
function postMakeWebhook(baseUrl, payload) {
  return fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: '*/*'
    },
    body: JSON.stringify(payload),
    keepalive: true
  });
}

// ── Estado global (getTyC, loadParticipant, pasos) ───────────────────────────
let allParticipants = [];
let currentIndex = 0;
let nombre = 'Participante';
let participantEmail = '';
let misPagosValidados = {}; // { reserva: {estado,eur,cop}, final: {...} } — solo lo que el admin ya validó
let tipo = 'jugador';
let conTiq = false;
let soloAct = false;
let sinPagoFinal = false; // World Challenge: grupo cuyo Pago Final es 0 (Solo Actividades/Solo World Challenge) — oculta el paso "Pago final" del stepper
let esStaffView = false;
let esComercialOnly = false;
let _gatedOnlySession = false; // true cuando se entra directo a admin/comercial sin datos de participante real
let grupoPaso = 1;
let programa = '';
let programKeyActivo = 'clinic'; // 'clinic' | 'world_challenge' — programa activo en pantalla
let adminLoaded = false;
let adminLastLoaded = 0;
let adminData = [];
let adminProgramaActivo = 'clinic'; // 'clinic' | 'world_challenge' — qué programa está viendo el admin
let pagoCurrentProgramKey = 'clinic'; // programa del participante cuyo modal de pagos está abierto
let adminSessionToken = sessionStorage.getItem('admin_token') || '';
let comercialSessionToken = sessionStorage.getItem('comercial_token') || '';
let adminCurrentRow = null;
let pagoCurrentIdx = null;
let pagoCurrentNombre = null;
let pagoCurrentTipo = '';
let pagoCurrentParticipanteNorm = null; // participante normalizado del modal de Pagos abierto — usado para calcular el monto esperado al confirmar/registrar un pago
let pagoCurrentTieneTiquete = true;
let habitacion = '';
let fotosLoaded = false;
let saberLoaded = false;
let comunLoaded = false;

/** Escapa HTML para insertar de forma segura texto proveniente de Sheets/usuarios en innerHTML. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Normaliza nombres de campo para comparar claves de Sheets/Make (tildes, espacios, /, guiones). */
function normFieldName(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Lee el primer valor no vacío de obj usando nombres candidatos y coincidencia flexible de claves.
 */
function rowVal(obj, ...names) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const byNorm = {};
  for (const key of Object.keys(obj)) {
    const nk = normFieldName(key);
    if (byNorm[nk] !== undefined) continue;
    const v = obj[key];
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) continue;
    const s = String(v).trim();
    if (s !== '') byNorm[nk] = s;
  }
  for (const name of names) {
    const nk = normFieldName(name);
    if (nk && byNorm[nk] !== undefined) return byNorm[nk];
  }
  return '';
}

function normalizeParticipant(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) return normalizeParticipant(p);
    } catch (_) {}
    return null;
  }
  if (Array.isArray(raw) || typeof raw !== 'object') return null;

  // Make.com Array Aggregator returns numeric column indices ("0","1","2"...) instead of header names
  const numColMap = {
    '1':'tipo','2':'nombre','3':'email','4':'phone','5':'pais','6':'pasaporte',
    '7':'fecha_nacimiento','8':'posicion','9':'club_colegio','10':'ciudad',
    '11':'salud_alergias','12':'acudiente','13':'relacion','14':'tiquete_aereo',
    '15':'programa','16':'habitacion','22':'paso_actual'
  };
  if (Object.keys(raw).some(k => /^\d+$/.test(k) && Number(k) < 20)) {
    const remapped = { ...raw };
    for (const [col, name] of Object.entries(numColMap)) {
      if (raw[col] != null && raw[col] !== '' && !remapped[name]) remapped[name] = raw[col];
    }
    raw = remapped;
  }

  const tipoRaw = (rowVal(raw, 'tipo', 'Tipo', 'type', 'rol', 'Rol', 'categoria', 'Categoría') || 'Jugador').toLowerCase();
  const esJugador = tipoRaw.includes('jug');
  const esStaff   = tipoRaw.includes('staff');
  const tiqRaw = rowVal(
    raw,
    'tiquete_aereo',
    'tiquete aereo',
    'Tiquete aéreo',
    'Tiquete aereo',
    'Tiquete',
    'tiquete',
    'Tiquete aéreo ',
    'vuelo',
    'Vuelo'
  );
  const conTicket = (tiqRaw === 'Con tiquete') || /con\s*tiquete/i.test(tiqRaw);

  const emailRaw = rowVal(
    raw,
    'email',
    'Email',
    'correo',
    'Correo electrónico',
    'Correo electronico',
    'e-mail',
    'E-mail',
    'mail'
  );

  return {
    nombre: rowVal(raw, 'nombre', 'Nombre completo', 'nombre_completo', 'Nombre', 'name', 'participant', 'Participante'),
    fecha_nacimiento: rowVal(
      raw,
      'fecha_nacimiento',
      'fecha de nacimiento',
      'Fecha de nacimiento',
      'fecha nacimiento',
      'Fecha nacimiento',
      'fnac',
      'birthdate',
      'date_of_birth',
      'dob'
    ),
    email: emailRaw.toLowerCase(),
    email_acudiente: rowVal(raw, 'email_acudiente', 'Email acudiente', 'email acudiente', 'correo_acudiente') || emailRaw.toLowerCase(),
    posicion: rowVal(raw, 'posicion', 'posición', 'Posición', 'Posicion', 'position', 'Position', 'rol_deportivo'),
    club_colegio: rowVal(
      raw,
      'club_colegio',
      'club colegio',
      'Club / Colegio',
      'Club colegio',
      'colegio',
      'club',
      'Club',
      'escuela',
      'institucion',
      'institución'
    ),
    tipo: esJugador ? 'Jugador' : esStaff ? 'Staff' : 'Acompañante',
    tiquete_aereo: conTicket ? 'Con tiquete' : (tiqRaw || 'Sin tiquete'),
    programa: rowVal(raw, 'programa', 'Programa', 'program', 'evento', 'Evento'),
    // '_program_key' viene marcado por el backend (buscarParticipantes) según de
    // qué sheet salió la fila — es la fuente de verdad. Si no viene (ej. otros
    // endpoints que aún no la setean), se infiere del texto libre de 'programa'.
    program_key: rowVal(raw, 'program_key') || (
      /world\s*challenge/i.test(rowVal(raw, 'programa', 'Programa', 'program', 'evento', 'Evento')) ? 'world_challenge' : 'clinic'
    ),
    habitacion: rowVal(raw, 'habitacion', 'habitación', 'Habitacion', 'Habitación', 'room', 'tipo_habitacion'),
    acudiente: rowVal(
      raw,
      'acudiente',
      'Nombre del acudiente',
      'nombre acudiente',
      'Nombre acudiente',
      'tutor',
      'Tutor',
      'representante',
      'padre_madre'
    ),
    phone: rowVal(
      raw,
      'phone',
      'Phone',
      'whatsapp',
      'WhatsApp',
      'telefono',
      'teléfono',
      'Teléfono',
      'movil',
      'móvil',
      'celular',
      'Celular',
      'contacto',
      'tel'
    ),
    pais: rowVal(raw, 'pais', 'país', 'País', 'country', 'país_residencia'),
    ciudad: rowVal(raw, 'ciudad', 'Ciudad', 'city', 'municipio', 'Municipio'),
    relacion: rowVal(raw, 'relacion', 'relación', 'Relación', 'Relacion', 'parentesco', 'Parentesco', 'vinculo', 'Vínculo'),
    paso_actual: rowVal(raw, 'paso_actual', 'Paso Actual', 'paso actual', 'step', 'paso'),
    abono_reserva: parseFloat(rowVal(raw, 'abono_reserva')) || 0,
    abono_tiquete: parseFloat(rowVal(raw, 'abono_tiquete')) || 0,
    abono_final: parseFloat(rowVal(raw, 'abono_final')) || 0,
    abono_reserva_fecha: rowVal(raw, 'abono_reserva_fecha') || '',
    abono_tiquete_fecha: rowVal(raw, 'abono_tiquete_fecha') || '',
    abono_final_fecha: rowVal(raw, 'abono_final_fecha') || '',
    // Comisión de tarjeta (3.5% Bold) y bruto realmente pagado — abono_* de
    // arriba ya viene SIN esta comisión (cuenta para el saldo); estos campos
    // son solo para mostrar el desglose al cliente/admin. Ver getAbonosValidados_
    // en el backend, que hace la separación.
    abono_reserva_comision: parseFloat(rowVal(raw, 'abono_reserva_comision')) || 0,
    abono_tiquete_comision: parseFloat(rowVal(raw, 'abono_tiquete_comision')) || 0,
    abono_final_comision: parseFloat(rowVal(raw, 'abono_final_comision')) || 0,
    abono_reserva_bruto: parseFloat(rowVal(raw, 'abono_reserva_bruto')) || 0,
    abono_tiquete_bruto: parseFloat(rowVal(raw, 'abono_tiquete_bruto')) || 0,
    abono_final_bruto: parseFloat(rowVal(raw, 'abono_final_bruto')) || 0,
    // Equivalente en COP de lo realmente pagado (bruto) — ver getAbonosValidados_.
    abono_reserva_cop_bruto: parseFloat(rowVal(raw, 'abono_reserva_cop_bruto')) || 0,
    abono_tiquete_cop_bruto: parseFloat(rowVal(raw, 'abono_tiquete_cop_bruto')) || 0,
    abono_final_cop_bruto: parseFloat(rowVal(raw, 'abono_final_cop_bruto')) || 0,
    // Estado de la fila PROPIA de este participante en Pagos (no del grupo) —
    // se usa para exigir que cada quien esté individualmente en "Completo"
    // antes de dar el concepto por pagado (ver conceptoGrupoCompleto_).
    abono_reserva_estado: (rowVal(raw, 'abono_reserva_estado') || '').toLowerCase(),
    abono_tiquete_estado: (rowVal(raw, 'abono_tiquete_estado') || '').toLowerCase(),
    abono_final_estado: (rowVal(raw, 'abono_final_estado') || '').toLowerCase(),
    // Programa de Referidos: 3 si este email tiene un código de referido
    // aplicado (ver descuentoReferidoDeEmail_ en el backend) — sin este
    // campo en el whitelist, montoReservaFinalParticipante_ nunca vería el
    // descuento aunque el backend sí lo mande.
    referido_descuento_pct: parseFloat(rowVal(raw, 'referido_descuento_pct')) || 0,
    // Alianza/promoción con precio total fijo (ver alianzaPorNombre_ en el
    // backend) — invalida el descuento de referido de arriba cuando está
    // presente. Mismo motivo de whitelist que referido_descuento_pct.
    alianza_nombre: rowVal(raw, 'alianza_nombre', 'Alianza', 'alianza') || '',
    alianza_precio_total: parseFloat(rowVal(raw, 'alianza_precio_total')) || 0,
  };
}

// Normaliza nombres para comparar identidad entre hojas (ignora may/min, espacios y tildes)
function normNombre(s) {
  return String(s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "Redcol" agrupa a los jugadores de estos 4 colegios — no es un valor real
// del campo Club/Colegio, así que buscar "redcol" en Participantes/Pagos no
// encontraría nada por texto plano. Se usan fragmentos distintivos de cada
// nombre (sin "Colegio"/ciudad) para que la coincidencia sea robusta aunque
// el dato en el Sheet varíe un poco en redacción.
const REDCOL_COLEGIOS_KEYWORDS = ['new cambridge', 'britanico', 'arboleda', 'vermont'];
function esColegioRedcol_(clubColegio) {
  const c = normNombre(clubColegio);
  return REDCOL_COLEGIOS_KEYWORDS.some(k => c.includes(k));
}

function extractParticipants(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body.map(normalizeParticipant).filter(Boolean);
  if (Array.isArray(body.participants)) return body.participants.map(normalizeParticipant).filter(Boolean);
  if (Array.isArray(body.rows)) return body.rows.map(normalizeParticipant).filter(Boolean);
  if (Array.isArray(body.data)) return body.data.map(normalizeParticipant).filter(Boolean);
  if (body.participant && typeof body.participant === 'object') return [normalizeParticipant(body.participant)].filter(Boolean);
  if (body.ok === false) return [];
  if (body.nombre || body.email) return [normalizeParticipant(body)].filter(Boolean);
  return [];
}

async function readJsonFlexible(res) {
  const text = await res.text();
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function edadDesdeISO(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  const t = new Date();
  let age = t.getFullYear() - d.getFullYear();
  const m = t.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < d.getDate())) age--;
  return age;
}

function updateDatosResumen(p) {
  document.getElementById('d-nombre').textContent =
    p.nombre || '-';

  document.getElementById('d-fecha').textContent =
    p.fecha_nacimiento || '-';

  document.getElementById('d-email').textContent =
    p.email || '-';

  document.getElementById('d-posicion').textContent =
    p.posicion || '-';

  document.getElementById('d-club').textContent =
    p.club_colegio || '-';
}

function updatePermisoDoc(u) {
  const el = document.getElementById('permiso-doc');
  const elReg = document.getElementById('registro-civil-doc');
  if (!el) return;
  // Permiso de salida y registro civil solo aplican al propio participante
  // cuando tiene tiquete aéreo Y además es menor de edad (misma fórmula de
  // edad de referencia que calcEdadRefFront: al 2 de octubre de 2026).
  const tieneTiquete = !!(u && u.tiquete_aereo === 'Con tiquete');
  const fObj = u ? parseFechaNacFront(u.fecha_nacimiento || '') : null;
  const edad = fObj ? calcEdadRefFront(fObj) : null;
  const esMenor = edad !== null && edad < 18;
  const requiereDocsExtra = tieneTiquete && esMenor;
  el.style.display = requiereDocsExtra ? '' : 'none';
  if (elReg) elReg.style.display = requiereDocsExtra ? '' : 'none';
}

// ── CÁLCULO DE TOTALES POR GRUPO ──────────────────────────────────────────────
// Filtra al programa ACTIVO (programKeyActivo) — un mismo email con
// inscripción en Clinic Y World Challenge tiene dos grupos independientes;
// antes esta función usaba allParticipants sin filtrar y mezclaba ambos.
function calcPaymentTotals() {
  const participantesPrograma = allParticipants.filter(p => (p.program_key || 'clinic') === programKeyActivo);
  const esWC = programKeyActivo === 'world_challenge';
  const total = participantesPrograma.length || 1;

  let reserva = 0, final = 0;
  for (const raw of participantesPrograma) {
    const n = normalizeParticipant(raw) || raw;
    const m = montoReservaFinalParticipante_(n, esWC);
    reserva += m.reserva;
    final += m.final;
  }
  if (participantesPrograma.length === 0) final = esWC ? PRECIOS_WC.jugador.final : 1790; // fallback

  const tasaRT = tasaReservaTiquete_();
  const tiqueteEurUnit = tiqueteUnitEur_();
  const tiqCount = participantesPrograma.filter(p => {
    const n = normalizeParticipant(p) || p;
    return n.tiquete_aereo === 'Con tiquete';
  }).length;
  const tiquete = Math.round(tiqueteEurUnit * tasaRT) * tiqCount;

  const abonoReserva = participantesPrograma.reduce((s, raw) => s + ((normalizeParticipant(raw) || raw).abono_reserva || 0), 0);
  const abonoTiquete = participantesPrograma.reduce((s, raw) => s + ((normalizeParticipant(raw) || raw).abono_tiquete || 0), 0);
  const abonoFinal = participantesPrograma.reduce((s, raw) => s + ((normalizeParticipant(raw) || raw).abono_final || 0), 0);
  // Comisión de tarjeta (3.5% Bold) ya excluida de abono* arriba — se suma
  // aparte solo para mostrarle al cliente el desglose (base + comisión = lo
  // realmente pagado), sin que afecte el saldo pendiente.
  const comisionReserva = participantesPrograma.reduce((s, raw) => s + ((normalizeParticipant(raw) || raw).abono_reserva_comision || 0), 0);
  const comisionTiquete = participantesPrograma.reduce((s, raw) => s + ((normalizeParticipant(raw) || raw).abono_tiquete_comision || 0), 0);
  const comisionFinal = participantesPrograma.reduce((s, raw) => s + ((normalizeParticipant(raw) || raw).abono_final_comision || 0), 0);
  // Equivalente en COP de lo realmente pagado (bruto) — para mostrar el abono
  // recibido también en COP, no solo en EUR (ver mostrarAbonoYRestante).
  const copBrutoReserva = participantesPrograma.reduce((s, raw) => s + ((normalizeParticipant(raw) || raw).abono_reserva_cop_bruto || 0), 0);
  const copBrutoTiquete = participantesPrograma.reduce((s, raw) => s + ((normalizeParticipant(raw) || raw).abono_tiquete_cop_bruto || 0), 0);
  const copBrutoFinal = participantesPrograma.reduce((s, raw) => s + ((normalizeParticipant(raw) || raw).abono_final_cop_bruto || 0), 0);
  // Detalle de cada abono individual (monto + fecha) — si más de un participante del
  // grupo pagó por separado el mismo concepto, se listan todos en vez de mostrar
  // arbitrariamente la fecha del primero.
  const detalleAbonos = (campoMonto, campoFecha, campoCop) => participantesPrograma
    .map(raw => normalizeParticipant(raw) || raw)
    .filter(p => (p[campoMonto] || 0) > 0)
    .map(p => ({ monto: p[campoMonto], fecha: p[campoFecha] || '', cop: p[campoCop] || 0 }));
  const abonosReservaDetalle = detalleAbonos('abono_reserva', 'abono_reserva_fecha', 'abono_reserva_cop_bruto');
  const abonosTiqueteDetalle = detalleAbonos('abono_tiquete', 'abono_tiquete_fecha', 'abono_tiquete_cop_bruto');
  const abonosFinalDetalle = detalleAbonos('abono_final', 'abono_final_fecha', 'abono_final_cop_bruto');

  return {
    reserva, tiquete, final, tiqCount, total, abonoReserva, abonoTiquete, abonoFinal,
    comisionReserva, comisionTiquete, comisionFinal,
    copBrutoReserva, copBrutoTiquete, copBrutoFinal,
    abonosReservaDetalle, abonosTiqueteDetalle, abonosFinalDetalle
  };
}

// Monto BASE (sin recargo de tarjeta) que le corresponde pagar a UN
// participante para un concepto — mismas reglas que calcPaymentTotals(), pero
// para una sola persona. Devuelve 0 si el concepto no le aplica (ej. tiquete
// para quien no lo tiene).
function montoEsperadoParticipante_(tipoPago, p, esWC) {
  if (tipoPago === 'reserva') return montoReservaFinalParticipante_(p, esWC).reserva;
  if (tipoPago === 'tiquete') return p.tiquete_aereo === 'Con tiquete' ? tiqueteUnitEur_() : 0;
  return montoReservaFinalParticipante_(p, esWC).final;
}

// Reparte un pago (monto BASE en EUR, sin recargo de tarjeta) entre los
// participantes del grupo activo que todavía tengan saldo pendiente para
// `tipoPago` — llenando a cada uno hasta cubrir exactamente lo que le falta
// antes de pasar al siguiente (en el orden en que aparecen en el grupo).
//
// Por qué existe: el área personal muestra un solo "saldo pendiente"
// combinado cuando el correo tiene varios participantes vinculados (ej. un
// jugador y sus acompañantes, o varios acompañantes bajo el mismo correo),
// pero en la hoja Pagos cada participante tiene su PROPIA fila independiente.
// Sin este reparto, todo el pago quedaría registrado contra quien subió el
// comprobante — aunque el dinero en realidad cubra lo que debe OTRO
// participante del grupo — y las filas de los demás nunca se pondrían al día
// aunque el grupo ya haya pagado todo.
function calcularDistribucionPago_(tipoPago, montoBaseEur) {
  const participantesPrograma = allParticipants.filter(p => (p.program_key || 'clinic') === programKeyActivo);
  const esWC = programKeyActivo === 'world_challenge';

  let restanteAAsignar = Math.round(montoBaseEur * 100) / 100;
  const distribucion = [];
  for (const raw of participantesPrograma) {
    if (restanteAAsignar <= 0) break;
    const p = normalizeParticipant(raw) || raw;
    const esperado = montoEsperadoParticipante_(tipoPago, p, esWC);
    if (esperado <= 0) continue; // no debe nada de este concepto
    const abonoCampo = tipoPago === 'reserva' ? 'abono_reserva' : tipoPago === 'tiquete' ? 'abono_tiquete' : 'abono_final';
    const faltante = Math.max(0, esperado - (p[abonoCampo] || 0));
    if (faltante <= 0) continue; // ya está cubierto
    const asignado = Math.round(Math.min(faltante, restanteAAsignar) * 100) / 100;
    if (asignado <= 0) continue;
    distribucion.push({ nombre: p.nombre, eur: asignado });
    restanteAAsignar = Math.round((restanteAAsignar - asignado) * 100) / 100;
  }
  // Si sobra dinero después de cubrir a todos los que debían (ej. pagó de
  // más, o hubo un desfase de redondeo), se le suma al último participante
  // de la lista para no perder el excedente en vez de descartarlo.
  if (restanteAAsignar > 0 && participantesPrograma.length > 0) {
    const ultimoRaw = participantesPrograma[participantesPrograma.length - 1];
    const ultimo = normalizeParticipant(ultimoRaw) || ultimoRaw;
    const existente = distribucion.find(d => d.nombre === ultimo.nombre);
    if (existente) existente.eur = Math.round((existente.eur + restanteAAsignar) * 100) / 100;
    else distribucion.push({ nombre: ultimo.nombre, eur: restanteAAsignar });
  }
  return distribucion;
}

// Un concepto (reserva/tiquete/final) se considera realmente completo para
// TODO el grupo solo cuando cada participante que debía algo de ese concepto
// quedó individualmente en estado "Completo" en su propia fila de Pagos — no
// basta con que la SUMA del grupo alcance el total (ver applyPasoActual /
// applyPaymentTotals). Alguien que no debe nada de ese concepto (ej. reserva
// para un acompañante solo actividades) no bloquea el chequeo.
function conceptoGrupoCompleto_(tipoPago) {
  const participantesPrograma = allParticipants.filter(p => (p.program_key || 'clinic') === programKeyActivo);
  const esWC = programKeyActivo === 'world_challenge';
  const estadoCampo = tipoPago === 'reserva' ? 'abono_reserva_estado' : tipoPago === 'tiquete' ? 'abono_tiquete_estado' : 'abono_final_estado';
  return participantesPrograma.every(raw => {
    const p = normalizeParticipant(raw) || raw;
    const esperado = montoEsperadoParticipante_(tipoPago, p, esWC);
    if (esperado <= 0) return true; // no debe nada de este concepto, no bloquea
    return p[estadoCampo] === 'completo';
  });
}

function applyPaymentTotals(t) {
  // Reserva: input + título del card, usando lo restante si hay abono
  const e1 = document.getElementById('eur1');
  const restanteReserva = mostrarAbonoYRestante('eur1', 'aviso-abono-reserva', '#pay-card1', null, t.reserva, t.abonoReserva || 0, 'la reserva', t.abonosReservaDetalle, t.comisionReserva || 0, t.copBrutoReserva || 0);
  window.restantePendiente = window.restantePendiente || {};
  window.restantePendiente.reserva = restanteReserva;
  if (e1) { e1.value = restanteReserva; calc1(); }
  if (pagoYaCongelado('reserva')) aplicarCongelamiento('reserva');
  const pc1 = document.getElementById('pay-card1');
  if (pc1) {
    const h = pc1.querySelector('.ctitle');
    if (h) h.childNodes[0].textContent = `Pago de reserva — ${t.reserva.toLocaleString('es-CO')} EUR `;
  }
  const idxR = STEP_DEFS.findIndex(s => s.panel === 'panel2');
  if (idxR > -1) STEP_DEFS[idxR].done = t.reserva > 0 && (t.abonoReserva || 0) >= t.reserva && conceptoGrupoCompleto_('reserva');

  // Tiquete: input (EUR fijo por persona), usando lo restante si hay abono
  const etiq = document.getElementById('eur-tiq');
  const totalTiqueteEur = tiqueteUnitEur_() * (t.tiqCount || 1);
  const restanteTiquete = mostrarAbonoYRestante('eur-tiq', 'aviso-abono-tiquete', '#panel-tiq', null, totalTiqueteEur, t.abonoTiquete || 0, 'el tiquete aéreo', t.abonosTiqueteDetalle, t.comisionTiquete || 0, t.copBrutoTiquete || 0);
  window.restantePendiente = window.restantePendiente || {};
  window.restantePendiente.tiquete = restanteTiquete;
  if (etiq) { etiq.value = restanteTiquete; calcTiq(); }
  const idxT = STEP_DEFS.findIndex(s => s.panel === 'panel-tiq');
  if (idxT > -1) STEP_DEFS[idxT].done = totalTiqueteEur > 0 && (t.abonoTiquete || 0) >= totalTiqueteEur && conceptoGrupoCompleto_('tiquete');

  // Pago final: input + subtítulo, usando lo restante si hay abono
  const e2 = document.getElementById('eur2');
  const restanteFinal = mostrarAbonoYRestante('eur2', 'aviso-abono-final', '#panel3', null, t.final, t.abonoFinal || 0, 'el pago final', t.abonosFinalDetalle, t.comisionFinal || 0, t.copBrutoFinal || 0);
  window.restantePendiente = window.restantePendiente || {};
  window.restantePendiente.final = restanteFinal;
  if (e2) { e2.value = restanteFinal; calc2(); }
  if (pagoYaCongelado('final')) aplicarCongelamiento('final');
  const sub3 = document.getElementById('panel3-subtitle');
  if (sub3) sub3.textContent = `SEGUNDO PAGO — ${t.final.toLocaleString('es-CO')} EUR`;
  const idxF = STEP_DEFS.findIndex(s => s.panel === 'panel3');
  if (idxF > -1) STEP_DEFS[idxF].done = t.final > 0 && (t.abonoFinal || 0) >= t.final && conceptoGrupoCompleto_('final');

  buildSteps();
  buildBreakdown(t);
  actualizarPagosCompletados();
}

function buildBreakdown(t) {
  function bkRow(nombre, sub, amt, currency) {
    return `<div class="bkrow"><span class="bk-name"><strong>${escapeHtml(nombre)}</strong><span class="bk-sub">(${escapeHtml(sub)})</span></span><span class="bk-amt">${amt.toLocaleString('es-CO')} ${currency || 'EUR'}</span></div>`;
  }
  function totalRow(label, amt, currency) {
    return `<div class="bkrow"><span>${escapeHtml(label)}</span><span class="bk-amt">${amt.toLocaleString('es-CO')} ${currency || 'EUR'}</span></div>`;
  }

  const participantesPrograma = allParticipants.filter(p => (p.program_key || 'clinic') === programKeyActivo);
  const esWC = programKeyActivo === 'world_challenge';

  // Reserva
  const br = document.getElementById('breakdown-reserva');
  if (br) {
    if (t.total > 1) {
      br.innerHTML = participantesPrograma.map(raw => {
        const p = normalizeParticipant(raw) || raw;
        const m = montoReservaFinalParticipante_(p, esWC);
        return bkRow(p.nombre || 'Participante', p.tipo || 'Jugador', m.reserva);
      }).join('') + totalRow('Total reserva', t.reserva);
      br.style.display = 'block';
    } else { br.style.display = 'none'; }
  }

  // Tiquete
  const bt = document.getElementById('breakdown-tiquete');
  if (bt) {
    const tasaRT = tasaReservaTiquete_();
    const tiqueteEurUnit = tiqueteUnitEur_();
    const tiqPax = participantesPrograma.map(raw => normalizeParticipant(raw) || raw).filter(p => p.tiquete_aereo === 'Con tiquete');
    if (tiqPax.length > 1) {
      bt.innerHTML = tiqPax.map(p => bkRow(p.nombre || 'Participante', p.tipo || 'Jugador', Math.round(tiqueteEurUnit * tasaRT), 'COP')).join('') + totalRow('Total tiquete', t.tiquete, 'COP');
      bt.style.display = 'block';
    } else { bt.style.display = 'none'; }
  }

  // Pago final
  const bf = document.getElementById('breakdown-final');
  if (bf) {
    if (t.total > 1) {
      bf.innerHTML = participantesPrograma.map(raw => {
        const p = normalizeParticipant(raw) || raw;
        const m = montoReservaFinalParticipante_(p, esWC);
        return bkRow(p.nombre || 'Participante', m.sub, m.final);
      }).join('') + totalRow('Total pago final', t.final);
      bf.style.display = 'block';
    } else { bf.style.display = 'none'; }
  }

  // Valor total del programa (reserva + pago final combinados, sin
  // subdividir) y del tiquete aéreo (si aplica) — vive en el paso de T&C
  // para que el participante vea de entrada cuánto va a pagar en total, sea
  // solo jugador o jugador + acompañantes. Antes programa y tiquete se
  // mostraban en dos cajas separadas, cada una con su propio subtotal; ahora
  // van juntas en un solo bloque — nombre, programa, tiquete — cerrado con
  // un único Total combinado (el tiquete se sigue pagando en su propio
  // panel aparte, esto es solo el resumen informativo).
  const bTotal = document.getElementById('breakdown-total-programa');
  if (bTotal) {
    if (participantesPrograma.length > 0) {
      let sumaPrograma = 0;
      const filasPrograma = participantesPrograma.map(raw => {
        const p = normalizeParticipant(raw) || raw;
        const m = montoReservaFinalParticipante_(p, esWC);
        sumaPrograma += m.reserva + m.final;
        return bkRow(p.nombre || 'Participante', m.sub, m.reserva + m.final);
      }).join('');

      const tiqueteUnit = tiqueteUnitEur_();
      const paxConTiquete = participantesPrograma.map(raw => normalizeParticipant(raw) || raw).filter(p => p.tiquete_aereo === 'Con tiquete');
      const filasTiquete = paxConTiquete.map(p => bkRow(p.nombre || 'Participante', 'Tiquete aéreo', tiqueteUnit)).join('');
      const sumaTiquete = tiqueteUnit * paxConTiquete.length;

      bTotal.innerHTML = filasPrograma + filasTiquete + totalRow('Total', sumaPrograma + sumaTiquete);
      bTotal.style.display = 'block';
    } else { bTotal.style.display = 'none'; }
  }
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function doLogin() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const errEl = document.getElementById('login-err');
  const defaultErr = 'No encontramos ninguna inscripción con ese correo. Verifica que sea el mismo que usaste en el formulario.';
  errEl.textContent = defaultErr;
  if (!email || !email.includes('@')) {
    errEl.textContent = 'Introduce un correo electrónico válido.';
    errEl.style.display = 'block';
    return;
  }
  // Admin emails — skip sheet lookups entirely and go straight to the admin gate
  if (ADMIN_EMAILS.includes(email)) {
    participantEmail = email;
    showAdminOnly();
    return;
  }
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Buscando...';
  errEl.style.display = 'none';
  try {
    // Buscar participante, comercial y referidor en paralelo
    const [rawText, comercialJson, referidoJson] = await Promise.all([
      fetch(APPS_SCRIPT_URL + '?action=buscar&email=' + encodeURIComponent(email) + '&login=1&_t=' + Date.now(), { redirect: 'follow' }).then(r => r.text()),
      fetch(APPS_SCRIPT_URL + '?action=comercial_login&email=' + encodeURIComponent(email) + '&_t=' + Date.now(), { redirect: 'follow' }).then(r => r.json()).catch(() => ({ found: false })),
      fetch(APPS_SCRIPT_URL + '?action=referido_login&email=' + encodeURIComponent(email) + '&_t=' + Date.now(), { redirect: 'follow' }).then(r => r.json()).catch(() => ({ found: false }))
    ]);

    let data; try { data = JSON.parse(rawText); } catch(e2) { data = null; }
    const rawParticipants = extractParticipants(data);
    const isComercial = !!(comercialJson && comercialJson.found);

    // Sin participantes y sin comercial → verificar admin o mostrar error
    if (rawParticipants.length === 0 && !isComercial) throw new Error('not_found');

    // Comercial sin participantes → panel de comisiones únicamente
    if (rawParticipants.length === 0 && isComercial) {
      participantEmail = email;
      showComercialOnly(comercialJson);
      return;
    }

    // Participante normal (con o sin rol comercial) — flujo existente
    allParticipants = rawParticipants.map(p => normalizeParticipant(p) || p);

    document.getElementById('login-gate').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';

    // Si el correo tiene inscripción en más de un programa (ej. Clinic Y World
    // Challenge), mostrar los botones para cambiar entre sus áreas personales.
    // Cada programa se inscribe/paga por separado — ver activarPrograma().
    const programasPresentes = [...new Set(allParticipants.map(p => p.program_key || 'clinic'))];
    setupProgramaSwitcher(programasPresentes);
    const programaInicial = programasPresentes.includes('clinic') ? 'clinic' : programasPresentes[0];
    const esStaffInicial = activarPrograma(programaInicial);
    if (esStaffInicial) return; // showStaffView() ya se mostró dentro de activarPrograma()
    // Admin emails siempre van al flujo gateado, aunque también estén en la hoja de participantes
    if (ADMIN_EMAILS.includes(participantEmail)) {
      showAdminOnly();
      return;
    }
    document.getElementById('section-tabs').style.display = 'flex';
    // Si también es comercial, mostrar tab de comisiones
    if (isComercial) {
      window._comercialData = comercialJson;
      document.getElementById('stab-comercial').style.display = '';
    }
    // Si tiene un código de Referidor activo, mostrar tab "Refiere y Gana"
    if (referidoJson && referidoJson.found) {
      window._referidoData = referidoJson;
      document.getElementById('stab-referidos').style.display = '';
    }
    checkNuevosComunicados();
    const tabParam = new URLSearchParams(window.location.search).get('tab');
    if (tabParam && ['fotos','comunicaciones','saber','admin','comercial','referidos'].includes(tabParam)) {
      setTimeout(() => switchSection(tabParam, true), 150); // no scroll en restauración por URL
    }
    // Link directo desde el correo de "proceso completado" — solo navega si
    // el participante realmente ya llegó a paso 7 (si no, el paso ya lo lleva
    // a su panel correspondiente vía applyPasoActual, sin desbloquear nada).
    const gotoParam = new URLSearchParams(window.location.search).get('goto');
    if (gotoParam === 'done' && grupoPaso >= 7) {
      setTimeout(() => goPanel('panel-done'), 200);
    }
  } catch (e) {
    const emailNorm = email.toLowerCase().trim();
    if (ADMIN_EMAILS.includes(emailNorm)) {
      participantEmail = emailNorm;
      showAdminOnly();
      return;
    }
    try {
      const accesoRes = await fetch(APPS_SCRIPT_URL + '?action=admin_acceso_check&email=' + encodeURIComponent(emailNorm) + '&_t=' + Date.now(), { redirect: 'follow' });
      const accesoData = await accesoRes.json();
      if (accesoData && accesoData.found) {
        participantEmail = emailNorm;
        showAdminOnly();
        return;
      }
    } catch(_) {}
    errEl.textContent = defaultErr;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Acceder →';
  }
}

// Muestra los botones de cambio de programa solo si el email tiene
// inscripción en más de uno. Con un solo programa, quedan ocultos y el
// comportamiento es idéntico al de antes de existir World Challenge.
function setupProgramaSwitcher(programKeys) {
  const wrap = document.getElementById('programa-switcher');
  if (!wrap) return;
  wrap.style.display = programKeys.length > 1 ? 'flex' : 'none';
}

// Se llama al hacer click en uno de los botones del switcher.
function cambiarPrograma(key) {
  activarPrograma(key);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Filtra allParticipants al programa `key` y (re)ejecuta toda la carga que
// antes vivía inline en doLogin(): tabs de participantes vinculados, cálculo
// de paso/tiquete/solo-actividades del GRUPO (no del email completo — un
// mismo correo con inscripción en Clinic y en World Challenge tiene dos
// grupos independientes, cada uno con su propio proceso y pagos), totales de
// pago y paso actual. Se llama una vez al login y de nuevo en cada cambio de
// programa. Devuelve true si el programa activo es de Staff (mismo atajo que
// tenía doLogin: showStaffView() y no continuar con el resto del flujo).
function activarPrograma(key, opts) {
  opts = opts || {};
  const btnClinic = document.getElementById('btn-prog-clinic');
  const btnWc = document.getElementById('btn-prog-wc');
  if (btnClinic) btnClinic.classList.toggle('active', key === 'clinic');
  if (btnWc) btnWc.classList.toggle('active', key === 'world_challenge');

  const programParticipants = allParticipants.filter(p => (p.program_key || 'clinic') === key);
  if (!programParticipants.length) return false;

  grupoPaso = Math.max(...programParticipants.map(p => parseInt(p.paso_actual) || 1));
  conTiq = programParticipants.some(p => p.tiquete_aereo === 'Con tiquete');
  soloAct = programParticipants.every(p => {
    const n = normalizeParticipant(p) || p;
    return !(n.tipo||'').toLowerCase().includes('jug') && (n.habitacion||'') === '';
  });
  // World Challenge: si TODO el grupo tiene un tipo de pago único (Solo
  // Actividades / Solo World Challenge — todo se paga en la reserva, sin
  // segundo pago), oculta el paso "Pago final" del stepper (ver STEP_DEFS).
  sinPagoFinal = key === 'world_challenge' && programParticipants.every(p => {
    const n = normalizeParticipant(p) || p;
    return montoReservaFinalParticipante_(n, true).final === 0;
  });

  if (programParticipants.length > 1) {
    buildParticipantTabs(programParticipants);
  } else {
    document.getElementById('ptabs-container').style.display = 'none';
    document.getElementById('ptabs').innerHTML = '';
  }

  const primerJug = programParticipants.find(p => p.tipo === 'Jugador') || programParticipants[0];
  loadParticipant(primerJug);
  cargarMisPagosValidados();
  actualizarFechasLimitePorPrograma_();

  document.getElementById('tiq-toggle-label').textContent = conTiq ? 'Quitar tiquete aéreo' : 'Agregar tiquete aéreo';
  document.getElementById('tc-text').innerHTML = getTyC();
  const tiqOptin = document.getElementById('tiq-optin');
  if (tiqOptin) tiqOptin.style.display = !conTiq ? 'block' : 'none';
  const tc = document.getElementById('tc-chk');
  if (tc) { tc.checked = grupoPaso > 2; onTC(); }
  applyPaymentTotals(calcPaymentTotals());
  const btnContinuar = document.getElementById('btn-continuar-tc');
  if (btnContinuar && soloAct) {
    btnContinuar.textContent = conTiq ? 'Continuar al pago del tiquete →' : 'Continuar al pago final →';
  }
  // Staff: saltar al paso de documentación directamente
  esStaffView = programParticipants.every(p => (p.tipo || '').toLowerCase().includes('staff'));
  if (esStaffView) { showStaffView(); return true; }
  applyPasoActual(grupoPaso, opts);
  return false;
}

function buildParticipantTabs(participants) {
  const container = document.getElementById('ptabs-container');
  const tabsEl = document.getElementById('ptabs');
  container.style.display = 'block';
  tabsEl.innerHTML = '';
  const sorted = [...participants].sort((a, b) => {
    const aJug = (normalizeParticipant(a) || a).tipo === 'Jugador' ? 0 : 1;
    const bJug = (normalizeParticipant(b) || b).tipo === 'Jugador' ? 0 : 1;
    return aJug - bJug;
  });
  sorted.forEach((raw, i) => {
    const p = normalizeParticipant(raw) || raw;
    const tab = document.createElement('button');
    tab.className = 'ptab' + (i === 0 ? ' active' : '');
    tab.textContent = (p.tipo === 'Jugador' ? '⚽ ' : p.tipo === 'Staff' ? '👥 ' : '👤 ') + (p.nombre || 'Participante');
    tab.onclick = () => {
      document.querySelectorAll('.ptab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentIndex = i;
      loadParticipant(sorted[i]);
    };
    tabsEl.appendChild(tab);
  });
}

// Countdown en vivo hacia el inicio del programa (2 de octubre 2026, hora Madrid).
// Se actualiza cada segundo. Si la fecha ya pasó, muestra un mensaje de cierre
// en vez de un conteo negativo — evita el caso confuso de "faltan -14 días".
let _countdownInterval = null;
function iniciarCountdownViaje() {
  const els = document.querySelectorAll('.countdown-text');
  if (!els.length) return;
  const fechasPorPrograma = {
    clinic:          { inicio: '2026-10-02T09:00:00+02:00', fin: '2026-10-10T23:59:59+02:00' },
    world_challenge: { inicio: '2027-03-19T09:00:00+01:00', fin: '2027-03-27T23:59:59+01:00' }
  };
  const fechas = fechasPorPrograma[programKeyActivo] || fechasPorPrograma.clinic;
  const inicioViaje = new Date(fechas.inicio).getTime();
  const finViaje = new Date(fechas.fin).getTime();

  function tick() {
    const ahora = Date.now();
    const diff = inicioViaje - ahora;

    if (ahora > finViaje) {
      els.forEach(el => { el.textContent = '¡Ya viviste tu experiencia en Madrid! 🏆'; });
      if (_countdownInterval) clearInterval(_countdownInterval);
      return;
    }
    if (diff <= 0) {
      els.forEach(el => { el.textContent = '¡Estás en Madrid ahora mismo! ⚽'; });
      return;
    }

    const dias = Math.floor(diff / 86400000);
    const horas = Math.floor((diff % 86400000) / 3600000);
    const minutos = Math.floor((diff % 3600000) / 60000);
    const segundos = Math.floor((diff % 60000) / 1000);

    if (dias > 0) {
      els.forEach(el => { el.textContent = `Faltan ${dias}d ${horas}h ${minutos}m para Madrid`; });
    } else {
      els.forEach(el => { el.textContent = `Faltan ${horas}h ${minutos}m ${segundos}s para Madrid`; });
    }
  }

  tick();
  if (_countdownInterval) clearInterval(_countdownInterval);
  _countdownInterval = setInterval(tick, 1000);
}

// Solo actualiza la info personal del participante (nombre, resumen, vinculados).
// Los pasos y pagos son globales para el grupo y NO se tocan aquí.
function loadParticipant(p) {
  const participant = normalizeParticipant(p) || p;
  nombre = participant.nombre || 'Participante';
  participantEmail = participant.email || '';
  tipo = (participant.tipo || 'Jugador').toLowerCase();
  programa = participant.programa || '';
  programKeyActivo = participant.program_key || 'clinic';
  habitacion = participant.habitacion || '';
  const subtitleEl = document.getElementById('welcome-subtitle');
  if (subtitleEl) {
    subtitleEl.textContent = programKeyActivo === 'world_challenge'
      ? 'Real Madrid Foundation World Challenge · 19–27 Marzo 2027 · Madrid, España'
      : 'Real Madrid Foundation Clinic · 2–10 Octubre 2026 · Madrid, España';
  }

  // Cargar el texto de T&C de inmediato, independiente del estado del checkbox
  // y antes de cualquier otra actualización de UI que pueda fallar más abajo.
  const tcTextEl = document.getElementById('tc-text');
  if (tcTextEl) { try { tcTextEl.innerHTML = getTyC(); } catch (e) {} }

  iniciarCountdownViaje();

  document.getElementById('dn').textContent = nombre;
  document.getElementById('dtipo').textContent = tipo.includes('jug') ? '⚽ Jugador' : tipo.includes('staff') ? '👥 Staff' : '👨‍👩‍👧 Acompañante';
  document.getElementById('ref1').textContent = nombre;
  const cartaNombre = document.getElementById('carta-nombre');
  if (cartaNombre) cartaNombre.textContent = nombre;

  updateDatosResumen(participant);
  updatePermisoDoc(participant);

  // Ocultar posición si el participante es acompañante
  const posicionItem = document.getElementById('d-posicion-item');
  if (posicionItem) posicionItem.style.display = tipo.includes('jug') ? '' : 'none';

  // Mostrar vinculados: jugador ve acompañantes, acompañante ve jugadores
  const secEl = document.getElementById('companions-section');
  const namesEl = document.getElementById('companions-names');
  const labelEl = document.getElementById('companions-label');
  if (secEl && namesEl) {
    const esJug = tipo.includes('jug');
    const vinculados = allParticipants
      .filter(c => c.nombre !== participant.nombre &&
        (c.program_key || 'clinic') === programKeyActivo &&
        (esJug ? !(c.tipo || '').toLowerCase().includes('jug') : (c.tipo || '').toLowerCase().includes('jug'))
      );
    if (vinculados.length > 0) {
      if (labelEl) labelEl.textContent = esJug ? 'Acompañantes' : 'Jugadores';
      namesEl.innerHTML = vinculados.map(c => `<strong>${escapeHtml(c.nombre)}</strong>`).join(' · ');
      secEl.style.display = '';
    } else {
      secEl.style.display = 'none';
    }
  }
}

function actualizarPagosCompletados() {
  const config = [
    { done: STEP_DEFS.find(s => s.panel === 'panel2')?.done, elems: ['pay-card1-hint', 'pay-grid-reserva', 'd1tc', 'd1tr', 'upload-block-reserva'], banner: 'pago-exitoso-reserva' },
    { done: STEP_DEFS.find(s => s.panel === 'panel-tiq')?.done, elems: ['pay-grid-tiquete', 'dtiqtc', 'dtiqtr', 'upload-block-tiquete'], banner: 'pago-exitoso-tiquete' },
    { done: STEP_DEFS.find(s => s.panel === 'panel3')?.done, elems: ['pay-grid-final', 'd2tc', 'd2tr', 'upload-block-final'], banner: 'pago-exitoso-final' }
  ];
  config.forEach(c => {
    c.elems.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = c.done ? 'none' : '';
    });
    const bannerEl = document.getElementById(c.banner);
    if (bannerEl) bannerEl.style.display = c.done ? 'block' : 'none';
  });
}

function applyPasoActual(paso, opts) {
  opts = opts || {};
  // Marcar pasos completados según número de paso
  STEP_DEFS[0].done = true; // Inscripción siempre done
  STEP_DEFS[1].done = paso >= 2; // T&C
  // Los pasos de pago (reserva/tiquete/final) se marcan "done" según el saldo
  // REAL pendiente (abono vs. total del grupo AHORA), no solo según el `paso`
  // guardado en la hoja. Si se agrega un participante nuevo después de que el
  // grupo ya había completado un pago, el `paso` guardado se queda en un valor
  // alto (nunca retrocede) pero el total a pagar sube — sin este recálculo el
  // check verde y el aviso de "pago completado" se quedaban pegados aunque
  // apareciera saldo pendiente nuevo. `opts.optimistic` es la única excepción:
  // se usa justo tras el envío del propio comprobante (ver enviarComprobante),
  // donde el monto recién enviado aún no llegó a la hoja para reflejarse en
  // calcPaymentTotals(), así que ahí sí confiamos en el avance de `paso`.
  const t = calcPaymentTotals();
  // "Cubierto" exige DOS cosas: que la suma del grupo alcance el total, Y que
  // cada participante quede individualmente en Completo en su propia fila
  // (conceptoGrupoCompleto_) — no basta con que el total cuadre, porque el
  // dinero puede estar repartido pero alguna fila seguir "Pendiente de
  // confirmar" sin que el admin la haya revisado todavía.
  const idxReserva = STEP_DEFS.findIndex(s => s.panel === 'panel2');
  if (idxReserva > -1) {
    const cubierto = t.reserva > 0 && (t.abonoReserva || 0) >= t.reserva && conceptoGrupoCompleto_('reserva');
    STEP_DEFS[idxReserva].done = cubierto || (opts.optimistic && paso >= 4);
  }
  const idxTiq = STEP_DEFS.findIndex(s => s.panel === 'panel-tiq');
  if (idxTiq > -1) {
    const totalTiqueteEur = tiqueteUnitEur_() * (t.tiqCount || 1);
    const cubierto = totalTiqueteEur > 0 && (t.abonoTiquete || 0) >= totalTiqueteEur && conceptoGrupoCompleto_('tiquete');
    STEP_DEFS[idxTiq].done = cubierto || (opts.optimistic && paso >= 5);
  }
  const idxFinal = STEP_DEFS.findIndex(s => s.panel === 'panel3');
  if (idxFinal > -1) {
    const cubierto = t.final > 0 && (t.abonoFinal || 0) >= t.final && conceptoGrupoCompleto_('final');
    STEP_DEFS[idxFinal].done = cubierto || (opts.optimistic && paso >= 6);
  }
  const idxDocs = STEP_DEFS.findIndex(s => s.panel === 'panel4');
  if (idxDocs > -1) STEP_DEFS[idxDocs].done = paso >= 7;

  actualizarPagosCompletados();

  buildSteps();

  // Ir al panel correcto según paso — salvo que esta llamada venga de un
  // auto-refresh en segundo plano (ver refrescarParticipanteAuto_, cada 60s):
  // en ese caso el participante puede estar navegando a propósito a un paso
  // anterior (ej. releer T&C estando ya en Reserva) y el refresh no debe
  // sacarlo de ahí. Solo se fuerza la navegación en el login inicial, el
  // cambio de programa, y el avance optimista tras subir un comprobante.
  if (!opts.isAutoRefresh) {
    const panelMap = {1:'panel-tc', 2:'panel-tc', 3:'panel2', 4:'panel-tiq', 5:'panel3', 6:'panel4', 7:'panel-done'};
    const targetPanel = panelMap[paso] || 'panel-tc';
    goPanel(targetPanel, true); // no scroll en carga inicial
  }
}

// ── STEPS ────────────────────────────────────────────────────────────────────
const STEP_DEFS = [
  {title:'Inscripción', desc:'Completada', panel:null, done:true},
  {title:'Términos y Condiciones', desc:'Lee y acepta los T&C', panel:'panel-tc', skipForStaff:true},
  {title:'Pago de reserva', desc:'Fecha límite: 1 de junio 2026', panel:'panel2', skipIfSoloAct:true, skipForStaff:true},
  {title:'Pago tiquete',    desc:'Fecha límite: 1 de junio 2026', panel:'panel-tiq', tiqOnly:true, skipForStaff:true},
  {title:'Pago final',      desc:'Fecha límite: 30 de julio 2026', panel:'panel3', skipForStaff:true, skipIfSinPagoFinal:true},
  {title:'Documentación',   desc:'Pasaporte vigente', panel:'panel4'},
  {title:'¡Bienvenido!',      desc:'¡Nos vemos en Madrid!', panel:'panel-done'},
];

let curPanel = 'panel-tc';

// Oculta el degradado/flecha de "desliza" cuando el usuario ya llegó al
// final del scroll horizontal del stepper.
function actualizarFadeSteps() {
  const row = document.getElementById('steps-row');
  const fade = document.getElementById('steps-fade');
  const dotsRow = document.getElementById('steps-dots');
  if (!row || !fade) return;
  const check = () => {
    const maxScroll = row.scrollWidth - row.clientWidth;
    const alFinal = maxScroll <= 4 || row.scrollLeft >= maxScroll - 4;
    fade.classList.toggle('hide', alFinal);
    if (dotsRow && dotsRow.children.length === 3) {
      const pct = maxScroll > 0 ? row.scrollLeft / maxScroll : 0;
      const activeIdx = pct < 0.34 ? 0 : (pct < 0.67 ? 1 : 2);
      Array.from(dotsRow.children).forEach((dot, idx) => dot.classList.toggle('active', idx === activeIdx));
    }
  };
  check();
  row.removeEventListener('scroll', row._fadeListener || (()=>{}));
  row._fadeListener = check;
  row.addEventListener('scroll', check, { passive: true });
}

function buildSteps() {
  const row = document.getElementById('steps-row');
  row.innerHTML = '';
  const bienvenidaBloqueada = grupoPaso < 7;
  const visible = STEP_DEFS.filter(s => (!s.tiqOnly || conTiq) && (!s.skipIfSoloAct || !soloAct) && (!s.skipIfSinPagoFinal || !sinPagoFinal) && (!s.skipForStaff || !esStaffView));
  visible.forEach((s, i) => {
    const bloqueado = s.panel === 'panel-done' && bienvenidaBloqueada;
    const d = document.createElement('div');
    d.className = 'step' + (s.done ? ' done' : '') + (s.panel === curPanel ? ' active' : '') + (bloqueado ? ' locked' : '');
    if (s.panel && !bloqueado) d.onclick = () => goPanel(s.panel);
    d.innerHTML = `<div class="snum">${s.done ? '✓' : i+1}</div><div class="stitle">${s.title}</div><div class="sdesc">${s.desc}</div>`;
    row.appendChild(d);
  });
  // Puntitos indicadores (uno por paso visible, resalta el activo)
  const dotsRow = document.getElementById('steps-dots');
  if (dotsRow && dotsRow.children.length !== 3) {
    dotsRow.innerHTML = '';
    for (let d = 0; d < 3; d++) {
      const dot = document.createElement('div');
      dot.className = 'step-dot';
      dotsRow.appendChild(dot);
    }
  }
  actualizarFadeSteps();
}

function goPanel(id, noScroll) {
  if (id === 'panel-done' && grupoPaso < 7) return;
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) { el.classList.add('active'); curPanel = id; }
  buildSteps();
  // Restore "Mi Proceso" tab state when navigating within the process flow
  document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.section === 'proceso'));
  const stepsRow = document.getElementById('steps-row');
  if (stepsRow) stepsRow.style.display = '';
  if (!noScroll && el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── TASA ─────────────────────────────────────────────────────────────────────
const MARGEN_TASA_PCT = 0.0025; // margen sobre la tasa de mercado (0,25%)
const TASA_FALLBACK = 4466; // ~4.424 EUR/COP mercado + 1% margen
let tasa = TASA_FALLBACK;
const TRM_RESERVA = 4288; // TRM oficial del 1 de junio de 2026 (fecha límite de pago de reserva) — tasa fija, no cambia
const TIQUETE_EUR = 993; // Valor fijo del tiquete aéreo por persona, convertido a COP con la TRM_RESERVA (misma fecha límite)

// ── PRECIOS WORLD CHALLENGE ────────────────────────────────────────────────
// A diferencia del Clinic (Reserva/Tiquete a tasa fija TRM_RESERVA, solo el
// Pago Final a tasa del día), World Challenge usa la tasa del día vigente
// para LOS TRES pagos — ver tasaReservaTiquete_() y tiqueteUnitEur_(), que
// centralizan esta rama para que calc1/calcTiq/congelamiento y
// calcPaymentTotals/buildBreakdown queden siempre consistentes entre sí.
const TIQUETE_EUR_WC = 950; // tiquete aéreo World Challenge — mismo valor para Jugador y Acompañante
// Valores oficiales según los T&C de World Challenge 2027 (PDFs por tipo de
// paquete) — son los totales "Sin Tiquete"; el tiquete aéreo se cobra APARTE
// en su propio panel (950€, ver TIQUETE_EUR_WC), no está incluido aquí.
const PRECIOS_WC = {
  jugador:           { reserva: 1150, final: 1740 }, // total sin tiquete: 2.890€ — reserva fija (no % del total; el tiquete se cobra aparte, ver TIQUETE_EUR_WC)
  acomp_doble:       { reserva: 1150, final: 1040 }, // total sin tiquete: 2.190€ — reserva fija (no % del total)
  acomp_sencilla:    { reserva: 1150, final: 1360 }, // total sin tiquete: 2.510€ — reserva fija (no % del total)
  // Solo Actividades y Solo World Challenge: pago único en la reserva, SIN
  // segundo pago de "Pago Final" (a diferencia del Clinic, donde este tipo de
  // acompañante paga todo al final en vez de en la reserva).
  acomp_actividades: { reserva: 590,  final: 0 }, // total sin tiquete: 590€
  acomp_solo_wc:     { reserva: 185,  final: 0 }  // total sin tiquete: 185€ — solo torneo, sin alojamiento ni actividades turísticas
};

function tasaReservaTiquete_() {
  return programKeyActivo === 'world_challenge' ? tasa : TRM_RESERVA;
}
function tiqueteUnitEur_() {
  return programKeyActivo === 'world_challenge' ? TIQUETE_EUR_WC : TIQUETE_EUR;
}

// Monto de Reserva y Pago Final para UN participante, según su tipo/habitación
// y el programa activo. Única fuente de verdad compartida por
// calcPaymentTotals() y buildBreakdown() — evita que ambos queden
// desincronizados si se ajusta un precio más adelante.
function montoReservaFinalParticipante_base_(p, esWC) {
  const esJug = (p.tipo || '').toLowerCase().includes('jug');
  const hab = (p.habitacion || '').toLowerCase();
  if (esWC) {
    if (esJug) return { reserva: PRECIOS_WC.jugador.reserva, final: PRECIOS_WC.jugador.final, sub: 'Jugador' };
    if (hab === 'solo_world_challenge') return { reserva: PRECIOS_WC.acomp_solo_wc.reserva, final: PRECIOS_WC.acomp_solo_wc.final, sub: 'Acompañante · Solo World Challenge' };
    if (hab === '' || hab === 'solo_actividades') return { reserva: PRECIOS_WC.acomp_actividades.reserva, final: PRECIOS_WC.acomp_actividades.final, sub: 'Acompañante · Solo actividades' };
    if (hab.includes('doble')) return { reserva: PRECIOS_WC.acomp_doble.reserva, final: PRECIOS_WC.acomp_doble.final, sub: 'Acompañante · hab. doble' };
    return { reserva: PRECIOS_WC.acomp_sencilla.reserva, final: PRECIOS_WC.acomp_sencilla.final, sub: 'Acompañante · hab. sencilla' };
  }
  // Clinic (comportamiento original, sin cambios)
  if (esJug) return { reserva: 1000, final: 1790, sub: 'Jugador' };
  if (hab === '') {
    const fObj = parseFechaNacFront(p.fecha_nacimiento || '');
    const edad = fObj ? calcEdadRefFront(fObj) : null;
    return { reserva: 0, final: (edad !== null && edad <= 12) ? 190 : 590, sub: 'Acompañante · Solo actividades' };
  }
  if (hab.includes('doble')) return { reserva: 1000, final: 1190, sub: 'Acompañante · hab. doble' };
  return { reserva: 1000, final: 1510, sub: 'Acompañante · hab. sencilla' };
}

// Programa de Referidos: envuelve montoReservaFinalParticipante_base_ (sin
// tocar su lógica) para restar el 3% de descuento del Pago Final — SOLO
// cuando el participante es Jugador (decisión de producto: los Acompañantes
// pueden registrarse con un código válido, pero no reciben ajuste de
// precio). precioBase debe coincidir con el hardcodeado en
// procesarReferidoExitoso_ (APPS_SCRIPT_CODE.gs) — actualizar ambos si el
// precio del programa cambia. Como todos los call-sites de
// montoReservaFinalParticipante_ pasan por aquí, quedan cubiertos
// automáticamente (login normal y panel admin) sin tocarlos uno por uno.
function montoReservaFinalParticipante_(p, esWC) {
  const m = montoReservaFinalParticipante_base_(p, esWC);
  const esJug = (p.tipo || '').toLowerCase().includes('jug');
  // Alianza/promoción: precio total fijo acordado (catálogo "Alianzas" en el
  // Sheet de Leads, ver alianzaPorNombre_ en el backend). Reemplaza el Pago
  // Final calculado arriba y es EXCLUYENTE con el descuento de referido de
  // abajo — un jugador con alianza nunca recibe también el 3% de referidos.
  const precioAlianza = esJug ? (parseFloat(p.alianza_precio_total) || 0) : 0;
  if (precioAlianza > 0) {
    m.final = Math.max(0, Math.round((precioAlianza - m.reserva) * 100) / 100);
    return m;
  }
  const descuentoPct = esJug ? (parseFloat(p.referido_descuento_pct) || 0) : 0;
  if (descuentoPct > 0 && m.final > 0) {
    const precioBase = esWC ? 2890 : 2790;
    const descuentoEur = Math.round(precioBase * (descuentoPct / 100) * 100) / 100;
    m.final = Math.max(0, Math.round((m.final - descuentoEur) * 100) / 100);
  }
  return m;
}

// Fechas límite de pago y texto de mecánica de tasa — World Challenge usa
// tasa del día (no una TRM fija) en los tres pagos, así que el texto
// explicativo también cambia, no solo la fecha. Se llama desde
// activarPrograma() cada vez que se carga o cambia de programa.
const FECHAS_LIMITE_WC = { reserva: '5 de octubre 2026', tiquete: '5 de octubre 2026', final: '11 de diciembre 2026' };
const FECHAS_LIMITE_CLINIC = { reserva: '1 de junio 2026', tiquete: '1 de junio 2026', final: '30 de julio 2026' };

function actualizarFechasLimitePorPrograma_() {
  const esWC = programKeyActivo === 'world_challenge';
  const fechas = esWC ? FECHAS_LIMITE_WC : FECHAS_LIMITE_CLINIC;

  const idxReserva = STEP_DEFS.findIndex(s => s.panel === 'panel2');
  if (idxReserva > -1) STEP_DEFS[idxReserva].desc = 'Fecha límite: ' + fechas.reserva;
  const idxTiq = STEP_DEFS.findIndex(s => s.panel === 'panel-tiq');
  if (idxTiq > -1) STEP_DEFS[idxTiq].desc = 'Fecha límite: ' + fechas.tiquete;
  const idxFinal = STEP_DEFS.findIndex(s => s.panel === 'panel3');
  if (idxFinal > -1) STEP_DEFS[idxFinal].desc = 'Fecha límite: ' + fechas.final;

  const elReservaInfo = document.getElementById('reserva-tasa-info');
  if (elReservaInfo) {
    elReservaInfo.innerHTML = esWC
      ? `El pago de la reserva se realiza en <strong>pesos colombianos (COP)</strong>, a la <strong>tasa del día</strong> en que realices el pago — fecha límite: <strong>${fechas.reserva}</strong>.`
      : `El pago de la reserva se realiza en <strong>pesos colombianos (COP)</strong>, al tipo de cambio fijado el <strong>1 de junio de 2026</strong> — fecha límite de pago de reserva: <strong>1 EUR = $4.288 COP</strong>.`;
  }
  const elReservaNota = document.getElementById('reserva-tasa-nota');
  if (elReservaNota) {
    elReservaNota.textContent = esWC ? 'Tasa del día — se actualiza con la tasa de mercado vigente.' : 'Tasa fija — no varía con la TRM del día.';
  }

  const elTiqInfo = document.getElementById('tiquete-info-parrafo');
  if (elTiqInfo) {
    elTiqInfo.innerHTML = esWC
      ? `El tiquete aéreo se gestiona como reserva grupal con vuelo y fecha fijos. Costo <strong>${TIQUETE_EUR_WC} EUR</strong> por persona, pagadero en pesos colombianos a la <strong>tasa del día</strong> en que realices el pago.`
      : `El tiquete aéreo <strong>Bogotá – Madrid – Bogotá</strong> se gestiona como reserva grupal con vuelo y fecha fijos. Costo <strong>${TIQUETE_EUR} EUR</strong> por persona, pagadero en pesos colombianos al tipo de cambio fijado el <strong>1 de junio de 2026</strong>.`;
  }
  const elTiqFecha = document.getElementById('tiquete-fecha-limite');
  if (elTiqFecha) elTiqFecha.textContent = fechas.tiquete;
  const elTiqCosto = document.getElementById('tiquete-costo-valor');
  if (elTiqCosto) elTiqCosto.textContent = (esWC ? TIQUETE_EUR_WC : TIQUETE_EUR) + ' EUR / persona';

  const elFinalFecha = document.getElementById('panel3-fecha-limite');
  if (elFinalFecha) elFinalFecha.textContent = fechas.final;

  // Carta de bienvenida (panel-done) — título, fecha y párrafos con el
  // nombre/fechas del programa activo.
  const elCartaFechaMes = document.getElementById('carta-fecha-mes');
  if (elCartaFechaMes) elCartaFechaMes.textContent = esWC ? 'Madrid, marzo 2027' : 'Madrid, octubre 2026';
  const elCartaTitulo = document.getElementById('carta-titulo');
  if (elCartaTitulo) elCartaTitulo.textContent = esWC ? '¡Bienvenido al Real Madrid Foundation World Challenge 2027!' : '¡Bienvenido al Real Madrid Foundation Clinic 2026!';
  const elCartaFechas = document.getElementById('carta-parrafo-fechas');
  if (elCartaFechas) {
    elCartaFechas.innerHTML = esWC
      ? 'Para nosotros —desde la Fundación Real Madrid y la Fundación Revel— es un verdadero orgullo darte la bienvenida a esta experiencia internacional única que vivirás en Madrid, España, del <strong>19 al 27 de marzo 2027</strong>.'
      : 'Para nosotros —desde la Fundación Real Madrid y la Fundación Revel— es un verdadero orgullo darte la bienvenida a esta experiencia internacional única que vivirás en Madrid, España, del <strong>2 al 10 de octubre 2026</strong>.';
  }
  const elCartaDesc = document.getElementById('carta-parrafo-descripcion');
  if (elCartaDesc) {
    elCartaDesc.textContent = esWC
      ? 'Bienvenido a formar parte de uno de los torneos más importantes del mundo, en el que representarás a tu país compitiendo contra equipos internacionales y viviendo el fútbol desde dentro, tal como lo hacen los futuros profesionales del Real Madrid CF.'
      : 'Bienvenido a formar parte de uno de los programas formativos más importantes del mundo, en el que representarás a tu país enfrentándote a academias internacionales y viviendo el fútbol desde dentro, tal como lo hacen los futuros profesionales del Real Madrid CF.';
  }
  const elCartaCierre = document.getElementById('carta-cierre');
  if (elCartaCierre) elCartaCierre.textContent = esWC
    ? '¡Nos emociona acompañarte en esta aventura y verte brillar en el Real Madrid Foundation World Challenge powered by Fundación Revel!'
    : '¡Nos emociona acompañarte en esta aventura y verte brillar en el Real Madrid Foundation Clinic powered by Fundación Revel!';

  // Panel de documentación — validez del pasaporte según fecha de fin del programa.
  const finPrograma = esWC ? '27 de marzo de 2027' : '10 de octubre de 2026';
  const finProgramaCorto = esWC ? '27 de marzo 2027' : '10 de octubre 2026';
  const elPasaporte1 = document.getElementById('doc-pasaporte-desc');
  if (elPasaporte1) elPasaporte1.textContent = `Mínimo 6 meses de validez desde el ${finProgramaCorto}. Página principal con foto.`;
  const elPasaporte2 = document.getElementById('doc-pasaporte-desc-2');
  if (elPasaporte2) elPasaporte2.innerHTML = `Debe tener validez mínima de <strong>6 meses</strong> después del ${finPrograma}. Sin excepciones.`;

  // Itinerario de vuelo grupal — Clinic y World Challenge ya tienen vuelo
  // confirmado con la aerolínea, cada uno con su propio itinerario.
  const elItinTitulo = document.getElementById('itinerario-vuelo-titulo');
  if (elItinTitulo) elItinTitulo.textContent = '🗓️ Itinerario de vuelos confirmado';
  const elItinPendiente = document.getElementById('itinerario-vuelo-pendiente');
  const elItinConfirmado = document.getElementById('itinerario-vuelo-confirmado');
  if (elItinPendiente && elItinConfirmado) {
    elItinPendiente.style.display = 'none';
    elItinConfirmado.style.display = 'flex';
  }
  const ITIN_VUELOS = {
    clinic: {
      idaFecha: '2 de octubre 2026', idaVuelo: 'Air Europa · UX194', idaSalida: '20:15 hrs', idaLlegada: '13:00 hrs',
      regresoFecha: '10 de octubre 2026', regresoVuelo: 'Air Europa · UX0193', regresoSalida: '15:15 hrs', regresoLlegada: '18:15 hrs'
    },
    world_challenge: {
      idaFecha: '19 de marzo 2027', idaVuelo: 'Air Europa · UX0194', idaSalida: '21:35 hrs', idaLlegada: '13:10 hrs',
      regresoFecha: '27 de marzo 2027', regresoVuelo: 'Air Europa · UX0193', regresoSalida: '15:15 hrs', regresoLlegada: '19:15 hrs'
    }
  };
  const itinVuelo = esWC ? ITIN_VUELOS.world_challenge : ITIN_VUELOS.clinic;
  const setItinTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setItinTxt('itin-ida-fecha', itinVuelo.idaFecha);
  setItinTxt('itin-ida-vuelo', itinVuelo.idaVuelo);
  setItinTxt('itin-ida-salida', itinVuelo.idaSalida);
  setItinTxt('itin-ida-llegada', itinVuelo.idaLlegada);
  setItinTxt('itin-regreso-fecha', itinVuelo.regresoFecha);
  setItinTxt('itin-regreso-vuelo', itinVuelo.regresoVuelo);
  setItinTxt('itin-regreso-salida', itinVuelo.regresoSalida);
  setItinTxt('itin-regreso-llegada', itinVuelo.regresoLlegada);

  // Vuelo independiente (participantes que gestionan su propio tiquete).
  const elVueloIndep = document.getElementById('doc-vuelo-independiente-desc');
  if (elVueloIndep) {
    elVueloIndep.innerHTML = esWC
      ? 'Debes coordinar con Victory tu itinerario de vuelo. El programa inicia el <strong>19 de marzo</strong> y finaliza el <strong>27 de marzo de 2027</strong>. Envía tu confirmación a <strong>alejandro.cabrera@fundacionrevel.net</strong>.'
      : 'Debes coordinar con Victory tu itinerario de vuelo. El vuelo sale el <strong>2 de octubre</strong> y la llegada a Madrid es el <strong>3 de octubre de 2026</strong>. La salida de regreso es el <strong>10 de octubre</strong>. Envía tu confirmación a <strong>alejandro.cabrera@fundacionrevel.net</strong>.';
  }

  renderClimaEstatico_();
}

// Datos históricos de clima de Madrid por ventana de viaje de cada programa.
// Clinic (2–10 oct): normales de octubre. World Challenge (19–27 mar): normales
// de marzo — más fresco y algo más lluvioso que octubre (fuente: normales
// climáticas de Madrid, ver weatherapi.com/climatestotravel — máx 18°C, mín
// 5°C, ~12 días de lluvia/mes, humedad ~68%, viento ~22 km/h; días
// soleados/lluvia de abajo son una proporción para la ventana de 9 días del
// viaje, no el mes completo).
const CLIMA_DATA = {
  clinic: {
    tituloRango: '2–10 Octubre', max: '19°C', min: '10°C', soleados: '7', lluvia: '3', humedad: '40%', viento: '14 km/h',
    forecastTitulo: 'Pronóstico 3–10 octubre 2026', forecastStart: '2026-10-03', forecastEnd: '2026-10-10',
    cutoffTexto: '19 de septiembre de 2026'
  },
  world_challenge: {
    tituloRango: '19–27 Marzo', max: '18°C', min: '5°C', soleados: '5', lluvia: '4', humedad: '65%', viento: '22 km/h',
    forecastTitulo: 'Pronóstico 19–27 marzo 2027', forecastStart: '2027-03-19', forecastEnd: '2027-03-27',
    cutoffTexto: '5 de marzo de 2027'
  }
};

function renderClimaEstatico_() {
  const esWC = programKeyActivo === 'world_challenge';
  const c = esWC ? CLIMA_DATA.world_challenge : CLIMA_DATA.clinic;
  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setTxt('clima-titulo', 'Datos Históricos del Clima · ' + c.tituloRango);
  setTxt('clima-max', c.max);
  setTxt('clima-min', c.min);
  setTxt('clima-soleados', c.soleados);
  setTxt('clima-lluvia', c.lluvia);
  setTxt('clima-humedad', c.humedad);
  setTxt('clima-viento', c.viento);
  setTxt('clima-forecast-titulo', c.forecastTitulo);
}

function updateTasaFecha() {
  const el = document.getElementById('tasa-fecha');
  if (!el) return;
  const now = new Date();
  const fmt = now.toLocaleString('es-CO', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
  el.textContent = `Tasa media del mercado · Actualizada: ${fmt}`;
}

function showTasaError() {
  tasa = TASA_FALLBACK;
  const el = document.getElementById('tasa-fecha');
  if (el) el.textContent = `Usando tasa de referencia: $${TASA_FALLBACK.toLocaleString('es-CO')} / EUR`;
  updateCalcs();
}

async function fetchTasa() {
  try {
    // Fuente 1: Wise (tasa mid-market), vía proxy del backend — el endpoint público de
    // Wise no tiene CORS habilitado, así que no se puede leer directo desde el navegador.
    const rw = await fetch(APPS_SCRIPT_URL + '?action=tasa_wise&_t=' + Date.now(), { redirect: 'follow' });
    const dw = await rw.json();
    if (dw && dw.ok && dw.value) {
      tasa = Math.round(parseFloat(dw.value) * (1 + MARGEN_TASA_PCT));
      updateTasaFecha();
      updateCalcs(); return;
    }
  } catch(e) {}
  try {
    // Fuente 2: fawazahmed0/currency-api en jsDelivr (CDN, gratuita, sin API key)
    const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json');
    const d = await r.json();
    if (d && d.eur && d.eur.cop) {
      tasa = Math.round(parseFloat(d.eur.cop) * (1 + MARGEN_TASA_PCT));
      updateTasaFecha();
      updateCalcs(); return;
    }
  } catch(e) {}
  try {
    // Fuente 3: ExchangeRate-API (respaldo)
    const r2 = await fetch('https://open.er-api.com/v6/latest/EUR');
    const d2 = await r2.json();
    if (d2 && d2.rates && d2.rates.COP) {
      tasa = Math.round(parseFloat(d2.rates.COP) * (1 + MARGEN_TASA_PCT));
      updateTasaFecha();
      updateCalcs(); return;
    }
  } catch(e) {}
  showTasaError();
}

function fmt(n)  { return '$ ' + Math.round(n).toLocaleString('es-CO'); }
function fmtT(n) { return '$ ' + Math.round(n).toLocaleString('es-CO') + ' / EUR'; }

// Recargo que cobra Bold por pago con tarjeta — debe coincidir con
// RECARGO_TARJETA_PCT en el backend (APPS_SCRIPT_CODE.gs).
const RECARGO_TARJETA_PCT = 0.035;

function updateCalcs() { calc1(); calc2(); calcTiq(); }
function updatePayAmounts(tcTotalId, tcFeeId, trTotalId, base) {
  const fee = base * RECARGO_TARJETA_PCT;
  const total = base + fee;
  const elTcT = document.getElementById(tcTotalId);
  const elTcF = document.getElementById(tcFeeId);
  const elTrT = document.getElementById(trTotalId);
  if (elTcT) elTcT.textContent = fmt(total);
  if (elTcF) elTcF.textContent = 'incl. recargo ' + fmt(fee);
  if (elTrT) elTrT.textContent = fmt(base);
}

function mostrarAbonoYRestante(idInput, idAviso, cardSelector, tituloEl, total, abono, labelConcepto, detalleAbonos, comision, copBruto) {
  const aviso = document.getElementById(idAviso);
  const input = document.getElementById(idInput);
  if (!aviso || !input) return 0;
  if (abono <= 0) { aviso.style.display = 'none'; return total; }
  // `abono` ya viene SIN la comisión de tarjeta (ver calcPaymentTotals) — el
  // saldo pendiente se calcula siempre sobre el monto base, nunca se reduce
  // por la comisión pagada. `comision` (si > 0) solo se usa para mostrarle al
  // participante que lo que realmente salió de su bolsillo fue abono+comisión.
  const restante = Math.max(0, total - abono);
  const cubierto = restante <= 0;
  aviso.style.display = 'block';
  const detalles = Array.isArray(detalleAbonos) ? detalleAbonos : [];
  // Un solo abono: la fecha se muestra junto al total, como antes. Dos o más
  // (ej. jugador + acompañante pagaron por separado): se listan todos con su propia fecha.
  const fechaUnica = detalles.length === 1 ? detalles[0].fecha : '';
  const listaDetalle = detalles.length > 1
    ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--gborder)">
        ${detalles.map(d => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--green);opacity:0.85;margin-top:3px">
          <span>${d.fecha ? escapeHtml(d.fecha) : '—'}</span><span>${d.monto.toLocaleString('es-CO')} EUR${d.cop ? ' · $' + Math.round(d.cop).toLocaleString('es-CO') + ' COP' : ''}</span>
        </div>`).join('')}
      </div>`
    : '';
  const comisionNum = comision || 0;
  const totalPagado = abono + comisionNum;
  const copBrutoNum = copBruto || 0;
  // El COP solo se conoce a nivel BRUTO (lo que realmente entró, tal cual la
  // hoja) — el desglose base/comisión en COP se reparte proporcionalmente al
  // mismo % que ya separa el EUR (abono/totalPagado y comisionNum/totalPagado),
  // para no depender de un recargo fijo aquí también.
  const copBase = copBrutoNum > 0 && totalPagado > 0 ? Math.round(copBrutoNum * (abono / totalPagado)) : 0;
  const copComision = copBrutoNum > 0 ? Math.round(copBrutoNum - copBase) : 0;
  const desgloseComision = comisionNum > 0
    ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--gborder);font-size:12px;color:var(--green);opacity:0.85">
        <div style="display:flex;justify-content:space-between;gap:10px"><span>Monto del programa</span><span>${abono.toLocaleString('es-CO')} EUR${copBase ? ' · $' + copBase.toLocaleString('es-CO') + ' COP' : ''}</span></div>
        <div style="display:flex;justify-content:space-between;gap:10px;margin-top:3px"><span>Comisión pago con tarjeta (3,5%)</span><span>${comisionNum.toLocaleString('es-CO')} EUR${copComision ? ' · $' + copComision.toLocaleString('es-CO') + ' COP' : ''}</span></div>
      </div>`
    : '';
  const saldoBox = cubierto ? '' : `
      <div style="background:rgba(217,119,6,.07);padding:14px 16px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#92400e;margin-bottom:5px">⏳ Saldo pendiente de ${escapeHtml(labelConcepto)}</div>
        <div style="font-size:20px;font-weight:700;color:#92400e">${restante.toLocaleString('es-CO')} EUR</div>
      </div>`;
  aviso.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:18px">
      <div style="background:var(--gbg);padding:14px 16px${cubierto ? '' : ';border-bottom:1px dashed var(--gborder)'}">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--green);margin-bottom:5px">✅ Abono recibido</div>
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div style="font-size:20px;font-weight:700;color:var(--green)">${totalPagado.toLocaleString('es-CO')} EUR${copBrutoNum ? ' <span style="font-size:14px;opacity:.85">· $' + Math.round(copBrutoNum).toLocaleString('es-CO') + ' COP</span>' : ''}</div>
          ${fechaUnica ? `<div style="font-size:12px;color:var(--green);opacity:0.8">${escapeHtml(fechaUnica)}</div>` : ''}
        </div>
        ${listaDetalle}
        ${desgloseComision}
      </div>
      ${saldoBox}
    </div>
  `;
  return restante;
}

function calc1() {
  if (pagoYaCongelado('reserva')) return; // ya se envió comprobante — el monto queda congelado
  // Clinic: tasa fija (TRM del 1 de junio de 2026, fecha límite de pago de
  // reserva) — no depende de la tasa en vivo. World Challenge: tasa del día
  // (ver tasaReservaTiquete_()).
  const e = parseFloat(document.getElementById('eur1').value) || 0;
  const tasaUsar = tasaReservaTiquete_();
  const base = e * tasaUsar;
  document.getElementById('tasa1').value = fmtT(tasaUsar);
  document.getElementById('cop1').textContent = fmt(base);
  updatePayAmounts('p1tc-total','p1tc-fee','p1tr-total', base);
}
function calc2() {
  if (pagoYaCongelado('final')) return; // ya se envió comprobante — el monto y la tasa quedan congelados
  if (!tasa) return;
  const e = parseFloat(document.getElementById('eur2').value) || 0;
  const base = e * tasa;
  document.getElementById('tasa2').value = fmtT(tasa);
  document.getElementById('cop2').textContent = fmt(base);
  updatePayAmounts('p2tc-total','p2tc-fee','p2tr-total', base);
}

// ── CONGELAR MONTO/TASA TRAS ENVIAR COMPROBANTE ───────────────────────────────
// Una vez el participante envía el comprobante de reserva o pago final, el
// monto y la tasa mostrados quedan fijos mientras el saldo siga cubierto — no
// se recalculan solo porque cambie la tasa en vivo (pago final). Pero si luego
// aparece saldo pendiente REAL (ej. se agrega un acompañante nuevo y el total
// del grupo sube por encima de lo ya abonado), pagoYaCongelado() descongela
// para permitir pagar la diferencia. El tiquete queda fuera a propósito —
// sigue recalculándose igual.
const PAGOS_CONGELABLES = {
  reserva: { eur: 'eur1', tasa: 'tasa1', cop: 'cop1', tcTotal: 'p1tc-total', tcFee: 'p1tc-fee', trTotal: 'p1tr-total', paso: 4 },
  final:   { eur: 'eur2', tasa: 'tasa2', cop: 'cop2', tcTotal: 'p2tc-total', tcFee: 'p2tc-fee', trTotal: 'p2tr-total', paso: 6 }
};

function congelarPagoKey(tipoPago) {
  return 'pago_congelado_' + tipoPago + '_' + (participantEmail || nombre || '');
}

function pagoYaCongelado(tipoPago) {
  const cfg = PAGOS_CONGELABLES[tipoPago];
  if (!cfg || grupoPaso < cfg.paso) return false;
  // Si tras congelar apareció saldo pendiente REAL (ej. se agregó un
  // participante nuevo después de que este pago ya estaba completo), el monto
  // congelado quedó desactualizado — hay que descongelar para permitir pagar
  // la diferencia y mostrar el monto/tasa/COP correctos.
  const t = calcPaymentTotals();
  const total = tipoPago === 'reserva' ? t.reserva : t.final;
  const abono = tipoPago === 'reserva' ? (t.abonoReserva || 0) : (t.abonoFinal || 0);
  if (total > 0 && abono < total) return false;
  return true;
}

// Consulta (sin token, igual que la búsqueda de participante) el estado real
// de los pagos en la hoja Pagos. Al resolver, si hay pagos ya congelados en
// pantalla, los vuelve a aplicar para que el valor validado por el admin
// reemplace la estimación mostrada mientras estaba "Pendiente de confirmar".
function cargarMisPagosValidados() {
  if (!nombre) return;
  fetch(APPS_SCRIPT_URL + '?action=mis_pagos&nombre=' + encodeURIComponent(nombre) + '&programa=' + encodeURIComponent(programKeyActivo) + '&_t=' + Date.now(), { redirect: 'follow' })
    .then(r => r.json())
    .then(data => {
      misPagosValidados = (data && typeof data === 'object') ? data : {};
      if (pagoYaCongelado('reserva')) aplicarCongelamiento('reserva');
      if (pagoYaCongelado('final')) aplicarCongelamiento('final');
    })
    .catch(() => {});
}

function congelarPago(tipoPago) {
  const cfg = PAGOS_CONGELABLES[tipoPago];
  if (!cfg) return;
  const eurEl = document.getElementById(cfg.eur);
  const tasaEl = document.getElementById(cfg.tasa);
  const copEl = document.getElementById(cfg.cop);
  const datos = {
    eur: eurEl ? eurEl.value : '',
    tasa: tasaEl ? tasaEl.value : '',
    cop: copEl ? copEl.textContent : ''
  };
  try { localStorage.setItem(congelarPagoKey(tipoPago), JSON.stringify(datos)); } catch(e) {}
  aplicarCongelamiento(tipoPago, datos);
}

function aplicarCongelamiento(tipoPago, datosForzados) {
  const cfg = PAGOS_CONGELABLES[tipoPago];
  if (!cfg) return;
  const eurEl = document.getElementById(cfg.eur);
  const tasaEl = document.getElementById(cfg.tasa);
  const copEl = document.getElementById(cfg.cop);
  let datos = datosForzados;
  if (!datos) {
    // Prioridad 1: si el admin ya validó el pago (Completo/Parcial), ese es el
    // valor real pagado — reemplaza cualquier estimación previa (incluida la
    // que se congeló al solo enviar el comprobante, aún "Pendiente de confirmar").
    const validado = misPagosValidados[tipoPago];
    const estadoValidado = validado ? String(validado.estado || '').toLowerCase() : '';
    if (validado && (estadoValidado === 'completo' || estadoValidado === 'parcial') && validado.eur > 0) {
      const tasaReal = validado.cop > 0 ? Math.round(validado.cop / validado.eur) : (tipoPago === 'reserva' ? tasaReservaTiquete_() : tasa);
      const copReal = validado.cop > 0 ? validado.cop : validado.eur * tasaReal;
      datos = { eur: String(validado.eur), tasa: fmtT(tasaReal), cop: fmt(copReal) };
      try { localStorage.setItem(congelarPagoKey(tipoPago), JSON.stringify(datos)); } catch(e) {}
    }
  }
  if (!datos) {
    try { datos = JSON.parse(localStorage.getItem(congelarPagoKey(tipoPago)) || 'null'); } catch(e) { datos = null; }
    // Blindaje: un blob viejo/corrupto con eur vacío o en 0 (ej. guardado
    // durante una carrera de recálculo mientras el campo aún no tenía valor)
    // nunca debe aplicarse — se descarta y se recalcula desde cero abajo, en
    // vez de dejar el monto congelado en 0 mientras el COP sí muestra un
    // número (esto fue lo que causó el envío en 0 EUR de Andrea).
    if (datos && !(parseFloat(datos.eur) > 0)) {
      try { localStorage.removeItem(congelarPagoKey(tipoPago)); } catch(e) {}
      datos = null;
    }
  }
  if (!datos) {
    // Sin registro local guardado (ej. otro dispositivo o caché borrada): calcular
    // una vez con la tasa vigente para que monto, tasa y COP queden coherentes
    // entre sí (en vez de dejar tasa/COP en blanco mientras el monto sí se ve),
    // y congelar ese resultado desde ahora.
    const tasaUsar = tipoPago === 'reserva' ? tasaReservaTiquete_() : tasa;
    const eur = eurEl ? (parseFloat(eurEl.value) || 0) : 0;
    const base = eur * tasaUsar;
    datos = { eur: eurEl ? eurEl.value : '', tasa: fmtT(tasaUsar), cop: fmt(base) };
    try { localStorage.setItem(congelarPagoKey(tipoPago), JSON.stringify(datos)); } catch(e) {}
  }
  if (eurEl) eurEl.value = datos.eur;
  if (tasaEl) tasaEl.value = datos.tasa;
  if (copEl) copEl.textContent = datos.cop;
  const base = parseFloat((datos.cop || '').replace(/[^\d]/g, '')) || 0;
  updatePayAmounts(cfg.tcTotal, cfg.tcFee, cfg.trTotal, base);
  if (eurEl) {
    eurEl.readOnly = true;
    eurEl.classList.add('ro');
    eurEl.title = 'Monto congelado: ya enviaste tu comprobante de pago';
  }
}
function calcTiq() {
  // Clinic: tasa fija (misma TRM del 1 de junio que la reserva). World
  // Challenge: tasa del día (ver tasaReservaTiquete_()).
  const e = parseFloat(document.getElementById('eur-tiq').value) || 0;
  const tasaUsar = tasaReservaTiquete_();
  const base = e * tasaUsar;
  const tasaTiq = document.getElementById('tasa-tiq');
  if (tasaTiq) tasaTiq.value = fmtT(tasaUsar);
  document.getElementById('cop-tiq').textContent = fmt(base);
  updatePayAmounts('ptiqtc-total','ptiqtc-fee','ptiqtr-total', base);
}

fetchTasa();
setInterval(fetchTasa, 30 * 60 * 1000); // Refrescar cada 30 minutos

// ── AUTO-REFRESH DEL ÁREA PERSONAL (participante y admin) ─────────────────────
// Mientras la pestaña quede abierta, se refresca todo cada 60s — así el
// participante ve reflejado en vivo cualquier pago que el admin confirme
// mientras tiene la página abierta, y el admin ve pagos/comprobantes nuevos
// sin tener que recargar manualmente. Se salta el ciclo si hay un modal
// abierto (ej. el admin a mitad de editar un pago), para no pisarle cambios
// sin guardar con datos frescos del servidor.
function hayModalAbierto_() {
  return !!document.querySelector('.modal-overlay.open');
}

// Solo participante: releer sus datos (abonos, pasos) y volver a aplicar el
// programa activo — reutiliza el mismo pipeline que ya corre al iniciar
// sesión (activarPrograma → applyPaymentTotals/applyPasoActual), así que no
// hay lógica de render duplicada que mantener sincronizada aparte.
function refrescarParticipanteAuto_() {
  if (hayModalAbierto_() || !participantEmail || !allParticipants.length) return;
  fetch(APPS_SCRIPT_URL + '?action=buscar&email=' + encodeURIComponent(participantEmail) + '&_t=' + Date.now(), { redirect: 'follow' })
    .then(r => r.text())
    .then(rawText => {
      let data; try { data = JSON.parse(rawText); } catch(e) { data = null; }
      const rawParticipants = extractParticipants(data);
      if (!rawParticipants.length) return;
      allParticipants = rawParticipants.map(p => normalizeParticipant(p) || p);
      activarPrograma(programKeyActivo, { isAutoRefresh: true });
    })
    .catch(() => {});
}

setInterval(() => {
  const mainVisible = document.getElementById('main-content') && document.getElementById('main-content').style.display !== 'none';
  if (!mainVisible) return;
  if (adminSessionToken) { loadAdmin(true); return; } // vista admin — refresca participantes+financiero+acceso
  refrescarParticipanteAuto_();
}, 60 * 1000);

// ── T&C ──────────────────────────────────────────────────────────────────────
function getTyC() {
  const tipoCurrent = (tipo || 'jugador').toLowerCase();
  if (programKeyActivo === 'world_challenge') return getTyCWorldChallenge_(tipoCurrent);
  // Bug histórico: comparaba `programa` (texto libre, ej. "Real Madrid
  // Foundation Clinic") contra 'solo_actividades', que en realidad es un
  // valor posible de `habitacion` — nunca coincidían, así que esta rama
  // jamás se activaba. Corregido a comparar el campo correcto.
  const conAloj = habitacion !== 'solo_actividades';

  const cancelacion = `
<h3>4. Políticas de cancelación</h3>
<ul>
  <li><strong>Más de 3 meses antes del programa:</strong> reembolso del <strong>80%</strong> del valor pagado</li>
  <li><strong>Entre 2 y 3 meses antes:</strong> reembolso del <strong>50%</strong> del valor pagado</li>
  <li><strong>Menos de 1 mes antes:</strong> <strong>sin reembolso</strong></li>
  <li>Con <strong>justificante médico válido</strong>: el programa podrá ser reprogramado para una edición futura</li>
  <li>⚠️ Estas políticas <strong>no aplican al tiquete aéreo</strong>, que se rige según las condiciones de la aerolínea correspondiente</li>
  <li>Situaciones personales (pasaporte vencido, documentación incompleta, demoras en aeropuerto, etc.) no dan derecho a reembolso</li>
</ul>`;

  if (tipoCurrent.includes('jug')) {
    return `
<h3>1. Servicios incluidos</h3>
<ul>
  ${conTiq ? '<li><strong>Tiquete aéreo:</strong> Bogotá – Madrid – Bogotá (vuelo grupal, fecha fija)</li>' : ''}
  <li><strong>Alojamiento:</strong> 7 noches y 8 días en el Campus Deportivo European Football Institute — pensión completa (desayuno, almuerzo, snack y cena). Lavandería incluida.</li>
  <li>4 sesiones de entrenamiento oficial con metodología de la Fundación Real Madrid en la Ciudad Deportiva (Valdebebas)</li>
  <li><strong>Victory Cup</strong> — 3 partidos oficiales contra colegios de Madrid</li>
  <li>Tour al Estadio Santiago Bernabéu y tienda oficial Adidas</li>
  <li>Recorrido histórico por la ciudad de Madrid</li>
  <li>Conferencia <em>Building a Champion</em></li>
  <li>Excursión al Parque Warner</li>
  <li><strong>Kit deportivo:</strong> 2 uniformes completos, 2 camisetas, chaqueta y escarapela identificativa</li>
  <li><strong>Seguro médico</strong> durante todo el programa</li>
  <li><strong>Staff dedicado</strong> para garantizar la experiencia de los participantes</li>
  <li><strong>Transporte:</strong> todos los traslados, incluyendo recogida y regreso al Aeropuerto Madrid-Barajas</li>
</ul>
<h3>2. Precio del programa y forma de pago</h3>
<ul>
  <li>Costo por participante: <strong>2.790 EUR</strong>${conTiq ? ' + tiquete aéreo (993 EUR)' : ' (sin tiquete aéreo)'}</li>
  <li>Pago de reserva: <strong>1.000 EUR</strong> — fecha límite <strong>1 de junio 2026</strong></li>
  <li>2do pago: <strong>1.790 EUR</strong> — fecha límite <strong>30 de julio 2026</strong></li>
  <li>Los pagos pueden realizarse en pesos colombianos (COP) según la TRM del día, mediante transferencia bancaria o tarjeta</li>
  <li><strong>Datos bancarios:</strong> Bancolombia · Beneficiario: Fundación Revel · Cta. Cte. 05962673128 · NIT 900636583</li>
</ul>
<h3>3. Documentación requerida</h3>
<ul>
  <li>Pasaporte vigente con mínimo 6 meses de validez desde la fecha de finalización del viaje</li>
  <li>Registro civil original y autenticado (menores de edad)</li>
  <li>Permiso de salida del país debidamente autenticado (menores de edad)</li>
</ul>
${cancelacion}
<h3>5. Cláusula de responsabilidad</h3>
<p>Victory Sports Spain y Fundación Revel garantizan la calidad de los servicios descritos y quedan exentos de responsabilidad en casos de fuerza mayor como desastres naturales, pandemias, huelgas o cualquier circunstancia imprevisible e inevitable.</p>
<h3>6. Cesión de derechos de imagen</h3>
<p>El padre, madre o representante legal autoriza a Victory Sports Spain SL y a la Fundación Revel a tomar fotografías y videos del participante durante el viaje para uso en redes sociales, páginas web y materiales promocionales, respetando en todo momento la dignidad de los participantes.</p>
<h3>7. Cláusula de comportamiento</h3>
<p>Todos los participantes deben respetar las normas y reglamentos del programa, mantener un comportamiento adecuado en todas las actividades y alojamientos, y cumplir con las indicaciones del staff de Victory Sports. Cualquier incumplimiento podrá resultar en la expulsión inmediata del programa sin derecho a reembolso.</p>
<h3>8. Política de cambios y fuerza mayor</h3>
<p>En caso de cambios en el itinerario por razones fuera del control de los organizadores, Fundación Revel se compromete a ofrecer alternativas de igual o mayor calidad, sin ser responsable por gastos adicionales incurridos por los participantes.</p>
<h3>9. Jurisdicción legal</h3>
<p>Este contrato se rige bajo las leyes colombianas. Cualquier disputa se resolverá en los tribunales de Bogotá.</p>
<h3>10. Declaración de aceptación</h3>
<p>Al aceptar estos términos, el participante o su representante legal declara haber leído, comprendido y aceptado los presentes términos y condiciones en su totalidad.</p>`;
  }

  const hab = habitacion === 'doble' ? 'Habitación doble' : 'Habitación sencilla';
  return `
<h3>1. Servicios incluidos (Acompañante)</h3>
<ul>
  ${conTiq ? '<li><strong>Tiquete aéreo:</strong> Bogotá – Madrid – Bogotá (vuelo grupal, fecha fija)</li>' : ''}
  ${conAloj ? `<li><strong>Alojamiento:</strong> ${hab} en Campus EFI, Madrid — desayuno incluido</li>` : '<li>Modalidad sin alojamiento — solo actividades</li>'}
  <li>Asistencia a la ceremonia de clausura del RMF Clinic en la Ciudad Deportiva del Real Madrid</li>
  <li>Entrada a los 3 partidos de la Victory Cup</li>
  <li>Tour al Estadio Santiago Bernabéu y tienda oficial Adidas</li>
  <li>Recorrido histórico por Madrid · Conferencia <em>Building a Champion</em> · Parque Warner</li>
  <li>Seguro médico durante todo el programa</li>
  <li>Transporte a todas las actividades</li>
</ul>
<h3>2. Precio y forma de pago</h3>
<ul>
  <li>Pago de reserva: <strong>1.000 EUR</strong> — fecha límite <strong>1 de junio 2026</strong></li>
  <li>2do pago: <strong>1.790 EUR</strong> — fecha límite <strong>30 de julio 2026</strong></li>
  <li>Pagos en COP según TRM del día. Bancolombia · Fundación Revel · Cta. 05962673128 · NIT 900636583</li>
</ul>
${cancelacion}
<h3>5. Cláusula de responsabilidad</h3>
<p>Victory Sports Spain y Fundación Revel garantizan la calidad de los servicios y quedan exentos de responsabilidad ante casos de fuerza mayor.</p>
<h3>6. Cesión de derechos de imagen</h3>
<p>El participante autoriza a Victory Sports Spain SL y Fundación Revel a usar fotografías y videos tomados durante el programa en redes sociales y materiales promocionales.</p>
<h3>7. Jurisdicción legal</h3>
<p>Este contrato se rige bajo las leyes colombianas. Cualquier disputa se resolverá en los tribunales de Bogotá.</p>`;
}

// ── T&C — WORLD CHALLENGE ──────────────────────────────────────────────────
// Transcrito de los T&C oficiales en PDF (8 variantes: Jugador, Acomp.
// Doble/Sencilla/Solo Actividades/Solo World Challenge, cada uno con/sin
// tiquete). Los montos y fechas se leen de PRECIOS_WC/TIQUETE_EUR_WC/
// FECHAS_LIMITE_WC — únicas fuentes de verdad, ya usadas por
// calcPaymentTotals() — para que el texto nunca se desincronice de lo que
// realmente se cobra.
function getTyCWorldChallenge_(tipoCurrent) {
  const esJug = tipoCurrent.includes('jug');
  const habNorm = (habitacion || '').toLowerCase();
  const esDoble = habNorm.includes('doble');
  const esSoloWC = !esJug && habNorm === 'solo_world_challenge';
  // Mismo criterio que montoReservaFinalParticipante_(): solo '' (compatibilidad)
  // o 'solo_actividades' cuentan como Solo Actividades — 'individual' y
  // cualquier otro valor no reconocido caen en Sencilla (rama "else" abajo),
  // igual que ya hace el cálculo de precios.
  const esSoloAct = !esJug && (habNorm === '' || habNorm === 'solo_actividades');
  const pagoUnico = esSoloAct || esSoloWC;
  const fReserva = FECHAS_LIMITE_WC.reserva, fFinal = FECHAS_LIMITE_WC.final;

  let servicios;
  if (esJug) {
    servicios = `
<ul>
  ${conTiq ? '<li><strong>Tiquete aéreo:</strong> ida y vuelta en la ruta Bogotá – Madrid – Bogotá</li>' : ''}
  <li><strong>Alojamiento:</strong> 7 noches y 8 días en el Campus Deportivo European Football Institute by StepHouse — pensión completa (desayuno, almuerzo, snack y cena). Lavandería incluida.</li>
  <li>Participación en el Real Madrid Foundation World Challenge</li>
  <li>Tour al Estadio Santiago Bernabéu y tienda oficial Adidas</li>
  <li>Recorrido histórico por la ciudad de Madrid</li>
  <li>Excursión Parque de Diversiones de Madrid</li>
  <li>Conferencia <em>Building a Champion</em></li>
  <li><strong>Transporte:</strong> todos los traslados durante el programa, incluyendo recogida y regreso al Aeropuerto Madrid-Barajas</li>
  <li><strong>Kit deportivo:</strong> dos camisetas, gorra, chaqueta y escarapela identificativa</li>
  <li><strong>Seguro médico</strong> durante todo el programa</li>
  <li><strong>Atención personalizada:</strong> staff dedicado para garantizar la experiencia de los participantes</li>
</ul>`;
  } else if (pagoUnico) {
    servicios = `
<ul>
  <li>${esSoloWC ? 'Entrada y participación en el torneo Real Madrid Foundation World Challenge' : 'Asistencia y participación en el Real Madrid Foundation World Challenge'}</li>
  <li>Seguro médico de viaje durante el evento</li>
</ul>`;
  } else {
    servicios = `
<ul>
  ${conTiq ? '<li><strong>Tiquete aéreo:</strong> ida y vuelta en la ruta Bogotá – Madrid – Bogotá</li>' : ''}
  <li><strong>Transporte</strong> Aeropuerto – Hotel y actividades</li>
  <li><strong>Alojamiento</strong> en Hotel Eurostars (desayuno incluido) — habitación ${esDoble ? 'doble' : 'sencilla'}</li>
  <li>Tour Estadio Santiago Bernabéu y Adidas Store</li>
  <li>City Tour Madrid histórico</li>
  <li>Excursión Parque de Diversiones de Madrid</li>
  <li>Seguro médico de viaje para todos los participantes durante el programa</li>
</ul>`;
  }

  const datosBancarios = `<li><strong>Datos bancarios:</strong> Bancolombia · Beneficiario: Fundación Revel · Cuenta 05962673128 · NIT 900636583-7</li>`;
  let precioSeccion;
  if (esJug) {
    const p = PRECIOS_WC.jugador;
    precioSeccion = `
<ul>
  <li>Costo total por participante: <strong>${p.reserva + p.final} EUR</strong>${conTiq ? ` (programa) + <strong>${TIQUETE_EUR_WC} EUR</strong> (tiquete aéreo) = <strong>${p.reserva + p.final + TIQUETE_EUR_WC} EUR</strong>` : ` (el tiquete aéreo no está incluido; valor referencial: ${TIQUETE_EUR_WC} EUR)`}</li>
  <li>Reserva: <strong>${p.reserva} EUR</strong> — fecha límite <strong>${fReserva}</strong></li>
  ${conTiq ? `<li>Tiquete aéreo: <strong>${TIQUETE_EUR_WC} EUR</strong> — fecha límite <strong>${fReserva}</strong></li>` : ''}
  <li>Pago final: <strong>${p.final} EUR</strong> — fecha límite <strong>${fFinal}</strong></li>
  <li>El pago se realizará en pesos colombianos (COP) según la tasa oficial del día de la transferencia bancaria</li>
  ${datosBancarios}
</ul>`;
  } else if (pagoUnico) {
    const base = esSoloWC ? PRECIOS_WC.acomp_solo_wc.reserva : PRECIOS_WC.acomp_actividades.reserva;
    const total = base + (conTiq ? TIQUETE_EUR_WC : 0);
    precioSeccion = `
<ul>
  <li>${conTiq ? 'Con Tiquete Aéreo' : 'Sin Tiquete Aéreo'}: <strong>${total} EUR</strong> — pago único al momento de la inscripción</li>
  <li>El pago se efectuará en COP o euros por transferencia</li>
  ${datosBancarios}
</ul>`;
  } else {
    const p = esDoble ? PRECIOS_WC.acomp_doble : PRECIOS_WC.acomp_sencilla;
    const total = p.reserva + p.final + (conTiq ? TIQUETE_EUR_WC : 0);
    precioSeccion = `
<ul>
  <li>Total del programa: <strong>${total} EUR</strong></li>
  <li>Reserva: <strong>${p.reserva} EUR</strong> — fecha límite <strong>${fReserva}</strong></li>
  ${conTiq ? `<li>Tiquete aéreo: <strong>${TIQUETE_EUR_WC} EUR</strong> — fecha límite <strong>${fReserva}</strong></li>` : ''}
  <li>Pago final: <strong>${p.final} EUR</strong> — fecha límite <strong>${fFinal}</strong></li>
  <li>El pago se efectuará en COP o euros por transferencia</li>
  ${datosBancarios}
</ul>`;
  }

  const documentacion = `
<ul>
  <li>Pasaporte con validez de mínimo 6 meses hasta la finalización del viaje</li>
  <li>Cédula de ciudadanía para mayores de edad y registro civil para menores de edad</li>
  <li>Permiso de salida del país para menores de edad${esJug ? ', debidamente autenticado ante notario' : ''}</li>
  ${esJug ? '<li>Registro Civil de nacimiento</li>' : ''}
</ul>`;

  let cancelacion;
  if (pagoUnico) {
    cancelacion = `
<ul>
  <li>El programa se paga en un solo pago (100% del valor total) al momento de la inscripción, sujeto a esta política de cancelación</li>
  <li><strong>Antes de los 3 meses del inicio del programa (más de 90 días):</strong> penalidad del 10% del valor pagado (reembolso del 90%)</li>
  <li><strong>De 90 a 61 días de anticipación:</strong> penalidad del 30% del valor pagado (reembolso del 70%)</li>
  <li><strong>De 60 a 31 días de anticipación:</strong> penalidad del 60% del valor pagado (reembolso del 40%)</li>
  <li><strong>30 días o menos de anticipación:</strong> penalidad del 100% (no hay lugar a reembolso)</li>
  <li>Cualquier inconveniente de índole personal en el aeropuerto (pasaporte vencido, permisos incompletos, homónimos, demandas, llegada fuera de hora, etc.) no da lugar a reembolso del 100% del valor pagado</li>
</ul>`;
  } else {
    cancelacion = `
<ul>
  <li><strong>Antes de los 3 meses del inicio del programa (más de 90 días):</strong> penalidad del 10% del valor pagado (reembolso del 90%)</li>
  <li><strong>De 90 a 61 días de anticipación:</strong> penalidad del 30% del valor pagado (reembolso del 70%)</li>
  <li><strong>De 60 a 31 días de anticipación:</strong> penalidad del 60% del valor pagado (reembolso del 40%)</li>
  <li><strong>30 días o menos de anticipación:</strong> penalidad del 100% (no hay lugar a reembolso)</li>
  ${esJug ? '<li>Tiquete aéreo: reembolsable según las políticas propias de la aerolínea, de forma independiente a esta política</li>' : ''}
  <li>Cualquier inconveniente de índole personal en el aeropuerto (pasaporte vencido, permisos incompletos, homónimos, demandas, llegada fuera de hora, etc.) no da lugar a reembolso del valor pagado</li>
  ${esJug ? '<li>Devoluciones por condiciones médicas debidamente certificadas: el programa se reprogramará a la siguiente fecha disponible del programa, conservando las mismas condiciones</li>' : ''}
</ul>`;
  }

  return `
<h3>1. Servicios incluidos</h3>
${servicios}
<h3>2. Precio del programa y forma de pago</h3>
${precioSeccion}
<h3>3. Documentación requerida</h3>
${documentacion}
<h3>4. Políticas de cancelación</h3>
${cancelacion}
<h3>5. Cláusula de responsabilidad</h3>
<p>Victory Sports Spain, Fundación Revel y sus operadores garantizan la calidad de los servicios descritos y quedan exentos de responsabilidad en casos de fuerza mayor, como desastres naturales, pandemias, huelgas o cualquier circunstancia imprevisible e inevitable.</p>
<h3>6. Cesión de derechos de imagen</h3>
<p>El padre, madre o representante legal del menor autoriza a Victory Sports Spain SL y a la Fundación Revel a tomar fotografías y videos del menor durante el viaje. Estas imágenes podrán ser utilizadas en redes sociales, páginas web y materiales promocionales, siempre respetando la dignidad del menor.</p>
${esJug ? `<h3>7. Cláusula de comportamiento</h3>
<p>Todos los participantes deben respetar las normas y reglamentos del programa, mantener un comportamiento adecuado en todas las actividades y alojamientos, y cumplir con las indicaciones del staff de Victory Sports. Cualquier incumplimiento podrá resultar en la expulsión inmediata del programa sin derecho a reembolso.</p>
<h3>8. Política de cambios y fuerza mayor</h3>
<p>En caso de cambios en el itinerario por razones fuera del control de los organizadores, Victory Sports Spain y Fundación Revel se comprometen a ofrecer alternativas de igual o mayor calidad, pero no serán responsables por gastos adicionales incurridos por los participantes.</p>
<h3>9. Jurisdicción legal</h3>
<p>Este contrato se rige bajo las leyes colombianas. Cualquier disputa que surja del mismo será resuelta en los tribunales de Bogotá.</p>
<h3>10. Declaración de aceptación</h3>
<p>Al realizar el primer pago, el participante o su representante legal declara haber leído, comprendido y aceptado estos términos y condiciones en su totalidad.</p>` : ''}`;
}

// ── TIQUETE OPTIN (query string opcional) ─────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('tiquete') === 'sin') {
  const opt = document.getElementById('tiq-optin');
  if (opt) opt.style.display = 'block';
}

function setTiquete(val) {
  conTiq = val;
  document.getElementById('tiq-ok').style.display = val ? 'block' : 'none';
  document.getElementById('btn-tiq-si').textContent = val ? '✅ Tiquete agregado' : '✈️ Sí, agregar tiquete';
  document.getElementById('btn-tiq-si').style.background = val ? 'var(--green)' : 'var(--blue)';
  // Actualizar T&C con la nueva elección
  document.getElementById('tc-text').innerHTML = getTyC();
  buildSteps();
}

// ── TC CHECKBOX ───────────────────────────────────────────────────────────────
function onTC() {
  const ok = document.getElementById('tc-chk').checked;
  const card = document.getElementById('pay-card1');
  if (card) card.classList.toggle('pay-lock', !ok);
  // El aviso vive FUERA de #pay-card1 a propósito: pay-lock deja la tarjeta
  // al 40% de opacidad, y un hijo no puede "deshacer" la opacidad de su
  // padre con su propio opacity — el mensaje quedaría igual de apagado y
  // fácil de pasar por alto si estuviera adentro.
  const lockMsg = document.getElementById('reserva-tc-lock-msg');
  if (lockMsg) lockMsg.style.display = ok ? 'none' : 'block';
  const btnContinuar = document.getElementById('btn-continuar-tc');
  if (btnContinuar) {
    btnContinuar.disabled = !ok;
    btnContinuar.style.opacity = ok ? '1' : '0.5';
    btnContinuar.style.cursor = ok ? 'pointer' : 'not-allowed';
  }
  if (ok) {
    const fecha = new Date().toLocaleDateString('es-CO', {year:'numeric', month:'long', day:'numeric'});
    const tcFecha = document.getElementById('tc-fecha');
    if (tcFecha) tcFecha.textContent = fecha;
    const tcOkDoc = document.getElementById('tc-ok-doc');
    if (tcOkDoc) tcOkDoc.style.display = 'block';
    const ds3 = document.getElementById('ds3');
    if (ds3) ds3.style.display = 'none';
    document.getElementById('tc-text').innerHTML = getTyC();
    // Marcar T&C como completado en los pasos
    const tcStep = STEP_DEFS.findIndex(s => s.panel === 'panel-tc');
    if (tcStep > -1) STEP_DEFS[tcStep].done = true;
    buildSteps();
    actualizarPaso(2);
  } else {
    const tcOkDoc = document.getElementById('tc-ok-doc');
    if (tcOkDoc) tcOkDoc.style.display = 'none';
    const ds3 = document.getElementById('ds3');
    if (ds3) ds3.style.display = '';
  }
}

// Recuerda qué panel (reserva/tiquete/final) abrió el modal de monto, para que
// el botón "Subir comprobante" sepa a qué sección de la página llevar al participante.
let boldModalPanelActual = null;

// Lleva al participante directo al bloque de "Subir comprobante de pago" del
// panel donde seleccionó "transferencia" — los datos de la cuenta bancaria ya
// se muestran dentro del propio modal, así que no hace falta pasar primero
// por esa sección de la página antes de subir el archivo.
function irASubirComprobante() {
  closeBoldModal();
  const idsPorPanel = { reserva: 'upload-block-reserva', tiquete: 'upload-block-tiquete', final: 'upload-block-final' };
  const id = idsPorPanel[boldModalPanelActual];
  const el = id ? document.getElementById(id) : null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── AVISO COMPROBANTE + MONTO A PAGAR ──────────────────────────────────────────
// Se dispara al SELECCIONAR el método de pago (tarjeta o transferencia), no al
// hacer clic en el link de Bold. El monto exacto se lee del total ya calculado
// en pantalla para ese panel y método (p1tc-total/p1tr-total, etc.), que ya
// incluye la tasa correcta (TRM_RESERVA fija para reserva/tiquete, tasa en vivo
// para pago final) y el recargo de tarjeta cuando aplica — así el popup nunca
// puede desalinearse de esos cálculos.
function avisoComprobante(panel, tipo) {
  boldModalPanelActual = panel;
  const totalIdByPanel = {
    reserva: { tc: 'p1tc-total',   tr: 'p1tr-total' },
    tiquete: { tc: 'ptiqtc-total', tr: 'ptiqtr-total' },
    final:   { tc: 'p2tc-total',   tr: 'p2tr-total' }
  };
  const totalId = (totalIdByPanel[panel] || {})[tipo];
  const totalEl = document.getElementById(totalId || '');
  const montoTxt = (totalEl && totalEl.textContent.trim()) || '$ —';

  // EUR y tasa que ya se muestran en el mismo panel — se envían junto al monto
  // en COP para que el correo al admin refleje exactamente lo que ve el participante.
  const eurTasaIdByPanel = {
    reserva: { eur: 'eur1',    tasa: 'tasa1' },
    tiquete: { eur: 'eur-tiq', tasa: 'tasa-tiq' },
    final:   { eur: 'eur2',    tasa: 'tasa2' }
  };
  const eurTasaIds = eurTasaIdByPanel[panel] || {};
  const eurEl = document.getElementById(eurTasaIds.eur || '');
  const tasaEl = document.getElementById(eurTasaIds.tasa || '');
  const eurTxt = (eurEl && eurEl.value) ? (eurEl.value + ' EUR') : '—';
  const tasaTxt = (tasaEl && tasaEl.value.trim()) || '—';

  const esTarjeta = tipo === 'tc';
  const iconoEl = document.getElementById('bold-modal-icono');
  const titleEl = document.getElementById('bold-modal-title');
  const labelEl = document.getElementById('bold-modal-label');
  const notaEl = document.getElementById('bold-modal-nota');
  if (iconoEl) iconoEl.textContent = esTarjeta ? '💳' : '🏦';
  if (titleEl) titleEl.textContent = esTarjeta ? 'Vas a pagar con Bold' : 'Vas a pagar por transferencia';
  if (labelEl) labelEl.textContent = esTarjeta ? 'Monto a ingresar en Bold' : 'Monto a transferir';
  if (notaEl) notaEl.textContent = esTarjeta ? 'Ingresa exactamente este monto al abrir Bold.' : 'Transfiere exactamente este monto a la cuenta bancaria indicada.';

  const ctaBoldEl = document.getElementById('bold-modal-cta-bold');
  const ctaCerrarEl = document.getElementById('bold-modal-cta-cerrar');
  if (ctaBoldEl) ctaBoldEl.style.display = esTarjeta ? 'block' : 'none';
  if (ctaCerrarEl) ctaCerrarEl.style.display = esTarjeta ? 'none' : 'block';
  const cuentaEl = document.getElementById('bold-modal-cuenta');
  if (cuentaEl) cuentaEl.style.display = esTarjeta ? 'none' : 'block';

  const montoEl = document.getElementById('bold-monto-valor');
  if (montoEl) montoEl.textContent = montoTxt + ' COP';
  const modal = document.getElementById('bold-monto-modal');
  if (modal) modal.classList.add('open');
  notificarClickBold(panel, tipo, montoTxt, eurTxt, tasaTxt);
}

// Aviso al admin de que un participante seleccionó método de pago — fire-and-forget.
function notificarClickBold(panel, tipo, monto, eur, tasa) {
  if (!participantEmail) return;
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ action: 'notificar_click_bold', email: participantEmail, nombre, panel, tipo, monto, eur, tasa }),
    keepalive: true
  }).catch(() => {});
}

function closeBoldModal() {
  const modal = document.getElementById('bold-monto-modal');
  if (modal) modal.classList.remove('open');
}

function copiarMontoBold() {
  const montoEl = document.getElementById('bold-monto-valor');
  const btn = document.getElementById('bold-copiar-btn');
  if (!montoEl) return;
  const soloNumero = montoEl.textContent.replace(/[^\d]/g, '');
  navigator.clipboard.writeText(soloNumero).then(() => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = '✓ Copiado';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {});
}

// ── PROGRAMA DE REFERIDOS — "Refiere y Gana" ────────────────────────────────
// Se alimenta de window._referidoData (poblado en doLogin(), fetch paralelo
// ?action=referido_login), igual patrón que window._comercialData — no
// requiere estar dentro de loadParticipant() porque no depende del
// participante activo, sino del email logueado.
function renderReferidosPanel() {
  const el = document.getElementById('referidos-content');
  const r = window._referidoData;
  if (!el) return;
  if (!r || !r.found) { el.innerHTML = '<p style="color:var(--muted)">No tienes un código de referido activo.</p>'; return; }
  const creditoEurNum = r.creditoPendienteEur || 0;
  const creditoCopEstimado = Math.round(creditoEurNum * (tasa || TASA_FALLBACK));
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap">
      <div id="referido-codigo-valor" style="font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:1px;color:var(--navy)">${escapeHtml(r.codigo)}</div>
      <button id="referido-copiar-btn" onclick="copiarCodigoReferido()" style="padding:8px 16px;background:var(--blue);color:#fff;border:none;border-radius:6px;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap">${String.fromCodePoint(0x1F4CB)} Copiar código</button>
    </div>
    <div class="bkrow"><span>Referidos exitosos</span><span class="bk-amt">${r.referidosExitosos} / 4</span></div>
    <div class="bkrow"><span>Descuento acumulado</span><span class="bk-amt">${r.tramoPct}%</span></div>
    <div class="bkrow"><span>Crédito pendiente</span><span class="bk-amt">${creditoEurNum.toLocaleString('es-CO')} EUR · ${fmt(creditoCopEstimado)}</span></div>
  `;
}

// Clon de copiarMontoBold() — mismo patrón exacto, sin el .replace(/[^\d]/g,'')
// porque el código es alfanumérico, no un monto.
function copiarCodigoReferido() {
  const el = document.getElementById('referido-codigo-valor');
  const btn = document.getElementById('referido-copiar-btn');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = '✓ Copiado';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {});
}

const metodoPagoSel = {}; // 'tarjeta' | 'transferencia', por tipoPago: 'reserva' | 'tiquete' | 'final'

// ── PAY SELECT ────────────────────────────────────────────────────────────────
function selPay(panel, tipo) {
  const map = {
    1:   {tc:'p1tc',    tr:'p1tr',    dtc:'d1tc',    dtr:'d1tr'},
    2:   {tc:'p2tc',    tr:'p2tr',    dtc:'d2tc',    dtr:'d2tr'},
    tiq: {tc:'ptiqtc',  tr:'ptiqtr',  dtc:'dtiqtc',  dtr:'dtiqtr'},
  };
  const m = map[panel];
  document.getElementById(m.tc).classList.toggle('sel', tipo==='tc');
  document.getElementById(m.tr).classList.toggle('sel', tipo!=='tc');
  document.getElementById(m.dtc).classList.toggle('vis', tipo==='tc');
  document.getElementById(m.dtr).classList.toggle('vis', tipo!=='tc');

  const panelKeyMap = { 1: 'reserva', 2: 'final', tiq: 'tiquete' };
  avisoComprobante(panelKeyMap[panel], tipo);
  metodoPagoSel[panelKeyMap[panel]] = (tipo === 'tc') ? 'tarjeta' : 'transferencia';
}

// ── DOC UPLOAD ────────────────────────────────────────────────────────────────
function uploadDocumento(inp, tipoDocumento) {
  const file = inp.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    alert('⚠️ Archivo demasiado grande. Máximo 5MB.');
    return;
  }
  const statusId = {
    pasaporte: 'ds1',
    permiso: 'ds2',
    registro_civil: 'ds4'
  }[tipoDocumento];

  const statusEl = document.getElementById(statusId);
  if (statusEl) {
    statusEl.innerHTML = '⏳ Subiendo...';
    statusEl.style.color = 'var(--muted)';
  }

  const reader = new FileReader();
  reader.onload = () => {
    const base64Data = reader.result.split(',')[1];
    const payload = {
      email: participantEmail,
      tipo_documento: tipoDocumento,
      base64: base64Data,
      fileName: file.name,
      nombre: nombre,
      programa: programKeyActivo
    };

    fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload)
    })
      .then(() => {
        if (statusEl) {
          statusEl.innerHTML = `✅ ${file.name} <button onclick="resetDocumento('${tipoDocumento}')" style="margin-left:8px;background:none;border:none;color:var(--muted);font-size:12px;cursor:pointer;text-decoration:underline;">× Cambiar</button>`;
          statusEl.classList.add('ok');
          statusEl.style.color = 'var(--green)';
        }
      })
      .catch(err => {
        console.error('Upload error:', err);
        if (statusEl) {
          statusEl.innerHTML = '❌ Error al subir. Intenta nuevamente.';
          statusEl.style.color = 'var(--red)';
        }
      });
  };
  reader.readAsDataURL(file);
}

function resetDocumento(tipoDocumento) {
  const statusId = { pasaporte:'ds1', permiso:'ds2', registro_civil:'ds4' }[tipoDocumento];
  const inputId  = { pasaporte:'di1', permiso:'di2', registro_civil:'di4' }[tipoDocumento];
  const statusEl = document.getElementById(statusId);
  if (statusEl) { statusEl.innerHTML = '⏳ Pendiente'; statusEl.style.color = ''; statusEl.classList.remove('ok'); }
  const inp = document.getElementById(inputId);
  if (inp) { inp.value = ''; inp.click(); }
}

// URL/fileId de Drive del último comprobante subido, por tipo de pago — se
// llenan al enviar y se envían al admin junto con el estado "Pendiente de confirmar".
const comprobanteUrls = {};
const comprobanteFileIds = {};

// Archivos seleccionados pero AÚN NO enviados, por tipo de pago — nada se sube
// a Drive/Sheets hasta que el participante hace clic en "Enviar comprobante".
// Permite adjuntar más de un comprobante para el mismo paso (ej. varios abonos).
const comprobantesStaged = { reserva: [], tiquete: [], final: [] };

const COMP_LISTA_ID = { reserva: 'comp-reserva-lista', tiquete: 'comp-tiquete-lista', final: 'comp-final-lista' };

function stageComprobante(inp, tipoPago) {
  const files = Array.from(inp.files || []);
  inp.value = ''; // permite volver a elegir el mismo archivo más adelante si se quita de la lista
  if (!files.length) return;
  files.forEach(file => {
    if (file.size > 5 * 1024 * 1024) {
      alert('⚠️ "' + file.name + '" es demasiado grande. Máximo 5MB.');
      return;
    }
    comprobantesStaged[tipoPago].push(file);
  });
  renderComprobantesStaged(tipoPago);
}

function quitarComprobanteStaged(tipoPago, idx) {
  comprobantesStaged[tipoPago].splice(idx, 1);
  renderComprobantesStaged(tipoPago);
}

function renderComprobantesStaged(tipoPago) {
  const listEl = document.getElementById(COMP_LISTA_ID[tipoPago]);
  const files = comprobantesStaged[tipoPago];
  if (listEl) {
    listEl.innerHTML = files.length
      ? files.map((f, i) => `
        <div class="dstatus ok" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px">
          <span>📄 ${escapeHtml(f.name)}</span>
          <button onclick="quitarComprobanteStaged('${tipoPago}', ${i})" style="background:none;border:none;color:var(--muted);font-size:12px;cursor:pointer;text-decoration:underline;white-space:nowrap">× Quitar</button>
        </div>`).join('')
      : '<div class="dstatus">⏳ Pendiente</div>';
  }
  const hay = files.length > 0;
  const btn = document.getElementById(`comp-${tipoPago}-btn`);
  if (btn) {
    btn.style.display = hay ? 'block' : 'none';
    btn.style.opacity = hay ? '1' : '0.5';
    btn.style.cursor = hay ? 'pointer' : 'not-allowed';
    btn.style.background = hay ? 'var(--blue)' : '#999';
  }
}

// Sube UN archivo staged a Drive/Sheets (misma llamada que antes se hacía al seleccionar el archivo).
function subirUnComprobante(file, tipoPago) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64Data = reader.result.split(',')[1];
      const payload = { email: participantEmail, tipo_pago: tipoPago, base64: base64Data, fileName: file.name, nombre, programa: programKeyActivo };
      fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload)
      })
        .then(r => r.json())
        .then(res => {
          if (res && res.url) comprobanteUrls[tipoPago] = res.url;
          if (res && res.id) comprobanteFileIds[tipoPago] = res.id;
          resolve(res);
        })
        .catch(reject);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function scrollToStepsBar() {
  const stepsRow = document.getElementById('steps-row');
  if (stepsRow) stepsRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function enviarComprobante(tipoPago) {
  const files = comprobantesStaged[tipoPago];
  if (!files || !files.length) { alert('Selecciona al menos un comprobante antes de enviarlo.'); return; }

  const btn = document.getElementById(`comp-${tipoPago}-btn`);
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.style.cursor = 'wait'; btn.textContent = 'Subiendo...'; }

  // Verificar si el monto que se está subiendo cubre lo que realmente falta pagar,
  // o si es solo un abono parcial (no debe avanzar el paso en ese caso).
  const eurInputId = { reserva: 'eur1', tiquete: 'eur-tiq', final: 'eur2' }[tipoPago];
  const eurEl = document.getElementById(eurInputId);
  const eurSubmitted = eurEl ? (parseFloat(eurEl.value) || 0) : 0;
  // Nunca enviar un comprobante con monto en 0 — puede pasar si el campo quedó
  // vacío por una carrera de recálculo (ej. un valor congelado corrupto). Un
  // envío en 0 EUR queda invisible para el admin (no hay nada que revisar) y
  // el participante cree que ya pagó. Mejor bloquear aquí con un mensaje claro
  // que dejar pasar un registro roto.
  if (eurSubmitted <= 0) {
    alert('No se pudo calcular el monto a pagar (aparece en 0). Refresca la página e intenta de nuevo — si el problema sigue, contáctanos por WhatsApp.');
    if (btn) { btn.disabled = false; btn.style.cursor = 'pointer'; btn.textContent = originalLabel; }
    return;
  }
  const restantePend = (window.restantePendiente && window.restantePendiente[tipoPago] != null)
    ? window.restantePendiente[tipoPago]
    : eurSubmitted; // si no hay dato de restante (sin abonos previos), se asume el monto completo
  const esPagoCompleto = eurSubmitted >= (restantePend - 1); // -1 para tolerar redondeos menores

  Promise.all(files.map(file => subirUnComprobante(file, tipoPago)))
    .then((resultados) => {
      const urlsNuevas = resultados.map(r => r && r.url).filter(Boolean);
      marcarComprobantePendiente(tipoPago, urlsNuevas);

      if (esPagoCompleto) {
        const pasoMap = { reserva: 4, tiquete: 5, final: 6 };
        let paso = pasoMap[tipoPago];
        if (tipoPago === 'reserva' && !conTiq) paso = sinPagoFinal ? 6 : 5; // sin tiquete: salta directo al siguiente paso pendiente
        if (tipoPago === 'tiquete' && sinPagoFinal) paso = 6; // World Challenge pago único: sin pago final, salta a documentos
        actualizarPaso(paso);
        if (tipoPago === 'reserva' || tipoPago === 'final') congelarPago(tipoPago);
        setTimeout(() => {
          applyPasoActual(paso, { optimistic: true }); // el comprobante recién enviado aún no está en la hoja
          scrollToStepsBar();
        }, 1500);
      }

      comprobantesStaged[tipoPago] = [];
      const listEl = document.getElementById(COMP_LISTA_ID[tipoPago]);
      if (listEl) listEl.innerHTML = '';
      if (btn) { btn.style.display = 'none'; btn.disabled = false; btn.style.cursor = 'pointer'; btn.textContent = originalLabel; }
      const validando = document.getElementById(`comp-${tipoPago}-validando`);
      if (validando) {
        validando.style.display = 'block';
        validando.innerHTML = esPagoCompleto
          ? '⏳ <strong>Comprobante en validación</strong><br><span style="font-size:12px;color:var(--muted);">Nuestro equipo está revisando tu pago. Te notificaremos en máx. 24 horas.</span>'
          : '⏳ <strong>Abono en validación</strong><br><span style="font-size:12px;color:var(--muted);">Registramos tu abono. Una vez confirmado, el saldo restante se actualizará aquí — el paso avanzará solo cuando el pago esté completo.</span>';
      }
    })
    .catch(err => {
      console.error('Error subiendo comprobante:', err);
      alert('❌ Hubo un error subiendo el comprobante. Intenta nuevamente.');
      if (btn) { btn.disabled = false; btn.style.cursor = 'pointer'; btn.textContent = originalLabel; }
    });
}

// Avisa al panel admin de que ya se subió el comprobante — cambia el estado de
// "Sin pago" a "Pendiente de confirmar" en la hoja Pagos, sin marcarlo como
// Completo (eso sigue siendo una decisión manual del admin). Se incluye el
// monto ya calculado en pantalla porque el admin filtra/oculta filas sin monto.
function marcarComprobantePendiente(tipoPago, urlsNuevas) {
  if (!nombre) return;
  const tipoLabel = { reserva: 'Reserva', tiquete: 'Tiquete', final: 'Pago Final' }[tipoPago];
  const tipoParticipante = tipo ? (tipo.charAt(0).toUpperCase() + tipo.slice(1)) : '';
  const eurInputId = { reserva: 'eur1', tiquete: 'eur-tiq', final: 'eur2' }[tipoPago];
  const eurEl = document.getElementById(eurInputId);
  const eur = eurEl ? (parseFloat(eurEl.value) || 0) : 0;
  // También se envía el COP ya calculado en pantalla (mismo total que ve el
  // participante antes de pagar), para no depender de que el admin lo tipee de nuevo.
  const copDisplayId = { reserva: 'cop1', tiquete: 'cop-tiq', final: 'cop2' }[tipoPago];
  const copEl = document.getElementById(copDisplayId);
  const cop = copEl ? (parseFloat((copEl.textContent || '').replace(/[^\d]/g, '')) || 0) : 0;
  const hoy = new Date().toISOString().slice(0, 10);
  // Todos los comprobantes subidos en ESTA tanda (puede haber más de uno) — el
  // backend los agrega, uno por línea, a los que ya hubiera de envíos anteriores.
  const comprobanteUrl = (urlsNuevas && urlsNuevas.length) ? urlsNuevas.join('\n') : (comprobanteUrls[tipoPago] || '');
  const fileId = comprobanteFileIds[tipoPago] || '';
  // Cuántos comprobantes se subieron en ESTA tanda — si son 2+ (ej. dos abonos
  // distintos pagados por separado), la IA solo alcanza a leer UNO (fileId
  // guarda el último que terminó de subir) y compararlo contra el monto total
  // combinado siempre daría "no coincide", así que el backend debe saltarse
  // la verificación/auto-corrección automática y dejarlo en revisión manual.
  const comprobanteCount = (urlsNuevas && urlsNuevas.length) ? urlsNuevas.length : 1;
  const metodoPago = metodoPagoSel[tipoPago] || 'transferencia';
  // eur/cop de arriba son el monto BASE del programa (eur2/cop2 nunca incluyen
  // el recargo de tarjeta). Lo que hay que guardar en la hoja — y lo que
  // realmente se transfiere por Bold — es el monto CON el recargo incluido:
  // el Sheet debe reflejar siempre el total real pagado, para la contabilidad
  // final. El backend (getAbonosValidados_) es quien separa base/comisión al
  // calcular el saldo del participante — aquí solo se guarda el bruto.
  const recargo = metodoPago === 'tarjeta' ? RECARGO_TARJETA_PCT : 0;
  const eurFinal = Math.round(eur * (1 + recargo) * 100) / 100;
  const copFinal = Math.round(cop * (1 + recargo));

  // El monto que se ve en pantalla puede ser el saldo COMBINADO de varios
  // participantes vinculados al mismo correo — hay que repartirlo entre
  // quienes realmente todavía deban (ver calcularDistribucionPago_), no
  // registrarlo entero contra `nombre` (quien subió el comprobante). tasaBase
  // = cop base / eur base del monto mostrado, para poder convertir cada
  // porción repartida a su propio COP proporcional.
  const tasaBase = eur > 0 ? cop / eur : 0;
  const distribucionBase = calcularDistribucionPago_(tipoPago, eur);
  const distribucion = distribucionBase.map(d => ({
    nombre: d.nombre,
    eur: Math.round(d.eur * (1 + recargo) * 100) / 100,
    cop: Math.round(d.eur * tasaBase * (1 + recargo))
  }));

  // Antes usaba mode:'no-cors' — con eso, si el backend lanzaba una excepción
  // al escribir en Pagos, el navegador nunca podía leer la respuesta y el
  // error quedaba completamente invisible (el comprobante parecía "enviado"
  // pero nunca llegaba a la hoja ni al panel de revisión). Otras llamadas a
  // este mismo Apps Script (agregarAbonoServidor, registrarPagoDesdePanel,
  // etc.) ya funcionan sin no-cors, así que se quita aquí también para que
  // un fallo del servidor quede registrado en la consola en vez de perderse.
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ action: 'marcar_comprobante_pendiente', nombre, tipo: tipoLabel, tipo_participante: tipoParticipante, eur: eurFinal, cop: copFinal, distribucion, fecha: hoy, comprobante_url: comprobanteUrl, file_id: fileId, comprobante_count: comprobanteCount, metodo_pago: metodoPago, programa: programKeyActivo }),
    redirect: 'follow'
  })
    .then(r => r.json())
    .then(res => {
      if (!res || !res.ok) console.error('marcarComprobantePendiente: el servidor no confirmó el registro en Pagos.', res);
    })
    .catch(err => console.error('marcarComprobantePendiente: error de red/servidor.', err));
}

// ── TIQUETE TOGGLE DESDE WELCOME ─────────────────────────────────────────────
function toggleTiqueteDesdeWelcome() {
  conTiq = !conTiq;
  // Actualizar label botón welcome
  document.getElementById('tiq-toggle-label').textContent =
    conTiq ? 'Quitar tiquete aéreo' : 'Agregar tiquete aéreo';
  // Ocultar optin del panel2 si ya se manejó desde welcome
  const optin = document.getElementById('tiq-optin');
  if (optin) optin.style.display = 'none';
  // Actualizar T&C
  document.getElementById('tc-text').innerHTML = getTyC();

  // NUEVO: Desmarcar checkbox de T&C y forzar re-lectura
  const tcChk = document.getElementById('tc-chk');
  if (tcChk) {
    tcChk.checked = false;
    onTC();
  }

  // NUEVO: Mostrar mensaje de alerta
  const tcPanel = document.getElementById('panel-tc');
  if (tcPanel) {
    const existingAlert = tcPanel.querySelector('.tiq-change-alert');
    if (existingAlert) existingAlert.remove();

    const alertBox = document.createElement('div');
    alertBox.className = 'tiq-change-alert';
    alertBox.style.cssText = `
      background: rgba(217,119,6,0.1);
      border: 1.5px solid rgba(217,119,6,0.4);
      border-radius: 10px;
      padding: 18px 20px;
      margin-bottom: 20px;
      font-size: 14px;
      color: #92400e;
      line-height: 1.7;
      animation: slideIn 0.3s ease;
    `;
    alertBox.innerHTML = `
      <strong>⚠️ Términos y Condiciones actualizados</strong><br>
      Has ${conTiq ? 'agregado' : 'removido'} el tiquete aéreo. Por favor, lee y acepta los nuevos Términos y Condiciones para continuar.
    `;

    const tcCard = tcPanel.querySelector('.card');
    if (tcCard) tcCard.insertBefore(alertBox, tcCard.firstChild);

    // Scroll al panel de T&C
    goPanel('panel-tc');
    setTimeout(() => {
      tcPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }

  // Reconstruir pasos
  buildSteps();
}

// ── ACTUALIZAR PASO EN SHEETS ─────────────────────────────────────────────────
function actualizarPaso(nuevoPaso) {
  if (!participantEmail) return;
  if (nuevoPaso <= grupoPaso) return; // nunca retroceder
  grupoPaso = nuevoPaso;
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ action: 'actualizar_paso', email: participantEmail, paso_actual: String(nuevoPaso), programa: programKeyActivo }),
    keepalive: true
  }).catch(() => {});
}

function continuarAReserva() {
  if (soloAct) {
    if (conTiq) {
      actualizarPaso(4);
      goPanel('panel-tiq');
    } else {
      actualizarPaso(5);
      goPanel('panel3');
    }
  } else {
    actualizarPaso(3);
    goPanel('panel2');
  }
}

function finalizarInscripcion() {
  actualizarPaso(7);
  const idxDocs = STEP_DEFS.findIndex(s => s.panel === 'panel4');
  if (idxDocs > -1) STEP_DEFS[idxDocs].done = true;
  goPanel('panel-done');
}

// ── GUIA BIENVENIDA — visible en cada sesión, se puede cerrar pero no se recuerda
function cerrarGuia() {
  document.getElementById('welcome-guide').style.display = 'none';
}
function abrirGuia() {
  document.getElementById('welcome-guide').style.display = 'block';
}
localStorage.removeItem('guia_cerrada');

// ── PASSWORD GATE ─────────────────────────────────────────────────────────────
let _pwdPendingSection = null;
let _pwdPrevSection = 'proceso';
let _pwdMode = 'verify'; // 'verify' | 'create' | 'must_change' | 'reset'
let _pwdResetToken = null;
let _pwdResetEmail = null;
// Biometric
let _bioSection = null;
let _bioOfferShownThisSession = false;
let _pendingBioCallback = null;

function _pwdSetUI({ title, subtitle, confirm, cancelText, submitText, forgotLink }) {
  document.getElementById('pwd-title').textContent = title || 'Acceso restringido';
  document.getElementById('pwd-subtitle').textContent = subtitle || '';
  document.getElementById('pwd-confirm-wrap').style.display = confirm ? '' : 'none';
  if (confirm) document.getElementById('pwd-confirm').value = '';
  document.getElementById('pwd-cancel-btn').textContent = cancelText || 'Cancelar';
  document.getElementById('pwd-cancel-btn').style.display = cancelText === false ? 'none' : '';
  document.getElementById('pwd-submit-btn').textContent = submitText || 'Entrar';
  document.getElementById('pwd-forgot-link').style.display = forgotLink ? '' : 'none';
  document.getElementById('pwd-input').value = '';
  document.getElementById('pwd-err').textContent = '';
  document.getElementById('pwd-form').style.display = '';
  document.getElementById('pwd-forgot-form').style.display = 'none';
  const _bioOffer = document.getElementById('pwd-biometric-offer');
  if (_bioOffer) _bioOffer.style.display = 'none';
  const _bioWrap = document.getElementById('pwd-biometric-wrap');
  if (_bioWrap) _bioWrap.style.display = 'none';
}

async function openPasswordGate(section) {
  _pwdPendingSection = section;
  const cd = window._comercialData;
  const hasComercialPwd = !!(cd && cd.has_password);

  if (section === 'comercial' && !hasComercialPwd) {
    _pwdMode = 'create';
    _pwdSetUI({ title: 'Área Comercial', subtitle: 'Primera vez: crea tu contraseña personal (mín. 6 caracteres).', confirm: true, submitText: 'Crear contraseña' });
  } else {
    _pwdMode = 'verify';
    _pwdSetUI({ title: section === 'admin' ? 'Panel de Administración' : 'Área Comercial', subtitle: 'Introduce la contraseña para continuar.', forgotLink: true });
  }
  // Show gate immediately — before async biometric check
  const gateEl = document.getElementById('pwd-gate');
  if (gateEl) gateEl.classList.add('open');
  setTimeout(() => { const inp = document.getElementById('pwd-input'); if (inp) inp.focus(); }, 80);

  // Async: show biometric button if credential registered and authenticator available
  if (section !== 'comercial' || hasComercialPwd) {
    if (localStorage.getItem('biometric_cred_' + section) && await isBiometricAvailable()) {
      const bioWrap = document.getElementById('pwd-biometric-wrap');
      if (bioWrap) bioWrap.style.display = '';
    }
  }
}

function _openMustChange() {
  _pwdMode = 'must_change';
  _pwdSetUI({ title: 'Crea tu contraseña', subtitle: 'Por seguridad, debes crear tu propia contraseña antes de continuar.', confirm: true, cancelText: false, submitText: 'Guardar contraseña' });
  document.getElementById('pwd-gate').classList.add('open');
  setTimeout(() => document.getElementById('pwd-input').focus(), 80);
}

function openResetGate(token, email, type) {
  _pwdResetToken = token; _pwdResetEmail = email;
  _pwdMode = 'reset'; _pwdPendingSection = type === 'admin' ? 'admin' : 'comercial';
  _pwdSetUI({ title: 'Nueva contraseña', subtitle: 'Crea tu nueva contraseña (mín. 6 caracteres).', confirm: true, cancelText: false, submitText: 'Guardar contraseña' });
  document.getElementById('pwd-gate').classList.add('open');
  setTimeout(() => document.getElementById('pwd-input').focus(), 80);
}

function closePasswordGate() {
  if (_pwdMode === 'must_change' || _pwdMode === 'reset') return; // no se puede cerrar
  document.getElementById('pwd-gate').classList.remove('open');
  const sec = _pwdPendingSection;
  _pwdPendingSection = null;

  // Login directo a admin/comercial (sin participante real detrás): si cancela
  // sin haberse autenticado, no dejar el área principal visible y vacía —
  // volver a la pantalla de login.
  if (_gatedOnlySession && sec && !sessionStorage.getItem('auth_' + sec)) {
    _gatedOnlySession = false;
    esComercialOnly = false;
    participantEmail = '';
    document.getElementById('main-content').style.display = 'none';
    document.getElementById('section-tabs').style.display = 'none';
    document.getElementById('stab-admin').style.display = 'none';
    document.getElementById('stab-comercial').style.display = 'none';
    document.getElementById('login-gate').style.display = 'flex';
    const emailInput = document.getElementById('login-email');
    const errEl = document.getElementById('login-err');
    if (errEl) errEl.style.display = 'none';
    if (emailInput) { emailInput.value = ''; emailInput.focus(); }
    return;
  }

  document.querySelectorAll('.stab').forEach(b =>
    b.classList.toggle('active', b.dataset.section === _pwdPrevSection)
  );
}

// ── BIOMETRIC AUTH (WebAuthn) ──────────────────────────────────────────────────
async function isBiometricAvailable() {
  try {
    return !!(window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch(e) { return false; }
}

async function registerBiometric(section, email) {
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Victory RMF Clinics', id: location.hostname },
        user: {
          id: new TextEncoder().encode(email || section),
          name: email || section,
          displayName: section === 'admin' ? 'Administrador' : 'Comercial'
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },   // ES256
          { alg: -257, type: 'public-key' }   // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'discouraged'
        },
        timeout: 60000
      }
    });
    const credId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
    localStorage.setItem('biometric_cred_' + section, credId);
    return true;
  } catch(e) { return false; }
}

async function loginWithBiometric() {
  const btn = document.getElementById('pwd-bio-btn');
  const label = document.getElementById('pwd-bio-label');
  const errEl = document.getElementById('pwd-err');
  errEl.textContent = '';
  btn.disabled = true;
  const origLabel = label.textContent;
  label.textContent = 'Verificando…';
  try {
    const storedId = localStorage.getItem('biometric_cred_' + _pwdPendingSection);
    const rawId = atob(storedId);
    const credIdBytes = Uint8Array.from(rawId, c => c.charCodeAt(0));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: credIdBytes.buffer }],
        userVerification: 'required',
        timeout: 60000
      }
    });
    if (assertion) {
      const sec = _pwdPendingSection;
      if (sec === 'admin') {
        // Face ID solo prueba identidad local, no renueva el token del servidor.
        // Verificamos aquí si el token guardado sigue vivo antes de dar acceso.
        const tokenActual = sessionStorage.getItem('admin_token') || '';
        let tokenValido = false;
        if (tokenActual) {
          try {
            const check = await fetch(APPS_SCRIPT_URL + '?action=admin_acceso&token=' + encodeURIComponent(tokenActual) + '&_t=' + Date.now(), { redirect: 'follow' }).then(r => r.json());
            tokenValido = Array.isArray(check);
          } catch (_) { tokenValido = false; }
        }
        if (!tokenValido) {
          errEl.textContent = 'Tu sesión expiró. Ingresa tu contraseña para continuar.';
          btn.disabled = false;
          label.textContent = origLabel;
          return;
        }
        adminSessionToken = tokenActual;
      }
      sessionStorage.setItem('auth_' + sec, '1');
      document.getElementById('pwd-gate').classList.remove('open');
      _pwdPendingSection = null;
      switchSection(sec);
    }
  } catch(e) {
    if (e.name === 'NotAllowedError') {
      errEl.textContent = 'Autenticación cancelada.';
    } else {
      localStorage.removeItem('biometric_cred_' + _pwdPendingSection);
      document.getElementById('pwd-biometric-wrap').style.display = 'none';
      errEl.textContent = 'Biométrico no disponible. Usa tu contraseña.';
    }
    btn.disabled = false;
    label.textContent = origLabel;
  }
}

function _isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

async function _offerBiometric(section, proceedFn) {
  _bioSection = section;
  if (!_isMobileDevice()) { proceedFn(); return; }
  const available = await isBiometricAvailable();
  if (!available || localStorage.getItem('biometric_cred_' + section) || _bioOfferShownThisSession) {
    proceedFn();
    return;
  }
  _bioOfferShownThisSession = true;
  _pendingBioCallback = proceedFn;
  // Transform modal into biometric offer screen
  document.getElementById('pwd-form').style.display = 'none';
  document.getElementById('pwd-forgot-form').style.display = 'none';
  document.getElementById('pwd-biometric-wrap').style.display = 'none';
  document.getElementById('pwd-biometric-offer').style.display = '';
  document.getElementById('pwd-title').textContent = 'Acceso más rápido';
  document.getElementById('pwd-subtitle').textContent = 'Activa Face ID / huella para entrar sin contraseña.';
}

async function _activateBiometric() {
  const offerEl = document.getElementById('pwd-biometric-offer');
  const inner = offerEl.querySelector('.pwd-offer');
  inner.innerHTML = '<p style="text-align:center;margin:0;color:var(--navy)">Verifica tu identidad…</p>';
  const email = _bioSection === 'comercial' ? (participantEmail || '') : '';
  const ok = await registerBiometric(_bioSection, email);
  if (ok) {
    inner.innerHTML = '<p style="text-align:center;margin:0;color:#16a34a;font-weight:600">✓ Activado correctamente</p>';
  } else {
    inner.innerHTML = '<p style="text-align:center;margin:0;color:#dc2626">No se pudo activar. Inténtalo más tarde.</p>';
  }
  setTimeout(() => {
    offerEl.style.display = 'none';
    document.getElementById('pwd-gate').classList.remove('open');
    if (_pendingBioCallback) { _pendingBioCallback(); _pendingBioCallback = null; }
  }, ok ? 1200 : 1800);
}

function _declineBiometric() {
  document.getElementById('pwd-biometric-offer').style.display = 'none';
  document.getElementById('pwd-gate').classList.remove('open');
  if (_pendingBioCallback) { _pendingBioCallback(); _pendingBioCallback = null; }
}

function showForgotPassword() {
  document.getElementById('pwd-form').style.display = 'none';
  document.getElementById('pwd-biometric-wrap').style.display = 'none';
  document.getElementById('pwd-forgot-form').style.display = '';
  document.getElementById('pwd-forgot-email').value = '';
  document.getElementById('pwd-forgot-err').textContent = '';
  const isAdmin = _pwdPendingSection === 'admin';
  document.getElementById('pwd-title').textContent = isAdmin ? 'Recuperar acceso admin' : 'Recuperar contraseña';
  document.getElementById('pwd-subtitle').textContent = 'Te enviaremos un enlace para restablecerla.';
  setTimeout(() => document.getElementById('pwd-forgot-email').focus(), 60);
}

function hideForgotPassword() {
  document.getElementById('pwd-forgot-form').style.display = 'none';
  document.getElementById('pwd-form').style.display = '';
  const isAdmin = _pwdPendingSection === 'admin';
  document.getElementById('pwd-title').textContent = isAdmin ? 'Panel de Administración' : 'Área Comercial';
  document.getElementById('pwd-subtitle').textContent = 'Introduce la contraseña para continuar.';
  // Restore biometric button if credential was registered
  if (localStorage.getItem('biometric_cred_' + _pwdPendingSection)) {
    isBiometricAvailable().then(ok => {
      if (ok) document.getElementById('pwd-biometric-wrap').style.display = '';
    });
  }
}

async function submitForgotPassword() {
  const email = document.getElementById('pwd-forgot-email').value.trim();
  const errEl = document.getElementById('pwd-forgot-err');
  const btn = document.getElementById('pwd-forgot-btn');
  errEl.style.color = '#dc2626'; errEl.textContent = '';
  if (!email || !email.includes('@')) { errEl.textContent = 'Introduce un correo válido.'; return; }
  btn.textContent = 'Enviando…'; btn.disabled = true;
  try {
    const resetUrl = location.origin + location.pathname;
    const action = _pwdPendingSection === 'admin' ? 'forgot_admin_password' : 'forgot_comercial_password';
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action, email, reset_url: resetUrl }),
      redirect: 'follow'
    });
    errEl.style.color = '#16a34a';
    errEl.textContent = 'Si el correo está registrado, recibirás el enlace en unos minutos.';
    btn.textContent = 'Enviado ✓'; // No re-enable — one send per open
  } catch(e) { errEl.textContent = 'Error de conexión. Inténtalo de nuevo.'; btn.textContent = 'Enviar enlace'; btn.disabled = false; }
}

async function submitPasswordGate() {
  const val = document.getElementById('pwd-input').value.trim();
  const errEl = document.getElementById('pwd-err');
  const submitBtn = document.getElementById('pwd-submit-btn');
  errEl.textContent = '';
  if (!val) { errEl.textContent = 'Introduce una contraseña.'; return; }

  // ── Modos con confirmación (create / must_change / reset) ──
  if (_pwdMode === 'create' || _pwdMode === 'must_change' || _pwdMode === 'reset') {
    const confirm = document.getElementById('pwd-confirm').value.trim();
    if (val.length < 6) { errEl.textContent = 'Mínimo 6 caracteres.'; return; }
    if (val !== confirm) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
    const origText = submitBtn.textContent;
    submitBtn.textContent = 'Guardando…'; submitBtn.disabled = true;
    const isAdminSection = _pwdPendingSection === 'admin';
    const email = _pwdMode === 'reset' ? _pwdResetEmail : participantEmail;
    let body;
    if (isAdminSection) {
      body = { action: 'set_admin_password', new_password: val, email };
      if (_pwdMode === 'reset' && _pwdResetToken) body.reset_token = _pwdResetToken;
    } else {
      body = { action: 'set_comercial_password', email, new_password: val };
      if (_pwdMode === 'reset' && _pwdResetToken) body.reset_token = _pwdResetToken;
      if (_pwdMode === 'must_change' && comercialSessionToken) body.token = comercialSessionToken;
    }
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body), redirect: 'follow'
      }).then(r => r.json());
      if (res.ok) {
        if (res.token) {
          if (isAdminSection) { adminSessionToken = res.token; sessionStorage.setItem('admin_token', res.token); }
          else { comercialSessionToken = res.token; sessionStorage.setItem('comercial_token', res.token); }
        }
        if (!isAdminSection && window._comercialData) { window._comercialData.has_password = true; window._comercialData.must_change = false; }
        sessionStorage.setItem('auth_' + (isAdminSection ? 'admin' : 'comercial'), '1');
        if (_pwdMode === 'reset') {
          // Limpiar token de URL y mostrar login normal
          const url = new URL(location.href);
          url.searchParams.delete('reset'); url.searchParams.delete('reset_admin');
          history.replaceState({}, '', url.toString());
          document.getElementById('pwd-gate').classList.remove('open');
          document.getElementById('login-gate').style.display = 'flex';
          return;
        }
        document.getElementById('pwd-gate').classList.remove('open');
        const sec = _pwdPendingSection; _pwdPendingSection = null;
        switchSection(sec);
      } else { errEl.textContent = res.error || 'Error al guardar.'; }
    } catch(e) { errEl.textContent = 'Error de conexión.'; }
    finally { submitBtn.textContent = origText; submitBtn.disabled = false; }
    return;
  }

  // ── Verificar contraseña ──
  if (_pwdPendingSection === 'admin') {
    submitBtn.textContent = 'Verificando…'; submitBtn.disabled = true;
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'check_admin_password', password: val, email: participantEmail }), redirect: 'follow'
      }).then(r => r.json());
      if (res.ok) {
        if (res.token) { adminSessionToken = res.token; sessionStorage.setItem('admin_token', res.token); }
        if (res.must_change) { _openMustChange(); return; }
        sessionStorage.setItem('auth_admin', '1');
        const sec = _pwdPendingSection; _pwdPendingSection = null;
        await _offerBiometric(sec, () => {
          document.getElementById('pwd-gate').classList.remove('open');
          switchSection(sec);
        });
      } else {
        errEl.textContent = res.error || 'Contraseña incorrecta. Inténtalo de nuevo.';
        document.getElementById('pwd-input').value = ''; document.getElementById('pwd-input').focus();
      }
    } catch(e) { errEl.textContent = 'Error de conexión.'; }
    finally { submitBtn.textContent = 'Entrar'; submitBtn.disabled = false; }

  } else if (_pwdPendingSection === 'comercial') {
    submitBtn.textContent = 'Verificando…'; submitBtn.disabled = true;
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'check_comercial_password', email: participantEmail, password: val }), redirect: 'follow'
      }).then(r => r.json());
      if (res.ok) {
        if (res.token) { comercialSessionToken = res.token; sessionStorage.setItem('comercial_token', res.token); }
        if (res.must_change) { _openMustChange(); return; }
        sessionStorage.setItem('auth_comercial', '1');
        const sec = _pwdPendingSection; _pwdPendingSection = null;
        await _offerBiometric(sec, () => {
          document.getElementById('pwd-gate').classList.remove('open');
          switchSection(sec);
        });
      } else {
        errEl.textContent = res.error || 'Contraseña incorrecta. Inténtalo de nuevo.';
        document.getElementById('pwd-input').value = ''; document.getElementById('pwd-input').focus();
      }
    } catch(e) { errEl.textContent = 'Error de conexión.'; }
    finally { submitBtn.textContent = 'Entrar'; submitBtn.disabled = false; }
  }
}

// ── Verificar reset token al cargar la página ─────────────────────────────────
(async function checkResetToken() {
  const params = new URLSearchParams(location.search);
  const token = params.get('reset');
  const adminToken = params.get('reset_admin');
  const activeToken = token || adminToken;
  const isAdminReset = !!adminToken;
  if (!activeToken) return;
  try {
    const typeParam = isAdminReset ? '&type=admin' : '';
    const res = await fetch(
      APPS_SCRIPT_URL + '?action=verify_reset_token&token=' + encodeURIComponent(activeToken) + typeParam + '&_t=' + Date.now(),
      { redirect: 'follow' }
    ).then(r => r.json());
    if (res.valid && res.email) {
      document.getElementById('login-gate').style.display = 'none';
      openResetGate(activeToken, res.email, res.type || (isAdminReset ? 'admin' : 'comercial'));
    } else {
      const hint = document.createElement('p');
      hint.style.cssText = 'color:#dc2626;font-size:13px;margin-top:10px;text-align:center';
      hint.textContent = res.reason === 'expired'
        ? 'El enlace de recuperación ha expirado. Solicita uno nuevo.'
        : 'El enlace de recuperación no es válido.';
      const loginBox = document.querySelector('#login-gate form, #login-gate .login-box');
      if (loginBox) loginBox.appendChild(hint);
      const url = new URL(location.href);
      url.searchParams.delete('reset'); url.searchParams.delete('reset_admin');
      history.replaceState({}, '', url.toString());
    }
  } catch(e) { /* silencioso — se muestra el login normal */ }
})();

// ── SECTION TABS (Fotos / Comunicaciones / Lo que debo saber) ─────────────────
function switchSection(section, noScroll) {
  if ((section === 'admin' || section === 'comercial') && !sessionStorage.getItem('auth_' + section)) {
    _pwdPrevSection = document.querySelector('.stab.active')?.dataset.section || 'proceso';
    openPasswordGate(section);
    return;
  }
  document.querySelectorAll('.stab').forEach(b =>
    b.classList.toggle('active', b.dataset.section === section)
  );
  const stepsRow = document.getElementById('steps-row');
  const stepsWrap = document.getElementById('steps-wrap');
  const stepsDots = document.getElementById('steps-dots');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

  const resumenCard = document.getElementById('datos-resumen-card');
  if (section === 'proceso') {
    stepsRow.style.display = '';
    if (stepsWrap) stepsWrap.style.display = '';
    if (stepsDots) stepsDots.style.display = '';
    if (resumenCard) resumenCard.style.display = '';
    const cur = document.getElementById(curPanel);
    if (cur) { cur.classList.add('active'); if (!noScroll) cur.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } else {
    stepsRow.style.display = 'none';
    if (stepsWrap) stepsWrap.style.display = 'none';
    if (stepsDots) stepsDots.style.display = 'none';
    if (resumenCard) resumenCard.style.display = (section === 'admin' || (section === 'comercial' && esComercialOnly)) ? 'none' : '';
    const el = document.getElementById('panel-' + section);
    if (el) { el.classList.add('active'); if (!noScroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (section === 'fotos' && !fotosLoaded) loadFotos();
    if (section === 'comunicaciones') { clearComunBadge(); if (!comunLoaded) loadComunicaciones(); }
    if (section === 'saber' && !saberLoaded) loadSaber();
    if (section === 'saber') loadClima();
    if (section === 'admin' && !adminLoaded) loadAdmin();
    if (section === 'comercial') renderComercialPanel();
    if (section === 'referidos') renderReferidosPanel();
  }
}

let lbFiles = [];
let lbIndex = 0;

function loadFotos() {
  fotosLoaded = true;
  fetch(APPS_SCRIPT_URL + '?action=fotos', { redirect: 'follow' })
    .then(r => r.json())
    .then(files => {
      const grid = document.getElementById('fotos-grid');
      if (!files || !files.length) {
        grid.innerHTML = '<p style="color:var(--muted)">Las fotos del viaje estarán disponibles pronto.</p>';
        return;
      }
      lbFiles = files;
      document.getElementById('btn-album').style.display = 'flex';
      grid.innerHTML = files.map((f, i) =>
        `<div class="foto-item" onclick="openLightbox(${i})">
          <img src="${f.viewUrl}" alt="${f.name}" loading="lazy">
          <a class="foto-dl-btn" href="https://drive.google.com/uc?export=download&id=${f.id}" target="_blank" rel="noopener" onclick="event.stopPropagation()">⬇ Descargar</a>
        </div>`
      ).join('');
    })
    .catch(err => {
      console.error('loadFotos error:', err);
      document.getElementById('fotos-grid').innerHTML =
        '<p style="color:var(--muted)">No se pudieron cargar las fotos. Revisa tu conexión e intenta de nuevo.</p>';
    });
}

function openLightbox(index) {
  lbIndex = index;
  const f = lbFiles[index];
  document.getElementById('lb-img').src = f.viewUrl;
  document.getElementById('lb-counter').textContent = (index + 1) + ' / ' + lbFiles.length;
  document.getElementById('lb-dl').href = 'https://drive.google.com/uc?export=download&id=' + f.id;
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}

function lbNav(dir) {
  lbIndex = (lbIndex + dir + lbFiles.length) % lbFiles.length;
  const f = lbFiles[lbIndex];
  document.getElementById('lb-img').src = f.viewUrl;
  document.getElementById('lb-counter').textContent = (lbIndex + 1) + ' / ' + lbFiles.length;
  document.getElementById('lb-dl').href = 'https://drive.google.com/uc?export=download&id=' + f.id;
}

document.addEventListener('keydown', e => {
  if (!document.getElementById('lightbox').classList.contains('open')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lbNav(-1);
  if (e.key === 'ArrowRight') lbNav(1);
});

function loadComunicaciones() {
  comunLoaded = true;
  fetch(APPS_SCRIPT_URL + '?action=comunicaciones&email=' + encodeURIComponent(participantEmail || '') + '&programa=' + encodeURIComponent(programKeyActivo), { redirect: 'follow' })
    .then(r => r.json())
    .then(data => {
      const msgs = (data && Array.isArray(data.mensajes)) ? data.mensajes : [];
      const feed = document.getElementById('comun-feed');
      if (!msgs.length) {
        feed.innerHTML = '<p style="color:var(--muted)">No hay comunicados aún. Los mensajes del equipo Victory aparecerán aquí.</p>';
        return;
      }
      feed.innerHTML = msgs.map(m =>
        `<div class="comun-msg">
          <div class="comun-fecha">${escapeHtml(m.fecha)}</div>
          <div class="comun-titulo">${escapeHtml(m.titulo)}</div>
          <div class="comun-body">${escapeHtml(m.mensaje)}</div>
        </div>`
      ).join('');
      if (participantEmail) {
        fetch(APPS_SCRIPT_URL + '?action=marcar_comunicados_vistos&email=' + encodeURIComponent(participantEmail) + '&count=' + msgs.length + '&programa=' + encodeURIComponent(programKeyActivo), { redirect: 'follow' }).catch(() => {});
      }
      clearComunBadge();
    })
    .catch(() => {
      document.getElementById('comun-feed').innerHTML =
        '<p style="color:var(--muted)">No hay comunicados aún.</p>';
    });
}

function checkNuevosComunicados() {
  if (!participantEmail) return;
  fetch(APPS_SCRIPT_URL + '?action=comunicaciones&email=' + encodeURIComponent(participantEmail) + '&programa=' + encodeURIComponent(programKeyActivo), { redirect: 'follow' })
    .then(r => r.json())
    .then(data => {
      const msgs = (data && Array.isArray(data.mensajes)) ? data.mensajes : [];
      const seen = (data && parseInt(data.seen)) || 0;
      if (!msgs.length) return;
      if (msgs.length > seen) {
        showComunBadge(msgs.length - seen);
        showNuevoMensajeModal();
      }
    })
    .catch(() => {});
}

function showNuevoMensajeModal() {
  const modal = document.getElementById('nuevo-mensaje-modal');
  if (modal) modal.classList.add('open');
}

function closeNuevoMensajeModal() {
  const modal = document.getElementById('nuevo-mensaje-modal');
  if (modal) modal.classList.remove('open');
}

function goToNuevoMensaje() {
  closeNuevoMensajeModal();
  switchSection('comunicaciones');
}

function showComunBadge(count) {
  const tab = document.querySelector('.stab[data-section="comunicaciones"]');
  if (!tab) return;
  let badge = tab.querySelector('.stab-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'stab-badge';
    tab.appendChild(badge);
  }
  badge.textContent = count;
}

function clearComunBadge() {
  const tab = document.querySelector('.stab[data-section="comunicaciones"]');
  if (tab) { const b = tab.querySelector('.stab-badge'); if (b) b.remove(); }
}

function loadSaber() {
  saberLoaded = true;
  fetch(APPS_SCRIPT_URL + '?action=saber', { redirect: 'follow' })
    .then(r => r.json())
    .then(files => {
      const list = document.getElementById('saber-list');
      if (!files || !files.length) {
        list.innerHTML = '<p style="color:var(--muted)">La información de viaje estará disponible pronto.</p>';
        return;
      }
      list.innerHTML = files.map(f => {
        const icon = f.mimeType && f.mimeType.includes('pdf') ? '📄'
          : f.mimeType && f.mimeType.includes('image') ? '🖼️'
          : f.mimeType && f.mimeType.includes('video') ? '🎬' : '📎';
        return `<a class="saber-item" href="${f.url}" target="_blank" rel="noopener">${icon} ${f.name}</a>`;
      }).join('');
    })
    .catch(() => {
      document.getElementById('saber-list').innerHTML =
        '<p style="color:var(--muted)">La información de viaje estará disponible pronto.</p>';
    });
}

// ── CLIMA MADRID (Open-Meteo, sin API key) ────────────────────────────────────
let climaLoaded = false;
function wmoIcon(c) {
  if (c === 0) return '☀️';
  if (c <= 3)  return '⛅';
  if (c <= 48) return '🌫️';
  if (c <= 55) return '🌦️';
  if (c <= 67) return '🌧️';
  if (c <= 77) return '🌨️';
  if (c <= 82) return '🌧️';
  return '⛈️';
}
function wmoDesc(c) {
  if (c === 0) return 'Despejado';
  if (c <= 2)  return 'Parcialmente nublado';
  if (c === 3) return 'Nublado';
  if (c <= 48) return 'Niebla';
  if (c <= 55) return 'Llovizna';
  if (c <= 67) return 'Lluvia';
  if (c <= 77) return 'Nieve';
  if (c <= 82) return 'Chubascos';
  return 'Tormenta';
}
function loadClima() {
  if (climaLoaded) return;
  climaLoaded = true;

  // Temperatura actual
  fetch('https://api.open-meteo.com/v1/forecast?latitude=40.4168&longitude=-3.7038&current=temperature_2m,apparent_temperature,relative_humidity_2m,weathercode,windspeed_10m&timezone=Europe%2FMadrid')
    .then(r => r.json())
    .then(d => {
      const c = d.current;
      document.getElementById('madrid-ahora').innerHTML =
        `<span style="font-size:36px;line-height:1">${wmoIcon(c.weathercode)}</span>
         <div>
           <div style="font-size:26px;font-weight:700;color:#fff;line-height:1">${Math.round(c.temperature_2m)}°C</div>
           <div style="font-size:12px;color:rgba(255,255,255,.6);margin-top:3px;">${wmoDesc(c.weathercode)} · Sensación ${Math.round(c.apparent_temperature)}°C · 💧${c.relative_humidity_2m}% · 💨${Math.round(c.windspeed_10m)} km/h</div>
         </div>`;
    })
    .catch(() => {
      document.getElementById('madrid-ahora').innerHTML = '<span style="font-size:13px;color:rgba(255,255,255,.4)">No se pudo cargar la temperatura.</span>';
    });

  // Pronóstico de la ventana de viaje del programa activo (ver CLIMA_DATA).
  renderClimaEstatico_();
  const climaProg = programKeyActivo === 'world_challenge' ? CLIMA_DATA.world_challenge : CLIMA_DATA.clinic;
  fetch('https://api.open-meteo.com/v1/forecast?latitude=40.4168&longitude=-3.7038&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=Europe%2FMadrid&start_date=' + climaProg.forecastStart + '&end_date=' + climaProg.forecastEnd)
    .then(r => r.json())
    .then(d => {
      const el = document.getElementById('madrid-forecast');
      if (!d.daily || !d.daily.time || !d.daily.time.length) {
        el.innerHTML = '<p style="color:var(--muted);font-size:13px;">⏳ El pronóstico exacto estará disponible aproximadamente el <strong>' + climaProg.cutoffTexto + '</strong> (14 días antes del viaje).</p>';
        return;
      }
      const days = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
      el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;">` +
        d.daily.time.map((t, i) => {
          const date = new Date(t + 'T12:00:00');
          const day = days[date.getDay()];
          const dd = date.getDate();
          const mm = date.getMonth() + 1;
          return `<div style="background:#f0f6ff;border-radius:8px;padding:10px 8px;text-align:center;">
            <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">${day} ${dd}/${mm}</div>
            <div style="font-size:22px;margin:4px 0;">${wmoIcon(d.daily.weathercode[i])}</div>
            <div style="font-size:13px;font-weight:700;color:var(--navy);">${Math.round(d.daily.temperature_2m_max[i])}°</div>
            <div style="font-size:11px;color:var(--muted);">${Math.round(d.daily.temperature_2m_min[i])}°</div>
          </div>`;
        }).join('') + `</div>`;
    })
    .catch(() => {
      document.getElementById('madrid-forecast').innerHTML =
        '<p style="color:var(--muted);font-size:13px;">⏳ El pronóstico exacto estará disponible aproximadamente el <strong>' + climaProg.cutoffTexto + '</strong>.</p>';
    });
}

// ── INIT ──────────────────────────────────────────────────────────────────────
// Todo se inicializa en loadParticipant() después del login exitoso.

// ── COMERCIAL PANEL ───────────────────────────────────────────────────────────
function showComercialOnly(data) {
  document.getElementById('login-gate').style.display = 'none';
  document.getElementById('main-content').style.display = 'block';
  document.getElementById('ptabs-container').style.display = 'none';
  document.getElementById('steps-row').style.display = 'none';
  document.getElementById('steps-wrap').style.display = 'none';
  document.getElementById('steps-dots').style.display = 'none';
  document.getElementById('datos-resumen-card').style.display = 'none';
  document.getElementById('welcome-guide').style.display = 'none';
  document.getElementById('dn').textContent = data.nombre;
  document.getElementById('dtipo').textContent = '💼 Comercial';
  document.getElementById('btn-toggle-tiq').style.display = 'none';
  document.getElementById('section-tabs').style.display = 'none';
  esComercialOnly = true;
  window._comercialData = data;
  // Sin esto el countdown ("Faltan Xd Xh...") nunca arrancaba para un login
  // comercial puro — iniciarCountdownViaje() solo se llamaba desde
  // loadParticipant() (participantes) y showAdminOnly(), así que la pastilla
  // se quedaba fija en "Calculando..." indefinidamente. programKeyActivo ya
  // tiene 'clinic' como valor por defecto, así que cuenta hacia ese programa.
  iniciarCountdownViaje();
  if (sessionStorage.getItem('auth_comercial')) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-comercial').classList.add('active');
    renderComercialPanel();
  } else {
    _gatedOnlySession = true;
    openPasswordGate('comercial');
  }
}

let comercialProgramaActivo = null; // 'clinic' | 'world_challenge' — pestaña activa en Mis Comisiones
const COMERCIAL_PROGRAMA_LABEL = { clinic: '🏟️ Clinic 2026', world_challenge: '🏆 World Challenge 2027' };

function selComercialPrograma(p) {
  comercialProgramaActivo = p;
  renderComercialPanel();
}

function renderComercialPanel() {
  const data = window._comercialData;
  if (!data || !data.found) return;
  const jugsAll = data.jugadores || [];
  // Cada comercial puede vender ambos programas con la misma cuenta — se
  // separan en pestañas para no mezclar comisiones de Clinic y World Challenge.
  const programasConDatos = Object.keys(COMERCIAL_PROGRAMA_LABEL).filter(function(p){ return jugsAll.some(function(r){ return r.programa === p; }); });
  if (!comercialProgramaActivo || programasConDatos.indexOf(comercialProgramaActivo) < 0) {
    comercialProgramaActivo = programasConDatos[0] || 'clinic';
  }
  const jugs = jugsAll.filter(function(r){ return r.programa === comercialProgramaActivo; });
  const totalJugs = jugs.reduce(function(s,r){ return s+(r.total||0); }, 0);
  function fmt(n){ return (n||0).toLocaleString('es-CO')+' €'; }
  function statusBadge(e){ var cls=(e||'').toLowerCase().includes('pag')?'com-status-pag':'com-status-pend'; return '<span class="com-status '+cls+'">'+(e||'Pendiente')+'</span>'; }

  var jugSubLabel = jugs.length ? jugs.map(function(r){ return r.jugadores+' jug. × '+fmt(r.comision_jugador); }).join(' · ') : 'Sin jugadores aún';

  var html = '';
  // Pestañas por programa (solo si vende en más de uno)
  if (programasConDatos.length > 1) {
    html += '<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">' + programasConDatos.map(function(p){
      var activo = p === comercialProgramaActivo;
      return '<button onclick="selComercialPrograma(\''+p+'\')" style="padding:8px 18px;border-radius:20px;border:1.5px solid '+(activo?'var(--navy)':'var(--border)')+';background:'+(activo?'var(--navy)':'#fff')+';color:'+(activo?'#fff':'var(--navy)')+';font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s">'+COMERCIAL_PROGRAMA_LABEL[p]+'</button>';
    }).join('') + '</div>';
  }
  // KPI row — los acompañantes no son comisionables, solo se muestran jugadores
  html += '<div class="com-kpi-row">'
    +'<div class="card" style="border:2px solid var(--blue)"><div class="ctitle" style="color:var(--blue)">Jugadores · '+(COMERCIAL_PROGRAMA_LABEL[comercialProgramaActivo]||'')+'</div><div class="com-kpi-val blue">'+fmt(totalJugs)+'</div><div class="com-kpi-label">Total comisiones jugadores</div><div class="com-kpi-sub">'+jugSubLabel+'</div></div>'
    +'</div>';

  // Jugadores detail
  html += '<div class="card" style="margin-bottom:16px"><div class="ctitle">Detalle — Jugadores</div>';
  if (jugs.length) {
    html += '<div class="com-table-wrap"><table class="com-table"><thead><tr><th>Jugadores</th><th>Com./Jugador</th><th>Estado</th><th>Total</th></tr></thead><tbody>';
    jugs.forEach(function(r){
      html += '<tr><td>'+r.jugadores+'</td><td>'+fmt(r.comision_jugador)+'</td><td>'+statusBadge(r.estado)+'</td><td><strong>'+fmt(r.total)+'</strong></td></tr>';
    });
    if (jugs.length > 1) html += '<tr class="com-total-row"><td colspan="3">Total jugadores</td><td>'+fmt(totalJugs)+'</td></tr>';
    html += '</tbody></table></div>';
  } else { html += '<p style="color:var(--muted);font-size:14px">Sin datos de jugadores.</p>'; }
  html += '</div>';

  // Mis jugadores — listado nominal asignado por el admin (pestaña
  // "Comerciales" del panel admin), separado del resumen agregado de arriba.
  var misJugadoresAll = data.misJugadores || [];
  var misJugadores = misJugadoresAll.filter(function(j){ return j.programa === comercialProgramaActivo; });
  html += '<div class="card" style="margin-bottom:16px"><div class="ctitle">Mis jugadores (' + misJugadores.length + ')</div>';
  if (misJugadores.length) {
    // Fecha/edad se calculan una vez y se reutilizan tanto para ordenar como
    // para mostrar la columna — mismo parseFechaNacFront/calcEdadRefFront que
    // ya usa buildCategorias() para el mismo cálculo en el panel admin.
    var misJugadoresConMeta = misJugadores.map(function(j){
      var fObj = parseFechaNacFront(j.fecha_nacimiento || '');
      return {
        j: j,
        colegioKey: normNombre(j.colegio || ''),
        fnDisp: fObj ? String(fObj.dia).padStart(2,'0')+'/'+String(fObj.mes).padStart(2,'0')+'/'+fObj.anio : '—',
        sortFecha: fObj ? fObj.anio*10000+fObj.mes*100+fObj.dia : -1,
        edad: calcEdadRefFront(fObj)
      };
    });
    // Colegio (alfabético, sin colegio al final) y luego de menor a mayor
    // edad — fecha de nacimiento más reciente primero (más joven = fecha más
    // reciente), ya que sortFecha crece con la fecha.
    misJugadoresConMeta.sort(function(a,b){
      var aVacio = !a.j.colegio, bVacio = !b.j.colegio;
      if (aVacio !== bVacio) return aVacio ? 1 : -1;
      if (a.colegioKey !== b.colegioKey) return a.colegioKey.localeCompare(b.colegioKey);
      return b.sortFecha - a.sortFecha;
    });

    // Cuadros de referencia: cuántos jugadores asignados hay por colegio.
    var colegioCounts = {};
    misJugadoresConMeta.forEach(function(m){
      var label = m.j.colegio || 'Sin colegio';
      colegioCounts[label] = (colegioCounts[label]||0) + 1;
    });
    var colegiosOrdenados = Object.keys(colegioCounts).sort(function(a,b){
      if (a === 'Sin colegio') return 1;
      if (b === 'Sin colegio') return -1;
      return normNombre(a).localeCompare(normNombre(b));
    });
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">' + colegiosOrdenados.map(function(col){
      return '<div style="background:var(--off,#f4f7fb);border:1px solid var(--border);border-radius:8px;padding:8px 14px;min-width:110px">'
        + '<div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px" title="'+escapeHtml(col)+'">'+escapeHtml(col)+'</div>'
        + '<div style="font-size:20px;font-weight:700;color:var(--navy)">'+colegioCounts[col]+'</div>'
        + '</div>';
    }).join('') + '</div>';

    html += '<input type="text" id="com-buscar-jugador" placeholder="🔍 Buscar por nombre o colegio..." oninput="filtrarMisJugadores()" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-family:\'DM Sans\',sans-serif;font-size:13px;margin-bottom:10px;box-sizing:border-box">';
    html += '<div class="com-table-wrap"><table class="com-table"><thead><tr><th>Nombre</th><th>Colegio</th><th>Fecha nac.</th></tr></thead><tbody id="mis-jugadores-tbody">';
    misJugadoresConMeta.forEach(function(m){
      var j = m.j;
      var dataNombre = normNombre(j.nombre || '');
      var dataColegio = m.colegioKey;
      var fechaTexto = m.fnDisp + (m.edad !== null ? ' · ' + m.edad + ' años' : '');
      html += '<tr data-nombre="' + dataNombre + '" data-colegio="' + dataColegio + '"><td>' + j.nombre + '</td><td>' + (j.colegio || '—') + '</td><td>' + fechaTexto + '</td></tr>';
    });
    html += '<tr id="mis-jugadores-sin-resultados" style="display:none"><td colspan="3" style="text-align:center;color:var(--muted)">Sin coincidencias.</td></tr>';
    html += '</tbody></table></div>';
  } else { html += '<p style="color:var(--muted);font-size:14px">Aún no tienes jugadores asignados por nombre.</p>'; }
  html += '</div>';

  // Cambiar contraseña
  html += '<div class="card" style="margin-top:16px">'
    + '<div class="ctitle" style="margin-bottom:4px">Cambiar contraseña</div>'
    + '<p style="font-size:13px;color:var(--muted);margin-bottom:14px">Actualiza la contraseña de acceso a tu área comercial.</p>'
    + '<div style="display:flex;flex-direction:column;gap:8px;max-width:340px">'
    + '<input type="password" id="com-pwd-current" class="pwd-input" placeholder="Contraseña actual" maxlength="50">'
    + '<input type="password" id="com-pwd-new" class="pwd-input" placeholder="Nueva contraseña (mín. 6 caracteres)" maxlength="50">'
    + '<input type="password" id="com-pwd-confirm" class="pwd-input" placeholder="Confirmar nueva contraseña" maxlength="50">'
    + '<div id="com-pwd-err" style="font-size:12px;min-height:16px"></div>'
    + '<button onclick="cambiarPasswordComercial(this)" style="background:var(--navy);color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;font-family:\'DM Sans\',sans-serif;cursor:pointer;align-self:flex-start">Cambiar contraseña</button>'
    + '</div></div>';

  document.getElementById('comercial-content').innerHTML = html;
}

// Filtra en vivo la tabla "Mis jugadores" del área comercial por nombre o
// colegio — coincidencia parcial, sin distinguir mayúsculas/tildes (mismo
// normNombre que usa el resto del panel). Oculta/muestra filas por DOM en
// vez de re-renderizar toda la tabla, para no perder el foco del input
// mientras se escribe.
function filtrarMisJugadores() {
  var q = normNombre((document.getElementById('com-buscar-jugador') || {}).value || '');
  var tbody = document.getElementById('mis-jugadores-tbody');
  if (!tbody) return;
  var visibles = 0;
  tbody.querySelectorAll('tr[data-nombre]').forEach(function(tr) {
    var match = !q || tr.dataset.nombre.indexOf(q) >= 0 || tr.dataset.colegio.indexOf(q) >= 0;
    tr.style.display = match ? '' : 'none';
    if (match) visibles++;
  });
  var sinResultados = document.getElementById('mis-jugadores-sin-resultados');
  if (sinResultados) sinResultados.style.display = visibles ? 'none' : '';
}

async function cambiarPasswordComercial(btn) {
  const current = (document.getElementById('com-pwd-current')?.value || '').trim();
  const newPwd  = (document.getElementById('com-pwd-new')?.value || '').trim();
  const confirm = (document.getElementById('com-pwd-confirm')?.value || '').trim();
  const errEl   = document.getElementById('com-pwd-err');
  errEl.style.color = '#dc2626'; errEl.textContent = '';
  if (!current) { errEl.textContent = 'Introduce la contraseña actual.'; return; }
  if (newPwd.length < 6) { errEl.textContent = 'Mínimo 6 caracteres.'; return; }
  if (newPwd !== confirm) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
  const origText = btn.textContent;
  btn.textContent = 'Guardando…'; btn.disabled = true;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'set_comercial_password', email: participantEmail, new_password: newPwd, current_password: current, token: comercialSessionToken }),
      redirect: 'follow'
    }).then(r => r.json());
    if (res.ok) {
      if (res.token) { comercialSessionToken = res.token; sessionStorage.setItem('comercial_token', res.token); }
      sessionStorage.setItem('auth_comercial', '1');
      errEl.style.color = '#16a34a';
      errEl.textContent = 'Contraseña actualizada correctamente.';
      document.getElementById('com-pwd-current').value = '';
      document.getElementById('com-pwd-new').value = '';
      document.getElementById('com-pwd-confirm').value = '';
    } else { errEl.textContent = res.error || 'Error al guardar.'; }
  } catch(e) { errEl.textContent = 'Error de conexión.'; }
  finally { btn.textContent = origText; btn.disabled = false; }
}

async function cambiarPasswordAdmin(btn) {
  const current = (document.getElementById('admin-pwd-current')?.value || '').trim();
  const newPwd  = (document.getElementById('admin-pwd-new')?.value || '').trim();
  const confirm = (document.getElementById('admin-pwd-confirm')?.value || '').trim();
  const errEl   = document.getElementById('admin-pwd-err');
  errEl.style.color = '#dc2626'; errEl.textContent = '';
  if (!current) { errEl.textContent = 'Introduce la contraseña actual.'; return; }
  if (newPwd.length < 6) { errEl.textContent = 'Mínimo 6 caracteres.'; return; }
  if (newPwd !== confirm) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
  const origText = btn.textContent;
  btn.textContent = 'Guardando…'; btn.disabled = true;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'set_admin_password', current_password: current, new_password: newPwd }),
      redirect: 'follow'
    }).then(r => r.json());
    if (res.ok) {
      sessionStorage.removeItem('auth_admin'); // Próxima vez pedirá la nueva
      errEl.style.color = '#16a34a';
      errEl.textContent = 'Contraseña actualizada. Se pedirá la nueva la próxima vez que accedas.';
      document.getElementById('admin-pwd-current').value = '';
      document.getElementById('admin-pwd-new').value = '';
      document.getElementById('admin-pwd-confirm').value = '';
    } else { errEl.textContent = res.error || 'Error al guardar.'; }
  } catch(e) { errEl.textContent = 'Error de conexión.'; }
  finally { btn.textContent = origText; btn.disabled = false; }
}

// ── ADMIN PANEL ───────────────────────────────────────────────────────────────
function showStaffView() {
  document.getElementById('welcome-guide').style.display = 'none';
  const tiqBtn = document.getElementById('btn-toggle-tiq');
  if (tiqBtn) tiqBtn.style.display = 'none';
  // Ocultar docs que no aplican a staff
  const permisoDoc = document.getElementById('permiso-doc');
  if (permisoDoc) permisoDoc.style.display = 'none';
  const registroDoc = document.getElementById('registro-civil-doc');
  if (registroDoc) registroDoc.style.display = 'none';
  const tcDocItem = document.getElementById('tc-doc-item');
  if (tcDocItem) tcDocItem.style.display = 'none';
  // Marcar pasos omitidos como completados y saltar a Documentación
  STEP_DEFS.forEach(s => { if (s.skipForStaff) s.done = true; });
  const idxDocs = STEP_DEFS.findIndex(s => s.panel === 'panel4');
  if (idxDocs > -1) STEP_DEFS[idxDocs].done = false;
  document.getElementById('section-tabs').style.display = 'flex';
  checkNuevosComunicados();
  actualizarPaso(6);
  goPanel('panel4');
}

function showAdminOnly() {
  document.getElementById('login-gate').style.display = 'none';
  document.getElementById('main-content').style.display = 'block';
  document.getElementById('ptabs-container').style.display = 'none';
  document.getElementById('steps-row').style.display = 'none';
  document.getElementById('steps-wrap').style.display = 'none';
  document.getElementById('steps-dots').style.display = 'none';
  document.getElementById('datos-resumen-card').style.display = 'none';
  document.getElementById('dn').textContent = 'Admin';
  iniciarCountdownViaje();
  document.getElementById('section-tabs').style.display = 'flex';
  document.getElementById('stab-admin').style.display = '';
  // Mostrar proceso vacío por defecto — el password gate se dispara al pulsar el tab admin
  document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.section === 'proceso'));
  _pwdPrevSection = 'proceso';
  _gatedOnlySession = true;
  openPasswordGate('admin');
}

let adminFinData = null;
let adminCurrency = 'eur';
let adminAccesoList = [];

function isEditAdmin() {
  if (participantEmail === SUPER_ADMIN) return true;
  return adminAccesoList.some(a => a.email === participantEmail && a.rol === 'editar');
}

function adminSection(section) {
  document.querySelectorAll('.asnav-btn').forEach(b => b.classList.toggle('active', b.dataset.asec === section));
  document.querySelectorAll('[id^="admin-sec-"]').forEach(el => el.style.display = 'none');
  const el = document.getElementById('admin-sec-' + section);
  if (el) el.style.display = '';
  // Render con datos actuales inmediatamente
  if (section === 'pagos' && adminFinData) { renderAdminPagos(adminFinData); reapplyPagosFilter(); }
  if (section === 'comisiones' && adminFinData) renderAdminComisiones(adminFinData);
  if (section === 'participantes' && adminData && adminData.length) { renderParticipantesKPIs(adminData); filterAdminTable(); }
  // Recargas específicas por sección
  if (section === 'comunicados') loadAdminComunicados();
  if (section === 'acceso') loadAdminAcceso();
  if (section === 'categorias') loadAdminCategorias();
  if (section === 'galeria') loadAdminFotos();
  if (section === 'comerciales') loadAdminComerciales();
  if (section === 'analytics') {
    const iframe = document.getElementById('analytics-iframe');
    if (iframe && !iframe.src) iframe.src = 'analytics-dashboard.html?token=' + encodeURIComponent(adminSessionToken);
  }
  // Pagos y Dashboard siempre re-fetch al entrar (ediciones directas en Sheet deben reflejarse)
  // Otras secciones: cooldown de 30s
  if (section === 'pagos' || section === 'dashboard') {
    loadAdmin(true);
  } else {
    const DATA_SECTIONS = ['participantes', 'comisiones'];
    if (DATA_SECTIONS.includes(section) && Date.now() - adminLastLoaded > 30000) {
      loadAdmin(true);
    }
  }
}

function mostrarErrorAdmin(detalles, esSesionExpirada) {
  let banner = document.getElementById('admin-error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'admin-error-banner';
    banner.style.cssText = 'background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:13px;color:#991b1b';
    const contenedor = document.getElementById('admin-sec-dashboard');
    if (contenedor) contenedor.prepend(banner);
  }
  const detalleTexto = (detalles || []).filter(Boolean).join(' · ');
  const mensaje = esSesionExpirada ? '🔒 Tu sesión de administrador expiró (dura 12 horas).' : '⚠️ No se pudo cargar la información.';
  const boton = esSesionExpirada
    ? `<button onclick="document.getElementById('admin-error-banner').style.display='none';openPasswordGate('admin');" style="padding:7px 14px;border:1px solid #dc2626;background:#fff;color:#dc2626;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;font-family:'DM Sans',sans-serif;">Volver a iniciar sesión</button>`
    : `<button onclick="loadAdmin(true)" style="padding:7px 14px;border:1px solid #dc2626;background:#fff;color:#dc2626;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;font-family:'DM Sans',sans-serif;">↻ Reintentar</button>`;
  banner.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px">
      <span>${mensaje}</span>
      ${boton}
    </div>
    <div style="font-family:monospace;font-size:11px;color:#7f1d1d;background:#fff;border-radius:6px;padding:8px;word-break:break-word;user-select:text">${detalleTexto || 'Sin detalle disponible'}</div>
  `;
  banner.style.display = 'block';
}

function ocultarErrorAdmin() {
  const banner = document.getElementById('admin-error-banner');
  if (banner) banner.style.display = 'none';
}

// Cambia qué programa ve el admin (Clinic / World Challenge) y refresca todo
// el panel — los datos de un programa nunca se mezclan con los del otro.
function cambiarProgramaAdmin(key) {
  if (adminProgramaActivo === key) return;
  adminProgramaActivo = key;
  document.getElementById('admin-prog-clinic')?.classList.toggle('active', key === 'clinic');
  document.getElementById('admin-prog-wc')?.classList.toggle('active', key === 'world_challenge');
  loadAdmin(true);
  // Invalidar el caché de "Comerciales" siempre, sin importar la pestaña
  // activa — si no, entrar después a esa pestaña mostraría datos del
  // programa anterior (loadAdminComerciales solo re-consulta si el caché
  // está vacío o se le pide force:true explícitamente).
  adminComercialesData = null;
  comercialAsignacionActivo = null;
  if ((document.querySelector('.asnav-btn.active') || {}).dataset?.asec === 'comerciales') {
    loadAdminComerciales(true);
  }
}

function loadAdmin(force, intento) {
  intento = intento || 1;
  if (adminLoaded && !force) return;
  document.getElementById('kpi-participantes').textContent = '…';
  ocultarErrorAdmin();
  const t = Date.now();
  const progQS = '&programa=' + encodeURIComponent(adminProgramaActivo);
  let errorParticipantes = null, errorFinanciero = null, errorAcceso = null;
  let sesionExpirada = false;
  Promise.all([
    fetch(APPS_SCRIPT_URL + '?action=admin_participantes&token=' + encodeURIComponent(adminSessionToken) + progQS + '&_t=' + t, { redirect: 'follow' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { errorParticipantes = e.message || String(e); return []; }),
    fetch(APPS_SCRIPT_URL + '?action=admin_financiero&token=' + encodeURIComponent(adminSessionToken) + progQS + '&_t=' + t, { redirect: 'follow' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { errorFinanciero = e.message || String(e); return null; }),
    fetch(APPS_SCRIPT_URL + '?action=admin_acceso&token=' + encodeURIComponent(adminSessionToken) + '&_t=' + t, { redirect: 'follow' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { errorAcceso = e.message || String(e); return []; })
  ])
  .then(([parts, fin, acceso]) => {
    [parts, fin, acceso].forEach(r => {
      if (r && !Array.isArray(r) && r.error) {
        sesionExpirada = true;
        if (!errorParticipantes && !errorFinanciero && !errorAcceso) {
          errorParticipantes = errorFinanciero = errorAcceso = r.error;
        }
      }
    });

    if (sesionExpirada) {
      adminLoaded = false;
      sessionStorage.removeItem('admin_token');
      sessionStorage.removeItem('auth_admin');
      adminSessionToken = '';
      mostrarErrorAdmin(['Tu sesión de administrador expiró.'], true);
      document.getElementById('kpi-participantes').textContent = 'Sesión expirada';
      return;
    }

    const todoFallo = errorParticipantes && errorFinanciero && errorAcceso;
    if (todoFallo) {
      if (intento < 2) {
        setTimeout(() => loadAdmin(true, intento + 1), 1500);
        return;
      }
      adminLoaded = false;
      mostrarErrorAdmin([errorParticipantes, errorFinanciero, errorAcceso], false);
      document.getElementById('kpi-participantes').textContent = 'Error';
      return;
    }

    adminLoaded = true;
    adminData = Array.isArray(parts) ? parts : [];
    adminFinData = fin && !fin.error ? fin : null;
    adminAccesoList = Array.isArray(acceso) ? acceso : [];
    adminLastLoaded = Date.now();
    cargarAlianzasCatalogo();
    renderAdminDashboard(adminData, adminFinData);
    filterAdminTable();
    renderParticipantesKPIs(adminData);
    applyAdminPermissions();
    const stabAcceso = document.getElementById('stab-acceso');
    if (stabAcceso) stabAcceso.style.display = participantEmail === SUPER_ADMIN ? '' : 'none';
    actualizarBadgePagosPendientes(adminFinData);
    const activeAsec = (document.querySelector('.asnav-btn.active') || {}).dataset?.asec;
    if (activeAsec === 'pagos' && adminFinData) { renderAdminPagos(adminFinData); reapplyPagosFilter(); }
    if (activeAsec === 'comisiones' && adminFinData) renderAdminComisiones(adminFinData);
  })
  .catch(err => {
    console.error('loadAdmin error:', err);
    adminLoaded = false;
    mostrarErrorAdmin([err.message || String(err)], false);
    document.getElementById('kpi-participantes').textContent = 'Error';
  });
}

function syncPaqueteModal(val) {
  ['pago-reserva-paquete', 'pago-tiquete-paquete', 'pago-pago-final-paquete'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
}

function refreshAdminPagos(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '↻ Cargando…'; }
  const t = Date.now();
  fetch(APPS_SCRIPT_URL + '?action=admin_financiero&token=' + encodeURIComponent(adminSessionToken) + '&programa=' + encodeURIComponent(adminProgramaActivo) + '&_t=' + t, { redirect: 'follow' })
    .then(r => r.json())
    .then(fin => {
      if (fin && !fin.error) {
        adminFinData = fin;
        adminLastLoaded = Date.now();
        renderAdminPagos(adminFinData);
        reapplyPagosFilter();
        if (typeof renderAdminDashboard === 'function') renderAdminDashboard(adminData, adminFinData);
      }
    })
    .catch(err => console.error('refreshAdminPagos error:', err))
    .finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Actualizar'; }
    });
}

function applyAdminPermissions() {
  const canEdit = isEditAdmin();
  // Galería — deshabilitar zona de subida si no puede editar
  const dropZone = document.getElementById('foto-drop-zone');
  if (dropZone) {
    if (!canEdit) {
      dropZone.style.pointerEvents = 'none';
      dropZone.style.opacity = '.45';
      dropZone.title = 'Solo el administrador con permisos de edición puede subir fotos.';
    } else {
      dropZone.style.pointerEvents = '';
      dropZone.style.opacity = '';
    }
  }
  // Comunicados — formulario de publicación
  const comunTitulo = document.getElementById('comun-titulo-input');
  const comunMensaje = document.getElementById('comun-mensaje-input');
  const comunBtn = document.querySelector('[onclick="adminPublicarComunicado()"]');
  if (!canEdit) {
    if (comunTitulo) comunTitulo.disabled = true;
    if (comunMensaje) comunMensaje.disabled = true;
    if (comunBtn) { comunBtn.disabled = true; comunBtn.style.opacity = '.45'; comunBtn.title = 'Solo lectura.'; }
  }
}

const TASA_EUR_COP = 4350;

function fmtEur(n) { return (n||0).toLocaleString('es-CO') + ' €'; }
function fmtCop(n) { return '$ ' + Math.round((n||0) * TASA_EUR_COP).toLocaleString('es-CO'); }
function fmtVal(n) { return adminCurrency === 'eur' ? fmtEur(n) : fmtCop(n); }

function toggleCurrency(c) {
  adminCurrency = c;
  document.getElementById('toggle-eur').classList.toggle('active', c === 'eur');
  document.getElementById('toggle-cop').classList.toggle('active', c === 'cop');
  if (adminFinData) renderRecaudacion(adminFinData);
}

function statusChip(estado) {
  const s = (estado || '').toLowerCase();
  if (!s || s === 'sin pago' || s === 'pendiente') return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;background:#f1f5f9;color:var(--muted)">Sin pago</span>`;
  if (s === 'pendiente de confirmar') return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(30,91,168,.12);color:var(--blue)">⏳ Pendiente de confirmar</span>`;
  if (s === 'completo' || s === 'pagado') return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(22,101,52,.12);color:#166534">${escapeHtml(estado)}</span>`;
  if (s === 'parcial' || s === 'abono') return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(217,119,6,.12);color:#92400e">${escapeHtml(estado)}</span>`;
  return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(239,68,68,.1);color:#991b1b">${escapeHtml(estado)}</span>`;
}

// Badge de verificación IA — solo tiene sentido mostrarlo junto a "Pendiente de
// confirmar" (una vez el admin marca Completo/Parcial, la verificación IA ya
// cumplió su propósito y no aporta más). Muestra visiblemente el monto esperado
// y el detalle de la IA (qué detectó y, si aplica, por qué quedó en "revisar").
function iaBadge(status, detalle, eurEsperado, copEsperado) {
  const s = (status || '').toLowerCase();
  if (!s) return '';
  const cfg = s === 'coincide'
    ? { bg: 'rgba(22,101,52,.12)', color: '#166534', icon: '✓', label: 'IA: coincide' }
    : s === 'revisar'
    ? { bg: 'rgba(217,119,6,.12)', color: '#92400e', icon: '⚠', label: 'IA: revisar' }
    : { bg: '#f1f5f9', color: 'var(--muted)', icon: '—', label: 'IA: manual' };
  const partesEsperado = [];
  if (eurEsperado) partesEsperado.push(eurEsperado.toLocaleString('es-CO') + ' €');
  if (copEsperado) partesEsperado.push(copEsperado.toLocaleString('es-CO') + ' COP');
  const esperadoLine = partesEsperado.length
    ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">Esperado: ${partesEsperado.join(' / ')}</div>`
    : '';
  const detalleLine = detalle
    ? `<div style="font-size:10px;color:${cfg.color};margin-top:2px;font-weight:500">${escapeHtml(detalle)}</div>`
    : '';
  return `<div style="display:inline-block;margin-top:3px;padding:4px 8px;border-radius:8px;background:var(--off);border-left:3px solid ${cfg.color}">
    <span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${cfg.bg};color:${cfg.color}">${cfg.icon} ${cfg.label}</span>
    ${esperadoLine}
    ${detalleLine}
  </div>`;
}

let _iaTipCounter = 0;
// Versión compacta de iaBadge() para usar en tablas: solo el chip con el
// ícono/label, y el detalle completo (esperado/detectado) va en un tooltip
// que se muestra al pasar el cursor (desktop) o al tocar (móvil).
function iaBadgeCompacto(status, detalle, eurEsperado, copEsperado) {
  const s = (status || '').toLowerCase();
  if (!s) return '';
  const cfg = s === 'coincide'
    ? { bg: 'rgba(22,101,52,.12)', color: '#166534', icon: '✓', label: 'Coincide' }
    : s === 'revisar'
    ? { bg: 'rgba(217,119,6,.12)', color: '#92400e', icon: '⚠', label: 'Revisar' }
    : { bg: '#f1f5f9', color: 'var(--muted)', icon: '—', label: 'Manual' };
  const tipId = 'iatip-' + (_iaTipCounter++);
  const partesEsperado = [];
  if (eurEsperado) partesEsperado.push(eurEsperado.toLocaleString('es-CO') + ' €');
  if (copEsperado) partesEsperado.push(copEsperado.toLocaleString('es-CO') + ' COP');
  const esperadoLine = partesEsperado.length ? `Esperado: ${partesEsperado.join(' / ')}` : '';
  const detalleLine = detalle ? escapeHtml(detalle) : '';
  return `<span class="ia-chip-compacto" style="background:${cfg.bg};color:${cfg.color}" onclick="toggleIaTip(event,'${tipId}')">
    ${cfg.icon} ${cfg.label}
    <span class="ia-tip" id="${tipId}">${esperadoLine}${esperadoLine && detalleLine ? '<br>' : ''}${detalleLine}</span>
  </span>`;
}

function toggleIaTip(event, tipId) {
  event.stopPropagation();
  document.querySelectorAll('.ia-tip.show').forEach(el => { if (el.id !== tipId) el.classList.remove('show'); });
  const el = document.getElementById(tipId);
  if (el) el.classList.toggle('show');
}
document.addEventListener('click', () => {
  document.querySelectorAll('.ia-tip.show').forEach(el => el.classList.remove('show'));
});

// Parsea "dd/mm/yyyy:eur:cop:metodo;dd/mm/yyyy:eur:cop:metodo;..." (mismo
// formato que genera el backend) para mostrar el resumen de abonos en el
// modal. `metodo` es el 4to campo, opcional (entradas viejas no lo traen) —
// permite que cada abono tenga su propio método (ej. primero transferencia,
// luego un segundo abono con tarjeta para el mismo concepto).
function parseHistorialAbonosFrontend_(str) {
  if (!str) return [];
  return String(str).split(';').map(s => {
    const p = s.trim().split(':');
    if (p.length < 2) return null;
    return { fecha: p[0], eur: parseFloat(p[1]) || 0, cop: parseFloat(p[2]) || 0, metodo: p[3] || '' };
  }).filter(Boolean);
}

// Monto EUR esperado para un concepto (Reserva/Tiquete/Pago Final) según el
// tipo de participante — mismas reglas que calcPaymentTotals(), pero para UN
// solo participante (el modal admin trabaja participante por participante,
// no por grupo).
function montoEsperadoEur_(tipo, n) {
  const esWC = (n.program_key || adminProgramaActivo) === 'world_challenge';
  if (tipo === 'Reserva') return montoReservaFinalParticipante_(n, esWC).reserva;
  if (tipo === 'Tiquete') {
    if (n.tiquete_aereo !== 'Con tiquete') return 0;
    return esWC ? TIQUETE_EUR_WC : TIQUETE_EUR;
  }
  if (tipo === 'Pago Final') return montoReservaFinalParticipante_(n, esWC).final;
  return 0;
}

// Al escribir el Valor EUR de un pago editable, decide automáticamente si el
// estado debe quedar en "Completo" (el monto alcanza el total esperado, con
// un margen de ±1 EUR por redondeos, o lo supera) o "Parcial" — así el admin
// no tiene que elegir el estado a mano antes de guardar.
function actualizarEstadoAuto_(tid, montoEsperado) {
  if (!montoEsperado || montoEsperado <= 0) return;
  const eurEl = document.getElementById(`pago-${tid}-eur`);
  const estadoEl = document.getElementById(`pago-${tid}-estado`);
  if (!eurEl || !estadoEl) return;
  const eur = parseFloat(eurEl.value) || 0;
  if (eur <= 0) return;
  estadoEl.value = (eur > montoEsperado || Math.abs(eur - montoEsperado) <= 1) ? 'Completo' : 'Parcial';
}

function renderAdminDashboard(rows, fin) {
  const valid = rows.filter(r => { const n = normalizeParticipant(r) || {}; return n.nombre || n.email || r['2'] || r['3']; });
  const total = valid.length;
  const jugadores = valid.filter(r => { const n = normalizeParticipant(r) || {}; return (n.tipo || '').toLowerCase().includes('jug'); }).length;
  const staffCount = valid.filter(r => { const n = normalizeParticipant(r) || {}; return (n.tipo || '').toLowerCase().includes('staff'); }).length;
  const acomp = total - jugadores - staffCount;
  const conTiquete = valid.filter(r => { const n = normalizeParticipant(r) || {}; return (n.tiquete_aereo || '').toLowerCase().includes('con'); }).length;
  const paso7 = valid.filter(r => { const n = normalizeParticipant(r) || {}; return parseInt(n.paso_actual || 1) >= 7; }).length;
  const pasoCount = {};
  valid.forEach(r => { const n = normalizeParticipant(r) || {}; const p = parseInt(n.paso_actual || 1) || 1; pasoCount[p] = (pasoCount[p] || 0) + 1; });

  // KPI cards — use financial data if available, otherwise calculate from participants
  const kpis = fin && fin.kpis && fin.kpis.participantes ? fin.kpis : null;
  const recibidos = fin && fin.pagos_recibidos ? fin.pagos_recibidos : {};
  const ingresos = kpis ? kpis.ingresos : 0;
  const costos = kpis ? kpis.costos : 0;
  const beneficio = kpis ? kpis.beneficio : 0;
  const margen = kpis ? (typeof kpis.margen === 'number' && kpis.margen <= 1 ? kpis.margen : kpis.margen / 100) : 0;
  const margenPct = kpis ? Math.round(margen * 100) : 0;
  const totalComisiones = fin && Array.isArray(fin.comisiones) ? fin.comisiones.reduce((s, c) => s + (c.total || 0), 0) : 0;
  const comisionesPendientes = fin && Array.isArray(fin.comisiones) ? fin.comisiones.filter(c => (c.estado||'').toLowerCase() === 'pendiente').reduce((s, c) => s + (c.total || 0), 0) : 0;
  const pctCostos = ingresos > 0 ? Math.round(costos / ingresos * 100) : 0;

  const displayTotal  = kpis && kpis.participantes  ? kpis.participantes  : total;
  const displayJug    = jugadores;
  const displayAcomp  = acomp;
  const displayStaff  = staffCount;

  const recaudado = recibidos.total_eur || 0;
  const pctRec = ingresos > 0 ? Math.min(100, Math.round(recaudado / ingresos * 100)) : 0;

  // Tasa media EUR→COP real calculada de pagos con ambos valores
  const pagosConTasa = (fin && fin.pagos_lista ? fin.pagos_lista : []).filter(p => p.cop > 0 && p.eur > 0);
  const tasaMedia = pagosConTasa.length > 0
    ? Math.round(pagosConTasa.reduce((s, p) => s + p.cop, 0) / pagosConTasa.reduce((s, p) => s + p.eur, 0))
    : 0;

  const totalParticipantes = displayTotal;
  const ingresosBrutos = ingresos || 0;
  const costosTotales = costos || 0;
  const beneficioBruto = beneficio || 0;
  const tasaEurCop = tasaMedia;

  document.getElementById('kpi-participantes').textContent = totalParticipantes;
  const subParts = [displayJug + ' jugadores', displayAcomp + ' acompañantes'];
  if (displayStaff > 0) subParts.push(displayStaff + ' staff');
  document.getElementById('kpi-participantes-sub').textContent = subParts.join(' · ');
  document.getElementById('kpi-con-tiquete').textContent = conTiquete;
  document.getElementById('kpi-sin-tiquete').textContent = total - conTiquete;

  document.getElementById('kpi-ingresos').textContent = ingresosBrutos.toLocaleString('es-ES') + '€';
  document.getElementById('kpi-ingresos-badge').textContent = conTiquete + ' con tiquete';

  document.getElementById('kpi-costos').textContent = costosTotales.toLocaleString('es-ES') + '€';
  const pctCostosKpi = ingresosBrutos > 0 ? Math.round((costosTotales / ingresosBrutos) * 100) : 0;
  document.getElementById('kpi-costos-sub').textContent = pctCostosKpi + '% de ingresos brutos';
  document.getElementById('kpi-costos-badge').textContent = pctCostosKpi + '%';
  document.getElementById('kpi-costos-bar').style.width = pctCostosKpi + '%';

  document.getElementById('kpi-beneficio').textContent = beneficioBruto.toLocaleString('es-ES') + '€';
  const pctMargenKpi = ingresosBrutos > 0 ? Math.round((beneficioBruto / ingresosBrutos) * 100) : 0;
  document.getElementById('kpi-beneficio-badge').textContent = 'Margen ' + pctMargenKpi + '%';
  document.getElementById('kpi-beneficio-bar').style.width = pctMargenKpi + '%';

  document.getElementById('kpi-tasa').textContent = tasaEurCop > 0 ? tasaEurCop.toLocaleString('es-ES') : '—';
  document.getElementById('kpi-tasa-sub').textContent = pagosConTasa.length > 0 ? 'Media de ' + pagosConTasa.length + ' pago' + (pagosConTasa.length > 1 ? 's' : '') + ' con COP' : 'Sin pagos en COP aún';

  // Recaudación bars
  if (ingresos > 0) {
    document.getElementById('admin-recaudacion-card').style.display = '';
    renderRecaudacion(fin);
  }

  // Pasos chart
  const pasoLabels = {1:'Pre-insc.',2:'T&C',3:'Reserva',4:'Tiquete',5:'Pago final',6:'Documentos',7:'Completado'};
  const pasoListEl = document.getElementById('paso-list');
  if (pasoListEl) {
    let pasosHtml = '';
    for (let i = 1; i <= 7; i++) {
      pasosHtml += renderPasoRow('P' + i, pasoLabels[i], pasoCount[i] || 0);
    }
    pasoListEl.innerHTML = pasosHtml;
  }
  const pasoBadge = document.getElementById('paso-total-badge');
  if (pasoBadge) pasoBadge.textContent = total + ' total';

  // Paquetes chart
  const paqListEl = document.getElementById('paq-list');
  const paqColorMap = {
    // Jugadores
    'redcol 1-30': '#1e5ba8', 'redcol 31+': '#16a34a',
    'standard': '#ea580c', 'premium': '#7c3aed',
    // Acompañantes — doble
    'acomp. doble standard': '#0d9488', 'acomp. doble premium': '#0f766e',
    // Acompañantes — sencilla
    'acomp. sencilla standard': '#7c3aed', 'acomp. sencilla premium': '#6d28d9',
    // Acompañantes — actividades
    'acomp. actividades standard': '#ea580c', 'acomp. actividades premium': '#c2410c'
  };
  const paqFallbackColors = ['#1e5ba8','#16a34a','#ea580c','#7c3aed','#0d9488','#7c3aed'];
  if (paqListEl) {
    if (fin && fin.paquetes && fin.paquetes.length) {
      const maxPaqTotal = Math.max(...fin.paquetes.map(p => p.total));
      const totalPaqGlobal = fin.paquetes.reduce((s, p) => s + (p.total || 0), 0);
      paqListEl.innerHTML = fin.paquetes.map((p, i) => {
        const key = (p.nombre || '').toLowerCase().trim();
        const color = paqColorMap[key] || paqFallbackColors[i % 4];
        return renderPaqRow(p.nombre, p.cantidad, p.precio, p.total, color, maxPaqTotal);
      }).join('');
      const paqBadge = document.getElementById('paq-total-badge');
      const paqFooter = document.getElementById('paq-total-footer');
      if (paqBadge) paqBadge.textContent = fin.paquetes.reduce((s,p) => s+(p.cantidad||0), 0) + ' inscritos';
      if (paqFooter) paqFooter.textContent = totalPaqGlobal.toLocaleString('es-ES') + '€';
    } else {
      paqListEl.innerHTML = '<p style="color:var(--muted);padding:16px;font-size:13px">Sin datos de paquetes.</p>';
    }
  }

  // Comisiones resumen
  const comCard = document.getElementById('admin-comisiones-resumen-card');
  if (fin && fin.comisiones && fin.comisiones.length) {
    comCard.style.display = '';
    const jugs = fin.comisiones.filter(c => c.seccion === 'jugadores');
    const acomps = fin.comisiones.filter(c => c.seccion === 'acompanantes');
    let html = '';
    if (jugs.length) {
      html += `<div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Jugadores</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead>
          <tr style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)">
            <th style="padding:8px 0;text-align:left;font-weight:500">Comercial</th>
            <th style="padding:8px 0;text-align:right;font-weight:500">Com./jug.</th>
            <th style="padding:8px 0;text-align:right;font-weight:500">Jugadores</th>
            <th style="padding:8px 0;text-align:right;font-weight:500">Estado</th>
            <th style="padding:8px 0;text-align:right;font-weight:500">Total</th>
          </tr>
        </thead>
        <tbody>
          ${jugs.map(c => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:11px 0;font-weight:500;color:var(--navy)">${c.comercial}</td>
              <td style="padding:11px 0;text-align:right;font-size:13px;color:var(--muted)">${(c.comision_jugador||0).toLocaleString('es-CO')}€</td>
              <td style="padding:11px 0;text-align:right;font-size:13px">${c.jugadores||0}</td>
              <td style="padding:11px 0;text-align:right">${statusChip(c.estado)}</td>
              <td style="padding:11px 0;text-align:right;font-weight:700;color:var(--blue)">${(c.total||0).toLocaleString('es-CO')}€</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    }
    if (acomps.length) {
      html += `<div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Acompañantes</div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)">
            <th style="padding:8px 0;text-align:left;font-weight:500">Comercial</th>
            <th style="padding:8px 0;text-align:right;font-weight:500">Com. Doble</th>
            <th style="padding:8px 0;text-align:right;font-weight:500">Com. Sencilla</th>
            <th style="padding:8px 0;text-align:right;font-weight:500">Acomp. D</th>
            <th style="padding:8px 0;text-align:right;font-weight:500">Acomp. S</th>
            <th style="padding:8px 0;text-align:right;font-weight:500">Total</th>
          </tr>
        </thead>
        <tbody>
          ${acomps.map(c => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:11px 0;font-weight:500;color:var(--navy)">${c.comercial}</td>
              <td style="padding:11px 0;text-align:right;font-size:13px;color:var(--muted)">${(c.com_doble||0).toLocaleString('es-CO')}€</td>
              <td style="padding:11px 0;text-align:right;font-size:13px;color:var(--muted)">${(c.com_sencilla||0).toLocaleString('es-CO')}€</td>
              <td style="padding:11px 0;text-align:right;font-size:13px">${c.acomp_doble||0}</td>
              <td style="padding:11px 0;text-align:right;font-size:13px">${c.acomp_sencilla||0}</td>
              <td style="padding:11px 0;text-align:right;font-weight:700;color:var(--blue)">${(c.total||0).toLocaleString('es-CO')}€</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    }
    const totalJugs  = jugs.reduce((s, c) => s + (c.total||0), 0);
    const totalAcomps = acomps.reduce((s, c) => s + (c.total||0), 0);
    const totalGlobal = totalJugs + totalAcomps;
    html += `<div style="display:flex;justify-content:flex-end;align-items:center;gap:20px;padding:10px 0;border-top:1px solid var(--border);margin-top:4px">
      <span style="font-size:15px;color:var(--muted)">Jugadores <strong style="color:var(--navy);font-weight:500">${totalJugs.toLocaleString('es-CO')}€</strong></span>
      <span style="font-size:15px;color:var(--muted)">Acompañantes <strong style="color:var(--navy);font-weight:500">${totalAcomps.toLocaleString('es-CO')}€</strong></span>
      <span style="font-size:15px;font-weight:700;color:var(--blue)">Total: ${totalGlobal.toLocaleString('es-CO')}€</span>
    </div>`;
    document.getElementById('admin-comisiones-resumen').innerHTML = html;
  } else if (comCard) {
    comCard.style.display = 'none';
  }
}

function renderRecaudacion(fin) {
  if (!fin || !fin.kpis) return;
  const ingresos  = fin.kpis.ingresos || 0;
  const recaudado = (fin.pagos_recibidos || {}).total_eur || 0;
  const gastos    = fin.gastos || {};
  const gastosPres   = gastos.presupuestado || 0;
  const gastosPag    = gastos.pagado || 0;
  const gastosPagCop = gastos.pagado_cop || 0;
  const gastosTasa   = gastos.tasa_media || TASA_EUR_COP;
  const gastosPct    = gastos.pct > 0 ? Math.min(100, Math.round(gastos.pct > 1 ? gastos.pct : gastos.pct * 100)) : 0;
  // Tasa real EUR→COP: media de los pagos que tienen ambos valores registrados
  // (misma tasa que se muestra en la tarjeta "Tasa EUR → COP"). Solo se usa la
  // constante fija como respaldo si aún no hay pagos en COP registrados.
  const pagosConTasa = (fin.pagos_lista || []).filter(p => p.cop > 0 && p.eur > 0);
  const tasaReal = pagosConTasa.length > 0
    ? Math.round(pagosConTasa.reduce((s, p) => s + p.cop, 0) / pagosConTasa.reduce((s, p) => s + p.eur, 0))
    : 0;
  const tasaUsar = tasaReal > 0 ? tasaReal : TASA_EUR_COP;
  const isCop = adminCurrency === 'cop';
  const fmt = v => isCop ? '$ ' + Math.round(v * tasaUsar).toLocaleString('es-CO') : v.toLocaleString('es-CO') + ' €';
  const gastosPagStr  = isCop && gastosPagCop > 0 ? '$ ' + Math.round(gastosPagCop).toLocaleString('es-CO') : gastosPag.toLocaleString('es-CO') + ' €';
  const gastosPresStr = isCop ? '$ ' + Math.round(gastosPres * gastosTasa).toLocaleString('es-CO') : gastosPres.toLocaleString('es-CO') + ' €';
  // Dinero en caja = recaudado − gastos pagados
  const enCajaEur = Math.max(0, recaudado - gastosPag);
  const enCajaCop = isCop && gastosPagCop > 0
    ? Math.max(0, Math.round(recaudado * tasaUsar) - gastosPagCop)
    : Math.max(0, Math.round(enCajaEur * tasaUsar));
  const enCajaStr = isCop ? '$ ' + enCajaCop.toLocaleString('es-CO') : enCajaEur.toLocaleString('es-CO') + ' €';
  const pctRec  = ingresos > 0 ? Math.min(100, Math.round(recaudado / ingresos * 100)) : 0;
  const pctCaja = recaudado > 0 ? Math.min(100, Math.round(enCajaEur / recaudado * 100)) : 0;
  document.getElementById('admin-recaudacion-bars').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">
      <div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:17px;font-weight:500;color:var(--navy)">Recaudado vs Ingresos totales</span>
          <span style="font-size:17px;font-weight:700;color:var(--blue)">${fmt(recaudado)} <span style="color:var(--muted);font-weight:400">/ ${fmt(ingresos)}</span></span>
        </div>
        <div style="height:14px;background:#f1f5f9;border-radius:7px">
          <div style="height:100%;width:${pctRec}%;background:var(--blue);border-radius:7px;transition:width .8s ease;position:relative;overflow:visible">
            <span style="position:absolute;right:-22px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:700;color:var(--blue);background:#fff;border:1.5px solid var(--blue);border-radius:8px;padding:1px 5px;white-space:nowrap;line-height:1.4">${pctRec}%</span>
          </div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:17px;font-weight:500;color:var(--navy)">Gastos pagados vs Total presupuestado</span>
          <span style="font-size:17px;font-weight:700;color:#dc2626">${gastosPagStr} <span style="color:var(--muted);font-weight:400">/ ${gastosPresStr}</span></span>
        </div>
        <div style="height:14px;background:#f1f5f9;border-radius:7px">
          <div style="height:100%;width:${gastosPct}%;background:#dc2626;border-radius:7px;transition:width .8s ease;position:relative;overflow:visible">
            <span style="position:absolute;right:-22px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:700;color:#dc2626;background:#fff;border:1.5px solid #dc2626;border-radius:8px;padding:1px 5px;white-space:nowrap;line-height:1.4">${gastosPct}%</span>
          </div>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:17px;font-weight:500;color:var(--navy)">Dinero en caja</span>
          <span style="font-size:17px;font-weight:700;color:#16a34a">${enCajaStr} <span style="color:var(--muted);font-weight:400;font-size:14px">de ${fmt(recaudado)} recaudado</span></span>
        </div>
        <div style="height:14px;background:#f1f5f9;border-radius:7px">
          <div style="height:100%;width:${pctCaja}%;background:#16a34a;border-radius:7px;transition:width .8s ease;position:relative;overflow:visible">
            <span style="position:absolute;right:-22px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:700;color:#16a34a;background:#fff;border:1.5px solid #16a34a;border-radius:8px;padding:1px 5px;white-space:nowrap;line-height:1.4">${pctCaja}%</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function actualizarBadgePagosPendientes(fin) {
  const badge = document.getElementById('pagos-pendientes-badge');
  if (!badge) return;
  const pagos = (fin && fin.pagos_lista) || [];
  const n = pagos.filter(p => (p.estado || '').toLowerCase().trim() === 'pendiente de confirmar').length;
  badge.textContent = n;
  badge.style.display = n > 0 ? 'block' : 'none';
}

function renderAdminPagos(fin) {
  if (!fin) return;
  actualizarBadgePagosPendientes(fin);
  const recibidos = fin.pagos_recibidos || {};
  const pagos = fin.pagos_lista || [];
  const totalEur = recibidos.total_eur || 0;
  const totalCop = recibidos.total_cop || 0;

  // Lista combinada: nombres del sheet de presupuesto (Pagos) + cualquier nuevo de inscripción
  const pagosNombres = fin.pagos_nombres || [];
  const seenNombres = new Set(pagosNombres.map(normNombre));
  const allNombres = [...pagosNombres];
  (adminData || []).forEach(r => {
    const n = normalizeParticipant(r) || {};
    if ((n.tipo || '').toLowerCase().includes('staff')) return;
    const nombre = n.nombre || r['Nombre'] || '';
    if (nombre && !seenNombres.has(normNombre(nombre))) {
      allNombres.push(nombre);
      seenNombres.add(normNombre(nombre));
    }
  });

  // Mapa tipo: nombre_norm → 'Jugador'/'Acompañante'
  const tipoMap = {};
  pagos.forEach(p => { if (p.tipo && p.nombre) tipoMap[normNombre(p.nombre)] = p.tipo; });
  (adminData || []).forEach(r => {
    const n = normalizeParticipant(r) || {};
    const key = normNombre(n.nombre || r['Nombre'] || '');
    if (key && !tipoMap[key]) tipoMap[key] = n.tipo || r['tipo'] || r['Tipo'] || '';
  });

  // Mapa habitacion: nombre_norm → habitacion ('' = Solo actividades)
  const habMap = {};
  (adminData || []).forEach(r => {
    const n = normalizeParticipant(r) || {};
    const key = normNombre(n.nombre || r['Nombre'] || '');
    if (key) habMap[key] = (n.habitacion || '').toLowerCase();
  });
  const esSoloAct = key => (tipoMap[key] || '').toLowerCase().includes('acomp') && (habMap[key] ?? '') === '';

  // Ordenar: Jugadores primero, luego Acompañantes, alfabético dentro de cada grupo
  allNombres.sort((a, b) => {
    const ta = (tipoMap[normNombre(a)] || '').toLowerCase();
    const tb = (tipoMap[normNombre(b)] || '').toLowerCase();
    const oa = ta.includes('acomp') ? 1 : 0;
    const ob = tb.includes('acomp') ? 1 : 0;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b, 'es');
  });

  // Mapa: nombre_norm → { reserva, tiquete, 'pago final' }
  const pagoMap = {};
  pagos.forEach(p => {
    const key = normNombre(p.nombre);
    if (!pagoMap[key]) pagoMap[key] = {};
    pagoMap[key][(p.notas || '').toLowerCase().trim()] = p;
  });

  // Clasificación por participante — usada tanto para los KPIs (conteo) como
  // para el atributo data-resumen de cada fila (filtro al hacer clic en un KPI).
  // Debe coincidir exactamente con la lógica que antes solo vivía inline en
  // los .filter() de completos/parciales, para que el número del KPI y las
  // filas que efectivamente se muestran al hacer clic sean siempre consistentes.
  const resumenPagoParticipante_ = key => {
    const pp = pagoMap[key] || {};
    if (!Object.keys(pp).length) return 'sin_pago';
    const reserva   = pp['reserva'];
    const pagoFinal = pp['pago final'];
    const tiquete   = pp['tiquete'];
    const isCompleto = p => p && (p.estado || '').toLowerCase() === 'completo';
    if (!esSoloAct(key) && !isCompleto(reserva)) return 'parcial';
    if (!isCompleto(pagoFinal)) return 'parcial';
    if (tiquete && !isCompleto(tiquete)) return 'parcial';
    return 'completo';
  };

  const completos = allNombres.filter(n => resumenPagoParticipante_(normNombre(n)) === 'completo').length;
  const parciales = allNombres.filter(n => resumenPagoParticipante_(normNombre(n)) === 'parcial').length;
  const sinPago   = allNombres.filter(n => resumenPagoParticipante_(normNombre(n)) === 'sin_pago').length;

  document.getElementById('admin-pagos-summary').innerHTML = `
    <div id="kpi-pago-completo" class="metric-card kpi-clickable${filtroResumenPagos==='completo'?' kpi-activo':''}" style="border-top:3px solid #166534" onclick="filtrarPorResumenPagos('completo')"><div class="mc-label">Pagos completos</div><div class="mc-value" style="color:#166534">${completos}</div><div class="mc-sub">Reserva + Pago Final (+ Tiquete si aplica)</div></div>
    <div id="kpi-pago-parcial" class="metric-card mc-green kpi-clickable${filtroResumenPagos==='parcial'?' kpi-activo':''}" onclick="filtrarPorResumenPagos('parcial')"><div class="mc-label">Pagos parciales</div><div class="mc-value">${parciales}</div><div class="mc-sub">Al menos 1 pago pendiente</div></div>
    <div id="kpi-pago-sin_pago" class="metric-card kpi-clickable${filtroResumenPagos==='sin_pago'?' kpi-activo':''}" onclick="filtrarPorResumenPagos('sin_pago')"><div class="mc-label">Sin pago aún</div><div class="mc-value" style="color:#dc2626">${sinPago}</div><div class="mc-sub">Sin ningún pago registrado</div></div>
  `;

  const fmtPago = (pago) => {
    if (!pago || !pago.eur) return `<div>${statusChip('')}</div>`;
    const esPendienteConfirmar = (pago.estado || '').toLowerCase().trim() === 'pendiente de confirmar';
    // La celda puede traer más de un link de comprobante (uno por línea, por abonos
    // sucesivos) — aquí solo se enlaza el primero; todos se listan en el detalle del modal.
    const urlsComprobante = pago.comprobante_url ? pago.comprobante_url.split('\n').filter(Boolean) : [];
    const tituloComprobante = urlsComprobante.length > 1 ? `Ver comprobantes en Drive (${urlsComprobante.length})` : 'Ver comprobante en Drive';
    const chip = (esPendienteConfirmar && urlsComprobante.length)
      ? `<a href="${escapeHtml(urlsComprobante[0])}" target="_blank" rel="noopener" style="text-decoration:none;cursor:pointer" title="${tituloComprobante}">${statusChip(pago.estado)}</a>`
      : statusChip(pago.estado);
    const ia = esPendienteConfirmar ? iaBadgeCompacto(pago.ia_status, pago.ia_detalle, pago.eur, pago.cop) : '';
    return `<div>${chip}</div>
      ${ia ? `<div>${ia}</div>` : ''}
      <div style="font-size:12px;font-weight:600;color:var(--navy);margin-top:3px">${pago.eur.toLocaleString('es-CO')} €</div>
      <div style="font-size:11px;color:var(--muted)">${escapeHtml(pago.fecha)}</div>`;
  };

  if (!allNombres.length) {
    document.getElementById('admin-pagos-body').innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">No hay participantes.</td></tr>';
    return;
  }

  document.getElementById('admin-pagos-body').innerHTML = allNombres.map(nombre => {
    const key = normNombre(nombre);
    const pp = pagoMap[key] || {};
    const reserva   = pp['reserva'];
    const tiquete   = pp['tiquete'];
    const pagoFinal = pp['pago final'];
    const totalPart = (reserva ? reserva.eur||0 : 0) + (tiquete ? tiquete.eur||0 : 0) + (pagoFinal ? pagoFinal.eur||0 : 0);
    // Buscar en adminData para saber si tiene tiquete y para el botón
    const origIdx = (adminData || []).findIndex(r => {
      const n = normalizeParticipant(r) || {};
      return normNombre(n.nombre || r['Nombre'] || '') === key;
    });
    const adRow = origIdx >= 0 ? (normalizeParticipant(adminData[origIdx]) || {}) : {};
    const conTiq = adRow.tiquete_aereo ? adRow.tiquete_aereo.toLowerCase().includes('con') : true;
    const btnClick = `openPagosModal(${origIdx}, '${nombre.replace(/'/g,"\\'")}')`;
    const tipoPart = tipoMap[key] || adRow.tipo || '';
    const tipoIsAcomp = tipoPart.toLowerCase().includes('acomp');
    const tipoBadge = tipoPart
      ? `<span style="font-size:11px;font-weight:600;padding:2px 10px;border-radius:10px;background:${tipoIsAcomp ? 'rgba(22,101,52,.08)' : 'rgba(30,91,168,.1)'};color:${tipoIsAcomp ? '#166534' : 'var(--blue)'};white-space:nowrap">${escapeHtml(tipoPart)}</span>`
      : '<span style="color:var(--muted);font-size:12px">—</span>';
    const acudienteKey = (adRow.acudiente || '').toLowerCase();
    const emailKey = (adRow.email || '').toLowerCase();
    const esPendienteConfirmar = p => p && (p.estado || '').toLowerCase().trim() === 'pendiente de confirmar';
    const tieneRevisar = esPendienteConfirmar(reserva) || esPendienteConfirmar(tiquete) || esPendienteConfirmar(pagoFinal);
    const colegioKey = normNombre(adRow.club_colegio || '');
    return `<tr data-nombre="${escapeHtml(key)}" data-tipo="${tipoIsAcomp ? 'acomp' : 'jug'}" data-acudiente="${escapeHtml(acudienteKey)}" data-email="${escapeHtml(emailKey)}" data-colegio="${escapeHtml(colegioKey)}" data-revisar="${tieneRevisar ? '1' : '0'}" data-resumen="${resumenPagoParticipante_(key)}">
      <td>${tipoBadge}</td>
      <td style="font-weight:500">${escapeHtml(nombre)}${adRow.alianza_nombre ? `<div style="font-size:11px;font-weight:400;color:var(--blue)">🤝 ${escapeHtml(adRow.alianza_nombre)}</div>` : ''}</td>
      <td>${esSoloAct(key) ? '<span style="color:var(--muted);font-size:12px">—</span>' : fmtPago(reserva)}</td>
      <td>${conTiq ? fmtPago(tiquete) : '<span style="color:var(--muted);font-size:12px">—</span>'}</td>
      <td>${fmtPago(pagoFinal)}</td>
      <td style="font-weight:700;color:var(--navy)">${totalPart > 0 ? totalPart.toLocaleString('es-CO') + ' €' : '<span style="color:var(--muted)">—</span>'}</td>
      <td><button onclick="${escapeHtml(btnClick)}" style="padding:5px 10px;border:1px solid rgba(30,91,168,.3);border-radius:6px;background:rgba(30,91,168,.06);font-size:12px;cursor:pointer;font-family:'DM Sans',sans-serif;color:var(--blue)">💳 Pagos</button></td>
    </tr>`;
  }).join('');

  // Sincronizar: agregar al Pagos sheet cualquier inscrito que no esté (fire & forget)
  fetch(APPS_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'},
    body: JSON.stringify({ action: 'sincronizar_participantes', token: adminSessionToken }), redirect:'follow' }).catch(()=>{});
}

let soloRevisarPagos = false;
// null | 'completo' | 'parcial' | 'sin_pago' — activado al hacer clic en uno
// de los 3 KPIs de arriba de la tabla de Pagos (ver renderAdminPagos).
let filtroResumenPagos = null;

function filtrarTablaPagos(q) {
  const term = (q || '').toLowerCase().trim();
  const esBusquedaRedcol = term.includes('redcol');
  let visibles = 0;
  document.querySelectorAll('#admin-pagos-body tr[data-nombre]').forEach(tr => {
    const pasaRedcol = esBusquedaRedcol && esColegioRedcol_(tr.dataset.colegio || '');
    const pasaTexto = !term || pasaRedcol || tr.dataset.nombre.includes(term) || (tr.dataset.tipo || '').includes(term) || (tr.dataset.acudiente || '').includes(term) || (tr.dataset.email || '').includes(term);
    const pasaRevisar = !soloRevisarPagos || tr.dataset.revisar === '1';
    const pasaResumen = !filtroResumenPagos || tr.dataset.resumen === filtroResumenPagos;
    const visible = pasaTexto && pasaRevisar && pasaResumen;
    tr.style.display = visible ? '' : 'none';
    if (visible) visibles++;
  });
  const countEl = document.getElementById('pagos-search-count');
  if (countEl) countEl.textContent = visibles + (visibles === 1 ? ' resultado' : ' resultados');
}

// Clic en un KPI de "Pagos completos/parciales/sin pago" — filtra la tabla de
// abajo a solo esos participantes. Un segundo clic en el MISMO KPI lo quita
// (vuelve a mostrar todo, sujeto a los demás filtros activos).
function filtrarPorResumenPagos(valor) {
  filtroResumenPagos = (filtroResumenPagos === valor) ? null : valor;
  ['completo', 'parcial', 'sin_pago'].forEach(v => {
    const card = document.getElementById('kpi-pago-' + v);
    if (card) card.classList.toggle('kpi-activo', filtroResumenPagos === v);
  });
  reapplyPagosFilter();
}

function toggleSoloRevisarPagos() {
  soloRevisarPagos = !soloRevisarPagos;
  const btn = document.getElementById('btn-pagos-revisar');
  if (btn) {
    btn.style.background = soloRevisarPagos ? '#dc2626' : '#fff';
    btn.style.color = soloRevisarPagos ? '#fff' : '#dc2626';
  }
  const search = document.getElementById('pagos-search');
  filtrarTablaPagos(search ? search.value : '');
}

// Reaplica el término de búsqueda y el filtro "solo por revisar" tras un re-render
// de la tabla de Pagos (evita que refrescos de datos o acciones de guardado limpien
// visualmente los filtros activos).
function reapplyPagosFilter() {
  const el = document.getElementById('pagos-search');
  filtrarTablaPagos(el ? el.value : '');
}

// Pasos
function renderPasoRow(codigo, label, count) {
  const activo = count > 0;
  return `
    <div class="paso-row">
      <span class="paso-code">${codigo}</span>
      <span class="paso-label">${label}</span>
      <div class="paso-toggle ${activo ? 'on' : 'off'}"></div>
      <span class="paso-count ${activo ? 'active' : ''}">${count}</span>
    </div>`;
}

// Paquetes
function renderPaqRow(nombre, cantidad, precio, total, color, maxTotal) {
  const pct = maxTotal > 0 ? Math.round((total / maxTotal) * 100) : 0;
  return `
    <div class="paq-row">
      <div class="paq-top">
        <div class="paq-info">
          <div class="paq-name">
            <div class="paq-dot" style="background:${color}"></div>
            ${escapeHtml(nombre)}
          </div>
          <div class="paq-formula">${cantidad} × ${precio.toLocaleString('es-ES')}€</div>
        </div>
        <div class="paq-amount">${total.toLocaleString('es-ES')}€</div>
      </div>
      <div class="paq-bar-wrap">
        <div class="paq-bar" style="width:${pct}%;background:${color}"></div>
      </div>
    </div>`;
}

function renderFilaJugador(nombre, comPorJug, numJugadores, estado, total) {
  return `
    <tr>
      <td><div class="com-name">${escapeHtml(nombre)}</div><div class="com-name-sub">Comercial activo/a</div></td>
      <td style="text-align:right"><span class="com-amt">${comPorJug}€</span></td>
      <td style="text-align:right"><span class="com-count">${numJugadores}</span></td>
      <td><div class="${total > 0 ? 'com-total-cell' : 'com-zero'}">${total.toLocaleString('es-ES')}€</div></td>
    </tr>`;
}

function renderFilaAcompanante(nombre, comDoble, comSencilla, numAcomp, total) {
  return `
    <tr>
      <td><div class="com-name">${escapeHtml(nombre)}</div><div class="com-name-sub">Comercial activo/a</div></td>
      <td style="text-align:right"><span class="com-amt">${comDoble}€</span></td>
      <td style="text-align:right"><span class="com-amt">${comSencilla}€</span></td>
      <td style="text-align:right"><span class="com-count">${numAcomp}</span></td>
      <td><div class="${total > 0 ? 'com-total-cell' : 'com-zero'}">${total.toLocaleString('es-ES')}€</div></td>
    </tr>`;
}

const avatarColores = [
  'linear-gradient(135deg,#1e5ba8,#3b7fd4)',
  'linear-gradient(135deg,#16a34a,#22c55e)',
  'linear-gradient(135deg,#7c3aed,#a855f7)',
  'linear-gradient(135deg,#ea580c,#f97316)',
  'linear-gradient(135deg,#0d9488,#2dd4bf)'
];

function iniciales(nombre) {
  return nombre.trim().split(' ').slice(0,2).map(p => p[0].toUpperCase()).join('');
}

function renderMobileJugador(nombre, comPorJug, numJugadores, estado, total, idx) {
  const color = avatarColores[idx % avatarColores.length];
  const valClase = total > 0 ? 'blue' : 'zero';
  return `
    <div class="com-mobile-card">
      <div class="com-mobile-card-name">
        ${escapeHtml(nombre)}
        <div class="com-mobile-avatar" style="background:${color}">${escapeHtml(iniciales(nombre))}</div>
      </div>
      <div class="com-mobile-row">
        <span class="com-mobile-key">Com. por jugador</span>
        <span class="com-mobile-val">${comPorJug}€</span>
      </div>
      <div class="com-mobile-row">
        <span class="com-mobile-key">Jugadores inscritos</span>
        <span class="com-mobile-val">${numJugadores}</span>
      </div>
      <div class="com-mobile-row">
        <span class="com-mobile-key">Total jugadores</span>
        <span class="com-mobile-val ${valClase}">${total.toLocaleString('es-ES')}€</span>
      </div>
    </div>`;
}

function renderMobileAcompanante(nombre, comDoble, comSencilla, numAcomp, total, idx) {
  const color = avatarColores[idx % avatarColores.length];
  const valClase = total > 0 ? 'green' : 'zero';
  return `
    <div class="com-mobile-card">
      <div class="com-mobile-card-name">
        ${escapeHtml(nombre)}
        <div class="com-mobile-avatar" style="background:${color}">${escapeHtml(iniciales(nombre))}</div>
      </div>
      <div class="com-mobile-row">
        <span class="com-mobile-key">Com. hab. doble</span>
        <span class="com-mobile-val">${comDoble}€</span>
      </div>
      <div class="com-mobile-row">
        <span class="com-mobile-key">Com. hab. sencilla</span>
        <span class="com-mobile-val">${comSencilla}€</span>
      </div>
      <div class="com-mobile-row">
        <span class="com-mobile-key">Acompañantes inscritos</span>
        <span class="com-mobile-val">${numAcomp}</span>
      </div>
      <div class="com-mobile-row">
        <span class="com-mobile-key">Total acompañantes</span>
        <span class="com-mobile-val ${valClase}">${total.toLocaleString('es-ES')}€</span>
      </div>
    </div>`;
}

function renderAdminComisiones(fin) {
  if (!fin || !fin.comisiones) return;
  const comisiones = fin.comisiones;

  const jugadores = comisiones.filter(c => c.seccion === 'jugadores');
  const acompanantes = comisiones.filter(c => c.seccion === 'acompanantes');

  const tbodyJug = document.getElementById('com-tabla-jugadores');
  if (tbodyJug) {
    tbodyJug.innerHTML = jugadores.length
      ? jugadores.map(c => renderFilaJugador(
          c.comercial,
          c.comision_jugador || 0,
          c.jugadores || 0,
          c.estado || 'Pendiente',
          c.total || 0
        )).join('')
      : `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px;font-size:13px">Sin comerciales registrados.</td></tr>`;
  }

  const tbodyAcomp = document.getElementById('com-tabla-acompanantes');
  if (tbodyAcomp) {
    tbodyAcomp.innerHTML = acompanantes.length
      ? acompanantes.map(c => renderFilaAcompanante(
          c.comercial,
          c.com_doble || 0,
          c.com_sencilla || 0,
          (c.acomp_doble || 0) + (c.acomp_sencilla || 0),
          c.total || 0
        )).join('')
      : `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px;font-size:13px">Sin comerciales registrados.</td></tr>`;
  }

  // Jugadores móvil
  const mobileJug = document.getElementById('com-mobile-jug');
  if (mobileJug) {
    mobileJug.innerHTML = jugadores.length
      ? jugadores.map((c, i) => renderMobileJugador(
          c.comercial,
          c.comision_jugador || 0,
          c.jugadores || 0,
          c.estado || 'Pendiente',
          c.total || 0,
          i
        )).join('')
      : '<p style="color:var(--muted);font-size:13px;padding:8px 0">Sin comerciales registrados.</p>';
  }

  // Acompañantes móvil
  const mobileAcomp = document.getElementById('com-mobile-acomp');
  if (mobileAcomp) {
    mobileAcomp.innerHTML = acompanantes.length
      ? acompanantes.map((c, i) => renderMobileAcompanante(
          c.comercial,
          c.com_doble || 0,
          c.com_sencilla || 0,
          (c.acomp_doble || 0) + (c.acomp_sencilla || 0),
          c.total || 0,
          i
        )).join('')
      : '<p style="color:var(--muted);font-size:13px;padding:8px 0">Sin comerciales registrados.</p>';
  }

  const totalJug   = jugadores.reduce((s, c) => s + (c.total || 0), 0);
  const totalAcomp = acompanantes.reduce((s, c) => s + (c.total || 0), 0);
  const totalGlobal = totalJug + totalAcomp;
  const fmt = n => (n || 0).toLocaleString('es-ES') + '€';

  const elGen   = document.getElementById('com-total-general');
  const elJug   = document.getElementById('com-total-jug');
  const elAcomp = document.getElementById('com-total-acomp');
  const elFooter = document.getElementById('com-total-footer');
  if (elGen)    elGen.textContent    = fmt(totalGlobal);
  if (elJug)    elJug.textContent    = fmt(totalJug);
  if (elAcomp)  elAcomp.textContent  = fmt(totalAcomp);
  if (elFooter) elFooter.textContent = fmt(totalGlobal);
}

// ── PANEL ADMIN: COMERCIALES (asignación de jugadores) ─────────────────────
let adminComercialesData = null;
let comercialAsignacionActivo = null;

function loadAdminComerciales(force) {
  if (!force && adminComercialesData) { renderAdminComerciales(); return; }
  fetch(APPS_SCRIPT_URL + '?action=admin_comerciales_data&token=' + encodeURIComponent(adminSessionToken) + '&programa=' + encodeURIComponent(adminProgramaActivo) + '&_t=' + Date.now(), { redirect: 'follow' })
    .then(r => r.json())
    .then(d => {
      if (!d || d.error) { adminComercialesData = null; return; }
      adminComercialesData = d;
      renderAdminComerciales();
    })
    .catch(err => console.error('loadAdminComerciales error:', err));
}

function renderAdminComerciales() {
  const d = adminComercialesData;
  const sel = document.getElementById('ac-comercial-select');
  if (!sel) return;
  const puedeEditar = isEditAdmin();
  const bloqueCrear = document.getElementById('ac-crear-bloque');
  if (bloqueCrear) bloqueCrear.style.display = puedeEditar ? '' : 'none';
  const prevValue = comercialAsignacionActivo;
  sel.innerHTML = '<option value="">Selecciona un comercial…</option>' +
    ((d && d.comerciales) || []).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if (prevValue && d && (d.comerciales || []).includes(prevValue)) {
    sel.value = prevValue;
    selComercialAsignacion(prevValue);
  } else {
    comercialAsignacionActivo = null;
    const detalle = document.getElementById('ac-comercial-detalle');
    if (detalle) detalle.style.display = 'none';
    const btnEliminar = document.getElementById('ac-btn-eliminar-comercial');
    if (btnEliminar) btnEliminar.style.display = 'none';
  }
}

function mostrarStatusTop(msg, ok) {
  const el = document.getElementById('ac-top-status');
  if (!el) return;
  el.style.display = 'block';
  el.style.background = ok ? 'var(--gbg)' : 'var(--rbg)';
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
  el.textContent = msg;
}

function crearComercial() {
  if (!isEditAdmin()) { alert('No tienes permisos de edición.'); return; }
  const nombreInput = document.getElementById('ac-nuevo-nombre');
  const nombre = nombreInput.value.trim();
  const comision = parseFloat(document.getElementById('ac-nuevo-comision').value) || 0;
  if (!nombre) { mostrarStatusTop('Escribe el nombre del comercial.', false); return; }
  const yaExiste = ((adminComercialesData && adminComercialesData.comerciales) || [])
    .some(c => normalizarTextoJS_(c) === normalizarTextoJS_(nombre));
  if (yaExiste) { mostrarStatusTop('Ya existe un comercial con ese nombre.', false); return; }
  fetch(APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      action: 'guardar_comercial', comercial: nombre, seccion: 'jugadores',
      comision_jugador: comision, jugadores: 0, estado: 'Pendiente', notas: '',
      _row: 0, programa: adminProgramaActivo, token: adminSessionToken
    }),
    redirect: 'follow'
  }).then(r => r.json()).then(res => {
    if (res.ok) {
      nombreInput.value = '';
      document.getElementById('ac-nuevo-comision').value = '';
      mostrarStatusTop('Comercial creado — ya puedes asignarle jugadores.', true);
      comercialAsignacionActivo = nombre;
      loadAdminComerciales(true);
    } else {
      mostrarStatusTop(res.error || 'Error al crear comercial.', false);
    }
  }).catch(() => mostrarStatusTop('Error de conexión.', false));
}

async function eliminarComercialActivo() {
  if (!isEditAdmin() || !comercialAsignacionActivo) return;
  const nombre = comercialAsignacionActivo;
  const jugadoresAsignados = ((adminComercialesData && adminComercialesData.porComercial && adminComercialesData.porComercial[nombre]) || []).length;
  const aviso = jugadoresAsignados > 0
    ? 'Esto eliminará a "' + nombre + '" de Comisiones y liberará ' + jugadoresAsignados + ' jugador(es) asignado(s), que quedarán disponibles para otro comercial. ¿Continuar?'
    : '¿Eliminar al comercial "' + nombre + '"? Se quitará de la hoja de Comisiones.';
  if (!confirm(aviso)) return;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'eliminar_comercial', comercial: nombre, programa: adminProgramaActivo, token: adminSessionToken }),
      redirect: 'follow'
    }).then(r => r.json());
    if (res.ok) {
      mostrarStatusTop('Comercial eliminado.', true);
      comercialAsignacionActivo = null;
      loadAdminComerciales(true);
      loadAdmin(true);
    } else {
      mostrarStatusTop(res.error || 'Error al eliminar.', false);
    }
  } catch (e) { mostrarStatusTop('Error de conexión.', false); }
}

function normalizarTextoJS_(s) {
  return String(s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function selComercialAsignacion(nombre) {
  comercialAsignacionActivo = nombre || null;
  const detalle = document.getElementById('ac-comercial-detalle');
  const btnEliminar = document.getElementById('ac-btn-eliminar-comercial');
  if (!detalle) return;
  if (!nombre) {
    detalle.style.display = 'none';
    if (btnEliminar) btnEliminar.style.display = 'none';
    return;
  }
  detalle.style.display = '';
  if (btnEliminar) btnEliminar.style.display = isEditAdmin() ? '' : 'none';
  document.getElementById('ac-tipo').value = 'individual';
  onCambioTipoAsignacion();
  poblarSelectoresAsignacion();
  renderReglasYJugadoresComercial();
  const bloqueAgregar = document.getElementById('ac-bloque-agregar');
  if (bloqueAgregar) bloqueAgregar.style.display = isEditAdmin() ? '' : 'none';
}

// Clave única de un jugador para el frontend: EMAIL + NOMBRE, no solo email —
// hermanos inscritos como jugadores separados suelen compartir el correo del
// mismo acudiente, así que el email solo no basta para distinguirlos. Debe
// coincidir con claveJugador_() en APPS_SCRIPT_CODE.gs.
function claveJugadorJS_(email, nombre) {
  return normalizarTextoJS_(email) + '|||' + normalizarTextoJS_(nombre);
}

function poblarSelectoresAsignacion() {
  const d = adminComercialesData;
  if (!d) return;
  const asignadosNorm = new Set();
  Object.values(d.porComercial || {}).forEach(lista => lista.forEach(j => asignadosNorm.add(claveJugadorJS_(j.email, j.nombre))));
  const disponibles = (d.jugadoresTodos || []).filter(j => !asignadosNorm.has(claveJugadorJS_(j.email, j.nombre)));
  const selJug = document.getElementById('ac-valor-individual');
  // El value codifica "email|||nombre" — el backend lo necesita completo para
  // distinguir entre hermanos que comparten el correo del acudiente.
  selJug.innerHTML = disponibles.length
    ? disponibles.map(j => `<option value="${escapeHtml(j.email + '|||' + j.nombre)}">${escapeHtml(j.nombre)}${j.colegio ? ' — ' + escapeHtml(j.colegio) : ''}</option>`).join('')
    : '<option value="">No hay jugadores disponibles para asignar</option>';

  const selCol = document.getElementById('ac-valor-colegio');
  selCol.innerHTML = (d.colegios || []).length
    ? d.colegios.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
    : '<option value="">Sin colegios registrados</option>';
}

function onCambioTipoAsignacion() {
  const tipo = document.getElementById('ac-tipo').value;
  document.getElementById('ac-group-individual').style.display = tipo === 'individual' ? '' : 'none';
  document.getElementById('ac-group-colegio').style.display = tipo === 'colegio' ? '' : 'none';
}

function renderReglasYJugadoresComercial() {
  const d = adminComercialesData;
  if (!d || !comercialAsignacionActivo) return;
  const reglas = (d.asignaciones || []).filter(a => a.comercial === comercialAsignacionActivo);
  const chipsEl = document.getElementById('ac-reglas-chips');
  const iconos = { individual: '👤', colegio: '🏫', redcol: '🎓', excluir: '🚫' };
  const puedeEditar = isEditAdmin();
  // El valor guardado de una regla "individual"/"excluir" es "email|||nombre"
  // — el nombre ya viene incluido, no hace falta buscarlo aparte.
  const etiquetaRegla = r => {
    if (r.tipo === 'redcol') return 'Redcol';
    if (r.tipo === 'individual') return r.valor.split('|||')[1] || r.valor;
    if (r.tipo === 'excluir') return 'Excluido: ' + (r.valor.split('|||')[1] || r.valor);
    return r.valor;
  };
  chipsEl.innerHTML = reglas.length
    ? reglas.map(r => `<span style="display:inline-flex;align-items:center;gap:6px;background:rgba(30,91,168,.08);color:var(--navy);border-radius:20px;padding:6px 6px 6px 12px;font-size:13px">${iconos[r.tipo] || ''} ${escapeHtml(etiquetaRegla(r))}${puedeEditar ? `<button onclick="eliminarAsignacionComercial(${r._row})" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0 2px" title="Quitar">×</button>` : ''}</span>`).join('')
    : '<span style="font-size:13px;color:var(--muted)">Sin reglas asignadas todavía.</span>';

  const jugadores = (d.porComercial && d.porComercial[comercialAsignacionActivo]) || [];
  document.getElementById('ac-conteo').textContent = jugadores.length;
  const tbody = document.getElementById('ac-jugadores-tbody');
  tbody.innerHTML = jugadores.length
    ? jugadores.map((j, idx) => `<tr><td>${escapeHtml(j.nombre)}</td><td>${escapeHtml(j.colegio) || '—'}</td><td>${escapeHtml(formatFechaNac(j.fecha_nacimiento))}</td><td>${(j.tiquete_aereo || '').toLowerCase().indexOf('con') >= 0 ? '✈ Sí' : '—'}</td><td>${escapeHtml(j.paso_actual || '1')}</td><td>${puedeEditar ? `<button onclick="excluirJugadorDeLista(${idx})" style="background:none;border:1px solid var(--rborder);color:var(--red);border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;white-space:nowrap" title="Quitar de esta lista">✕ Quitar</button>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:14px;font-size:13px">Sin jugadores asignados.</td></tr>';
}

// Excluye a un jugador puntual de la lista del comercial activo, aunque
// calce con una regla amplia (colegio/redcol) — ej. un jugador que
// pertenece a un colegio Redcol pero en realidad llegó por otro canal y no
// es de este comercial. Queda libre para que otro comercial lo reclame.
async function excluirJugadorDeLista(idx) {
  if (!isEditAdmin() || !comercialAsignacionActivo) return;
  const d = adminComercialesData;
  const jugadores = (d && d.porComercial && d.porComercial[comercialAsignacionActivo]) || [];
  const j = jugadores[idx];
  if (!j) return;
  if (!confirm('¿Quitar a "' + j.nombre + '" de la lista de ' + comercialAsignacionActivo + '? Dejará de contar para su comisión, pero seguirá disponible para asignarlo a otro comercial si corresponde.')) return;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'admin_comercial_asignar', accion: 'add', comercial: comercialAsignacionActivo, tipo: 'excluir', valor: j.email + '|||' + j.nombre, programa: adminProgramaActivo, token: adminSessionToken }),
      redirect: 'follow'
    }).then(r => r.json());
    if (res.ok) {
      mostrarStatusAsignacion('Jugador quitado de la lista.', true);
      await refrescarComercialesTrasCambio();
    } else {
      mostrarStatusAsignacion(res.error || 'Error al quitar.', false);
    }
  } catch (e) { mostrarStatusAsignacion('Error de conexión.', false); }
}

function mostrarStatusAsignacion(msg, ok) {
  const el = document.getElementById('ac-status');
  if (!el) return;
  el.style.display = 'block';
  el.style.background = ok ? 'var(--gbg)' : 'var(--rbg)';
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
  el.textContent = msg;
}

async function agregarAsignacionComercial() {
  if (!comercialAsignacionActivo) return;
  const tipo = document.getElementById('ac-tipo').value;
  const valor = tipo === 'individual' ? document.getElementById('ac-valor-individual').value
    : tipo === 'colegio' ? document.getElementById('ac-valor-colegio').value
    : '';
  if (tipo !== 'redcol' && !valor) { mostrarStatusAsignacion('Selecciona un valor antes de agregar.', false); return; }
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'admin_comercial_asignar', accion: 'add', comercial: comercialAsignacionActivo, tipo: tipo, valor: valor, programa: adminProgramaActivo, token: adminSessionToken }),
      redirect: 'follow'
    }).then(r => r.json());
    if (res.ok) {
      mostrarStatusAsignacion('Asignación agregada.', true);
      await refrescarComercialesTrasCambio();
    } else {
      mostrarStatusAsignacion(res.error || 'Error al agregar.', false);
    }
  } catch (e) { mostrarStatusAsignacion('Error de conexión.', false); }
}

async function eliminarAsignacionComercial(rowNum) {
  if (!comercialAsignacionActivo) return;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'admin_comercial_asignar', accion: 'remove', _row: rowNum, comercial: comercialAsignacionActivo, programa: adminProgramaActivo, token: adminSessionToken }),
      redirect: 'follow'
    }).then(r => r.json());
    if (res.ok) {
      mostrarStatusAsignacion('Asignación eliminada.', true);
      await refrescarComercialesTrasCambio();
    } else {
      mostrarStatusAsignacion(res.error || 'Error al eliminar.', false);
    }
  } catch (e) { mostrarStatusAsignacion('Error de conexión.', false); }
}

// Tras agregar/quitar una regla, el conteo escrito en Comisiones!C también
// cambió — se refresca esta pestaña Y se fuerza un recarga de admin_financiero
// (loadAdmin) para que la pestaña Comisiones no quede con el número viejo.
async function refrescarComercialesTrasCambio() {
  const res = await fetch(APPS_SCRIPT_URL + '?action=admin_comerciales_data&token=' + encodeURIComponent(adminSessionToken) + '&programa=' + encodeURIComponent(adminProgramaActivo) + '&_t=' + Date.now(), { redirect: 'follow' })
    .then(r => r.json()).catch(() => null);
  if (res && !res.error) {
    adminComercialesData = res;
    poblarSelectoresAsignacion();
    renderReglasYJugadoresComercial();
  }
  loadAdmin(true);
}

function renderAdminTable(rows) {
  const tbody = document.getElementById('admin-ptable-body');
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:24px">No hay participantes.</td></tr>';
    return;
  }
  // Orden fijo: Jugadores → Acompañantes → Staff (sort estable: dentro de
  // cada grupo se conserva el orden original, ej. el de la hoja).
  const ordenTipo = tp => tp.toLowerCase().includes('jug') ? 0 : tp.toLowerCase().includes('staff') ? 2 : 1;
  const rowsOrdenadas = [...rows].sort((a, b) => {
    const ta = (normalizeParticipant(a) || {}).tipo || a['1'] || '';
    const tb = (normalizeParticipant(b) || {}).tipo || b['1'] || '';
    return ordenTipo(ta) - ordenTipo(tb);
  });
  tbody.innerHTML = rowsOrdenadas.map((row, i) => {
    const n = normalizeParticipant(row) || {};
    const nb = n.nombre || row['2'] || '';
    const tp = n.tipo || row['1'] || '';
    const em = n.email || row['3'] || '';
    const ph = n.phone || row['4'] || '';
    const fnRaw = n.fecha_nacimiento || row['Fecha Nacimiento'] || row['fecha_nacimiento'] || '';
    const fn = fnRaw ? formatFechaNac(fnRaw) : '—';
    const club = n.club_colegio || row['Club / Colegio'] || row['Club/Colegio'] || row['Colegio'] || row['Club'] || '';
    const tiq = (n.tiquete_aereo || '').toLowerCase().includes('con') ? '<span style="color:var(--blue)">✈ Sí</span>' : '<span style="color:var(--muted)">—</span>';
    const hab = n.habitacion || '';
    const paso = n.paso_actual || '1';
    const cls = parseInt(paso) >= 7 ? 'paso-pill paso-done' : 'paso-pill';
    const origIdx = adminData.indexOf(row);
    const tipoBg = tp.toLowerCase().includes('jug') ? 'rgba(30,91,168,.1)' : tp.toLowerCase().includes('staff') ? 'rgba(124,58,237,.1)' : 'rgba(22,101,52,.08)';
    const tipoColor = tp.toLowerCase().includes('jug') ? 'var(--blue)' : tp.toLowerCase().includes('staff') ? '#7c3aed' : '#166534';
    return `<tr onclick="openDetailModal(${origIdx})" style="cursor:pointer">
      <td style="font-weight:500">${escapeHtml(nb)}</td>
      <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${tipoBg};color:${tipoColor}">${escapeHtml(tp)}</span></td>
      <td style="font-size:12px;color:var(--muted)">${escapeHtml(em)}</td>
      <td style="font-size:12px">${escapeHtml(ph)}</td>
      <td style="font-size:12px">${escapeHtml(fn)}</td>
      <td style="font-size:12px;color:var(--muted)">${escapeHtml(club) || '—'}</td>
      <td style="text-align:center">${tiq}</td>
      <td style="font-size:12px">${escapeHtml(hab)}</td>
      <td style="font-size:12px">${n.alianza_nombre ? `<span style="color:var(--blue)">🤝 ${escapeHtml(n.alianza_nombre)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td><span class="${cls}">${escapeHtml(paso)}</span></td>
      <td><div style="display:flex;gap:5px;flex-wrap:wrap">${isEditAdmin() ? `<button onclick="event.stopPropagation();openEditModal(${origIdx})" style="padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:#fff;font-size:12px;cursor:pointer;font-family:'DM Sans',sans-serif;color:var(--navy)" onmouseover="this.style.background='var(--off)'" onmouseout="this.style.background='#fff'">Editar</button>` : '<span style="font-size:11px;color:var(--muted)">Solo ver</span>'}</div></td>
    </tr>`;
  }).join('');
}

// Convierte fecha del sheet (aaaa-mm-dd o dd/mm/aaaa) a dd/mm/aaaa para mostrar
function formatFechaNac(v) {
  if (!v) return '—';
  var s = String(v).trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    var p = s.split('-');
    return p[2].padStart(2,'0') + '/' + p[1].padStart(2,'0') + '/' + p[0];
  }
  return s; // ya en dd/mm/aaaa u otro formato
}

function filterAdminTable() {
  const q = (document.getElementById('admin-search').value || '').toLowerCase();
  const countEl = document.getElementById('admin-search-count');
  if (!q) {
    renderAdminTable(adminData);
    if (countEl) countEl.textContent = adminData.length + (adminData.length === 1 ? ' participante' : ' participantes');
    return;
  }
  const esBusquedaRedcol = q.includes('redcol');
  const filtrados = adminData.filter(row => {
    const n = normalizeParticipant(row) || {};
    if (esBusquedaRedcol && esColegioRedcol_(n.club_colegio)) return true;
    return (n.nombre || '').toLowerCase().includes(q) || (n.email || '').toLowerCase().includes(q) || (n.acudiente || '').toLowerCase().includes(q);
  });
  renderAdminTable(filtrados);
  if (countEl) countEl.textContent = filtrados.length + (filtrados.length === 1 ? ' resultado' : ' resultados');
}

// Catálogo de alianzas activas del programa actual (nombre + precio total),
// cargado en loadAdmin() vía ?action=listar_alianzas. adminAlianzasOptions
// es el mismo array por referencia que usa el select "Alianza" del modal de
// edición (EDIT_FIELDS_JUGADOR) — se muta in-place para no romper esa referencia.
let adminAlianzasCatalogo = [];
let adminAlianzasOptions = [''];
async function cargarAlianzasCatalogo() {
  try {
    const res = await fetch(APPS_SCRIPT_URL + '?action=listar_alianzas&programa=' + encodeURIComponent(adminProgramaActivo) + '&_t=' + Date.now(), { redirect: 'follow' }).then(r => r.json());
    adminAlianzasCatalogo = Array.isArray(res) ? res : [];
  } catch (err) {
    adminAlianzasCatalogo = [];
  }
  adminAlianzasOptions.length = 0;
  adminAlianzasOptions.push('', ...adminAlianzasCatalogo.map(a => a.nombre));
}

// Base fields shared by all participants
const EDIT_FIELDS_BASE = [
  {key:'nombre',label:'Nombre',type:'text'},{key:'email',label:'Email',type:'email'},
  {key:'phone',label:'Teléfono',type:'text'},{key:'pais',label:'País',type:'text'},
  {key:'pasaporte',label:'Pasaporte',type:'text'},{key:'ciudad',label:'Ciudad',type:'text'},
  {key:'salud_alergias',label:'Condiciones médicas y alergias',type:'text',full:true},
  {key:'tiquete_aereo',label:'Tiquete aéreo',type:'select',options:['Con tiquete','Sin tiquete']},
  {key:'paso_actual',label:'Paso actual',type:'text'}
];
// Extra fields only for jugadores
const EDIT_FIELDS_JUGADOR = [
  {key:'fecha_nacimiento',label:'Fecha de nacimiento',type:'text'},
  {key:'posicion',label:'Posición',type:'text'},
  {key:'club_colegio',label:'Club / Colegio',type:'text'},
  {key:'acudiente',label:'Nombre del acudiente',type:'text'},
  {key:'relacion',label:'Relación con el acudiente',type:'text'},
  {key:'alianza',label:'Alianza',type:'select',options:adminAlianzasOptions,emptyLabel:'Sin alianza'},
];
// Extra fields only for acompañantes
const EDIT_FIELDS_ACOMP = [
  {key:'jugador_acompanado',label:'Jugador que acompaña',type:'text',full:true},
  {key:'fecha_nacimiento',label:'Fecha de nacimiento',type:'text'},
  {key:'habitacion',label:'Habitación',type:'select',options:['Doble','Sencilla','']},
];
// Keep EDIT_FIELDS as alias for legacy references
const EDIT_FIELDS = [...EDIT_FIELDS_BASE, ...EDIT_FIELDS_JUGADOR, ...EDIT_FIELDS_ACOMP];

function getEditFields(esJugador) {
  if (esJugador) return [...EDIT_FIELDS_BASE.slice(0,5), ...EDIT_FIELDS_JUGADOR, ...EDIT_FIELDS_BASE.slice(5)];
  return [...EDIT_FIELDS_BASE, ...EDIT_FIELDS_ACOMP];
}

function openEditModal(idx) {
  const row = adminData[idx];
  if (!row) return;
  if (!isEditAdmin()) { alert('No tienes permisos de edición.'); return; }
  adminCurrentRow = { ...row, _idx: idx };
  const n = normalizeParticipant(row) || {};
  const esJugador = (n.tipo || '').toLowerCase().includes('jug');
  const fields = getEditFields(esJugador);
  document.getElementById('edit-modal-fields').innerHTML = fields.map(f => {
    const val = n[f.key] != null ? n[f.key] : (row[f.key] || '');
    const cls = 'mfield' + (f.full ? ' full' : '');
    if (f.type === 'select') {
      const opts = f.options.map(o => `<option value="${o}"${o===val?' selected':''}>${o||(f.emptyLabel||'Solo actividades')}</option>`).join('');
      return `<div class="${cls}"><label>${f.label}</label><select id="ef-${f.key}">${opts}</select></div>`;
    }
    return `<div class="${cls}"><label>${f.label}</label><input type="${f.type}" id="ef-${f.key}" value="${String(val).replace(/"/g,'&quot;')}"></div>`;
  }).join('');
  document.getElementById('edit-modal-status').style.display = 'none';
  document.getElementById('edit-modal').classList.add('open');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.remove('open');
  adminCurrentRow = null;
}

// ── MODAL DETALLE PARTICIPANTE (solo lectura) ──────────────────────────────────
function calcularEdad(fechaStr) {
  if (!fechaStr) return null;
  const s = String(fechaStr).trim();
  let d, m, y;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (dmy) { d = +dmy[1]; m = +dmy[2]; y = +dmy[3]; }
  else return null;
  const birth = new Date(y, m - 1, d);
  if (isNaN(birth.getTime())) return null;
  const today = new Date();
  let edad = today.getFullYear() - birth.getFullYear();
  const mDiff = today.getMonth() - birth.getMonth();
  if (mDiff < 0 || (mDiff === 0 && today.getDate() < birth.getDate())) edad--;
  return edad;
}

function openDetailModal(idx) {
  const row = adminData[idx];
  if (!row) return;
  const n = normalizeParticipant(row) || {};
  const edad = calcularEdad(n.fecha_nacimiento);
  const pasaporte = rowVal(row, 'pasaporte', 'Pasaporte', 'documento_pasaporte', 'No. Pasaporte', 'numero_pasaporte');
  const salud = rowVal(row, 'salud_alergias', 'Salud/Alergias', 'Salud / Alergias', 'Condiciones médicas y alergias', 'condiciones_medicas', 'alergias');
  const tieneTiquete = (n.tiquete_aereo || '').toLowerCase().includes('con');

  const items = [
    ['Nombre', n.nombre || '—'],
    ['Edad', edad != null ? edad + ' años' : '—'],
    ['Colegio / Club', n.club_colegio || '—'],
    ['Acudiente', n.acudiente || '—'],
    ['Pasaporte', pasaporte || '—'],
    ['Tiquete aéreo', tieneTiquete ? '✈ Sí, incluye tiquete' : 'No incluye tiquete'],
    ['Tipo', n.tipo || '—'],
    ['Salud / Alergias', salud || 'Ninguna reportada'],
    ['Teléfono (WhatsApp)', n.phone || '—']
  ];

  document.getElementById('detail-modal-title-name').textContent = n.nombre || 'Detalle del participante';
  document.getElementById('detail-modal-body').innerHTML = items.map(([label, val]) =>
    `<div class="mfield"><label>${escapeHtml(label)}</label><div style="font-size:14px;color:var(--navy);padding:4px 0">${escapeHtml(val)}</div></div>`
  ).join('');
  document.getElementById('detail-modal').classList.add('open');
}

function closeDetailModal() {
  document.getElementById('detail-modal').classList.remove('open');
}

// ── MODAL AGREGAR INSCRITO ─────────────────────────────────────────────────────
function openAddParticipantModal() {
  if (!isEditAdmin()) { alert('No tienes permisos de edición.'); return; }
  document.getElementById('ap-tipo').value = 'Jugador';
  renderAddParticipantFields('Jugador');
  document.getElementById('add-participant-status').style.display = 'none';
  document.getElementById('add-participant-modal').classList.add('open');
}

function closeAddParticipantModal() {
  document.getElementById('add-participant-modal').classList.remove('open');
}

function renderAddParticipantFields(tipo) {
  const fields = (tipo === 'Jugador' ? getEditFields(true) : tipo === 'Staff' ? EDIT_FIELDS_BASE : getEditFields(false)).filter(f => f.key !== 'paso_actual');
  const s = 'width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:7px;font-family:\'DM Sans\',sans-serif;font-size:14px;outline:none;box-sizing:border-box';
  document.getElementById('add-participant-fields').innerHTML = fields.map(f => {
    const cls = 'mfield' + (f.full ? ' full' : '');
    if (f.type === 'select') {
      const opts = f.options.map(o => `<option value="${o}">${o || 'Solo actividades'}</option>`).join('');
      return `<div class="${cls}"><label>${f.label}</label><select id="ap-${f.key}" style="${s};background:#fff">${opts}</select></div>`;
    }
    return `<div class="${cls}"><label>${f.label}</label><input type="${f.type}" id="ap-${f.key}" placeholder="${f.label}" style="${s}"></div>`;
  }).join('');
}

function saveNewParticipant() {
  const tipo = document.getElementById('ap-tipo').value;
  const fields = (tipo === 'Jugador' ? getEditFields(true) : tipo === 'Staff' ? EDIT_FIELDS_BASE : getEditFields(false)).filter(f => f.key !== 'paso_actual');

  const nombre = document.getElementById('ap-nombre')?.value.trim();
  const email  = document.getElementById('ap-email')?.value.trim().toLowerCase();
  if (!nombre) { alert('El nombre es obligatorio.'); return; }
  if (!email || !email.includes('@')) { alert('Introduce un email válido.'); return; }

  const payload = { action: 'agregar_participante', tipo, paso_actual: '1', fuente: 'Panel Admin', programa: adminProgramaActivo, token: adminSessionToken };
  fields.forEach(f => { const el = document.getElementById('ap-' + f.key); if (el) payload[f.key] = el.value; });

  const statusEl = document.getElementById('add-participant-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Guardando...</span>';

  fetch(APPS_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(payload), redirect:'follow' })
    .then(r => r.json())
    .then(res => {
      if (res.ok) {
        statusEl.innerHTML = '<span style="color:#166534">✓ Inscrito agregado correctamente.</span>';
        // Añadir al cache local y re-renderizar
        const newEntry = { _row: res._row, tipo, ...payload };
        adminData.push(newEntry);
        filterAdminTable();
        if (typeof renderAdminDashboard === 'function') renderAdminDashboard(adminData, adminFinData);
        setTimeout(closeAddParticipantModal, 1400);
      } else {
        statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error || 'desconocido'}</span>`;
      }
    })
    .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

// ── MODAL COMERCIAL ────────────────────────────────────────────────────────────
let comercialCurrentRow = null;

function openComercialModal(idx, seccion) {
  if (!isEditAdmin()) { alert('No tienes permisos de edición.'); return; }
  const comisiones = adminFinData && adminFinData.comisiones ? adminFinData.comisiones : [];
  const c = (idx !== undefined && comisiones[idx]) ? comisiones[idx] : null;
  comercialCurrentRow = c ? { ...c } : null;

  const sec = c ? (c.seccion || 'jugadores') : (seccion || 'jugadores');
  const secLabel = sec === 'acompanantes' ? 'Acompañantes' : 'Jugadores';
  document.getElementById('comercial-modal-title').textContent = (c ? 'Editar' : 'Añadir') + ' comercial — ' + secLabel;
  document.getElementById('cm-seccion').value = sec;
  document.getElementById('cm-nombre').value = c ? c.comercial : '';

  const isAcomp = sec === 'acompanantes';
  ['cm-group-jug1','cm-group-jug2','cm-group-jug3','cm-group-jug4'].forEach(id =>
    document.getElementById(id).style.display = isAcomp ? 'none' : '');
  ['cm-group-acomp1','cm-group-acomp2','cm-group-acomp3','cm-group-acomp4'].forEach(id =>
    document.getElementById(id).style.display = isAcomp ? '' : 'none');

  if (isAcomp) {
    document.getElementById('cm-com-doble').value = c ? (c.com_doble || '') : '';
    document.getElementById('cm-com-sencilla').value = c ? (c.com_sencilla || '') : '';
    document.getElementById('cm-acomp-doble').value = c ? (c.acomp_doble || '') : '';
    document.getElementById('cm-acomp-sencilla').value = c ? (c.acomp_sencilla || '') : '';
  } else {
    document.getElementById('cm-comision').value = c ? (c.comision_jugador || '') : '';
    document.getElementById('cm-jugadores').value = c ? (c.jugadores || '') : '';
    document.getElementById('cm-estado').value = c ? (c.estado || 'Pendiente') : 'Pendiente';
    document.getElementById('cm-notas').value = c ? (c.notas || '') : '';
  }
  document.getElementById('comercial-modal-status').style.display = 'none';
  document.getElementById('comercial-modal').classList.add('open');
}

function closeComercialModal() {
  document.getElementById('comercial-modal').classList.remove('open');
  comercialCurrentRow = null;
}

function saveComercialModal() {
  const nombre = document.getElementById('cm-nombre').value.trim();
  if (!nombre) { alert('El nombre del comercial es obligatorio.'); return; }
  const sec = document.getElementById('cm-seccion').value || 'jugadores';
  const payload = { action: 'guardar_comercial', comercial: nombre, seccion: sec,
    _row: comercialCurrentRow ? (comercialCurrentRow._row || 0) : 0, token: adminSessionToken, programa: adminProgramaActivo };
  if (sec === 'acompanantes') {
    payload.com_doble = parseFloat(document.getElementById('cm-com-doble').value) || 0;
    payload.com_sencilla = parseFloat(document.getElementById('cm-com-sencilla').value) || 0;
    payload.acomp_doble = parseInt(document.getElementById('cm-acomp-doble').value) || 0;
    payload.acomp_sencilla = parseInt(document.getElementById('cm-acomp-sencilla').value) || 0;
  } else {
    payload.comision_jugador = parseFloat(document.getElementById('cm-comision').value) || 0;
    payload.jugadores = parseInt(document.getElementById('cm-jugadores').value) || 0;
    payload.estado = document.getElementById('cm-estado').value;
    payload.notas = document.getElementById('cm-notas').value.trim();
  }
  const statusEl = document.getElementById('comercial-modal-status');
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'Guardando...';
  fetch(APPS_SCRIPT_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  })
  .then(r => r.json())
  .then(res => {
    if (res.ok) {
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = 'Guardado correctamente.';
      setTimeout(() => {
        closeComercialModal();
        fetch(APPS_SCRIPT_URL + '?action=admin_financiero&token=' + encodeURIComponent(adminSessionToken) + '&programa=' + encodeURIComponent(adminProgramaActivo) + '&_t=' + Date.now(), { redirect: 'follow' })
          .then(r => r.json())
          .then(fin => {
            adminFinData = fin && !fin.error ? fin : null;
            if (adminFinData) {
              renderAdminComisiones(adminFinData);
              renderAdminDashboard(adminData, adminFinData);
            }
          })
          .catch(() => {});
      }, 700);
    } else {
      statusEl.style.color = '#dc2626';
      statusEl.textContent = 'Error: ' + (res.error || 'No se pudo guardar.');
    }
  })
  .catch(() => {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = 'Error de red. Inténtalo de nuevo.';
  });
}

// Reabre el modal de Pagos DESPUÉS de refrescar adminFinData desde el servidor.
// Las 4 acciones del modal (registrar/agregar abono/confirmar/actualizar
// estado) reabrían el modal directo desde el adminFinData en memoria, que
// todavía tenía el estado ANTERIOR al cambio recién guardado (adminFinData
// solo se actualiza al cargar la pestaña o con "↻ Actualizar") — el admin
// veía "Actualizado" un instante y luego, al reabrirse el modal con datos
// viejos, parecía que el estado "volvía" a Parcial/Pendiente. No era la fila
// del Sheet (que sí quedó bien) sino el modal mostrando una foto vieja.
function refrescarFinDataYReabrirPagosModal_() {
  const idxAbrir = pagoCurrentIdx, nombreAbrir = pagoCurrentNombre;
  const programa = pagoCurrentProgramKey || adminProgramaActivo;
  fetch(APPS_SCRIPT_URL + '?action=admin_financiero&token=' + encodeURIComponent(adminSessionToken) + '&programa=' + encodeURIComponent(programa) + '&_t=' + Date.now(), { redirect: 'follow' })
    .then(r => r.json())
    .then(fin => { if (fin && !fin.error) adminFinData = fin; })
    .catch(() => {})
    .finally(() => { openPagosModal(idxAbrir, nombreAbrir); });
}

// ── MODAL PAGOS ────────────────────────────────────────────────────────────────
function openPagosModal(idx, nombreOverride) {
  if (!isEditAdmin()) { alert('No tienes permisos de edición.'); return; }
  let nombre, tieneTiquete;
  let participanteNorm = null;
  if (idx >= 0 && adminData[idx]) {
    pagoCurrentIdx = idx;
    pagoCurrentNombre = null;
    const row = adminData[idx];
    const n = normalizeParticipant(row) || {};
    participanteNorm = n;
    nombre = n.nombre || row['Nombre'] || nombreOverride || '';
    tieneTiquete = (n.tiquete_aereo || '').toLowerCase().includes('con');
    pagoCurrentTipo = n.tipo || row['tipo'] || row['Tipo'] || '';
  } else {
    pagoCurrentIdx = -1;
    pagoCurrentNombre = nombreOverride || '';
    nombre = pagoCurrentNombre;
    tieneTiquete = true;
    // Buscar tipo en pagos_lista si no hay adminData
    pagoCurrentTipo = ((adminFinData && adminFinData.pagos_lista) || [])
      .find(p => normNombre(p.nombre) === normNombre(nombre))?.tipo || '';
  }
  if (!nombre) return;
  pagoCurrentTieneTiquete = tieneTiquete;
  pagoCurrentParticipanteNorm = participanteNorm;
  pagoCurrentProgramKey = (participanteNorm && participanteNorm.program_key) || adminProgramaActivo;

  const pagos = adminFinData && adminFinData.pagos_lista
    ? adminFinData.pagos_lista.filter(p => normNombre(p.nombre) === normNombre(nombre))
    : [];
  const pagosByTipo = {};
  pagos.forEach(p => { pagosByTipo[(p.notas||'').toLowerCase()] = p; });

  document.getElementById('pagos-modal-nombre').textContent = nombre;

  const tipoIcons = { Reserva: '🏦', Tiquete: '✈️', 'Pago Final': '✅' };
  const today = new Date().toISOString().split('T')[0];

  const fechaToInput = s => {
    if (!s) return today;
    const p = s.split('/');
    return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : s;
  };

  const inputStyle = 'width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-family:\'DM Sans\',sans-serif;font-size:14px;outline:none;box-sizing:border-box';
  const selectStyle = inputStyle + ';background:#fff';

  // Paquete ya guardado en cualquier pago de este participante (para pre-llenar filas sin pago).
  // Si no hay ninguno guardado todavía, el default sigue la regla: con tiquete
  // aéreo → Premium, sin tiquete → Estándar.
  const currentPaquete = Object.values(pagosByTipo).find(p => p.paquete && p.paquete !== '')?.paquete || (tieneTiquete ? 'Premium' : 'Estándar');

  document.getElementById('pagos-modal-body').innerHTML = ['Reserva', 'Tiquete', 'Pago Final'].map(tipo => {
    const ex = pagosByTipo[tipo.toLowerCase()] || null;
    const tid = tipo.replace(' ', '-').toLowerCase();
    const paqueteVal = ex ? ex.paquete : currentPaquete;
    const montoEsperadoPrevio = participanteNorm ? montoEsperadoEur_(tipo, participanteNorm) : 0;

    // Reserva (u otro concepto que no sea Tiquete) que este participante no
    // debe pagar — ej. acompañante "solo actividades" con reserva en 0 — no
    // se muestra en absoluto, igual que ya pasaba con el Tiquete cuando no
    // está incluido. El Tiquete es distinto porque sí se puede "activar" a
    // mano (botón de abajo); Reserva/Pago Final no, así que si no debe nada
    // y no tiene ningún pago previo, la sección se oculta directamente.
    // Solo se oculta cuando SÍ sabemos con certeza que no debe nada
    // (participanteNorm disponible) — si el modal se abrió sin poder
    // resolver el participante (ej. por nombre suelto, sin fila en
    // adminData), no hay forma de calcular el monto esperado, así que por
    // seguridad se sigue mostrando la sección en vez de ocultarla a ciegas.
    if (tipo !== 'Tiquete' && participanteNorm && montoEsperadoPrevio <= 0 && !ex) return '';

    if (tipo === 'Tiquete' && !tieneTiquete && !ex) {
      return `<div style="border:1px dashed var(--border);border-radius:10px;padding:18px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="font-weight:600;color:var(--muted);font-size:14px">✈️ Tiquete aéreo</div>
          <span style="font-size:11px;background:#f1f5f9;color:var(--muted);padding:3px 10px;border-radius:10px;font-weight:500">No incluido</span>
        </div>
        <div id="tiquete-locked" style="margin-top:12px">
          <p style="font-size:13px;color:var(--muted);margin:0 0 10px">Este participante no tiene tiquete aéreo en su paquete.</p>
          <button onclick="activarTiquete()" style="padding:9px 16px;background:#f1f5f9;color:var(--navy);border:1px solid var(--border);border-radius:8px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:500;cursor:pointer">+ Activar tiquete aéreo</button>
        </div>
        <div id="tiquete-form" style="display:none;margin-top:14px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
            <div><div class="clabel">Fecha</div><input type="date" id="pago-tiquete-fecha" value="${today}" style="${inputStyle}"></div>
            <div><div class="clabel">Estado</div><select id="pago-tiquete-estado" style="${selectStyle}"><option>Parcial</option><option selected>Completo</option></select></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
            <div><div class="clabel">Valor EUR</div><input type="number" id="pago-tiquete-eur" placeholder="993" style="${inputStyle}"></div>
            <div><div class="clabel">Valor COP</div><input type="number" id="pago-tiquete-cop" placeholder="4257984" style="${inputStyle}"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
            <div><div class="clabel">Método de pago</div><select id="pago-tiquete-metodo" style="${selectStyle}"><option value="transferencia" selected>Transferencia</option><option value="tarjeta">Tarjeta (recargo 3,5%)</option></select></div>
            <div><div class="clabel">Paquete</div><select id="pago-tiquete-paquete" onchange="syncPaqueteModal(this.value)" style="${selectStyle}"><option${currentPaquete!=='Premium'?' selected':''}>Estándar</option><option${currentPaquete==='Premium'?' selected':''}>Premium</option></select></div>
          </div>
          <button onclick="registrarPagoDesdePanel('Tiquete')" style="width:100%;padding:11px;background:var(--blue);color:#fff;border:none;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:500;cursor:pointer">Registrar pago de Tiquete</button>
        </div>
      </div>`;
    }

    const estadoActual = ex ? ex.estado : 'Completo';
    const esPendienteConfirmar = estadoActual.toLowerCase().trim() === 'pendiente de confirmar';
    const esCompleto = estadoActual.toLowerCase().trim() === 'completo';
    const historialEntradas = ex ? parseHistorialAbonosFrontend_(ex.historial_abonos) : [];
    const tieneHistorial = historialEntradas.length > 0;
    // Barras de solo lectura solo en el estado "en reposo" (Parcial/Completo)
    // CON historial ya registrado — mientras está Pendiente de confirmar,
    // siguen editables para poder corregir el monto antes de confirmar.
    const barrasReadonly = tieneHistorial && !esPendienteConfirmar;
    const readonlyAttr = barrasReadonly ? 'readonly' : '';
    const readonlyStyle = barrasReadonly ? 'background:#f1f5f9;color:var(--muted)' : '';
    // Monto EUR esperado para este concepto según el tipo de participante —
    // permite auto-seleccionar Completo/Parcial mientras el admin escribe,
    // sin necesidad de elegir el estado a mano. También aplica en "Pendiente
    // de confirmar": si el admin edita el monto (ej. para corregir lo que
    // detectó la IA), el estado se recalcula en vivo en vez de quedar fijo.
    // No aplica cuando el campo está en solo lectura (ya hay historial acumulado).
    const montoEsperado = montoEsperadoPrevio;
    const wireAutoEstado = !barrasReadonly && montoEsperado > 0;
    // "+ Agregar abono" solo tiene sentido mientras el pago sigue Parcial —
    // no debe verse ni en Pendiente de confirmar (ahí aparece "Confirmar
    // pago" en su lugar) ni en Completo (ya no hay nada que agregar).
    const mostrarAgregarAbono = ex && !esPendienteConfirmar && !esCompleto;
    const statusColor = !ex ? '#92400e' : esPendienteConfirmar ? 'var(--blue)' : '#166534';
    const statusText = !ex ? 'Pendiente' : (esPendienteConfirmar ? '⏳ Pendiente de confirmar' : '✓ Registrado') + ` · ${ex.fecha} · ${ex.eur.toLocaleString('es-CO')}€`;
    const iaLine = (esPendienteConfirmar && ex && ex.ia_status)
      ? `<div style="margin-bottom:10px">${iaBadge(ex.ia_status, ex.ia_detalle, ex.eur, ex.cop)}</div>`
      : '';
    const urlsComprobanteEx = (ex && ex.comprobante_url) ? ex.comprobante_url.split('\n').filter(Boolean) : [];
    const comprobanteLink = urlsComprobanteEx.length
      ? urlsComprobanteEx.map((url, i) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--blue);text-decoration:underline;margin-bottom:6px;display:inline-block">📎 Ver comprobante${urlsComprobanteEx.length > 1 ? ' ' + (i + 1) : ''} subido por el participante</a><br>`).join('')
      : '';
    // Valor EUR/COP en la hoja (ex.eur/ex.cop) = lo REALMENTE pagado (bruto,
    // incl. el 3,5% de recargo de Bold si fue con tarjeta), YA sumado y YA
    // corregido contra lo detectado por la IA — el backend
    // (aplicarPagoAFilaParticipante_ + factorDistribucion en
    // marcarComprobanteSubido) aplica esa corrección antes de guardar la fila,
    // incluida la repartición proporcional cuando el comprobante cubre a
    // VARIOS participantes del mismo grupo (ver `distribucion`). Antes este
    // modal RECALCULABA eur/cop a partir de ex.ia_detalle (el detalle de la
    // IA), pero ese detalle guarda el monto TOTAL del comprobante — igual en
    // la fila de cada participante del grupo — así que para un pago conjunto
    // el recálculo terminaba mostrando (y al confirmar, escribiendo) el total
    // combinado en la fila de CADA participante en vez de su porción. Usar
    // ex.eur/ex.cop directamente evita ese doble cálculo y coincide con lo que
    // ya quedó bien repartido en la hoja.
    let eurMostrado = ex ? ex.eur : '';
    let copMostrado = ex ? ex.cop : '';
    // Si el pago quedó "Pendiente de confirmar" y la IA detectó (o el admin
    // ya corrigió) un monto MENOR al esperado, el estado a preseleccionar es
    // "Parcial", no "Completo" — antes el botón "Confirmar pago" forzaba
    // siempre "Completo" sin mirar el monto, así que un abono parcial menor
    // (ej. comprobante detectado por la IA como inferior a lo esperado)
    // terminaba marcado como pago completo por error.
    const estadoAutoPendiente = (esPendienteConfirmar && montoEsperado > 0 && eurMostrado > 0)
      ? ((eurMostrado > montoEsperado || Math.abs(eurMostrado - montoEsperado) <= 1) ? 'Completo' : 'Parcial')
      : null;
    const estadoSeleccionado = esPendienteConfirmar
      ? (estadoAutoPendiente || 'Pendiente de confirmar')
      : (estadoActual === 'Parcial' ? 'Parcial' : 'Completo');
    // Normalmente la celda "Metodo de pago" (de la fila, o de cada abono
    // dentro del historial) solo dice "tarjeta" (recargo estándar 3,5%).
    // Para casos puntuales con un recargo real distinto (ej. pagos antiguos
    // con el 3% que cobraba Bold antes) se puede escribir "tarjeta 3%" —
    // ver recargoTarjetaDeCelda_ en el backend, que aplica la misma lógica.
    const metodoPagoStr = (ex && ex.metodo_pago) ? String(ex.metodo_pago).trim().toLowerCase() : '';
    const esPagoTarjeta = metodoPagoStr.indexOf('tarjeta') === 0;
    const recargoDeMetodo = (m) => {
      const match = String(m || '').toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*%/);
      return match ? parseFloat(match[1].replace(',', '.')) / 100 : RECARGO_TARJETA_PCT;
    };
    // Si hay historial con varios abonos, cada uno puede tener su propio
    // método (ej. primero transferencia, después un segundo abono con
    // tarjeta) — el desglose se calcula ENTRADA POR ENTRADA, igual que
    // getAbonosValidados_() en el backend, en vez de aplicar un solo recargo
    // sobre el total de la fila.
    const entradasParaComision = tieneHistorial
      ? historialEntradas
      : (ex && ex.eur > 0 ? [{ eur: ex.eur, cop: ex.cop, metodo: metodoPagoStr }] : []);
    let totalBase = 0, totalComision = 0, totalBruto = 0, totalBrutoCop = 0, totalBaseCop = 0, totalComisionCop = 0, hayTarjeta = false;
    entradasParaComision.forEach(en => {
      const metodoEn = (en.metodo || metodoPagoStr || '').toLowerCase();
      const esTC = metodoEn.indexOf('tarjeta') === 0;
      const recargo = esTC ? recargoDeMetodo(metodoEn) : 0;
      const base = esTC ? en.eur / (1 + recargo) : en.eur;
      const baseCop = en.cop > 0 ? (esTC ? en.cop / (1 + recargo) : en.cop) : 0;
      if (esTC) hayTarjeta = true;
      totalBase += base;
      totalComision += en.eur - base;
      totalBruto += en.eur;
      totalBrutoCop += en.cop || 0;
      totalBaseCop += baseCop;
      totalComisionCop += (en.cop || 0) - baseCop;
    });
    const montoRealTarjetaLine = hayTarjeta
      ? (() => {
          const base = Math.round(totalBase * 100) / 100;
          const comision = Math.round(totalComision * 100) / 100;
          const baseCop = Math.round(totalBaseCop);
          const comisionCop = Math.round(totalComisionCop);
          return `<div style="margin-bottom:10px;padding:8px 10px;background:rgba(217,119,6,.08);border-radius:8px;font-size:11px;color:#92400e">
            💳 Incluye pago(s) con tarjeta — total pagado: <strong>${totalBruto.toLocaleString('es-CO')} EUR${totalBrutoCop ? ' / ' + totalBrutoCop.toLocaleString('es-CO') + ' COP' : ''}</strong>
            = monto del programa <strong>${base.toLocaleString('es-CO')} EUR${baseCop ? ' / ' + baseCop.toLocaleString('es-CO') + ' COP' : ''}</strong>
            + comisión Bold <strong>${comision.toLocaleString('es-CO')} EUR${comisionCop ? ' / ' + comisionCop.toLocaleString('es-CO') + ' COP' : ''}</strong>
            — la comisión no cuenta para el saldo del cliente, solo para contabilidad interna.
          </div>`;
        })()
      : '';
    // Resumen de abonos — solo se muestra si hay historial registrado.
    const resumenAbonos = tieneHistorial ? `<div style="border:1px solid var(--gborder,var(--border));border-radius:10px;overflow:hidden;margin-bottom:12px">
        <div style="background:var(--gbg,#f4f7fb);padding:10px 14px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted)">
          ${historialEntradas.length > 1 ? 'Abonos registrados' : 'Pago registrado'}
        </div>
        <div style="padding:6px 14px 10px">
          ${historialEntradas.map(a => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--navy);padding:4px 0;border-bottom:1px dashed var(--border)">
            <span>${escapeHtml(a.fecha)}${a.metodo ? ` <span style="color:var(--muted)">· ${a.metodo.toLowerCase().indexOf('tarjeta')===0 ? '💳 tarjeta' : '🏦 transferencia'}</span>` : ''}</span><span>${a.eur.toLocaleString('es-CO')} EUR${a.cop ? ' · $' + a.cop.toLocaleString('es-CO') + ' COP' : ''}</span>
          </div>`).join('')}
        </div>
      </div>` : '';
    // Botón para deshacer la activación del tiquete — solo tiene sentido para
    // el concepto Tiquete, mientras esté activado (tieneTiquete) y todavía no
    // tenga ningún pago registrado (!ex). Si ya hay un pago, desactivar aquí
    // dejaría un pago huérfano sin el flag que lo justifica.
    const quitarTiqueteBtn = (tipo === 'Tiquete' && tieneTiquete && !ex)
      ? `<button onclick="quitarTiquete()" style="font-size:11px;background:none;border:none;color:#dc2626;text-decoration:underline;cursor:pointer;padding:0;font-family:'DM Sans',sans-serif">Quitar tiquete aéreo</button>`
      : '';
    return `<div style="border:1px solid var(--border);border-radius:10px;padding:18px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="font-weight:600;color:var(--navy);font-size:14px">${tipoIcons[tipo] || '💳'} ${tipo}</div>
        <div style="display:flex;align-items:center;gap:10px">
          ${quitarTiqueteBtn}
          <div style="font-size:12px;color:${statusColor};font-weight:500">${statusText}</div>
        </div>
      </div>
      ${iaLine}
      ${montoRealTarjetaLine}
      ${comprobanteLink}
      ${resumenAbonos}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div><div class="clabel">Fecha</div><input type="date" id="pago-${tid}-fecha" value="${fechaToInput(ex ? ex.fecha : '')}" style="${inputStyle}" ${barrasReadonly ? 'readonly' : ''}></div>
        <div><div class="clabel">Estado</div><select id="pago-${tid}-estado" style="${selectStyle}">
          <option${estadoSeleccionado==='Parcial'?' selected':''}>Parcial</option>
          <option${estadoSeleccionado==='Pendiente de confirmar'?' selected':''}>Pendiente de confirmar</option>
          <option${estadoSeleccionado==='Completo'?' selected':''}>Completo</option>
        </select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:${barrasReadonly ? '4' : '10'}px">
        <div><div class="clabel">Valor EUR${barrasReadonly ? ' (total acumulado)' : ''}</div><input type="number" id="pago-${tid}-eur" value="${eurMostrado}" placeholder="1000" style="${inputStyle};${readonlyStyle}" ${readonlyAttr} ${wireAutoEstado ? `oninput="actualizarEstadoAuto_('${tid}', ${montoEsperado})"` : ''}></div>
        <div><div class="clabel">Valor COP${barrasReadonly ? ' (total acumulado)' : ''}</div><input type="number" id="pago-${tid}-cop" value="${copMostrado}" placeholder="4350000" style="${inputStyle};${readonlyStyle}" ${readonlyAttr}></div>
      </div>
      ${barrasReadonly ? `<div id="pago-${tid}-editar-link" style="margin-bottom:10px">
        <button type="button" onclick="habilitarEdicionMonto_('${tid}')" style="font-size:11px;background:none;border:none;color:var(--blue);text-decoration:underline;cursor:pointer;padding:0;font-family:'DM Sans',sans-serif">✏️ Editar monto ya registrado</button>
      </div>
      <div id="pago-${tid}-aviso-correccion" style="display:none;font-size:11px;color:#92400e;background:rgba(217,119,6,.08);border-radius:6px;padding:6px 10px;margin-bottom:10px">Al guardar, este valor reemplaza el total y el historial de abonos acumulado por una sola entrada corregida — no se puede deshacer.</div>` : ''}
      ${mostrarAgregarAbono ? `<div style="display:flex;align-items:flex-end;gap:8px;margin-bottom:10px;padding:10px;background:var(--off);border-radius:8px;flex-wrap:wrap">
        <div style="flex:1;min-width:100px"><div class="clabel">Fecha del abono</div><input type="date" id="pago-${tid}-abono-add-fecha" value="${today}" style="${inputStyle}"></div>
        <div style="flex:1;min-width:110px"><div class="clabel">+ Abono (EUR)</div><input type="number" id="pago-${tid}-abono-add" placeholder="ej. 500" style="${inputStyle}"></div>
        <div style="flex:1;min-width:130px"><div class="clabel">+ COP real</div><input type="number" id="pago-${tid}-abono-add-cop" placeholder="del comprobante" style="${inputStyle}"></div>
        <button type="button" onclick="agregarAbonoServidor('${tid}','${tipo}')" style="padding:9px 14px;background:var(--navy);color:#fff;border:none;border-radius:7px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap">+ Agregar abono</button>
      </div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div><div class="clabel">Método de pago</div><select id="pago-${tid}-metodo" style="${selectStyle}">
          <option value="transferencia"${!esPagoTarjeta?' selected':''}>Transferencia</option>
          <option value="tarjeta"${esPagoTarjeta?' selected':''}>Tarjeta (recargo 3,5%)</option>
        </select></div>
        <div><div class="clabel">Paquete</div><select id="pago-${tid}-paquete" onchange="syncPaqueteModal(this.value)" style="${selectStyle}"><option${paqueteVal!=='Premium'?' selected':''}>Estándar</option><option${paqueteVal==='Premium'?' selected':''}>Premium</option></select></div>
      </div>
      ${esPendienteConfirmar ? `<button onclick="confirmarPagoDesdePanel('${tipo}')" style="width:100%;padding:11px;background:#166534;color:#fff;border:none;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:500;cursor:pointer">✓ Confirmar pago de ${tipo}</button>` : ''}
      ${(ex && !esPendienteConfirmar) ? `<button onclick="actualizarEstadoDesdePanel('${tipo}')" style="width:100%;padding:11px;background:var(--blue);color:#fff;border:none;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:500;cursor:pointer;margin-bottom:${barrasReadonly ? '8px' : '0'}">Actualizar estado/paquete</button>` : ''}
      ${!esPendienteConfirmar ? `<button id="pago-${tid}-guardar-correccion" onclick="registrarPagoDesdePanel('${tipo}')" style="width:100%;padding:11px;background:var(--blue);color:#fff;border:none;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:500;cursor:pointer;${(!ex || !barrasReadonly) ? '' : 'display:none'}">${ex ? 'Guardar corrección de ' + tipo : 'Registrar pago de ' + tipo}</button>` : ''}
    </div>`;
  }).join('');

  document.getElementById('pagos-modal-status').style.display = 'none';
  document.getElementById('pagos-modal').classList.add('open');
}

function closePagosModal() {
  document.getElementById('pagos-modal').classList.remove('open');
  pagoCurrentIdx = null;
  pagoCurrentNombre = null;
}

// Activa el tiquete aéreo del participante SIN registrar ningún pago — solo
// marca tiquete_aereo='Con tiquete' en su fila de Inscripción. Con eso: (1) el
// área personal del participante ya le muestra la sección de Tiquete para que
// pague y suba su comprobante cuando quiera, y (2) este modal deja de estar
// "bloqueado" para que, cuando llegue ese pago, se registre normalmente con
// "Registrar pago de Tiquete". Antes este botón solo mostraba el formulario
// sin guardar nada — el participante seguía apareciendo "Sin tiquete" hasta
// que efectivamente se registraba un pago.
function activarTiquete() {
  const row = pagoCurrentIdx >= 0 ? adminData[pagoCurrentIdx] : null;
  if (!row || !row._row) { alert('No se pudo identificar la fila del participante para activar el tiquete.'); return; }

  const statusEl = document.getElementById('pagos-modal-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Activando tiquete aéreo...</span>';

  fetch(APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'actualizar_participante', _row: row._row, programa: row._program_key || pagoCurrentProgramKey, tiquete_aereo: 'Con tiquete', token: adminSessionToken }),
    redirect: 'follow'
  })
  .then(r => r.json())
  .then(res => {
    if (!res.ok) { statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error || 'desconocido'}</span>`; return; }
    marcarTiqueteAereoLocal_(row);
    pagoCurrentTieneTiquete = true;
    if (pagoCurrentParticipanteNorm) pagoCurrentParticipanteNorm.tiquete_aereo = 'Con tiquete';
    statusEl.innerHTML = '<span style="color:#166534">✓ Tiquete activado — el participante ya puede pagarlo desde su área personal.</span>';
    setTimeout(() => { statusEl.style.display = 'none'; }, 2500);
    document.getElementById('tiquete-locked').style.display = 'none';
    document.getElementById('tiquete-form').style.display = '';
  })
  .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

// Sobrescribe en el objeto crudo de adminData la clave que realmente trae el
// campo Tiquete Aéreo — el header del Sheet varía ('Tiquete Aéreo',
// 'tiquete_aereo', etc., ver normalizeParticipant) — para que el cambio se
// refleje de inmediato en la UI sin esperar un recargo completo de adminData.
function marcarTiqueteAereoLocal_(row, valor) {
  if (!row) return;
  const candidatos = ['tiquete_aereo', 'tiquete aereo', 'Tiquete aéreo', 'Tiquete aereo', 'Tiquete', 'tiquete', 'vuelo', 'Vuelo'];
  const nkCandidatos = candidatos.map(normFieldName);
  const keyExistente = Object.keys(row).find(k => nkCandidatos.includes(normFieldName(k)));
  row[keyExistente || 'tiquete_aereo'] = valor || 'Con tiquete';
}

// Inverso de activarTiquete(): quita el tiquete aéreo de un participante que
// lo activó por error o se arrepintió ANTES de pagarlo — vuelve
// tiquete_aereo a 'Sin tiquete' en su fila de Inscripción. Solo se ofrece
// mientras no exista ningún pago de Tiquete registrado todavía (ver
// condición del botón en el template) — si ya hay un pago, primero hay que
// resolver ese pago aparte antes de desactivar el tiquete.
function quitarTiquete() {
  const row = pagoCurrentIdx >= 0 ? adminData[pagoCurrentIdx] : null;
  if (!row || !row._row) { alert('No se pudo identificar la fila del participante.'); return; }
  if (!confirm('¿Quitar el tiquete aéreo de este participante? Su área personal dejará de mostrarle esa sección de pago.')) return;

  const statusEl = document.getElementById('pagos-modal-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Quitando tiquete aéreo...</span>';

  fetch(APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'actualizar_participante', _row: row._row, programa: row._program_key || pagoCurrentProgramKey, tiquete_aereo: 'Sin tiquete', token: adminSessionToken }),
    redirect: 'follow'
  })
  .then(r => r.json())
  .then(res => {
    if (!res.ok) { statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error || 'desconocido'}</span>`; return; }
    marcarTiqueteAereoLocal_(row, 'Sin tiquete');
    pagoCurrentTieneTiquete = false;
    if (pagoCurrentParticipanteNorm) pagoCurrentParticipanteNorm.tiquete_aereo = 'Sin tiquete';
    statusEl.style.display = 'none';
    openPagosModal(pagoCurrentIdx, pagoCurrentNombre);
  })
  .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

// Suma un abono adicional al monto ya cargado en los campos Valor EUR/COP del
// modal, en vez de que el admin tenga que calcular la suma a mano y sobreescribir
// el campo. EUR y COP son OBLIGATORIOS — se exige el COP real del comprobante
// (no se estima) porque cada abono puede haberse pagado a una tasa distinta, y
// como al congelar el pago para el participante la tasa mostrada se calcula como
// COP total / EUR total (ver aplicarCongelamiento), mantener aquí el COP real
// acumulado hace que esa tasa congelada quede como la media ponderada real de
// todos los abonos.
function agregarAbonoServidor(tid, tipo) {
  const fechaEl = document.getElementById(`pago-${tid}-abono-add-fecha`);
  const abonoEl = document.getElementById(`pago-${tid}-abono-add`);
  const abonoCopEl = document.getElementById(`pago-${tid}-abono-add-cop`);
  if (!fechaEl || !abonoEl || !abonoCopEl) return;
  const fecha = fechaEl.value;
  const abonoEur = parseFloat(abonoEl.value) || 0;
  const abonoCop = parseFloat(abonoCopEl.value) || 0;
  if (!fecha || abonoEur <= 0) { alert('Escribe la fecha y el monto en EUR del abono a agregar.'); return; }

  let nombre = pagoCurrentIdx >= 0 && adminData[pagoCurrentIdx]
    ? (normalizeParticipant(adminData[pagoCurrentIdx]) || {}).nombre || adminData[pagoCurrentIdx]['Nombre'] || ''
    : (pagoCurrentNombre || '');
  if (!nombre) return;
  const metodoEl = document.getElementById(`pago-${tid}-metodo`);
  const metodoPago = metodoEl ? metodoEl.value : 'transferencia';
  const esperadoEur = pagoCurrentParticipanteNorm ? montoEsperadoEur_(tipo, pagoCurrentParticipanteNorm) : null;

  const statusEl = document.getElementById('pagos-modal-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Guardando abono...</span>';

  fetch(APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'agregar_abono_pago', nombre, tipo, fecha, eur: abonoEur, cop: abonoCop, metodo_pago: metodoPago, esperado_eur: esperadoEur, tipo_participante: pagoCurrentTipo, programa: pagoCurrentProgramKey, token: adminSessionToken }),
    redirect: 'follow'
  })
  .then(r => r.json())
  .then(res => {
    if (res.ok) {
      statusEl.innerHTML = '<span style="color:#166534">✓ Abono agregado.</span>';
      setTimeout(() => { refrescarFinDataYReabrirPagosModal_(); statusEl.style.display = 'none'; }, 700);
    } else {
      statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error || 'desconocido'}</span>`;
    }
  })
  .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

function confirmarPagoDesdePanel(tipo) {
  let nombre = pagoCurrentIdx >= 0 && adminData[pagoCurrentIdx]
    ? (normalizeParticipant(adminData[pagoCurrentIdx]) || {}).nombre || adminData[pagoCurrentIdx]['Nombre'] || ''
    : (pagoCurrentNombre || '');
  if (!nombre) return;
  const tid = tipo.replace(' ', '-').toLowerCase();

  const fecha = document.getElementById(`pago-${tid}-fecha`).value;
  const eur = parseFloat(document.getElementById(`pago-${tid}-eur`).value) || 0;
  const cop = parseFloat(document.getElementById(`pago-${tid}-cop`).value) || 0;
  const estadoEl = document.getElementById(`pago-${tid}-estado`);
  const paquete = document.getElementById(`pago-${tid}-paquete`).value;
  const metodoEl = document.getElementById(`pago-${tid}-metodo`);
  const metodoPago = metodoEl ? metodoEl.value : 'transferencia';
  if (!fecha || eur <= 0) { alert('Ingresa al menos la fecha y el valor en EUR.'); return; }
  // El estado ya viene preseleccionado como Parcial/Completo según el monto
  // detectado (ver estadoAutoPendiente en openPagosModal) y se recalcula en
  // vivo si el admin edita el EUR (actualizarEstadoAuto_) — ya NO se fuerza
  // "Completo" a ciegas, porque un abono parcial (ej. la IA detectó un monto
  // menor al esperado) terminaba marcado como pago completo por error. Si
  // sigue en "Pendiente de confirmar" es porque no hay monto esperado con
  // qué comparar — se le pide al admin que elija a mano.
  if (estadoEl.value.toLowerCase() === 'pendiente de confirmar') {
    alert('Selecciona si el pago quedó Parcial o Completo antes de confirmar.');
    return;
  }
  const estado = estadoEl.value;
  const esperadoEur = pagoCurrentParticipanteNorm ? montoEsperadoEur_(tipo, pagoCurrentParticipanteNorm) : null;

  const statusEl = document.getElementById('pagos-modal-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Confirmando...</span>';

  // Una sola llamada que CORRIGE la entrada pendiente (en vez de agregar_abono_pago
  // + actualizar_estado_pago por separado) — esas dos acciones encadenadas
  // duplicaban el monto: la primera agregaba el valor del modal como una
  // entrada NUEVA encima de la que ya había quedado "Pendiente de confirmar"
  // tras la subida del comprobante, así que el correo (y la hoja) terminaban
  // sumando el mismo pago dos veces.
  fetch(APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'confirmar_pago_pendiente', nombre, tipo, fecha, eur, cop, estado, paquete, metodo_pago: metodoPago, esperado_eur: esperadoEur, tipo_participante: pagoCurrentTipo, programa: pagoCurrentProgramKey, token: adminSessionToken }),
    redirect: 'follow'
  })
  .then(r => r.json())
  .then(res => {
    if (res.ok) {
      statusEl.innerHTML = '<span style="color:#166534">✓ Pago confirmado.</span>';
      setTimeout(() => { refrescarFinDataYReabrirPagosModal_(); statusEl.style.display = 'none'; }, 2200);
    } else {
      statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error || 'desconocido'}</span>`;
    }
  })
  .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

// Desbloquea la barra "Valor EUR/COP (total acumulado)" de un concepto ya
// Completo/Parcial (con historial) para permitir corregir el monto — por
// defecto queda en solo lectura para no editar por accidente un pago ya
// validado. Al guardar, registrarPagoDesdePanel() reutiliza la misma acción
// que registra un pago nuevo (registrar_pago): el backend encuentra la fila
// existente de este participante+concepto y la SOBRESCRIBE por completo,
// incluido el historial de abonos (que queda reducido a esta única entrada
// corregida) — por eso la advertencia antes de desbloquear.
function habilitarEdicionMonto_(tid) {
  const ok = confirm('Vas a editar un pago ya registrado.\n\nAl guardar, el nuevo valor reemplaza el total y el historial de abonos acumulado por una sola entrada corregida — no se puede deshacer.\n\n¿Continuar?');
  if (!ok) return;
  ['fecha', 'eur', 'cop'].forEach(suf => {
    const el = document.getElementById(`pago-${tid}-${suf}`);
    if (el) { el.removeAttribute('readonly'); el.style.background = ''; el.style.color = ''; }
  });
  const linkEditar = document.getElementById(`pago-${tid}-editar-link`);
  if (linkEditar) linkEditar.style.display = 'none';
  const aviso = document.getElementById(`pago-${tid}-aviso-correccion`);
  if (aviso) aviso.style.display = 'block';
  const btnGuardar = document.getElementById(`pago-${tid}-guardar-correccion`);
  if (btnGuardar) btnGuardar.style.display = 'block';
}

function actualizarEstadoDesdePanel(tipo) {
  let nombre = pagoCurrentIdx >= 0 && adminData[pagoCurrentIdx]
    ? (normalizeParticipant(adminData[pagoCurrentIdx]) || {}).nombre || adminData[pagoCurrentIdx]['Nombre'] || ''
    : (pagoCurrentNombre || '');
  if (!nombre) return;
  const tid = tipo.replace(' ', '-').toLowerCase();
  const estado = document.getElementById(`pago-${tid}-estado`).value;
  const paquete = document.getElementById(`pago-${tid}-paquete`).value;
  const esperadoEur = pagoCurrentParticipanteNorm ? montoEsperadoEur_(tipo, pagoCurrentParticipanteNorm) : null;

  const statusEl = document.getElementById('pagos-modal-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Actualizando...</span>';

  fetch(APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'actualizar_estado_pago', nombre, tipo, estado, paquete, esperado_eur: esperadoEur, programa: pagoCurrentProgramKey, token: adminSessionToken }),
    redirect: 'follow'
  })
  .then(r => r.json())
  .then(res => {
    if (res.ok) {
      statusEl.innerHTML = '<span style="color:#166534">✓ Actualizado.</span>';
      setTimeout(() => { refrescarFinDataYReabrirPagosModal_(); statusEl.style.display = 'none'; }, 700);
    } else {
      statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error || 'desconocido'}</span>`;
    }
  })
  .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

function registrarPagoDesdePanel(tipo) {
  let nombre, email = '', participanteActual = null;
  if (pagoCurrentIdx >= 0 && adminData[pagoCurrentIdx]) {
    const row = adminData[pagoCurrentIdx];
    const n = normalizeParticipant(row) || {};
    participanteActual = n;
    nombre = n.nombre || row['Nombre'] || '';
    email = n.email || '';
  } else {
    nombre = pagoCurrentNombre || '';
    // Fallback: buscar email por nombre en adminData
    const match = (adminData || []).find(r => {
      const n = normalizeParticipant(r) || {};
      return normNombre(n.nombre || r['Nombre'] || '') === normNombre(nombre);
    });
    if (match) email = (normalizeParticipant(match) || {}).email || '';
  }
  if (!nombre) return;
  const tid = tipo.replace(' ', '-').toLowerCase();

  const fecha = document.getElementById(`pago-${tid}-fecha`).value;
  const eur = parseFloat(document.getElementById(`pago-${tid}-eur`).value) || 0;
  const cop = parseFloat(document.getElementById(`pago-${tid}-cop`).value) || 0;
  const estado = document.getElementById(`pago-${tid}-estado`).value;
  const paquete = document.getElementById(`pago-${tid}-paquete`).value;
  const metodoEl = document.getElementById(`pago-${tid}-metodo`);
  const metodoPago = metodoEl ? metodoEl.value : 'transferencia';
  const esperadoEur = participanteActual ? montoEsperadoEur_(tipo, participanteActual) : null;

  if (!fecha || !eur) { alert('Ingresa al menos la fecha y el valor en EUR.'); return; }

  const statusEl = document.getElementById('pagos-modal-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Guardando...</span>';

  fetch(APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'registrar_pago', nombre, tipo, fecha, eur, cop, estado, paquete, metodo_pago: metodoPago, esperado_eur: esperadoEur, tipo_participante: pagoCurrentTipo, programa: pagoCurrentProgramKey, token: adminSessionToken }),
    redirect: 'follow'
  })
  .then(r => r.json())
  .then(res => {
    if (res.ok) {
      statusEl.innerHTML = '<span style="color:#166534">✓ Guardado correctamente.</span>';

      // Registrar un pago de Tiquete NO activa por sí solo el campo "Tiquete
      // Aéreo" del participante (son dos cosas distintas: la fila de pago vs.
      // la fila del participante) — el botón "+ Activar tiquete aéreo" solo
      // mostraba el formulario sin persistir nada, así que el participante
      // seguía apareciendo como "Sin tiquete" aunque ya tuviera el pago
      // registrado. Al confirmar el pago de Tiquete para alguien que no lo
      // tenía, se marca explícitamente en el Sheet vía actualizar_participante.
      if (tipo === 'Tiquete' && !pagoCurrentTieneTiquete) {
        const rowTiquete = pagoCurrentIdx >= 0 && adminData[pagoCurrentIdx]
          ? adminData[pagoCurrentIdx]
          : (adminData || []).find(r => normNombre((normalizeParticipant(r) || {}).nombre || r['Nombre'] || '') === normNombre(nombre));
        if (rowTiquete && rowTiquete._row) {
          fetch(APPS_SCRIPT_URL, {
            method: 'POST', headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action: 'actualizar_participante', _row: rowTiquete._row, programa: rowTiquete._program_key || pagoCurrentProgramKey, tiquete_aereo: 'Con tiquete', token: adminSessionToken }),
            redirect: 'follow'
          }).catch(() => {});
          marcarTiqueteAereoLocal_(rowTiquete);
        }
        pagoCurrentTieneTiquete = true;
        if (pagoCurrentParticipanteNorm) pagoCurrentParticipanteNorm.tiquete_aereo = 'Con tiquete';
        if (participanteActual) participanteActual.tiquete_aereo = 'Con tiquete';
      }

      // Actualizar caché local para que el modal se refresque
      if (adminFinData && adminFinData.pagos_lista) {
        const fmtFecha = fecha.split('-').reverse().join('/');
        const i = adminFinData.pagos_lista.findIndex(p =>
          normNombre(p.nombre) === normNombre(nombre) &&
          (p.notas||'').toLowerCase() === tipo.toLowerCase()
        );
        const np = { nombre, fecha: fmtFecha, cop, eur, estado, paquete, notas: tipo, metodo_pago: metodoPago };
        if (i >= 0) adminFinData.pagos_lista[i] = np;
        else adminFinData.pagos_lista.push(np);
        // Sync paquete in cache across all rows of this participant
        adminFinData.pagos_lista.forEach(p => {
          if (normNombre(p.nombre) === normNombre(nombre)) p.paquete = paquete;
        });
        renderAdminPagos(adminFinData);
        reapplyPagosFilter();
        if (typeof renderAdminDashboard === 'function') renderAdminDashboard(adminData, adminFinData);
      }
      // Pago marcado como Completo → avanzar paso_actual del participante (igual que cuando él mismo sube su comprobante)
      const pasoMap = { 'Reserva': 4, 'Tiquete': 5, 'Pago Final': 6 };
      let nuevoPaso = pasoMap[tipo];
      // World Challenge, pago único (Solo Actividades/Solo World Challenge): no hay Pago Final — salta directo a Documentación
      const sinFinalActual = participanteActual ? montoReservaFinalParticipante_(participanteActual, pagoCurrentProgramKey === 'world_challenge').final === 0 : false;
      if (tipo === 'Reserva' && !pagoCurrentTieneTiquete) nuevoPaso = sinFinalActual ? 6 : 5; // sin tiquete: salta directo al siguiente paso pendiente
      if (tipo === 'Tiquete' && sinFinalActual) nuevoPaso = 6; // sin pago final: salta a Documentación
      if (estado === 'Completo' && email && nuevoPaso) {
        fetch(APPS_SCRIPT_URL, {
          method: 'POST', headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'actualizar_paso', email, paso_actual: String(nuevoPaso), programa: pagoCurrentProgramKey })
        }).then(() => {
          (adminData || []).forEach(r => {
            const n = normalizeParticipant(r) || {};
            if (n.email === email) {
              const actual = parseInt(n.paso_actual) || 1;
              if (nuevoPaso > actual) r['paso_actual'] = String(nuevoPaso);
            }
          });
          filterAdminTable();
          if (typeof renderAdminDashboard === 'function') renderAdminDashboard(adminData, adminFinData);
        }).catch(() => {});
      }
      setTimeout(() => { refrescarFinDataYReabrirPagosModal_(); statusEl.style.display = 'none'; }, 700);
    } else {
      statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error || 'desconocido'}</span>`;
    }
  })
  .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

function saveEditModal() {
  if (!adminCurrentRow) return;
  const statusEl = document.getElementById('edit-modal-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Guardando...</span>';
  const payload = { action: 'actualizar_participante', _row: adminCurrentRow._row, programa: adminCurrentRow._program_key || adminProgramaActivo, token: adminSessionToken };
  // Pass all original keys so backend can match column headers
  Object.keys(adminCurrentRow).forEach(k => { if (k !== '_idx') payload[k] = adminCurrentRow[k]; });
  // Override with edited values using normalized key names
  const n2 = normalizeParticipant(adminCurrentRow) || {};
  const esJugador2 = (n2.tipo || '').toLowerCase().includes('jug');
  getEditFields(esJugador2).forEach(f => {
    const el = document.getElementById('ef-' + f.key);
    if (el) payload[f.key] = el.value;
  });
  fetch(APPS_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify(payload), redirect:'follow' })
    .then(r => r.json())
    .then(res => {
      if (res.ok) {
        statusEl.innerHTML = '<span style="color:var(--green)">Guardado correctamente.</span>';
        const editedRow = adminData[adminCurrentRow._idx];
        EDIT_FIELDS.forEach(f => {
          const el = document.getElementById('ef-' + f.key);
          if (!el) return;
          const val = el.value;
          editedRow[f.key] = val;
          // También actualiza la clave original del Sheet (puede tener tildes/mayúsculas)
          const normTarget = f.key.toLowerCase().replace(/[\s_]+/g, '_');
          Object.keys(editedRow).forEach(k => {
            if (k !== f.key) {
              const normK = k.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[\s_]+/g,'_');
              if (normK === normTarget) editedRow[k] = val;
            }
          });
        });
        // Resolver alianza_nombre/alianza_precio_total localmente contra el
        // catálogo ya cargado, para que la tabla y el Pago Final reflejen el
        // cambio de inmediato sin esperar a un loadAdmin(true).
        const alianzaEl2 = document.getElementById('ef-alianza');
        if (alianzaEl2) {
          const infoAlianza = adminAlianzasCatalogo.find(a => a.nombre === alianzaEl2.value);
          editedRow.alianza_nombre = infoAlianza ? infoAlianza.nombre : '';
          editedRow.alianza_precio_total = infoAlianza ? String(infoAlianza.precioTotal) : '';
        }
        filterAdminTable();
        if (typeof renderAdminDashboard === 'function') renderAdminDashboard(adminData, adminFinData);
        if (typeof renderAdminPagos === 'function' && adminFinData) { renderAdminPagos(adminFinData); reapplyPagosFilter(); }
        setTimeout(closeEditModal, 1200);
      } else {
        statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error || 'desconocido'}</span>`;
      }
    })
    .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

function switchParticipantesTab(tab) {
  document.getElementById('ptab-content-lista').style.display       = tab === 'lista'      ? '' : 'none';
  document.getElementById('ptab-content-categorias').style.display  = tab === 'categorias' ? '' : 'none';
  const btnLista = document.getElementById('ptab-lista');
  const btnCat   = document.getElementById('ptab-categorias');
  if (btnLista) { btnLista.style.background = tab==='lista'?'var(--blue)':'#fff'; btnLista.style.color = tab==='lista'?'#fff':'var(--muted)'; btnLista.style.borderColor = tab==='lista'?'var(--blue)':'var(--border)'; }
  if (btnCat)   { btnCat.style.background   = tab==='categorias'?'var(--blue)':'#fff'; btnCat.style.color = tab==='categorias'?'#fff':'var(--muted)'; btnCat.style.borderColor = tab==='categorias'?'var(--blue)':'var(--border)'; }
  if (tab === 'categorias') buildCategorias();
}

function parseFechaNacFront(v) {
  if (!v || v === '—') return null;
  var s = String(v).trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) { var p=s.split('-'); return {anio:+p[0],mes:+p[1],dia:+p[2]}; }
  if (s.indexOf('/')>=0) { var p2=s.split('/'); if(p2.length===3){ var a=+p2[2],m=+p2[1],d=+p2[0]; if(a>1900) return {anio:a,mes:m,dia:d}; } }
  return null;
}

function calcEdadRefFront(f) {
  if (!f) return null;
  var edad = 2026 - f.anio;
  if (f.mes > 10 || (f.mes === 10 && f.dia > 2)) edad -= 1;
  return edad;
}

function renderParticipantesKPIs(data) {
  if (!data) return;
  let jugs = 0, acomps = 0, staff = 0;
  data.forEach(row => {
    const t = ((normalizeParticipant(row) || {}).tipo || '').toLowerCase();
    if (t.includes('jug')) jugs++;
    else if (t.includes('staff')) staff++;
    else acomps++;
  });
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('kpi-p-jugadores', jugs);
  set('kpi-p-acompanantes', acomps);
  set('kpi-p-staff', staff);
}

function buildCategorias() {
  const el = document.getElementById('admin-categorias-content');
  if (!el || !adminData || !adminData.length) { if(el) el.innerHTML='<p style="color:var(--muted);font-size:13px;">Sin datos de participantes.</p>'; return; }

  const yr = new Date().getFullYear();
  const CATS = ['Sub 18','Sub 16','Sub 14','Sub 12','Sub 10'];
  const catColors = {'Sub 18':'#1e5ba8','Sub 16':'#0d9488','Sub 14':'#7c3aed','Sub 12':'#ea580c','Sub 10':'#dc2626'};
  // Cortes por año de nacimiento: Sub N cubre nacidos en (yr-N) y (yr-N+1)
  function catDesdeAnio(anio) {
    if (anio === null) return 'Sub 18';
    if (anio >= yr-18 && anio <= yr-17) return 'Sub 18';
    if (anio >= yr-16 && anio <= yr-15) return 'Sub 16';
    if (anio >= yr-14 && anio <= yr-13) return 'Sub 14';
    if (anio >= yr-12 && anio <= yr-11) return 'Sub 12';
    if (anio >= yr-10 && anio <= yr-9)  return 'Sub 10';
    return anio < yr-18 ? 'Sub 18' : 'Sub 10'; // fuera de rango → categoría más cercana
  }
  const mkCatMap = () => ({'Sub 18':[],'Sub 16':[],'Sub 14':[],'Sub 12':[],'Sub 10':[]});
  const catMapGM    = mkCatMap();
  const catMapOtros = mkCatMap();

  adminData.forEach(row => {
    const n = normalizeParticipant(row) || {};
    if (!(n.tipo||'').toLowerCase().includes('jug')) return;

    const nombre = n.nombre || '';
    const fnRaw  = n.fecha_nacimiento || row['Fecha Nacimiento'] || row['fecha nacimiento'] || row['fecha_nacimiento'] || '';
    const fObj   = parseFechaNacFront(fnRaw);
    const edad   = calcEdadRefFront(fObj);
    const fnDisp = fObj ? String(fObj.dia).padStart(2,'0')+'/'+String(fObj.mes).padStart(2,'0')+'/'+fObj.anio : '—';
    const sort   = fObj ? fObj.anio*10000+fObj.mes*100+fObj.dia : 0;
    const club   = n.club_colegio || row['Club / Colegio'] || row['Club/Colegio'] || row['Colegio'] || row['Club'] || '';

    const cat = catDesdeAnio(fObj ? fObj.anio : null);

    const esGM = club.toLowerCase().includes('gimnasio moderno');
    (esGM ? catMapGM : catMapOtros)[cat].push({nombre, fnDisp, edad, club, sort});
  });

  function buildSchoolBlock(catMap, label, headerColor) {
    const total = CATS.reduce((s,c)=>s+catMap[c].length, 0);
    let html = `<div style="margin-bottom:28px">`;
    html += `<div style="background:${headerColor};color:#fff;border-radius:8px 8px 0 0;padding:12px 18px;font-weight:700;font-size:14px;letter-spacing:.5px">${label} <span style="opacity:.7;font-weight:400;font-size:12px">(${total} jugador${total!==1?'es':''})</span></div>`;
    html += '<table class="ptable" style="width:100%;border-radius:0 0 8px 8px;overflow:hidden"><thead><tr><th style="width:35%">Nombre</th><th>Colegio / Club</th><th>Fecha nac.</th><th style="text-align:center">Edad</th></tr></thead><tbody>';
    CATS.forEach(cat => {
      const color = catColors[cat];
      const jug   = catMap[cat].slice().sort((a,b)=>a.sort-b.sort);
      html += `<tr><td colspan="4" style="background:${color};color:#fff;font-weight:600;font-size:11px;letter-spacing:1px;padding:8px 16px;">${cat} <span style="opacity:.7;font-weight:400">(${jug.length})</span></td></tr>`;
      if (!jug.length) {
        html += `<tr><td colspan="4" style="color:var(--muted);font-size:12px;font-style:italic;padding:8px 16px;">Sin jugadores en esta categoría</td></tr>`;
      } else {
        jug.forEach((j,i)=>{
          html += `<tr style="background:${i%2===0?'var(--off)':'#fff'}"><td style="font-weight:500">${escapeHtml(j.nombre)}</td><td style="font-size:12px;color:var(--muted)">${escapeHtml(j.club)||'—'}</td><td style="font-size:12px;color:var(--muted)">${escapeHtml(j.fnDisp)}</td><td style="font-size:12px;color:var(--muted);text-align:center">${j.edad!==null?j.edad:'—'}</td></tr>`;
        });
      }
    });
    html += '</tbody></table></div>';
    return html;
  }

  const totalGM    = CATS.reduce((s,c)=>s+catMapGM[c].length, 0);
  const totalOtros = CATS.reduce((s,c)=>s+catMapOtros[c].length, 0);
  const total = totalGM + totalOtros;

  let html = buildSchoolBlock(catMapGM, 'Gimnasio Moderno', '#0b1f3a');
  html += buildSchoolBlock(catMapOtros, 'Otros colegios', '#475569');
  html += `<p style="margin-top:4px;font-size:12px;color:var(--muted);text-align:right;">Total jugadores: <strong>${total}</strong></p>`;
  el.innerHTML = html;
}

function loadAdminCategorias() { buildCategorias(); }

function renderAdminCategorias(cats) {
  const el = document.getElementById('admin-categorias-content');
  if (!el) return;
  if (!cats || !cats.length) { el.innerHTML = '<p style="color:var(--muted);font-size:13px;">Sin datos.</p>'; return; }

  const catColors = { 'Sub 18':'#1e5ba8','Sub 16':'#0d9488','Sub 14':'#7c3aed','Sub 12':'#ea580c','Sub 10':'#dc2626' };
  let total = 0;
  let html = '<table class="ptable" style="width:100%"><thead><tr><th style="width:60%">Nombre</th><th>Fecha nac.</th></tr></thead><tbody>';

  cats.forEach(cat => {
    const color = catColors[cat.categoria] || '#1e5ba8';
    const count = cat.jugadores.length;
    total += count;
    html += `<tr><td colspan="2" style="background:${color};color:#fff;font-weight:600;font-size:12px;letter-spacing:1px;padding:10px 16px;">
      ${cat.categoria} &nbsp;<span style="opacity:.7;font-weight:400">(${count} jugador${count!==1?'es':''})</span>
    </td></tr>`;
    if (!count) {
      html += `<tr><td colspan="2" style="color:var(--muted);font-size:12px;font-style:italic;padding:10px 16px;">Sin jugadores en esta categoría</td></tr>`;
    } else {
      cat.jugadores.forEach((j, idx) => {
        html += `<tr style="background:${idx%2===0?'var(--off)':'#fff'}">
          <td style="font-weight:500">${escapeHtml(j.nombre)}</td>
          <td style="font-size:12px;color:var(--muted)">${escapeHtml(j.fecha)}</td>
        </tr>`;
      });
    }
  });

  html += `</tbody></table>`;
  html += `<p style="margin-top:12px;font-size:12px;color:var(--muted);text-align:right;">Total jugadores: <strong>${total}</strong></p>`;
  el.innerHTML = html;
}

function loadAdminComunicados() {
  const el = document.getElementById('admin-comun-list');
  el.innerHTML = '<p style="color:var(--muted)">Cargando...</p>';
  fetch(APPS_SCRIPT_URL + '?action=comunicaciones&programa=' + encodeURIComponent(adminProgramaActivo) + '&_t=' + Date.now(), { redirect:'follow' })
    .then(r => r.json())
    .then(data => {
      const msgs = (data && Array.isArray(data.mensajes)) ? data.mensajes : [];
      if (!msgs.length) { el.innerHTML = '<p style="color:var(--muted)">No hay comunicados publicados.</p>'; return; }
      const destLabels = {todos:'👥 Todos',con_tiquete:'✈️ Con tiquete',sin_tiquete:'🛫 Sin tiquete'};
      el.innerHTML = msgs.map(m => {
        const dest = m.destinatario || 'todos';
        const destText = destLabels[dest] || ('👤 ' + dest);
        return `<div class="comun-admin-item">
          <div class="comun-admin-body">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
              <span class="comun-admin-fecha">${escapeHtml(m.fecha)}</span>
              <span style="font-size:10px;padding:1px 8px;border-radius:10px;background:rgba(30,91,168,.1);color:var(--blue);font-weight:500">${escapeHtml(destText)}</span>
            </div>
            <div class="comun-admin-titulo">${escapeHtml(m.titulo)}</div>
            <div class="comun-admin-preview">${escapeHtml(m.mensaje)}</div>
          </div>
          ${isEditAdmin() ? `<button class="btn-del" onclick="adminDeleteComunicado(this,'${encodeURIComponent(m.titulo||'')}','${encodeURIComponent(m.fecha||'')}')">Eliminar</button>` : ''}
        </div>`;
      }).join('');
    })
    .catch(() => { el.innerHTML = '<p style="color:var(--muted)">Error al cargar.</p>'; });
}

function onComunDestChange() {
  const val = document.querySelector('input[name="comun-dest"]:checked')?.value || 'todos';
  document.getElementById('comun-individual-wrap').style.display = val === 'individual' ? '' : 'none';
  document.getElementById('comun-colegio-wrap').style.display = val === 'colegio' ? '' : 'none';
  ['todos','con_tiquete','sin_tiquete','individual','colegio'].forEach(k => {
    const lbl = document.getElementById('dest-opt-' + k);
    if (lbl) lbl.style.borderColor = (k === val) ? 'var(--blue)' : '';
  });
  if (val === 'individual') {
    const list = document.getElementById('comun-individual-list');
    if (!list.children.length && adminData.length) poblarComunIndividual('');
  }
  if (val === 'colegio') {
    const list = document.getElementById('comun-colegio-list');
    if (!list.children.length && adminData.length) poblarComunColegio('');
  }
}

function getColegiosUnicos() {
  const set = new Set();
  (adminData || []).forEach(row => {
    const n = normalizeParticipant(row) || {};
    const colegio = (n.club_colegio || row['Club / Colegio'] || row['Club/Colegio'] || row['Colegio'] || row['Club'] || '').trim();
    if (colegio) set.add(colegio);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
}

function poblarComunColegio(filtro) {
  const list = document.getElementById('comun-colegio-list');
  const q = (filtro || '').toLowerCase();
  const prevChecked = new Set(
    Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value)
  );
  const colegios = getColegiosUnicos().filter(c => !q || c.toLowerCase().includes(q));
  if (!colegios.length) {
    list.innerHTML = '<p style="color:var(--muted);font-size:13px;margin:6px 8px">No hay colegios registrados aún.</p>';
    actualizarCuentaColegio();
    return;
  }
  list.innerHTML = colegios.map(colegio => {
    const checked = prevChecked.has(colegio) ? ' checked' : '';
    return `<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--navy)" onmouseover="this.style.background='var(--off)'" onmouseout="this.style.background=''">
      <input type="checkbox" value="${escapeHtml(colegio)}"${checked} onchange="actualizarCuentaColegio()" style="accent-color:var(--blue);width:15px;height:15px;flex-shrink:0">
      <span>🏫 ${escapeHtml(colegio)}</span>
    </label>`;
  }).join('');
  actualizarCuentaColegio();
}

function filtrarComunColegio() {
  poblarComunColegio(document.getElementById('comun-colegio-search').value);
}

function actualizarCuentaColegio() {
  const count = document.querySelectorAll('#comun-colegio-list input[type="checkbox"]:checked').length;
  document.getElementById('comun-colegio-count').textContent =
    count === 1 ? '1 seleccionado' : count + ' seleccionados';
}

function seleccionarTodosColegio() {
  const cbs = document.querySelectorAll('#comun-colegio-list input[type="checkbox"]');
  const allChecked = Array.from(cbs).every(cb => cb.checked);
  cbs.forEach(cb => cb.checked = !allChecked);
  actualizarCuentaColegio();
}

// Resuelve los colegios seleccionados a los emails de sus participantes
// (se envía como lista de emails, igual que la opción "Individual", sin requerir cambios en el backend).
function emailsPorColegios(colegios) {
  const setColegios = new Set(colegios.map(c => c.toLowerCase().trim()));
  const emails = [];
  const seen = new Set();
  (adminData || []).forEach(row => {
    const n = normalizeParticipant(row) || {};
    const colegio = (n.club_colegio || row['Club / Colegio'] || row['Club/Colegio'] || row['Colegio'] || row['Club'] || '').toLowerCase().trim();
    const email = (n.email || '').toLowerCase().trim();
    if (colegio && setColegios.has(colegio) && email && !seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  });
  return emails;
}

function poblarComunIndividual(filtro) {
  const list = document.getElementById('comun-individual-list');
  const q = (filtro || '').toLowerCase();
  // Preserve checked state across re-renders
  const prevChecked = new Set(
    Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value)
  );
  const rows = adminData.filter(row => {
    const n = normalizeParticipant(row) || {};
    const nombre = (n.nombre || row['2'] || '').toLowerCase();
    const email = (n.email || row['3'] || '').toLowerCase();
    return !q || nombre.includes(q) || email.includes(q);
  });
  list.innerHTML = rows.map(row => {
    const n = normalizeParticipant(row) || {};
    const nombre = n.nombre || row['2'] || '';
    const email = n.email || row['3'] || '';
    if (!email) return '';
    const checked = prevChecked.has(email) ? ' checked' : '';
    return `<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--navy)" onmouseover="this.style.background='var(--off)'" onmouseout="this.style.background=''">
      <input type="checkbox" value="${escapeHtml(email)}"${checked} onchange="actualizarCuentaIndividual()" style="accent-color:var(--blue);width:15px;height:15px;flex-shrink:0">
      <span>${escapeHtml(nombre)} <span style="color:var(--muted);font-size:11px">${escapeHtml(email)}</span></span>
    </label>`;
  }).join('');
  actualizarCuentaIndividual();
}

function filtrarComunIndividual() {
  poblarComunIndividual(document.getElementById('comun-individual-search').value);
}

function actualizarCuentaIndividual() {
  const count = document.querySelectorAll('#comun-individual-list input[type="checkbox"]:checked').length;
  document.getElementById('comun-individual-count').textContent =
    count === 1 ? '1 seleccionado' : count + ' seleccionados';
}

function seleccionarTodosIndividual() {
  const cbs = document.querySelectorAll('#comun-individual-list input[type="checkbox"]');
  const allChecked = Array.from(cbs).every(cb => cb.checked);
  cbs.forEach(cb => cb.checked = !allChecked);
  actualizarCuentaIndividual();
}

function adminPublicarComunicado() {
  if (!isEditAdmin()) { alert('No tienes permisos de edición.'); return; }
  const titulo = document.getElementById('comun-titulo-input').value.trim();
  const mensaje = document.getElementById('comun-mensaje-input').value.trim();
  const statusEl = document.getElementById('comun-publish-status');
  const destVal = document.querySelector('input[name="comun-dest"]:checked')?.value || 'todos';
  let destinatario = destVal;
  let colegiosSeleccionados = [];
  if (destVal === 'individual') {
    const checked = Array.from(document.querySelectorAll('#comun-individual-list input[type="checkbox"]:checked'));
    if (!checked.length) { statusEl.style.display='block'; statusEl.innerHTML='<span style="color:#dc2626">Selecciona al menos un participante.</span>'; return; }
    destinatario = checked.map(cb => cb.value).join(',');
  }
  if (destVal === 'colegio') {
    colegiosSeleccionados = Array.from(document.querySelectorAll('#comun-colegio-list input[type="checkbox"]:checked')).map(cb => cb.value);
    if (!colegiosSeleccionados.length) { statusEl.style.display='block'; statusEl.innerHTML='<span style="color:#dc2626">Selecciona al menos un colegio.</span>'; return; }
    const emails = emailsPorColegios(colegiosSeleccionados);
    if (!emails.length) { statusEl.style.display='block'; statusEl.innerHTML='<span style="color:#dc2626">No se encontraron participantes de los colegios seleccionados.</span>'; return; }
    destinatario = emails.join(',');
  }
  if (!titulo || !mensaje) { statusEl.style.display='block'; statusEl.innerHTML='<span style="color:#dc2626">Completa el título y el mensaje.</span>'; return; }
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Publicando...</span>';
  const today = new Date();
  const fecha = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  fetch(APPS_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({action:'publicar_comunicado',titulo,mensaje,fecha,destinatario,token:adminSessionToken,programa:adminProgramaActivo}), redirect:'follow' })
    .then(r => r.json())
    .then(res => {
      if (res.ok) {
        const nDest = destinatario.includes(',') ? destinatario.split(',').length + ' participantes' : destinatario;
        let destLabel = {todos:'todos los participantes',con_tiquete:'participantes con tiquete',sin_tiquete:'participantes sin tiquete'}[destVal] || nDest;
        if (destVal === 'colegio') destLabel = colegiosSeleccionados.join(', ') + ' (' + nDest + ')';
        statusEl.innerHTML = `<span style="color:var(--green)">✅ Comunicado publicado y enviado a <strong>${destLabel}</strong>.</span>`;
        document.getElementById('comun-titulo-input').value = '';
        document.getElementById('comun-mensaje-input').value = '';
        const todosRadio = document.querySelector('input[name="comun-dest"][value="todos"]');
        if (todosRadio) { todosRadio.checked = true; onComunDestChange(); }
        comunLoaded = false;
        loadAdminComunicados();
      } else {
        statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error||'desconocido'}</span>`;
      }
    })
    .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

function adminDeleteComunicado(btn, encodedTitulo, encodedFecha) {
  if (!isEditAdmin()) { alert('No tienes permisos de edición.'); return; }
  if (!confirm('¿Eliminar este comunicado?')) return;
  const titulo = decodeURIComponent(encodedTitulo);
  const fecha = decodeURIComponent(encodedFecha);
  btn.disabled = true;
  btn.textContent = '...';
  fetch(APPS_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({action:'eliminar_comunicado',titulo,fecha,token:adminSessionToken,programa:adminProgramaActivo}), redirect:'follow' })
    .then(r => r.json())
    .then(res => {
      if (res.ok) { btn.closest('.comun-admin-item').remove(); comunLoaded = false; }
      else { btn.disabled=false; btn.textContent='Eliminar'; alert('Error: ' + (res.error||'desconocido')); }
    })
    .catch(() => { btn.disabled=false; btn.textContent='Eliminar'; });
}

// ── ACCESO MANAGEMENT ─────────────────────────────────────────────────────────

function loadAdminAcceso() {
  const el = document.getElementById('acceso-list');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--muted);font-size:13px">Cargando...</p>';
  fetch(APPS_SCRIPT_URL + '?action=admin_acceso&token=' + encodeURIComponent(adminSessionToken) + '&_t=' + Date.now(), { redirect: 'follow' })
    .then(r => r.json())
    .then(list => {
      adminAccesoList = Array.isArray(list) ? list : [];
      renderAdminAcceso();
    })
    .catch(() => { el.innerHTML = '<p style="color:#dc2626;font-size:13px">Error al cargar.</p>'; });
}

function renderAdminAcceso() {
  const el = document.getElementById('acceso-list');
  if (!el) return;
  // Super admin always at top as non-removable
  const superRow = `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid rgba(30,91,168,.25);border-radius:8px;margin-bottom:8px;background:rgba(30,91,168,.04)">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:var(--navy)">${SUPER_ADMIN}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">Super administrador</div>
      </div>
      <span style="padding:4px 12px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(30,91,168,.12);color:var(--blue)">Ver y editar</span>
    </div>`;
  if (!adminAccesoList.length) {
    el.innerHTML = superRow + '<p style="color:var(--muted);font-size:13px;margin-top:8px">No hay otros accesos configurados.</p>';
    return;
  }
  el.innerHTML = superRow + adminAccesoList.map((a, i) => {
    const rolLabel = a.rol === 'editar' ? 'Ver y editar' : 'Solo ver';
    const rolColor = a.rol === 'editar' ? 'rgba(22,101,52,.12)' : 'rgba(30,91,168,.1)';
    const rolTextColor = a.rol === 'editar' ? '#166534' : 'var(--blue)';
    const cambiarRolClick = `adminCambiarRolAcceso('${a.email.replace(/'/g,"\\'")}', this.value)`;
    const eliminarClick = `adminEliminarAcceso('${a.email.replace(/'/g,"\\'")}', this)`;
    return `
    <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:#fff">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500;color:var(--navy)">${escapeHtml(a.email)}</div>
        ${a.nombre ? `<div style="font-size:11px;color:var(--muted);margin-top:1px">${escapeHtml(a.nombre)}</div>` : ''}
      </div>
      <select onchange="${escapeHtml(cambiarRolClick)}"
              style="padding:5px 10px;border:1px solid var(--border);border-radius:6px;font-family:'DM Sans',sans-serif;font-size:12px;color:var(--navy);background:#fff;cursor:pointer">
        <option value="ver"${a.rol !== 'editar' ? ' selected' : ''}>Solo ver</option>
        <option value="editar"${a.rol === 'editar' ? ' selected' : ''}>Ver y editar</option>
      </select>
      <button onclick="${escapeHtml(eliminarClick)}" class="btn-del">Eliminar</button>
    </div>`;
  }).join('');
}

function adminAgregarAcceso() {
  const email = (document.getElementById('acceso-email-input').value || '').trim().toLowerCase();
  const rol = document.getElementById('acceso-rol-input').value;
  const statusEl = document.getElementById('acceso-add-status');
  if (!email || !email.includes('@')) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span style="color:#dc2626">Introduce un correo válido.</span>';
    return;
  }
  if (email === SUPER_ADMIN) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span style="color:#dc2626">El super admin ya tiene acceso total.</span>';
    return;
  }
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color:var(--blue)">Guardando...</span>';
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'admin_acceso_guardar', accion: 'add', email, rol, token: adminSessionToken }),
    redirect: 'follow'
  })
    .then(r => r.json())
    .then(res => {
      if (res.ok) {
        statusEl.innerHTML = '<span style="color:var(--green)">Acceso agregado correctamente.</span>';
        document.getElementById('acceso-email-input').value = '';
        loadAdminAcceso();
      } else {
        statusEl.innerHTML = `<span style="color:#dc2626">Error: ${res.error || 'desconocido'}</span>`;
      }
    })
    .catch(() => { statusEl.innerHTML = '<span style="color:#dc2626">Error de conexión.</span>'; });
}

function adminEliminarAcceso(email, btn) {
  if (!confirm(`¿Eliminar acceso de ${email}?`)) return;
  btn.disabled = true;
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'admin_acceso_guardar', accion: 'remove', email, token: adminSessionToken }),
    redirect: 'follow'
  })
    .then(r => r.json())
    .then(res => {
      if (res.ok) { adminAccesoList = adminAccesoList.filter(a => a.email !== email); renderAdminAcceso(); }
      else { btn.disabled = false; alert('Error: ' + (res.error || 'desconocido')); }
    })
    .catch(() => { btn.disabled = false; });
}

function adminCambiarRolAcceso(email, nuevoRol) {
  fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'admin_acceso_guardar', accion: 'update', email, rol: nuevoRol, token: adminSessionToken }),
    redirect: 'follow'
  })
    .then(r => r.json())
    .then(res => {
      if (res.ok) {
        const found = adminAccesoList.find(a => a.email === email);
        if (found) found.rol = nuevoRol;
      }
    })
    .catch(() => {});
}

let adminFotosLoaded = false;
function loadAdminFotos(force) {
  if (adminFotosLoaded && !force) return;
  adminFotosLoaded = true;
  const grid = document.getElementById('admin-fotos-grid');
  if (!grid) return;
  grid.innerHTML = '<p style="color:var(--muted);font-size:13px">Cargando fotos...</p>';
  fetch(APPS_SCRIPT_URL + '?action=fotos&_t=' + Date.now(), { redirect: 'follow' })
    .then(r => r.json())
    .then(files => {
      if (!Array.isArray(files) || !files.length) {
        grid.innerHTML = '<p style="color:var(--muted);font-size:13px">No hay fotos aún en el álbum.</p>';
        return;
      }
      grid.innerHTML = files.map(f =>
        `<div class="foto-item" style="position:relative">
          <a href="${f.url}" target="_blank" rel="noopener" style="display:block;width:100%;height:100%">
            <img src="${f.viewUrl}" alt="${f.name}" loading="lazy">
          </a>
          <span class="foto-dl-btn" style="opacity:1;bottom:auto;top:8px;right:8px;background:rgba(220,38,38,.85);cursor:pointer" onclick="deleteAdminFoto('${f.id}','${f.name.replace(/'/g,"\\'")}',this)">✕</span>
        </div>`
      ).join('');
    })
    .catch(() => {
      grid.innerHTML = '<p style="color:#dc2626;font-size:13px">Error al cargar las fotos.</p>';
    });
}

function deleteAdminFoto(fileId, fileName, btn) {
  if (!isEditAdmin()) { alert('No tienes permisos de edición.'); return; }
  if (!confirm('¿Eliminar "' + fileName + '"? Esta acción no se puede deshacer.')) return;
  btn.textContent = '…';
  btn.style.pointerEvents = 'none';
  fetch(APPS_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({action:'eliminar_foto_drive', fileId}), redirect:'follow' })
    .then(r => r.json())
    .then(res => {
      if (res.ok) {
        btn.closest('.foto-item').remove();
        fotosLoaded = false;
      } else {
        btn.textContent = '✕';
        btn.style.pointerEvents = '';
        alert('Error al eliminar: ' + (res.error || 'desconocido'));
      }
    })
    .catch(() => {
      btn.textContent = '✕';
      btn.style.pointerEvents = '';
      alert('Error de conexión al eliminar.');
    });
}

function adminHandleFotoDrop(event) {
  event.preventDefault();
  document.getElementById('foto-drop-zone').classList.remove('drag');
  if (event.dataTransfer.files.length) adminHandleFotoUpload(event.dataTransfer.files);
}

function adminHandleFotoUpload(files) {
  if (!isEditAdmin()) { alert('No tienes permisos de edición.'); return; }
  const progressEl = document.getElementById('foto-upload-progress');
  progressEl.style.display = 'block';
  const fileArr = Array.from(files).filter(f => f.type.startsWith('image/') && f.size <= 8 * 1024 * 1024);
  if (!fileArr.length) { progressEl.innerHTML = '<span style="color:#dc2626">No hay imágenes válidas (máx 8 MB).</span>'; return; }
  let done = 0, errors = 0;
  progressEl.innerHTML = `<span style="color:var(--blue)">Subiendo ${fileArr.length} foto(s)... (0/${fileArr.length})</span>`;
  fileArr.forEach(file => {
    const reader = new FileReader();
    reader.onload = function(ev) {
      const base64 = ev.target.result.split(',')[1];
      const ext = file.name.split('.').pop().toLowerCase();
      const fileName = 'foto_' + Date.now() + '_' + Math.random().toString(36).slice(2,7) + '.' + ext;
      fetch(APPS_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'}, body:JSON.stringify({action:'subir_foto_drive',base64,fileName,mimeType:file.type}), redirect:'follow' })
        .then(r => r.json())
        .then(res => {
          done++;
          if (!res.ok) errors++;
          if (done < fileArr.length) { progressEl.innerHTML = `<span style="color:var(--blue)">Subiendo... (${done}/${fileArr.length})</span>`; return; }
          progressEl.innerHTML = errors === 0
            ? `<span style="color:var(--green)">${done} foto(s) subidas. Aparecerán en la galería de todos los participantes.</span>`
            : `<span style="color:#d97706">${done - errors} subidas, ${errors} con error.</span>`;
          fotosLoaded = false; // Force refresh on next visit
          loadAdminFotos(true); // Refresh admin grid
        })
        .catch(() => { done++; errors++; if (done===fileArr.length) progressEl.innerHTML=`<span style="color:#dc2626">Error al subir.</span>`; });
    };
    reader.readAsDataURL(file);
  });
}

