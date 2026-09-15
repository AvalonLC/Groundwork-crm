/**
 * Shared activity-log writer.
 *
 * Extracted from src/index.tsx (where it was a private, unexported function)
 * into this leaf module for the same reason src/env.ts and
 * src/marketing/leads.ts exist: src/index.tsx mounts standalone routers
 * (marketingRouter, ratesRouter, and now leadImportRouter — see
 * src/ai/lead-import-routes.ts) and those routers cannot import a helper
 * back out of the file that mounts them without an import cycle. index.tsx
 * now imports logActivity from here instead of declaring it; every existing
 * call site is unchanged.
 *
 * Never throws — an activity-log failure must never break the write
 * operation it is auditing.
 */
export async function logActivity(
  db: D1Database,
  { companyId, actorId, actorName, entityType, entityId, entityLabel, action, beforeJson, afterJson }: {
    companyId: string; actorId: string; actorName: string;
    entityType: string; entityId: string; entityLabel: string;
    action: string; beforeJson?: any; afterJson?: any
  }
) {
  try {
    const id = 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    await db.prepare(`
      INSERT INTO activity_log
        (id, company_id, actor_id, actor_name, entity_type, entity_id, entity_label, action, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, companyId, actorId, actorName,
      entityType, entityId, entityLabel, action,
      beforeJson ? JSON.stringify(beforeJson) : '',
      afterJson  ? JSON.stringify(afterJson)  : ''
    ).run()
  } catch (_) {
    // Activity log failures must never break the main operation
  }
}
