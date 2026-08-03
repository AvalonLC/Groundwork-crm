/**
 * Groundwork CRM — Internationalization (i18n) Engine v2
 * Supports: English (en) | Spanish (es)
 *
 * v2 — DOM AUTO-TRANSLATION:
 *   The app's render code is written in English. Instead of requiring _t()
 *   calls everywhere, this engine walks the live DOM and translates every
 *   text node + placeholder/title/aria-label attribute using the dictionary
 *   below. A MutationObserver re-translates anything newly rendered, so ALL
 *   views (dashboard, pipeline, work orders, field mode…) flip to Spanish
 *   instantly — and flip back to the original English when toggled off.
 *
 * Usage:
 *   _t('Clock In')              → 'Registrar Entrada' (when lang=es)
 *   window._gwLang              → 'en' | 'es'
 *   window._gwSetLang('es')     → switches language + saves preference
 *   window._gwTranslatePage()   → force full-page re-translation
 */

'use strict';

// ── Active language — sourced from:
//   1. D1 bootstrap (window._gwBootstrap.rep.preferred_language)
//   2. localStorage fallback
//   3. default 'en'
window._gwLang = (function() {
  try {
    const stored = localStorage.getItem('gw_lang');
    if (stored === 'es' || stored === 'en') return stored;
  } catch(_) {}
  return 'en';
})();

// ── Translation dictionary ────────────────────────────────────────────────────
// Keys are canonical English strings (trimmed). Values are Spanish.

const _GW_ES = {

  // ── Greetings / time-of-day ────────────────────────────────────────────────
  'Good morning':   'Buenos días',
  'Good afternoon': 'Buenas tardes',
  'Good evening':   'Buenas noches',
  'Field User':     'Usuario de Campo',
  'Loading…':       'Cargando…',
  'Loading...':     'Cargando…',

  // ── Clock states ───────────────────────────────────────────────────────────
  'Not Clocked In':    'Sin Registrar Entrada',
  'Clocked In':        'Entrada Registrada',
  'Clocked Out':       'Salida Registrada',
  'On Break':          'En Descanso',
  'Done for Today':    'Listo por Hoy',
  'Time on the clock': 'Tiempo registrado',
  'Break timer running': 'Temporizador de descanso activo',

  // ── Clock-in / out buttons ─────────────────────────────────────────────────
  'Clock In':    'Registrar Entrada',
  'Clock Out':   'Registrar Salida',
  'Break':       'Descanso',
  'Start Break': 'Iniciar Descanso',
  'End Break':   'Terminar Descanso',
  'View My Timesheet': 'Ver Mi Hoja de Tiempo',

  // ── Sidebar workspaces ─────────────────────────────────────────────────────
  'Dashboard':  'Panel',
  'Sales':      'Ventas',
  'Financial':  'Finanzas',
  'Operations': 'Operaciones',
  'Learning':   'Aprendizaje',
  'Admin':      'Administración',
  'Platform Admin': 'Admin de Plataforma',

  // ── Dashboard subtabs ──────────────────────────────────────────────────────
  'My Day':              'Mi Día',
  'Command Center':      'Centro de Comando',
  'Business Pulse':      'Pulso del Negocio',
  'Team':                'Equipo',

  // ── Sales subtabs ──────────────────────────────────────────────────────────
  'Pipeline':       'Embudo de Ventas',
  'Leads':          'Prospectos',
  'Clients':        'Clientes',
  'Properties':     'Propiedades',
  'Estimates':      'Presupuestos',
  'Communications': 'Comunicaciones',
  'Inbox':          'Bandeja de Entrada',
  'Templates':      'Plantillas',
  'Sequences':      'Secuencias',
  'Talk Tracks':    'Guiones de Venta',
  'Playbooks':      'Manuales',
  'AI Assist':      'Asistente IA',

  // ── Financial subtabs ──────────────────────────────────────────────────────
  'Overview':   'Resumen',
  'Invoices':   'Facturas',
  'Reviews':    'Reseñas',
  'Payments':   'Pagos',
  'Ledger':     'Libro Mayor',
  'Deposits':   'Depósitos',
  'Statements': 'Estados de Cuenta',
  'Activity':   'Actividad',

  // ── Operations subtabs ─────────────────────────────────────────────────────
  'Schedule':           'Horario',
  'Dispatch':           'Despacho',
  'Work Orders':        'Órdenes de Trabajo',
  'Recurring Services': 'Servicios Recurrentes',
  'Service Plans':      'Planes de Servicio',
  'Assets':             'Activos',
  'Maintenance':        'Mantenimiento',
  'Inventory':          'Inventario',
  'Tools':              'Herramientas',
  'Equipment':          'Equipos',
  'Inventory & Tools':  'Inventario y Herramientas',
  'Mechanic':           'Mecánico',
  'Log Service':        'Registrar Servicio',
  'Service Plan':       'Plan de Servicio',
  'Service History':    'Historial de Servicio',
  'Import / Export':    'Importar / Exportar',
  'Time Tracker':       'Control de Tiempo',
  'Timesheet Review':   'Revisión de Horas',

  // ── Learning subtabs ───────────────────────────────────────────────────────
  'Sales Academy':      'Academia de Ventas',
  'Estimating 101':     'Presupuestos 101',
  'Financial Literacy': 'Educación Financiera',
  'CRM Guide':          'Guía del CRM',

  // ── Admin subtabs ──────────────────────────────────────────────────────────
  'General':                  'General',
  'Employees':                'Empleados',
  'Integrations':             'Integraciones',
  'Workflow':                 'Flujo de Trabajo',
  'Templates & Automations':  'Plantillas y Automatizaciones',
  'Approval Queue':           'Cola de Aprobación',
  'Audit':                    'Auditoría',
  'Audit Log':                'Registro de Auditoría',
  'Client Portal':            'Portal del Cliente',
  'Field Mode':               'Modo Campo',
  'Field Reports':            'Reportes de Campo',
  'AAR Template':             'Plantilla AAR',
  'AAR Reviews':              'Revisiones AAR',
  'System Config':            'Configuración del Sistema',
  'Workday Settings':         'Ajustes de Jornada',
  'Settings':                 'Ajustes',
  'Company':                  'Empresa',
  'Workday':                  'Jornada',
  'Field Preview':            'Vista de Campo',

  // ── Roles ──────────────────────────────────────────────────────────────────
  'Owner / Admin':   'Dueño / Admin',
  'Office Manager':  'Gerente de Oficina',
  'Sales Rep':       'Vendedor',
  'Foreman':         'Capataz',
  'Laborer':         'Trabajador',
  'Crew Lead':       'Líder de Cuadrilla',

  // ── Topbar ─────────────────────────────────────────────────────────────────
  'Search scripts, forms, stages, templates...': 'Buscar guiones, formularios, etapas, plantillas...',
  'Search':          'Buscar',
  'Open in app':     'Abrir en app',
  'Work':            'Trabajo',
  'New':             'Nuevo',

  // ── My Day dashboard ───────────────────────────────────────────────────────
  '+ Task':          '+ Tarea',
  '+ Lead':          '+ Prospecto',
  '+ New Task':      '+ Nueva Tarea',
  '+ New Lead':      '+ Nuevo Prospecto',
  'New Task':        'Nueva Tarea',
  'New Lead':        'Nuevo Prospecto',
  'Open Leads':      'Prospectos Abiertos',
  'Proposals Out':   'Propuestas Enviadas',
  'Pipeline Value':  'Valor del Embudo',
  'Won MTD':         'Ganado del Mes',

  'My Tasks':        'Mis Tareas',
  '+ Add Task':      '+ Agregar Tarea',
  'Add Task':        'Agregar Tarea',
  'Overdue':         'Atrasadas',
  'Due Today':       'Para Hoy',
  'Upcoming':        'Próximas',
  'No Date':         'Sin Fecha',
  'All clear':       'Todo al día',
  'No tasks scheduled — add one to get started.': 'No hay tareas programadas — agrega una para comenzar.',
  'No open tasks today': 'No hay tareas abiertas hoy',
  'Task marked done ✓':  'Tarea marcada como lista ✓',
  'HIGH':            'ALTA',
  'MEDIUM':          'MEDIA',
  'LOW':             'BAJA',
  'High':            'Alta',
  'Medium':          'Media',
  'Low':             'Baja',
  'Due':             'Vence',
  'Priority':        'Prioridad',
  'Due Date':        'Fecha Límite',
  'Title':           'Título',
  'Description':     'Descripción',
  'Assigned To':     'Asignado a',
  'Complete':        'Completar',
  'Mark Done':       'Marcar Lista',

  // Task types
  'Follow-Up':   'Seguimiento',
  'Follow Up':   'Seguimiento',
  'Call':        'Llamada',
  'Text':        'Mensaje',
  'Site Visit':  'Visita al Sitio',
  'Meeting':     'Reunión',
  'Task':        'Tarea',

  // ── Financial Pulse ────────────────────────────────────────────────────────
  'Financial Pulse': 'Pulso Financiero',
  'FINANCIAL PULSE': 'PULSO FINANCIERO',
  'Full View':       'Vista Completa',
  'YTD Actual':      'Real del Año',
  'Annual Budget':   'Presupuesto Anual',
  'YTD Variance':    'Variación del Año',
  'Needed / Mo':     'Necesario / Mes',
  'Needed / Month':  'Necesario / Mes',
  'Landscape':       'Paisajismo',
  'Snow':            'Nieve',
  'Revenue':         'Ingresos',
  'Expenses':        'Gastos',
  'Profit':          'Ganancia',

  // ── Daily checklist ────────────────────────────────────────────────────────
  'Daily Sales Start-Up': 'Arranque Diario de Ventas',
  'Weekly Sales Review':  'Revisión Semanal de Ventas',
  'Review all open opportunities and follow-up dates': 'Revisar todas las oportunidades abiertas y fechas de seguimiento',
  'Identify the top 3 priorities for today': 'Identificar las 3 prioridades principales de hoy',
  'Check for any overdue follow-ups (7+ days no contact)': 'Verificar seguimientos atrasados (7+ días sin contacto)',
  'Confirm all scheduled calls, site walks, and meetings for today': 'Confirmar todas las llamadas, visitas y reuniones programadas para hoy',
  'Review any outstanding proposals awaiting decision': 'Revisar propuestas pendientes de decisión',
  'Prepare for any discovery calls or site walks scheduled today': 'Prepararse para llamadas de descubrimiento o visitas programadas hoy',
  'Update the pipeline after any calls or site visits': 'Actualizar el embudo después de llamadas o visitas',
  'Log all activity, notes, and next steps in the system': 'Registrar toda actividad, notas y próximos pasos en el sistema',

  // ── Recently Updated ───────────────────────────────────────────────────────
  'Recently Updated': 'Actualizados Recientemente',
  'Today':      'Hoy',
  'Yesterday':  'Ayer',
  'unknown':    'desconocido',

  // ── Pipeline stages ────────────────────────────────────────────────────────
  'Lead Intake / Rapport':          'Captación / Conexión',
  'Mutual Agreement Set':           'Acuerdo Mutuo Establecido',
  'Discovery / CBR Uncovered':      'Descubrimiento / CBR Identificado',
  'Budget & Investment Qualified':  'Presupuesto Calificado',
  'Decision Process Qualified':     'Proceso de Decisión Calificado',
  'Presentation & SOW Pitch':       'Presentación y Propuesta',
  'Deal Closed / Won':              'Cerrado / Ganado',
  'On Hold':                        'En Espera',
  'Closed Lost':                    'Cerrado Perdido',
  'Closed Won':                     'Cerrado Ganado',
  'New Lead':                       'Nuevo Prospecto',
  'Discovery Scheduled':            'Descubrimiento Programado',
  'Site Walk Scheduled':            'Visita Programada',
  'Scope Development':              'Desarrollo de Alcance',
  'Estimating':                     'Presupuestando',
  'Proposal Sent':                  'Propuesta Enviada',
  'Verbal Yes':                     'Sí Verbal',
  'Sold / Activation':              'Vendido / Activación',

  // ── Reviews widget ─────────────────────────────────────────────────────────
  'Requests':    'Solicitudes',
  'Reviewed':    'Reseñados',
  'Conversion':  'Conversión',
  'View all':    'Ver todo',
  '+ View Google Reviews': '+ Ver Reseñas de Google',
  'View Google Reviews':   'Ver Reseñas de Google',

  // ── Job count / dashboard sections ─────────────────────────────────────────
  ' Job':  ' Trabajo',
  ' Jobs': ' Trabajos',
  'Active Job':           'Trabajo Activo',
  'Currently working on': 'Trabajando en',
  'Switch':               'Cambiar',
  "Today's Jobs":          'Trabajos de Hoy',
  'No jobs scheduled today': 'No hay trabajos programados hoy',
  'View Schedule':           'Ver Horario',
  'Your Crew / Foreman Today': 'Tu Cuadrilla / Capataz Hoy',
  "Today's Crew":              'Cuadrilla de Hoy',
  'Crew / Foreman':            'Cuadrilla / Capataz',
  'Crew Member':               'Miembro de Cuadrilla',
  'Crew':                      'Cuadrilla',
  'Quick Links':  'Accesos Rápidos',
  'Timesheet':    'Hoja de Tiempo',

  // ── Field Actions ──────────────────────────────────────────────────────────
  'Field Actions':                    'Acciones de Campo',
  'Equipment / Supply Report':        'Reporte de Equipo / Materiales',
  'Report a broken tool, truck issue, or supply request': 'Reporta una herramienta rota, problema con vehículo, o solicitud de materiales',
  'End-of-Day Report':                'Reporte de Fin de Día',
  '5-min after action report — required before clock-out': 'Reporte de 5 min — requerido antes de registrar salida',

  // ── Equipment Report bottom-sheet ─────────────────────────────────────────
  'Notify management of an issue or request': 'Notifica a la gerencia de un problema o solicitud',
  'Report Type':             'Tipo de Reporte',
  'Report Type *':           'Tipo de Reporte *',
  'Broken Tool':             'Herramienta Rota',
  'Truck/Vehicle':           'Camión/Vehículo',
  'Supply Request':          'Solicitud de Materiales',
  'What item / asset?':      '¿Qué artículo / activo?',
  'What item / asset? *':    '¿Qué artículo / activo? *',
  'e.g. Milwaukee Drill M18, F-250 Truck #3, Gloves': 'ej. Taladro Milwaukee M18, Camión F-250 #3, Guantes',
  'Urgency':                 'Urgencia',
  'Normal — handle when possible': 'Normal — atender cuando sea posible',
  'High — need it soon':           'Alta — necesario pronto',
  'Urgent — blocking work today':  'Urgente — bloquea el trabajo de hoy',
  'Description / Notes':     'Descripción / Notas',
  'Describe the issue or what you need...': 'Describe el problema o lo que necesitas...',
  'Submit Report':           'Enviar Reporte',
  'Cancel':                  'Cancelar',
  'Please select a report type':      'Por favor selecciona un tipo de reporte',
  'Please describe the item or asset': 'Por favor describe el artículo o activo',
  'Submitting…':             'Enviando…',
  'Report submitted — management has been notified ✓': 'Reporte enviado — la gerencia fue notificada ✓',
  'Submit failed':           'Error al enviar',
  'Network error — try again': 'Error de red — intenta de nuevo',

  // ── AAR (End-of-Day Report) ────────────────────────────────────────────────
  'End-of-day report already submitted for today ✓': 'Reporte de fin de día ya enviado hoy ✓',
  'questions · ~5 min':           'preguntas · ~5 min',
  'Submit & Clock Out':            'Enviar y Registrar Salida',
  'Save progress for later':       'Guardar progreso para después',
  'End-of-day report submitted ✓': 'Reporte de fin de día enviado ✓',
  'questions':               'preguntas',
  'Yes':                      'Sí',
  'No':                       'No',
  '— Select —':                '— Seleccionar —',
  'Did you complete all assigned work orders today?':     '¿Completaste todas las órdenes de trabajo asignadas hoy?',
  'Were there any safety incidents or near-misses today?':'¿Hubo algún incidente de seguridad o casi-accidente hoy?',
  'Any issues or concerns from today that need follow-up?':'¿Algún problema o preocupación de hoy que necesite seguimiento?',
  'Overall how did today go? (1 = rough, 5 = great)':    '¿Cómo fue el día en general? (1 = difícil, 5 = excelente)',
  'Any materials, tools, or supplies needed for tomorrow?':'¿Se necesitan materiales, herramientas o suministros para mañana?',
  'Your answer…':  'Tu respuesta…',
  'Please complete your end-of-day report before clocking out': 'Por favor completa tu reporte de fin de día antes de registrar salida',

  // ── Work Order list ────────────────────────────────────────────────────────
  'Loading work orders…':    'Cargando órdenes de trabajo…',
  'total':                'total',
  'in progress':          'en progreso',
  'scheduled':            'programado',
  'Unassigned':           'Sin Asignar',
  'Schedule Board':       'Tablero de Horario',
  '+ New Work Order':     '+ Nueva Orden de Trabajo',
  'New Work Order':       'Nueva Orden de Trabajo',
  'No work orders yet.':  'No hay órdenes de trabajo todavía.',
  '+ Create First Work Order': '+ Crear Primera Orden de Trabajo',
  'Open':                 'Abrir',
  'WO #':                 'OT #',
  'Client':               'Cliente',
  'Type':                 'Tipo',
  'Date':                 'Fecha',
  'Status':               'Estado',
  'Scheduled':   'Programado',
  'In Progress': 'En Progreso',
  'Completed':   'Completado',
  'Cancelled':   'Cancelado',

  // ── Schedule Board ─────────────────────────────────────────────────────────
  'Loading schedule…':  'Cargando horario…',
  'No crews yet.':      'Sin cuadrillas todavía.',
  'Manage Crews':       'Administrar Cuadrillas',
  'Crew Lanes':         'Carriles de Cuadrilla',

  // ── Timesheet / Time Tracker ───────────────────────────────────────────────
  'Total Hours':     'Total de Horas',
  'Regular':         'Regular',
  'Overtime':        'Horas Extra',
  'No time entries': 'Sin registros de tiempo',
  'Hours':           'Horas',
  'This Week':       'Esta Semana',
  'Last Week':       'Semana Pasada',

  // ── Language toggle ────────────────────────────────────────────────────────
  'Language':         'Idioma',
  'English':          'Inglés',
  'Spanish':          'Español',
  'Switch to English': 'Cambiar a Inglés',
  'Switch to Spanish': 'Cambiar a Español',
  'Language saved':    'Idioma guardado',

  // ── Generic UI ─────────────────────────────────────────────────────────────
  'Network error':    'Error de red',
  'Saved':            'Guardado',
  'Error':            'Error',
  'Loading':          'Cargando',
  'Delete':           'Eliminar',
  'Save':             'Guardar',
  'Close':            'Cerrar',
  'Confirm':          'Confirmar',
  'Back':             'Atrás',
  'Next':             'Siguiente',
  'Submit':           'Enviar',
  'Edit':             'Editar',
  'Add':              'Agregar',
  'Remove':           'Eliminar',
  'Filter':           'Filtrar',
  'View':             'Ver',
  'Details':          'Detalles',
  'Notes':            'Notas',
  'Name':             'Nombre',
  'Address':          'Dirección',
  'Phone':            'Teléfono',
  'Email':            'Correo',
  'Amount':           'Monto',
  'Total':            'Total',
  'Actions':          'Acciones',
  'None':             'Ninguno',
  'All':              'Todos',
  'Value':            'Valor',
  'Source':           'Fuente',
  'Stage':            'Etapa',
  'Created':          'Creado',
  'Updated':          'Actualizado',
  'Notifications':    'Notificaciones',
  'No notifications': 'Sin notificaciones',
  'Logout':           'Cerrar Sesión',
  'Log Out':          'Cerrar Sesión',
  'Sign Out':         'Cerrar Sesión',
  'Profile':          'Perfil',
};

// ── Case-insensitive lookup map ───────────────────────────────────────────────
const _GW_ES_LC = {};
for (const k in _GW_ES) _GW_ES_LC[k.toLowerCase()] = _GW_ES[k];

// ── Pattern rules for dynamic strings (counts, dates, etc.) ──────────────────
const _GW_PATTERNS = [
  [/^Overdue \((\d+)\)$/,        'Atrasadas ($1)'],
  [/^Due Today \((\d+)\)$/,      'Para Hoy ($1)'],
  [/^Upcoming \((\d+)\)$/,       'Próximas ($1)'],
  [/^(\d+) overdue$/,            '$1 atrasadas'],
  [/^(\d+) due today$/,          '$1 para hoy'],
  [/^(\d+)d ago$/,               'hace $1d'],
  [/^(\d+)h ago$/,               'hace $1h'],
  [/^(\d+)m ago$/,               'hace $1m'],
  [/^(\d+)w ago$/,               'hace $1sem'],
  [/^(\d+)% of annual target$/,  '$1% del objetivo anual'],
  [/^(\d+)% done$/,              '$1% hecho'],
  [/^(\d+)\/(\d+) done$/,        '$1/$2 hecho'],
  [/^1 mo left$/,                '1 mes restante'],
  [/^(\d+) mos? left$/,          '$1 meses restantes'],
  [/^of \$([\d,.KMk]+)$/,        'de $$$1'],
  [/^(\d+) open · (\d+) due today$/, '$1 abiertas · $2 para hoy'],
  [/^(\d+) questions? · ~(\d+) min$/, '$1 preguntas · ~$2 min'],
  [/^Follow up with (.+)$/,      'Seguimiento con $1'],
  [/^Call (.+) back$/,           'Devolver llamada a $1'],
  [/^Send after call email$/,    'Enviar correo post-llamada'],
  [/^Post Site Visit EMAIL w\/ (.+)$/, 'Correo post-visita con $1'],
];

// ── Date word replacement (for locale date strings baked into text) ──────────
const _GW_DATE_WORDS = [
  // Full weekday names (upper + title case)
  ['MONDAY','LUNES'],['TUESDAY','MARTES'],['WEDNESDAY','MIÉRCOLES'],['THURSDAY','JUEVES'],['FRIDAY','VIERNES'],['SATURDAY','SÁBADO'],['SUNDAY','DOMINGO'],
  ['Monday','Lunes'],['Tuesday','Martes'],['Wednesday','Miércoles'],['Thursday','Jueves'],['Friday','Viernes'],['Saturday','Sábado'],['Sunday','Domingo'],
  // Full month names
  ['JANUARY','ENERO'],['FEBRUARY','FEBRERO'],['MARCH','MARZO'],['APRIL','ABRIL'],['MAY','MAYO'],['JUNE','JUNIO'],['JULY','JULIO'],['AUGUST','AGOSTO'],['SEPTEMBER','SEPTIEMBRE'],['OCTOBER','OCTUBRE'],['NOVEMBER','NOVIEMBRE'],['DECEMBER','DICIEMBRE'],
  ['January','Enero'],['February','Febrero'],['March','Marzo'],['April','Abril'],['June','Junio'],['July','Julio'],['August','Agosto'],['September','Septiembre'],['October','Octubre'],['November','Noviembre'],['December','Diciembre'],
  // Abbreviated (only where Spanish differs)
  ['JAN','ENE'],['APR','ABR'],['AUG','AGO'],['DEC','DIC'],
  ['Jan','Ene'],['Apr','Abr'],['Aug','Ago'],['Dec','Dic'],
  ['MON','LUN'],['TUE','MAR'],['WED','MIÉ'],['THU','JUE'],['FRI','VIE'],['SAT','SÁB'],['SUN','DOM'],
  ['Mon','Lun'],['Tue','Mar'],['Wed','Mié'],['Thu','Jue'],['Fri','Vie'],['Sat','Sáb'],['Sun','Dom'],
];
// Precompile date word regexes (word-boundary, case-sensitive)
const _GW_DATE_RES = _GW_DATE_WORDS.map(([en, es]) => [new RegExp('\\b' + en + '\\b', 'g'), es]);

// ── Core string translator ────────────────────────────────────────────────────
/**
 * Translate a raw string (may include surrounding whitespace).
 * Returns translated string, or null if no translation applies.
 */
function _gwTranslateString(src) {
  const t = src.trim();
  if (!t || !/[A-Za-z]/.test(t)) return null;

  // 1. Exact dictionary hit
  let out = _GW_ES[t];

  // 2. Case-insensitive hit (handles CSS-independent ALL-CAPS text)
  if (out === undefined) {
    const hit = _GW_ES_LC[t.toLowerCase()];
    if (hit !== undefined) {
      out = (t === t.toUpperCase()) ? hit.toUpperCase() : hit;
    }
  }

  // 3. Pattern rules
  if (out === undefined) {
    for (let i = 0; i < _GW_PATTERNS.length; i++) {
      const re = _GW_PATTERNS[i][0];
      if (re.test(t)) { out = t.replace(re, _GW_PATTERNS[i][1]); break; }
    }
  }

  // 4. Date-word substitution (applies to date-looking strings)
  if (out === undefined && /\b(MON|TUE|WED|THU|FRI|SAT|SUN|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY|January|February|March|April|June|July|August|September|October|November|December|JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\b/.test(t)) {
    let s = t, changed = false;
    for (let i = 0; i < _GW_DATE_RES.length; i++) {
      if (_GW_DATE_RES[i][0].test(s)) {
        s = s.replace(_GW_DATE_RES[i][0], _GW_DATE_RES[i][1]);
        changed = true;
      }
      _GW_DATE_RES[i][0].lastIndex = 0; // reset /g regex state
    }
    if (changed) out = s;
  }

  if (out === undefined || out === t) return null;

  // Preserve surrounding whitespace
  const lead  = src.match(/^\s*/)[0];
  const trail = src.match(/\s*$/)[0];
  return lead + out + trail;
}

// ── _t() — programmatic translation (kept for code that calls it) ────────────
window._t = function _t(key, vars) {
  let str = key;
  if (window._gwLang === 'es') {
    str = _GW_ES[key] || _gwTranslateString(key) || key;
  }
  if (vars && typeof vars === 'object') {
    str = str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : '{' + k + '}'));
  }
  return str;
};

// Expose dictionary for external access
window._GW_ES = _GW_ES;

// ══════════════════════════════════════════════════════════════════════════════
// DOM AUTO-TRANSLATION ENGINE
// ══════════════════════════════════════════════════════════════════════════════

// Original English text is remembered per text-node / per attribute so that
// switching back to EN restores exactly what the app rendered.
const _gwOrigText = new WeakMap();   // Text node → original English string
const _gwLastSet  = new WeakMap();   // Text node → last value WE wrote
const _gwOrigAttr = new WeakMap();   // Element  → { attrName: original }

const _GW_SKIP_TAGS = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEXTAREA:1, CODE:1, PRE:1 };
const _GW_ATTRS = ['placeholder', 'title', 'aria-label'];

let _gwApplying = false; // guard: ignore mutations we cause ourselves

/**
 * Translate (or restore) all text nodes + attributes under `root`.
 */
function _gwTranslateRoot(root) {
  if (!root) return;
  if (root.nodeType === 3) { root = root.parentElement; if (!root) return; }
  if (root.nodeType !== 1 && root.nodeType !== 9) return;

  _gwApplying = true;
  try {
    const toES = window._gwLang === 'es';

    // ── Text nodes ──
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || _GW_SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
        if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      let orig = _gwOrigText.get(n);
      // If node is new, or the APP re-wrote its text since our last pass,
      // treat the current value as the new English original.
      if (orig === undefined || (n.nodeValue !== _gwLastSet.get(n) && n.nodeValue !== orig)) {
        orig = n.nodeValue;
        _gwOrigText.set(n, orig);
      }
      if (toES) {
        const tr = _gwTranslateString(orig);
        const want = (tr !== null) ? tr : orig;
        if (n.nodeValue !== want) n.nodeValue = want;
        _gwLastSet.set(n, want);
      } else {
        if (n.nodeValue !== orig) n.nodeValue = orig;
        _gwLastSet.set(n, orig);
      }
    }

    // ── Attributes (placeholder / title / aria-label) ──
    if (root.querySelectorAll) {
      const els = root.querySelectorAll('[placeholder],[title],[aria-label]');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        let store = _gwOrigAttr.get(el);
        if (!store) { store = {}; _gwOrigAttr.set(el, store); }
        for (let a = 0; a < _GW_ATTRS.length; a++) {
          const attr = _GW_ATTRS[a];
          if (!el.hasAttribute(attr)) continue;
          const cur = el.getAttribute(attr);
          if (store[attr] === undefined || (cur !== store[attr] && cur !== store['_set_' + attr])) {
            store[attr] = cur; // capture new original
          }
          if (toES) {
            const tr = _gwTranslateString(store[attr]);
            const want = (tr !== null) ? tr : store[attr];
            if (cur !== want) el.setAttribute(attr, want);
            store['_set_' + attr] = want;
          } else {
            if (cur !== store[attr]) el.setAttribute(attr, store[attr]);
            store['_set_' + attr] = store[attr];
          }
        }
      }
    }
  } finally {
    _gwApplying = false;
  }
}

/** Full-page translation pass. */
window._gwTranslatePage = function() {
  _gwTranslateRoot(document.body);
};

// ── MutationObserver — translate anything the app renders, live ──────────────
let _gwMOQueue = new Set();
let _gwMOScheduled = false;

function _gwFlushMO() {
  _gwMOScheduled = false;
  if (window._gwLang !== 'es') { _gwMOQueue.clear(); return; }
  const roots = Array.from(_gwMOQueue);
  _gwMOQueue.clear();
  // If a huge number of subtrees changed, just do the whole body once.
  if (roots.length > 40) { _gwTranslateRoot(document.body); return; }
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    if (r && (r.isConnected === undefined || r.isConnected)) _gwTranslateRoot(r);
  }
}

const _gwObserver = new MutationObserver(function(mutations) {
  if (_gwApplying) return;
  if (window._gwLang !== 'es') return;
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    if (m.type === 'childList') {
      _gwMOQueue.add(m.target);
    } else if (m.type === 'characterData') {
      // Skip if this is the value we ourselves set
      if (m.target.nodeValue === _gwLastSet.get(m.target)) continue;
      _gwMOQueue.add(m.target.parentElement || m.target);
    } else if (m.type === 'attributes') {
      _gwMOQueue.add(m.target);
    }
  }
  if (_gwMOQueue.size && !_gwMOScheduled) {
    _gwMOScheduled = true;
    requestAnimationFrame(_gwFlushMO);
  }
});

function _gwStartObserver() {
  if (!document.body) return;
  _gwObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: _GW_ATTRS,
  });
}

// ── Language switcher ─────────────────────────────────────────────────────────
window._gwSetLang = async function _gwSetLang(lang) {
  if (lang !== 'en' && lang !== 'es') return;
  window._gwLang = lang;
  try { localStorage.setItem('gw_lang', lang); } catch(_) {}

  // Persist to D1 (best-effort, don't block UI)
  fetch('/api/me/language', {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language: lang }),
  }).catch(() => {});

  // Update language toggle button appearance
  _gwUpdateLangToggle();

  // Translate / restore the whole page immediately
  window._gwTranslatePage();

  if (typeof window.showToast === 'function') {
    window.showToast(_t('Language saved') + ' — ' + (lang === 'es' ? 'Español' : 'English'), 'success');
  }
};

// ── Language toggle button render ─────────────────────────────────────────────
window._gwRenderLangToggle = function _gwRenderLangToggle() {
  document.getElementById('gw-lang-toggle')?.remove();
  const container = document.querySelector('.sidebar-footer');
  if (!container) return;
  const wrapper = document.createElement('div');
  wrapper.id = 'gw-lang-toggle';
  wrapper.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 12px;margin-bottom:4px;border-top:1px solid rgba(255,255,255,.08)';
  wrapper.innerHTML = _gwLangToggleHTML();
  container.parentNode?.insertBefore(wrapper, container);
};

function _gwLangToggleHTML() {
  const isEs = window._gwLang === 'es';
  return `
    <span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:rgba(255,255,255,.45);font-weight:600;letter-spacing:.04em">
      ${(typeof gwIcon === 'function') ? gwIcon('globe', 13, 'rgba(255,255,255,.45)') : ''}${isEs ? 'Idioma' : 'Language'}
    </span>
    <div style="display:flex;gap:0;border:1px solid rgba(255,255,255,.20);border-radius:6px;overflow:hidden">
      <button id="gw-lang-en" onclick="window._gwSetLang('en')"
        style="padding:3px 8px;font-size:11px;font-weight:700;border:none;cursor:pointer;
          background:${!isEs ? 'rgba(255,255,255,.25)' : 'transparent'};
          color:${!isEs ? '#fff' : 'rgba(255,255,255,.45)'}">
        EN
      </button>
      <button id="gw-lang-es" onclick="window._gwSetLang('es')"
        style="padding:3px 8px;font-size:11px;font-weight:700;border:none;cursor:pointer;
          background:${isEs ? 'rgba(255,255,255,.25)' : 'transparent'};
          color:${isEs ? '#fff' : 'rgba(255,255,255,.45)'}">
        ES
      </button>
    </div>`;
}

window._gwUpdateLangToggle = function() {
  const el = document.getElementById('gw-lang-toggle');
  if (el) {
    el.innerHTML = _gwLangToggleHTML();
  } else {
    _gwRenderLangToggle();
  }
};

// ── Bootstrap integration ─────────────────────────────────────────────────────
(function _gwI18nBootstrap() {
  function _applyBootstrapLang() {
    const rep = window._d1SessionRep || window._gwBootstrap?.rep;
    const saved = rep?.preferred_language;
    if (saved && (saved === 'en' || saved === 'es') && saved !== window._gwLang) {
      window._gwLang = saved;
      try { localStorage.setItem('gw_lang', saved); } catch(_) {}
    }
    _gwRenderLangToggle();
    if (window._gwLang === 'es') window._gwTranslatePage();
  }

  function _init() {
    _gwStartObserver();
    // First translation pass (covers server-rendered shell)
    if (window._gwLang === 'es') window._gwTranslatePage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  if (window._d1BootstrapReady && typeof window._d1BootstrapReady.then === 'function') {
    window._d1BootstrapReady.then(() => {
      setTimeout(_applyBootstrapLang, 100);
    }).catch(() => {});
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(_applyBootstrapLang, 1500));
  }
})();

console.info('[GW i18n] v2 DOM auto-translation engine loaded — active lang:', window._gwLang);
