// ════════════════════════════════════════════════════════════════════════════
// CATÁLOGO DE PROGRAMAS (frontend) — una entrada por edición
// ════════════════════════════════════════════════════════════════════════════
// Lo cargan areapersonal.html, inscripcion.html y rmf-clinic.html. Debe
// coincidir con la constante PROGRAMAS de APPS_SCRIPT_CODE.gs (mismas keys,
// fechas límite y precios).
//
// CÓMO AGREGAR UN PROGRAMA NUEVO (cada ~5 meses):
//   1. Copiar la entrada anterior de la misma familia, cambiar key (con año,
//      ej. 'world_challenge_2028'), anio, fechas, precios, vuelo, clima, etc.
//   2. Cuando el backend ya tenga sus Sheets reales: habilitado: true.
//   3. Para abrir la inscripción: inscripcionAbierta: true. Para cerrarla en
//      la edición anterior: inscripcionAbierta: false en esa entrada.
//   El estado "finalizado" (vista de recuerdo, sale del admin principal) es
//   automático: se calcula con la fecha `fin`.
//
// OJO precios / tiqueteEur / fechasLimite: son solo valores POR DEFECTO. Los
// reales se editan en el Sheet de Inscripciones de cada programa (pestaña
// "Alianzas", fila "Estándar") y areapersonal.html los reemplaza al cargar
// (ver aplicarConfigPrograma_). Los T&C salen de la pestaña "T&C".
//
// familia: 'clinic' | 'world_challenge' — decide las reglas de negocio
// (estructura de precios, T&C, pago único de WC, categorías). Todo lo que
// cambia de una edición a otra (fechas, precios, textos) vive aquí.
(function (global) {
  'use strict';

  var PROGRAMAS = [
    {
      key: 'clinic', familia: 'clinic', anio: 2026, legacy: true,
      habilitado: true, inscripcionAbierta: false,
      nombre: 'Real Madrid Foundation Clinic 2026',
      nombreBase: 'Real Madrid Foundation Clinic',
      nombreCorto: 'RMF Clinic 2026',
      etiqueta: '🏟️ Clinic 2026',
      inicio: '2026-10-02T09:00:00+02:00', fin: '2026-10-10T23:59:59+02:00',
      fechaRefEdad: { anio: 2026, mes: 10, dia: 2 },
      fechaRefEdadTexto: '2-oct-2026',
      subtitulo: 'Real Madrid Foundation Clinic · 2–10 Octubre 2026 · Madrid, España',
      precios: {
        jugador: { reserva: 1000, final: 1790 },
        acomp_doble: { reserva: 1000, final: 1190 },
        acomp_sencilla: { reserva: 1000, final: 1510 },
        acomp_actividades: { reserva: 0, final: 590 },
        acomp_actividades_menor12: { reserva: 0, final: 190 }
      },
      // Carpeta de Drive del álbum de fotos (botón 'Descargar álbum completo'); null = sin botón.
      albumUrl: 'https://drive.google.com/drive/folders/1VZxd3FdN8YLU2MpM-CJJIpy2IAb6FCFE',
      precioBaseReferido: 2790,
      tiqueteEur: 993,
      // Reserva y tiquete a tasa fija (TRM de la fecha límite); null = tasa del día.
      tasaFija: { valor: 4288, fechaTexto: '1 de junio de 2026' },
      fechasLimite: { reserva: '1 de junio 2026', tiquete: '1 de junio 2026', final: '30 de julio 2026' },
      finTexto: '10 de octubre de 2026', finTextoCorto: '10 de octubre 2026',
      carta: {
        fechaMes: 'Madrid, octubre 2026',
        titulo: '¡Bienvenido al Real Madrid Foundation Clinic 2026!',
        fechasHtml: 'del <strong>2 al 10 de octubre 2026</strong>',
        descripcion: 'Bienvenido a formar parte de uno de los programas formativos más importantes del mundo, en el que representarás a tu país enfrentándote a academias internacionales y viviendo el fútbol desde dentro, tal como lo hacen los futuros profesionales del Real Madrid CF.',
        cierre: '¡Nos emociona acompañarte en esta aventura y verte brillar en el Real Madrid Foundation Clinic powered by Fundación Revel!'
      },
      vuelo: {
        idaFecha: '2 de octubre 2026', idaVuelo: 'Air Europa · UX194', idaSalida: '20:15 hrs', idaLlegada: '13:00 hrs',
        idaLlegadaLarga: '13:00 (3 de octubre, hora Madrid)',
        regresoFecha: '10 de octubre 2026', regresoVuelo: 'Air Europa · UX0193', regresoSalida: '15:15 hrs', regresoLlegada: '18:15 hrs'
      },
      vueloIndependienteHtml: 'Debes coordinar con Victory tu itinerario de vuelo. El vuelo sale el <strong>2 de octubre</strong> y la llegada a Madrid es el <strong>3 de octubre de 2026</strong>. La salida de regreso es el <strong>10 de octubre</strong>. Envía tu confirmación a <strong>alejandro.cabrera@fundacionrevel.net</strong>.',
      clima: {
        tituloRango: '2–10 Octubre', max: '19°C', min: '10°C', soleados: '7', lluvia: '3', humedad: '40%', viento: '14 km/h',
        forecastTitulo: 'Pronóstico 3–10 octubre 2026', forecastStart: '2026-10-03', forecastEnd: '2026-10-10',
        cutoffTexto: '19 de septiembre de 2026'
      },
      inscripcion: {
        titulo: 'Real Madrid Foundation Clinic',
        descripcion: 'Programa deportivo en la Ciudad Deportiva del Real Madrid. 2–10 Octubre 2026 · Madrid, España.',
        icono: '🏟️',
        precioTiqueteHtml: 'Vuelo grupal <strong>Bogotá – Madrid – Bogotá</strong> con fecha fija. Costo <strong>$4.050.000 COP</strong> por persona.',
        anioNacMin: null, anioNacMax: null, edadTexto: '8 a 17 años'
      }
    },
    {
      key: 'world_challenge', familia: 'world_challenge', anio: 2027, legacy: true,
      habilitado: true, inscripcionAbierta: true,
      nombre: 'Real Madrid Foundation World Challenge 2027',
      nombreBase: 'Real Madrid Foundation World Challenge',
      nombreCorto: 'RMF World Challenge 2027',
      etiqueta: '🏆 World Challenge 2027',
      inicio: '2027-03-19T09:00:00+01:00', fin: '2027-03-27T23:59:59+01:00',
      fechaRefEdad: { anio: 2026, mes: 10, dia: 2 },
      fechaRefEdadTexto: '2-oct-2026',
      subtitulo: 'Real Madrid Foundation World Challenge · 19–27 Marzo 2027 · Madrid, España',
      precios: {
        jugador: { reserva: 1150, final: 1740 },
        acomp_doble: { reserva: 1150, final: 1040 },
        acomp_sencilla: { reserva: 1150, final: 1360 },
        acomp_actividades: { reserva: 590, final: 0 },
        acomp_solo_wc: { reserva: 270, final: 0 },
        acomp_triple: { reserva: 650, final: 0 } // 3.ª persona en hab. doble (triple). Menores de 3 años: gratis
      },
      precioBaseReferido: 2890,
      tiqueteEur: 1400,
      tasaFija: null,
      fechasLimite: { reserva: '15 de diciembre 2026', tiquete: '15 de diciembre 2026', final: '15 de enero 2027' },
      finTexto: '27 de marzo de 2027', finTextoCorto: '27 de marzo 2027',
      carta: {
        fechaMes: 'Madrid, marzo 2027',
        titulo: '¡Bienvenido al Real Madrid Foundation World Challenge 2027!',
        fechasHtml: 'del <strong>19 al 27 de marzo 2027</strong>',
        descripcion: 'Bienvenido a formar parte de uno de los torneos más importantes del mundo, en el que representarás a tu país compitiendo contra equipos internacionales y viviendo el fútbol desde dentro, tal como lo hacen los futuros profesionales del Real Madrid CF.',
        cierre: '¡Nos emociona acompañarte en esta aventura y verte brillar en el Real Madrid Foundation World Challenge powered by Fundación Revel!'
      },
      vuelo: {
        idaFecha: '19 de marzo 2027', idaVuelo: 'Air Europa · UX0194', idaSalida: '21:35 hrs', idaLlegada: '13:10 hrs',
        idaLlegadaLarga: '13:10 (20 de marzo, hora Madrid)',
        regresoFecha: '27 de marzo 2027', regresoVuelo: 'Air Europa · UX0193', regresoSalida: '15:15 hrs', regresoLlegada: '19:15 hrs'
      },
      vueloIndependienteHtml: 'Debes coordinar con Victory tu itinerario de vuelo. El programa inicia el <strong>20 de marzo</strong> en Madrid y finaliza el <strong>27 de marzo de 2027</strong>. Envía tu confirmación a <strong>alejandro.cabrera@fundacionrevel.net</strong>.',
      clima: {
        tituloRango: '19–27 Marzo', max: '18°C', min: '5°C', soleados: '5', lluvia: '4', humedad: '65%', viento: '22 km/h',
        forecastTitulo: 'Pronóstico 19–27 marzo 2027', forecastStart: '2027-03-19', forecastEnd: '2027-03-27',
        cutoffTexto: '5 de marzo de 2027'
      },
      inscripcion: {
        titulo: 'Real Madrid Foundation World Challenge',
        descripcion: 'Torneo internacional en la Ciudad Deportiva del Real Madrid. 19–27 Marzo 2027 · Madrid, España.',
        icono: '🏆',
        precioTiqueteHtml: 'Vuelo grupal <strong>Bogotá – Madrid – Bogotá</strong> con fecha fija. Costo <strong>1.400 EUR</strong> por persona (válido hasta agotar cupos reservados; bebés menores de 2 años: <strong>25%</strong>), pagadero en pesos colombianos a la <strong>tasa del día</strong> del pago.',
        anioNacMin: 2013, anioNacMax: 2018, edadTexto: '8 a 14 años'
      },
      cuposTiquete: 20
    },
    {
      // TODO Clinic 2027: completar fechas, precios, vuelo y clima reales.
      // Pasar habilitado a true cuando el backend tenga los Sheets reales, e
      // inscripcionAbierta a true para abrir la inscripción.
      key: 'clinic_2027', familia: 'clinic', anio: 2027,
      habilitado: true, inscripcionAbierta: false, // TODO inscripcionAbierta: true cuando estén fechas y precios

      nombre: 'Real Madrid Foundation Clinic 2027',
      nombreBase: 'Real Madrid Foundation Clinic',
      nombreCorto: 'RMF Clinic 2027',
      etiqueta: '🏟️ Clinic 2027',
      inicio: '2027-10-01T09:00:00+02:00', fin: '2027-10-09T23:59:59+02:00', // TODO
      fechasConfirmadas: false, // TODO quitar cuando inicio/fin sean reales — mientras tanto se muestran los textos fijos (subtitulo, carta…)
      fechaRefEdad: { anio: 2027, mes: 10, dia: 1 },
      fechaRefEdadTexto: '1-oct-2027',
      subtitulo: 'Real Madrid Foundation Clinic · Octubre 2027 · Madrid, España', // TODO fechas exactas
      precios: { // TODO confirmar — copiados del Clinic 2026
        jugador: { reserva: 1000, final: 1790 },
        acomp_doble: { reserva: 1000, final: 1190 },
        acomp_sencilla: { reserva: 1000, final: 1510 },
        acomp_actividades: { reserva: 0, final: 590 },
        acomp_actividades_menor12: { reserva: 0, final: 190 }
      },
      albumUrl: 'https://drive.google.com/drive/folders/1dWV2jp6vO0K33cVRapBAOawtoPz6KYMa',
      precioBaseReferido: 2790,
      tiqueteEur: 993, // TODO
      tasaFija: null, // TODO: si se fija una TRM, poner { valor: ..., fechaTexto: '...' }
      fechasLimite: { reserva: '1 de junio 2027', tiquete: '1 de junio 2027', final: '30 de julio 2027' }, // TODO
      finTexto: '9 de octubre de 2027', finTextoCorto: '9 de octubre 2027', // TODO
      carta: {
        fechaMes: 'Madrid, octubre 2027',
        titulo: '¡Bienvenido al Real Madrid Foundation Clinic 2027!',
        fechasHtml: 'en <strong>octubre de 2027</strong>', // TODO fechas exactas
        descripcion: 'Bienvenido a formar parte de uno de los programas formativos más importantes del mundo, en el que representarás a tu país enfrentándote a academias internacionales y viviendo el fútbol desde dentro, tal como lo hacen los futuros profesionales del Real Madrid CF.',
        cierre: '¡Nos emociona acompañarte en esta aventura y verte brillar en el Real Madrid Foundation Clinic powered by Fundación Revel!'
      },
      vuelo: null, // TODO itinerario cuando esté confirmado (null = "por confirmar")
      vueloIndependienteHtml: 'Debes coordinar con Victory tu itinerario de vuelo. Las fechas exactas del programa (octubre de 2027) se confirmarán pronto. Envía tu confirmación a <strong>alejandro.cabrera@fundacionrevel.net</strong>.',
      clima: {
        tituloRango: 'Octubre', max: '19°C', min: '10°C', soleados: '7', lluvia: '3', humedad: '40%', viento: '14 km/h',
        forecastTitulo: 'Pronóstico octubre 2027', forecastStart: '2027-10-01', forecastEnd: '2027-10-09', // TODO
        cutoffTexto: '17 de septiembre de 2027'
      },
      inscripcion: {
        titulo: 'Real Madrid Foundation Clinic',
        descripcion: 'Programa deportivo en la Ciudad Deportiva del Real Madrid. Octubre 2027 · Madrid, España.', // TODO fechas
        icono: '🏟️',
        precioTiqueteHtml: 'Vuelo grupal <strong>Bogotá – Madrid – Bogotá</strong> con fecha fija. Costo por confirmar.', // TODO
        anioNacMin: null, anioNacMax: null, edadTexto: '8 a 17 años'
      }
    }
  ];

  function porKey(key) {
    for (var i = 0; i < PROGRAMAS.length; i++) if (PROGRAMAS[i].key === key) return PROGRAMAS[i];
    return null;
  }

  // Igual que getPrograma_ del backend: key exacta, luego texto con año
  // ("Real Madrid Foundation Clinic 2027"), luego texto viejo sin año → la
  // edición legacy de esa familia. Nunca devuelve null.
  function getPrograma(programa) {
    var raw = String(programa == null ? '' : programa).trim();
    var exacto = porKey(raw);
    if (exacto) return exacto;
    var txt = raw.toLowerCase().replace(/_/g, ' ');
    var familia = txt.indexOf('world challenge') >= 0 ? 'world_challenge' : (txt.indexOf('clinic') >= 0 ? 'clinic' : '');
    var i;
    if (familia) {
      for (i = 0; i < PROGRAMAS.length; i++) {
        if (PROGRAMAS[i].familia === familia && txt.indexOf(String(PROGRAMAS[i].anio)) >= 0) return PROGRAMAS[i];
      }
      for (i = 0; i < PROGRAMAS.length; i++) {
        if (PROGRAMAS[i].familia === familia && PROGRAMAS[i].legacy) return PROGRAMAS[i];
      }
    }
    for (i = 0; i < PROGRAMAS.length; i++) if (PROGRAMAS[i].familia === 'clinic' && PROGRAMAS[i].legacy) return PROGRAMAS[i];
    return PROGRAMAS[0];
  }

  function familiaDe(programa) { return getPrograma(programa).familia; }
  function esWCKey(programa) { return familiaDe(programa) === 'world_challenge'; }

  function programaFinalizado(programa) {
    var p = getPrograma(programa);
    return Date.now() > new Date(p.fin).getTime();
  }

  function programasHabilitados() {
    return PROGRAMAS.filter(function (p) { return p.habilitado; });
  }

  function ordenarPorInicio(lista, desc) {
    return lista.slice().sort(function (a, b) {
      var d = new Date(a.inicio).getTime() - new Date(b.inicio).getTime();
      return desc ? -d : d;
    });
  }

  // Próximos/en curso (no finalizados), del más cercano al más lejano.
  function programasActivos() {
    return ordenarPorInicio(programasHabilitados().filter(function (p) { return !programaFinalizado(p.key); }));
  }

  // Ya finalizados, del más reciente al más antiguo.
  function programasPasados() {
    return ordenarPorInicio(programasHabilitados().filter(function (p) { return programaFinalizado(p.key); }), true);
  }

  // Programa que abre el panel admin por defecto: el próximo no finalizado;
  // si todos terminaron, el más reciente.
  function programaAdminPorDefecto() {
    var act = programasActivos();
    if (act.length) return act[0].key;
    var pas = programasPasados();
    return pas.length ? pas[0].key : PROGRAMAS[0].key;
  }

  // Entre varias keys (ej. los programas de un participante), la que debe
  // abrirse primero: la próxima no finalizada; si todas terminaron, la más
  // reciente.
  function programaPreferido(keys) {
    var lista = (keys || []).map(getPrograma);
    var act = ordenarPorInicio(lista.filter(function (p) { return !programaFinalizado(p.key); }));
    if (act.length) return act[0].key;
    var pas = ordenarPorInicio(lista, true);
    return pas.length ? pas[0].key : PROGRAMAS[0].key;
  }

  function programasConInscripcionAbierta() {
    return ordenarPorInicio(PROGRAMAS.filter(function (p) { return p.habilitado && p.inscripcionAbierta; }));
  }

  global.PROGRAMAS = PROGRAMAS;
  global.getPrograma = getPrograma;
  global.familiaDe = familiaDe;
  global.esWCKey = esWCKey;
  global.programaFinalizado = programaFinalizado;
  global.programasHabilitados = programasHabilitados;
  global.programasActivos = programasActivos;
  global.programasPasados = programasPasados;
  global.programaAdminPorDefecto = programaAdminPorDefecto;
  global.programaPreferido = programaPreferido;
  global.programasConInscripcionAbierta = programasConInscripcionAbierta;
})(typeof window !== 'undefined' ? window : this);
