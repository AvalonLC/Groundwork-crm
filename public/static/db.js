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
    sync,
    migrateFromLocalStorage,
    getSession,
    /** Expose cid() for debugging: DB.companyId() */
    companyId: cid
  };

})();

// Make available globally
window.DB = DB;
