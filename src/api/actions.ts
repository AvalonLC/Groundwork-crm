import { Hono } from "hono";
import { getOpenActionItems, insertActionItem, resolveActionItem } from "../db/repos";
import type { ActionVerb, RateConfidence } from "../db/schema";

export type ActionsBindings = { DB: D1Database };

const VALID_VERBS: readonly ActionVerb[] = ["collect", "bill", "pay", "fix", "decide"];

export const actionsRouter = new Hono<{ Bindings: ActionsBindings }>();

/**
 * See docs/spec/ACTIONS.md. Every AI finding or human task becomes an
 * action_item with a verb in exactly this five-item set (CLAUDE.md) —
 * validated here at the API boundary in addition to the DB's own CHECK
 * constraint (defense in depth, not a substitute for it). owner_id and
 * sla_due are required on every action — no unowned, no open-ended action.
 */
actionsRouter.post("/", async (c) => {
  const body = await c.req.json<{
    id: string; company_id: string; verb: string; owner_id?: string; sla_due?: string;
    amount_cents?: number; confidence?: RateConfidence; stale_components?: string[];
    source_type?: string; source_id?: string;
  }>();

  if (!VALID_VERBS.includes(body.verb as ActionVerb)) {
    return c.json({ error: `verb must be one of: ${VALID_VERBS.join(", ")}` }, 400);
  }
  if (!body.owner_id) return c.json({ error: "owner_id is required" }, 400);
  if (!body.sla_due) return c.json({ error: "sla_due is required" }, 400);
  if (!body.id || !body.company_id) return c.json({ error: "id and company_id are required" }, 400);

  await insertActionItem(c.env.DB, {
    id: body.id,
    company_id: body.company_id,
    verb: body.verb as ActionVerb,
    owner_id: body.owner_id,
    sla_due: body.sla_due,
    amount_cents: (body.amount_cents ?? null) as never,
    confidence: body.confidence ?? "medium",
    stale_components: body.stale_components ? JSON.stringify(body.stale_components) : null,
    source_type: (body.source_type ?? null) as never,
    source_id: body.source_id ?? null,
  });

  return c.json({ ok: true }, 201);
});

actionsRouter.get("/", async (c) => {
  const companyId = c.req.query("company_id");
  if (!companyId) return c.json({ error: "company_id query param is required" }, 400);
  const verb = c.req.query("verb") as ActionVerb | undefined;
  if (verb && !VALID_VERBS.includes(verb)) {
    return c.json({ error: `verb must be one of: ${VALID_VERBS.join(", ")}` }, 400);
  }
  const items = await getOpenActionItems(c.env.DB, companyId, verb);
  return c.json({ items });
});

actionsRouter.post("/:id/resolve", async (c) => {
  const companyId = c.req.query("company_id");
  if (!companyId) return c.json({ error: "company_id query param is required" }, 400);
  await resolveActionItem(c.env.DB, companyId, c.req.param("id"));
  return c.json({ ok: true });
});
