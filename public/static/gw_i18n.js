/**
 * Groundwork CRM — Internationalization (i18n) Engine
 * Supports: English (en) | Spanish (es)
 *
 * Usage:
 *   _t('Clock In')              → 'Registrar Entrada' (when lang=es)
 *   _t('Hello {name}', {name:'Ana'}) → 'Hola Ana'
 *   window._gwLang              → 'en' | 'es'
 *   window._gwSetLang('es')     → switches language + saves preference
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

// ── Translation dictionaries ──────────────────────────────────────────────────
// Keys are canonical English strings. Values are Spanish translations.
// Field-facing strings are the priority; admin/sales strings stay in English
// for now and fall back gracefully.

const _GW_ES = {

  // ── Greetings / time-of-day ────────────────────────────────────────────────
  'Good morning':   'Buenos días',
  'Good afternoon': 'Buenas tardes',
  'Good evening':   'Buenas noches',
  'Field User':     'Usuario de Campo',
  'Loading…':       'Cargando…',

  // ── Clock states ───────────────────────────────────────────────────────────
  'Not Clocked In':    'Sin Registrar Entrada',
  'Clocked In':        'Entrada Registrada',
  'On Break':          'En Descanso',
  'Done for Today':    'Listo por Hoy',
  'Time on the clock': 'Tiempo registrado',
  'Break timer running': 'Temporizador de descanso activo',

  // ── Clock-in / out buttons ─────────────────────────────────────────────────
  'Clock In':    'Registrar Entrada',
  'Clock Out':   'Registrar Salida',
  'Break':       'Descanso',
  'End Break':   'Terminar Descanso',
  'View My Timesheet': 'Ver Mi Hoja de Tiempo',

  // ── Job count suffix ───────────────────────────────────────────────────────
  ' Job':  ' Trabajo',
  ' Jobs': ' Trabajos',

  // ── Dashboard sections ─────────────────────────────────────────────────────
  'Dashboard':            'Panel Principal',
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

  // ── Quick links ────────────────────────────────────────────────────────────
  'Quick Links':  'Accesos Rápidos',
  'Schedule':     'Horario',
  'Work Orders':  'Órdenes de Trabajo',
  'Timesheet':    'Hoja de Tiempo',
  'Crew':         'Cuadrilla',
  'Field Mode':   'Modo Campo',

  // ── My Tasks ───────────────────────────────────────────────────────────────
  'My Tasks':          'Mis Tareas',
  'No open tasks today': 'No hay tareas abiertas hoy',
  'Task marked done ✓':  'Tarea marcada como lista ✓',
  'HIGH':              'ALTA',
  'Due':               'Vence',

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
  '✅ Yes':   '✅ Sí',
  '❌ No':    '❌ No',

  'questions':               'preguntas',
  'Yes':                      'Sí',
  'No':                       'No',
  '— Select —':                '— Seleccionar —',

  // AAR question defaults
  'Did you complete all assigned work orders today?':     '¿Completaste todas las órdenes de trabajo asignadas hoy?',
  'Were there any safety incidents or near-misses today?':'¿Hubo algún incidente de seguridad o casi-accidente hoy?',
  'Any issues or concerns from today that need follow-up?':'¿Algún problema o preocupación de hoy que necesite seguimiento?',
  'Overall how did today go? (1 = rough, 5 = great)':    '¿Cómo fue el día en general? (1 = difícil, 5 = excelente)',
  'Any materials, tools, or supplies needed for tomorrow?':'¿Se necesitan materiales, herramientas o suministros para mañana?',
  'Your answer…':  'Tu respuesta…',

  // Clock-out gate
  'Please complete your end-of-day report before clocking out': 'Por favor completa tu reporte de fin de día antes de registrar salida',

  // ── Work Order list ────────────────────────────────────────────────────────
  'Loading work orders…':    'Cargando órdenes de trabajo…',
  'Work Orders':              'Órdenes de Trabajo',
  'total':                'total',
  'in progress':          'en progreso',
  'scheduled':            'programado',
  'Unassigned':           'Sin Asignar',
  'Schedule Board':       'Tablero de Horario',
  '+ New Work Order':     '+ Nueva Orden de Trabajo',
  'No work orders yet.':  'No hay órdenes de trabajo todavía.',
  '+ Create First Work Order': '+ Crear Primera Orden de Trabajo',
  'Open':                 'Abrir',
  'WO #':                 'OT #',
  'Client':               'Cliente',
  'Type':                 'Tipo',
  'Date':                 'Fecha',
  'Status':               'Estado',

  // WO status labels
  'Scheduled':   'Programado',
  'In Progress': 'En Progreso',
  'Completed':   'Completado',
  'Cancelled':   'Cancelado',
  'On Hold':     'En Espera',

  // ── Schedule Board ─────────────────────────────────────────────────────────
  'Loading schedule…':  'Cargando horario…',
  'No crews yet.':      'Sin cuadrillas todavía.',
  'Manage Crews':       'Administrar Cuadrillas',
  'Crew Lanes':         'Carriles de Cuadrilla',
  'Unassigned':         'Sin Asignar',
  'Today':              'Hoy',
  'Sun': 'Dom', 'Mon': 'Lun', 'Tue': 'Mar',
  'Wed': 'Mié', 'Thu': 'Jue', 'Fri': 'Vie', 'Sat': 'Sáb',

  // ── Timesheet / Time Tracker ───────────────────────────────────────────────
  'Timesheet':       'Hoja de Tiempo',
  'Time Tracker':    'Control de Tiempo',
  'Clock In':        'Registrar Entrada',
  'Clock Out':       'Registrar Salida',
  'Break':           'Descanso',
  'Start Break':     'Iniciar Descanso',
  'End Break':       'Terminar Descanso',
  'Total Hours':     'Total de Horas',
  'Regular':         'Regular',
  'Overtime':        'Horas Extra',
  'No time entries': 'Sin registros de tiempo',

  // ── Sidebar nav labels ─────────────────────────────────────────────────────
  'Operations': 'Operaciones',
  'Admin':      'Administración',
  'Sales':      'Ventas',
  'Financial':  'Finanzas',
  'Learning':   'Aprendizaje',

  // ── Language toggle ────────────────────────────────────────────────────────
  'Language':         'Idioma',
  'English':          'Inglés',
  'Spanish':          'Español',
  'Switch to English': 'Cambiar a Inglés',
  'Switch to Spanish': 'Cambiar a Español',
  'Language saved':    'Idioma guardado',

  // ── Toast / generic ────────────────────────────────────────────────────────
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
  'Search':           'Buscar',
  'Filter':           'Filtrar',
  'View':             'Ver',
  'Details':          'Detalles',
  'Notes':            'Notas',
  'Name':             'Nombre',
  'Address':          'Dirección',
  'Phone':            'Teléfono',
  'Email':            'Correo',
};

// ── Core translation function ─────────────────────────────────────────────────
/**
 * _t(key, vars)
 * Returns translated string for current language.
 * Falls back to key (English) if no translation found.
 * Supports {placeholder} interpolation.
 *
 * @param {string} key  - English string (canonical key)
 * @param {object} vars - optional interpolation map e.g. {name:'Ana', count:3}
 * @returns {string}
 */
window._t = function _t(key, vars) {
  let str = key;
  if (window._gwLang === 'es') {
    str = _GW_ES[key] || key;
  }
  // Interpolate {var} placeholders
  if (vars && typeof vars === 'object') {
    str = str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : '{' + k + '}'));
  }
  return str;
};

// Expose dictionary for external access (e.g. dynamic server-side strings)
window._GW_ES = _GW_ES;

// ── Language switcher ─────────────────────────────────────────────────────────
/**
 * _gwSetLang(lang)
 * Switch active language, persist to localStorage + D1, re-render current view.
 * @param {'en'|'es'} lang
 */
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

  // Re-render current view so strings flip immediately
  try {
    const current = window._currentView;
    if (current && typeof window.show === 'function') {
      window.show(current);
    }
  } catch(_) {}

  if (typeof window.showToast === 'function') {
    window.showToast(_t('Language saved') + ' — ' + (lang === 'es' ? '🇲🇽 Español' : '🇺🇸 English'), 'success');
  }
};

// ── Language toggle button render ─────────────────────────────────────────────
// Renders/updates the language toggle pill in the sidebar footer area.
// Called from _updateSidebarRep() and on language change.

window._gwRenderLangToggle = function _gwRenderLangToggle() {
  // Remove existing toggle to avoid duplicates
  document.getElementById('gw-lang-toggle')?.remove();

  const container = document.querySelector('.sidebar-footer');
  if (!container) return;

  // Insert a language toggle row ABOVE the footer
  const wrapper = document.createElement('div');
  wrapper.id = 'gw-lang-toggle';
  wrapper.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 12px;margin-bottom:4px;border-top:1px solid rgba(255,255,255,.08)';

  wrapper.innerHTML = _gwLangToggleHTML();
  container.parentNode?.insertBefore(wrapper, container);
};

function _gwLangToggleHTML() {
  const isEs = window._gwLang === 'es';
  return `
    <span style="font-size:11px;color:rgba(255,255,255,.45);font-weight:600;letter-spacing:.04em">
      ${isEs ? '🌐 Idioma' : '🌐 Language'}
    </span>
    <div style="display:flex;gap:0;border:1px solid rgba(255,255,255,.20);border-radius:6px;overflow:hidden">
      <button id="gw-lang-en" onclick="window._gwSetLang('en')"
        style="padding:3px 8px;font-size:11px;font-weight:700;border:none;cursor:pointer;
          background:${!isEs ? 'rgba(255,255,255,.25)' : 'transparent'};
          color:${!isEs ? '#fff' : 'rgba(255,255,255,.45)'}">
        🇺🇸 EN
      </button>
      <button id="gw-lang-es" onclick="window._gwSetLang('es')"
        style="padding:3px 8px;font-size:11px;font-weight:700;border:none;cursor:pointer;
          background:${isEs ? 'rgba(255,255,255,.25)' : 'transparent'};
          color:${isEs ? '#fff' : 'rgba(255,255,255,.45)'}">
        🇲🇽 ES
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
// When D1 bootstrap completes, hydrate the language from the rep's saved pref.

(function _gwI18nBootstrap() {
  function _applyBootstrapLang() {
    const rep = window._d1SessionRep || window._gwBootstrap?.rep;
    const saved = rep?.preferred_language;
    if (saved && (saved === 'en' || saved === 'es') && saved !== window._gwLang) {
      window._gwLang = saved;
      try { localStorage.setItem('gw_lang', saved); } catch(_) {}
    }
    _gwRenderLangToggle();
  }

  if (window._d1BootstrapReady && typeof window._d1BootstrapReady.then === 'function') {
    window._d1BootstrapReady.then(() => {
      setTimeout(_applyBootstrapLang, 100);
    }).catch(() => {});
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(_applyBootstrapLang, 1500));
  }
})();

console.info('[GW i18n] Language engine loaded — active lang:', window._gwLang);
