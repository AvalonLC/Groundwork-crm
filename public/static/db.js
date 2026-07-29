/**
 * Groundwork CRM — D1 Frontend API Client (db.js)
 *
 * This module replaces direct localStorage reads/writes with async
 * fetch() calls to the Hono API layer backed by Cloudflare D1.
 *
 * Multi-tenant: all requests include companyId (default 'avalon').
 * Set window._companyId before calling any method to scope to a tenant.
 *
 * Usage:
 *   const opps = await DB.opportunities.list({ repId: 'tyler' });
 *   await DB.opportunities.save(opp);  // create or update
 *   await DB.notes.add(oppId, body, repId);
 *   const me = await DB.auth.me();
 *
 * All methods return the data payload directly (unwrapped from { ok, data }).
 * On error they throw with a descriptive message.
 *
 * MIGRATION BRIDGE:
 *   DB.sync(state) — sends full localStorage state to /api/sync for one-time
 *   migration. Call on first D1-enabled load if localStorage has data.
 */

const DB = (() => {

  // ── Company context ──────────────────────────────────────────────────────────
  // window._companyId is set by app_premium.js after login resolves.
  // Fall back to 'avalon' so existing code works without changes.
  function cid() {
    return (window._companyId && window._companyId !== '') ? window._companyId : 'avalon';
  }

  // ── Base fetch helper ────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'  // send session cookie
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `API error ${res.status}: ${path}`);
    return json.data;
  }

  const get  = (path)        => api('GET',    path);
  const post = (path, body)  => api('POST',   path, body);
  const put  = (path, body)  => api('PUT',    path, body);
  const del  = (path)        => api('DELETE', path);

  // ── AUTH ─────────────────────────────────────────────────────────────────────
  const auth = {
    /** Login with email + password. Returns rep object on success.
     *  Legacy repId+pin shape is also accepted (falls through to server). */
    login(emailOrRepId, password, companyId) {
      // Detect email vs legacy repId (email contains '@')
      if (emailOrRepId && emailOrRepId.includes('@')) {
        return post('/auth/login', { email: emailOrRepId.toLowerCase().trim(), password });
      }
      // Legacy: repId + pin (offline path)
      return post('/auth/login', { repId: emailOrRepId, password, companyId: companyId || cid() });
    },
    /** Logout — clears session cookie. */
    logout() {
      return post('/auth/logout', {});
    },
    /** Returns current rep from session cookie, or throws 401. */
    me() {
      return get('/auth/me');
    }
  };

  // ── REPS ─────────────────────────────────────────────────────────────────────
  const reps = {
    list()     { return get(`/reps?companyId=${encodeURIComponent(cid())}`); },
    get(id)    { return get(`/reps/${id}?companyId=${encodeURIComponent(cid())}`); },
    update(id, data) { return put(`/reps/${id}`, { ...data, companyId: cid() }); }
  };

  // ── OPPORTUNITIES ────────────────────────────────────────────────────────────
  const opportunities = {
    /** List all opportunities, optionally filtered by repId and/or status. */
    list({ repId, status } = {}) {
      const params = new URLSearchParams();
      params.set('companyId', cid());
      if (repId)  params.set('repId', repId);
      if (status) params.set('status', status);
      return get('/opportunities?' + params.toString());
    },

    /** Get single opportunity by id. */
    get(id) {
      return get(`/opportunities/${id}?companyId=${encodeURIComponent(cid())}`);
    },

    /**
     * Save (create or update) an opportunity.
     * If opp.id exists → PUT, else → POST.
     * Returns { id } on success.
     */
    async save(opp) {
      const payload = { ...opp, companyId: opp.companyId || cid() };
      if (opp.id) {
        return put(`/opportunities/${opp.id}`, payload);
      } else {
        return post('/opportunities', payload);
      }
    },

    /** Delete an opportunity and all child records. */
    delete(id) {
      return del(`/opportunities/${id}?companyId=${encodeURIComponent(cid())}`);
    },

    /**
     * Bulk-upsert from localStorage array — used on first D1 login to push
     * any leads that were created before D1 was reachable.
     * Skips opps already in D1 (server checks by id).
     */
    bulkUpsert(opps) {
      return post('/opportunities/bulk-upsert', { opps, companyId: cid() });
    }
  };

  // ── NOTES ────────────────────────────────────────────────────────────────────
  const notes = {
    /** Get all notes for an opportunity. */
    list(oppId) {
      return get(`/opportunities/${oppId}/notes?companyId=${encodeURIComponent(cid())}`);
    },

    /** Add a new note to an opportunity. */
    add(oppId, body, repId) {
      return post(`/opportunities/${oppId}/notes`, { body, repId, companyId: cid() });
    },

    /** Delete a note by id. */
    delete(noteId) {
      return del(`/notes/${noteId}?companyId=${encodeURIComponent(cid())}`);
    }
  };

  // ── COMMUNICATIONS ───────────────────────────────────────────────────────────
  const comms = {
    /** Get communications for an opportunity. */
    list(oppId) {
      return get(`/opportunities/${oppId}/comms?companyId=${encodeURIComponent(cid())}`);
    },

    /** Log a communication (call, email, SMS, proposal). */
    add(oppId, { type, direction, subject, body, repId }) {
      return post(`/opportunities/${oppId}/comms`, { type, direction, subject, body, repId, companyId: cid() });
    },

    /** Get all communications (global activity log), optionally filtered by repId. */
    all(repId) {
      const params = new URLSearchParams({ companyId: cid() });
      if (repId) params.set('repId', repId);
      return get('/comms?' + params.toString());
    }
  };

  // ── CHECKLIST PROGRESS ───────────────────────────────────────────────────────
  const checklist = {
    /** Get all checklist progress rows for an opportunity. */
    list(oppId) {
      return get(`/checklist/${oppId}?companyId=${encodeURIComponent(cid())}`);
    },

    /**
     * Upsert a checklist item.
     * @param {string} oppId
     * @param {string} checklistId  — e.g. 'new-lead', 'proposal-sent'
     * @param {number} itemIndex
     * @param {boolean} checked
     */
    set(oppId, checklistId, itemIndex, checked) {
      return put('/checklist', { oppId, checklistId, itemIndex, checked, companyId: cid() });
    }
  };

  // ── CLIENTS ──────────────────────────────────────────────────────────────────
  const clients = {
    list() { return get(`/clients?companyId=${encodeURIComponent(cid())}`); },
    save(client) {
      const payload = { ...client, companyId: client.companyId || cid() };
      if (client.id) return put(`/clients/${client.id}`, payload);
      return post('/clients', payload);
    },
    delete(id) { return del(`/clients/${id}?companyId=${encodeURIComponent(cid())}`); }
  };

  // ── SETTINGS ─────────────────────────────────────────────────────────────────
  const settings = {
    getAll()         { return get(`/settings?companyId=${encodeURIComponent(cid())}`); },
    set(key, value)  { return put('/settings', { key, value, companyId: cid() }); }
  };

  // ── REVENUE ACTUALS ──────────────────────────────────────────────────────────
  const revenue = {
    list()                                           {
      return get(`/revenue?companyId=${encodeURIComponent(cid())}`);
    },
    set(month, year, rev, note, division = 'total')  {
      return put('/revenue', { month, year, revenue: rev, note, division, companyId: cid() });
    }
  };

  // ── ACADEMY ──────────────────────────────────────────────────────────────────
  const academy = {
    progress: {
      list(repId) {
        return get(`/academy/progress/${repId}?companyId=${encodeURIComponent(cid())}`);
      },
      set(repId, moduleId, sectionId, completed, score) {
        return put('/academy/progress', { repId, moduleId, sectionId, completed, score, companyId: cid() });
      }
    },
    quiz: {
      list(repId) {
        return get(`/academy/quiz/${repId}?companyId=${encodeURIComponent(cid())}`);
      },
      submit(repId, moduleId, score, total, passed, answers) {
        return post('/academy/quiz', { repId, moduleId, score, total, passed, answers, companyId: cid() });
      }
    },
    badges: {
      list(repId) {
        return get(`/academy/badges/${repId}?companyId=${encodeURIComponent(cid())}`);
      },
      award(repId, badgeId) {
        return post('/academy/badges', { repId, badgeId, companyId: cid() });
      }
    },
    certs: {
      list(repId) {
        return get(`/academy/certs/${repId}?companyId=${encodeURIComponent(cid())}`);
      },
      set(repId, phaseId, status) {
        return put('/academy/certs', { repId, phaseId, status, companyId: cid() });
      }
    }
  };

  // ── BULK SYNC (one-time localStorage → D1 migration) ─────────────────────────
  /**
   * Send full localStorage state to /api/sync for one-time migration.
   * Safe to call multiple times — uses INSERT OR IGNORE / INSERT OR REPLACE.
   * @param {object} state — { opportunities[], notes[], communications[], clients[] }
   * @returns {{ synced: number }}
   */
  async function sync(state) {
    return post('/sync', {
      companyId:      cid(),
      opportunities:  state.opportunities  || [],
      notes:          state.notes          || [],
      communications: state.communications || [],
      clients:        state.clients        || []
    });
  }

  // ── MIGRATION BRIDGE ─────────────────────────────────────────────────────────
  /**
   * One-time migration: reads localStorage, pushes to D1, marks done.
   * Call this on app startup (before loadState from D1).
   *
   * Uses flag key 'db_migrated_v1' in D1 settings to avoid repeat migration.
   */
  async function migrateFromLocalStorage() {
    const STORAGE_KEY = 'avalonSalesHubStateV3';
    const MIGRATE_FLAG = 'db_migrated_v1';

    // Check if migration already done
    try {
      const allSettings = await settings.getAll();
      if (allSettings && allSettings[MIGRATE_FLAG] === '1') {
        console.log('[DB] Migration already done, skipping.');
        return false;
      }
    } catch(e) {
      console.warn('[DB] Could not check migration flag:', e.message);
    }

    // Check if localStorage has data
    let localData;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        console.log('[DB] No localStorage data to migrate.');
        await settings.set(MIGRATE_FLAG, '1');
        return false;
      }
      localData = JSON.parse(raw);
    } catch(e) {
      console.warn('[DB] Could not read localStorage:', e.message);
      return false;
    }

    const hasData = (
      (localData.opportunities && localData.opportunities.length > 0) ||
      (localData.notes          && localData.notes.length          > 0) ||
      (localData.communications && localData.communications.length > 0)
    );

    if (!hasData) {
      console.log('[DB] localStorage empty, nothing to migrate.');
      await settings.set(MIGRATE_FLAG, '1');
      return false;
    }

    // Also migrate clients from separate localStorage key
    let localClients = [];
    try {
      const raw = localStorage.getItem('avalonClientsV1');
      if (raw) localClients = JSON.parse(raw) || [];
    } catch(e) {}

    console.log(`[DB] Migrating ${localData.opportunities?.length || 0} opps, ` +
      `${localData.notes?.length || 0} notes, ${localData.communications?.length || 0} comms, ` +
      `${localClients.length} clients from localStorage → D1 (companyId: ${cid()})`);

    try {
      const result = await sync({
        opportunities:  localData.opportunities  || [],
        notes:          localData.notes          || [],
        communications: localData.communications || [],
        clients:        localClients
      });
      console.log(`[DB] Migration synced ${result.synced} records`);
      await settings.set(MIGRATE_FLAG, '1');
      return true;
    } catch(e) {
      console.error('[DB] Migration failed:', e.message);
      return false;
    }
  }

  // ── SESSION MANAGEMENT ───────────────────────────────────────────────────────
  /**
   * Check if user is currently logged in.
   * Returns rep object (including company_id) or null.
   * Also sets window._companyId from the rep's company_id for subsequent calls.
   */
  async function getSession() {
    try {
      const rep = await auth.me();
      if (rep && rep.company_id) {
        window._companyId = rep.company_id;
      }
      return rep;
    } catch(e) {
      return null;
    }
  }

  // ── EVENTS (real-time peer-change detection) ─────────────────────────────────
  const events = {
    poll() { return get('/events/poll'); },
    ping()  { return post('/events/ping', {}).catch(() => {}); }
  };

  // ── ROLES (per-company generic role system) ───────────────────────────────────
  const roles = {
    /** List all roles for this company */
    list() { return get('/roles'); },
    /** Create a custom role */
    create(role) { return post('/roles', role); },
    /** Update a role's label, color, description, or permissions */
    update(id, patch) { return put(`/roles/${id}`, patch); },
    /** Delete a custom role */
    delete(id) { return del(`/roles/${id}`); }
  };

  // ── PIPELINE STAGES (per-company configurable) ────────────────────────────────
  const pipelineStages = {
    /** Get ordered stage list for this company */
    list() { return get('/pipeline-stages'); },
    /** Update the stage list (admin only) */
    save(stages) { return put('/pipeline-stages', { stages }); }
  };

  // Versioned sales processes. AI suggestions are drafts and publication always
  // requires a separately validated version plus an approved mapping batch.
  const salesProcess = {
    get(versionId) { return get('/sales-process' + (versionId ? `?version_id=${encodeURIComponent(versionId)}` : '')); },
    templates() { return get('/sales-process/templates'); },
    adoptTemplate(templateVersionId, name) { return post('/sales-process/drafts/from-template', { template_version_id: templateVersionId, name }); },
    saveStages(versionId, stages, contentRevision) { return put(`/sales-process/drafts/${encodeURIComponent(versionId)}/stages`, { stages, content_revision: contentRevision }); },
    saveComponents(versionId, component, items, contentRevision) { return put(`/sales-process/drafts/${encodeURIComponent(versionId)}/components/${encodeURIComponent(component)}`, { items, content_revision: contentRevision }); },
    createSuggestion(versionId, suggestion) { return post(`/sales-process/drafts/${encodeURIComponent(versionId)}/ai-suggestions`, suggestion); },
    generateSuggestions(versionId, interview) { return post(`/sales-process/drafts/${encodeURIComponent(versionId)}/ai-suggestions/generate`, interview); },
    decideSuggestion(versionId, suggestionId, decision, appliedRevision = 0) { return put(`/sales-process/drafts/${encodeURIComponent(versionId)}/ai-suggestions/${encodeURIComponent(suggestionId)}`, { decision, applied_revision: appliedRevision }); },
    validate(versionId) { return post(`/sales-process/versions/${encodeURIComponent(versionId)}/validate`, {}); },
    inventory() { return get('/sales-process/migration/inventory'); },
    propose(versionId) { return post('/sales-process/migration/propose', { process_version_id: versionId }); },
    mappings(batchId) { return get(`/sales-process/migration/${encodeURIComponent(batchId)}`); },
    approveMapping(batchId, opportunityId, finalStageId, finalOutcomeType = '') { return put(`/sales-process/migration/${encodeURIComponent(batchId)}/${encodeURIComponent(opportunityId)}`, { final_stage_id: finalStageId, final_outcome_type: finalOutcomeType }); },
    readiness(versionId, batchId) { return get(`/sales-process/versions/${encodeURIComponent(versionId)}/publication-readiness?migration_batch_id=${encodeURIComponent(batchId)}`); },
    captureSnapshot(versionId, batchId) { return post(`/sales-process/versions/${encodeURIComponent(versionId)}/snapshots`, { migration_batch_id: batchId }); },
    approveSnapshot(snapshotId) { return post(`/sales-process/snapshots/${encodeURIComponent(snapshotId)}/approve`, {}); },
    preview(versionId, batchId) { return get(`/sales-process/versions/${encodeURIComponent(versionId)}/preview?migration_batch_id=${encodeURIComponent(batchId || '')}`); },
    context(opportunityId) { return get(`/opportunities/${encodeURIComponent(opportunityId)}/sales-context`); },
    playbook() { return get('/sales-process/playbook'); },
    transition(opportunityId, stageId, expectedStageId, outcomeType = '', overrideReason = '') {
      return put(`/opportunities/${encodeURIComponent(opportunityId)}/sales-stage`, { stage_id: stageId, expected_stage_id: expectedStageId, outcome_type: outcomeType, override_reason: overrideReason });
    },
    publish(versionId, batchId) { return post(`/sales-process/versions/${encodeURIComponent(versionId)}/publish`, { migration_batch_id: batchId, confirm: true }); },
    rollback(publicationId) { return post(`/sales-process/publications/${encodeURIComponent(publicationId)}/rollback`, {}); }
  };

  // ── NAV PERMISSIONS (per-company per-role access) ────────────────────────────
  const navPerms = {
    /** Get nav perms for this company */
    get() { return get('/nav-perms'); },
    /** Save updated nav perms (admin only) */
    save(perms) { return put('/nav-perms', { perms }); }
  };

  // ── ACTIVITY LOG (append-only audit trail) ────────────────────────────────────
  const activityLog = {
    /**
     * Get paginated activity log.
     * opts: { limit, offset, entity_type, entity_id, actor_id }
     */
    list(opts = {}) {
      const qs = Object.entries(opts)
        .filter(([,v]) => v !== undefined && v !== '')
        .map(([k,v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
      return get('/activity-log' + (qs ? '?' + qs : ''));
    }
  };

  // ── PUBLIC API ───────────────────────────────────────────────────────────────
  return {
    auth,
    reps,
    opportunities,
    notes,
    comms,
    checklist,
    clients,
    settings,
    revenue,
    academy,
    events,
    roles,
    pipelineStages,
    salesProcess,
    navPerms,
    activityLog,
    sync,
    migrateFromLocalStorage,
    getSession,
    /** Expose cid() for debugging: DB.companyId() */
    companyId: cid
  };

})();

// Make available globally
window.DB = DB;

// ── Bootstrap synchronization promise ────────────────────────────────────────
// Created here (db.js loads first) so app_premium.js can safely await it
// before calling show(). Resolved by bootstrapD1Auth() in the inline <script>
// at the bottom of index.tsx after session check + REPS hydration completes.
window._d1BootstrapReady = new Promise(function(resolve) {
  window._d1BootstrapResolve = resolve;
});
