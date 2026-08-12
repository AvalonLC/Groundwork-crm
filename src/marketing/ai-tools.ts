/**
 * The AI copilot's knowledge layer.
 *
 * THE HARD BOUNDARY: nothing in this registry can send, schedule, approve, or
 * suppress. Every tool is a read against the tenant's own data, and the only
 * thing the model can produce is a CampaignDraft — structured content that
 * lands in a draft for a human to review. Sending requires
 * POST /api/marketing/campaigns/:id/approve with confirm:true and an
 * expected_recipient_count that matches the frozen snapshot, from an
 * authenticated admin session. A test in ai-tools.test.ts asserts the absence
 * of a send tool literally, so adding one has to be a deliberate act that
 * breaks a red test rather than an oversight.
 *
 * The model also never writes HTML. It emits blocks, which src/marketing/
 * render.ts turns into email-safe markup. That is what makes "the AI wrote it"
 * survive contact with Outlook.
 */

import { parseCampaignDoc, BLOCK_TYPES, type CampaignDoc } from './blocks';
import { compileAudienceCount, describeFilter, parseFilter } from './audience';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (db: D1Database, companyId: string, args: Record<string, unknown>) => Promise<unknown>;
}

const str = (v: unknown, max = 200): string => String(v ?? '').slice(0, max);
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});

// ── read tools ───────────────────────────────────────────────────────────────

export const MARKETING_AI_TOOLS: ToolDef[] = [
  {
    name: 'get_brand_profile',
    description:
      'The company brand kit: display name, colors, tone-of-voice notes, default calls to action and the postal address that appears in every footer.',
    parameters: obj({}),
    handler: async (db, companyId) => {
      const row = await db
        .prepare(
          `SELECT name, colors_json, voice_json, default_ctas_json, physical_address
             FROM marketing_brand_profile WHERE company_id=? AND active=1 LIMIT 1`,
        )
        .bind(companyId)
        .first();
      return row ?? { note: 'No brand kit has been set up yet.' };
    },
  },
  {
    name: 'list_service_profiles',
    description:
      'Services this company markets, with the season each one sells in and the customer type it suits. Use this to pick what a campaign should be about.',
    parameters: obj({}),
    handler: async (db, companyId) => {
      const rows = await db
        .prepare(
          `SELECT id, name, category, season, customer_type, preferred_cta_label
             FROM marketing_service_profile WHERE company_id=? AND active=1 ORDER BY name LIMIT 50`,
        )
        .bind(companyId)
        .all();
      return rows.results ?? [];
    },
  },
  {
    name: 'get_service_profile',
    description:
      'Full marketing detail for one service, including the approved benefit list, pre-approved copy, and claims that must NOT be made about it. Always read this before writing copy about a service.',
    parameters: obj({ service_profile_id: { type: 'string' } }, ['service_profile_id']),
    handler: async (db, companyId, args) => {
      const row = await db
        .prepare(`SELECT * FROM marketing_service_profile WHERE id=? AND company_id=? LIMIT 1`)
        .bind(str(args.service_profile_id, 60), companyId)
        .first();
      return row ?? { error: 'no such service profile' };
    },
  },
  {
    name: 'search_media',
    description:
      'Find images approved for marketing use. Returns asset ids to place in image blocks. Only approved assets are returned.',
    parameters: obj(
      {
        query: { type: 'string', description: 'matches file name, alt text or tags' },
        season: { type: 'string' },
        limit: { type: 'number' },
      },
      [],
    ),
    handler: async (db, companyId, args) => {
      const q = str(args.query, 80).toLowerCase();
      const season = str(args.season, 40).toLowerCase();
      const binds: unknown[] = [companyId];
      let sql = `SELECT id, file_name, alt_text, tags_json, season FROM marketing_asset
                 WHERE company_id=? AND approved_for_marketing=1`;
      if (q) {
        sql += ` AND (lower(file_name) LIKE ? OR lower(alt_text) LIKE ? OR lower(tags_json) LIKE ?)`;
        binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (season) {
        sql += ` AND lower(season)=?`;
        binds.push(season);
      }
      const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
      sql += ` ORDER BY created_at DESC LIMIT ${limit}`;
      const rows = await db.prepare(sql).bind(...binds).all();
      return rows.results ?? [];
    },
  },
  {
    name: 'list_audiences',
    description: 'Saved audiences, each with a plain-English description of who it targets.',
    parameters: obj({}),
    handler: async (db, companyId) => {
      const rows = await db
        .prepare(`SELECT id, name, description, filter_json, last_count FROM marketing_audience WHERE company_id=? ORDER BY name LIMIT 50`)
        .bind(companyId)
        .all<{ id: string; name: string; description: string; filter_json: string; last_count: number }>();
      return (rows.results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        targets: describeFilter(r.filter_json),
        last_count: r.last_count,
      }));
    },
  },
  {
    name: 'count_audience',
    description:
      'How many people a saved audience currently reaches, after removing anyone on the suppression list. Use this before proposing an audience so the recommendation is grounded in a real number.',
    parameters: obj({ audience_id: { type: 'string' } }, ['audience_id']),
    handler: async (db, companyId, args) => {
      const row = await db
        .prepare(`SELECT filter_json FROM marketing_audience WHERE id=? AND company_id=? LIMIT 1`)
        .bind(str(args.audience_id, 60), companyId)
        .first<{ filter_json: string }>();
      if (!row) return { error: 'no such audience' };
      const compiled = compileAudienceCount(companyId, parseFilter(row.filter_json));
      const count = await db.prepare(compiled.sql).bind(...compiled.binds).first<{ n: number }>();
      return { count: Number(count?.n ?? 0), targets: describeFilter(row.filter_json) };
    },
  },
  {
    name: 'get_past_campaigns',
    description:
      'Recent campaigns with their subject lines and status, so a new draft does not repeat a subject that just went out.',
    parameters: obj({ limit: { type: 'number' } }, []),
    handler: async (db, companyId, args) => {
      const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
      const rows = await db
        .prepare(
          `SELECT id, name, campaign_type, subject, status, sent_at, recipient_count
             FROM marketing_campaign WHERE company_id=? ORDER BY COALESCE(sent_at, updated_at) DESC LIMIT ${limit}`,
        )
        .bind(companyId)
        .all();
      return rows.results ?? [];
    },
  },
  {
    name: 'get_campaign_performance',
    description:
      'How a past campaign actually performed: delivered, opened, clicked, inquiries generated, and jobs sold in cents. Use it to argue from evidence rather than taste.',
    parameters: obj({ campaign_id: { type: 'string' } }, ['campaign_id']),
    handler: async (db, companyId, args) => {
      const campaignId = str(args.campaign_id, 60);
      const owned = await db
        .prepare(`SELECT id FROM marketing_campaign WHERE id=? AND company_id=? LIMIT 1`)
        .bind(campaignId, companyId)
        .first();
      if (!owned) return { error: 'no such campaign' };

      const delivery = await db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status IN ('sent','delivered') THEN 1 ELSE 0 END) AS sent,
                  SUM(CASE WHEN first_opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
                  SUM(CASE WHEN first_clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
             FROM marketing_campaign_recipient WHERE campaign_id=?`,
        )
        .bind(campaignId)
        .first();
      const outcomes = await db
        .prepare(
          `SELECT event, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS amount_cents
             FROM marketing_attribution WHERE company_id=? AND campaign_id=? GROUP BY event`,
        )
        .bind(companyId, campaignId)
        .all();
      return { delivery: delivery ?? {}, outcomes: outcomes.results ?? [] };
    },
  },
  {
    name: 'list_forms',
    description:
      'Inquiry forms that campaign buttons can point at. Returns the public URL path to use as a call-to-action target.',
    parameters: obj({}),
    handler: async (db, companyId) => {
      const rows = await db
        .prepare(`SELECT id, name, public_token, headline FROM marketing_form WHERE company_id=? AND active=1 LIMIT 50`)
        .bind(companyId)
        .all<{ id: string; name: string; public_token: string; headline: string }>();
      return (rows.results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        headline: r.headline,
        cta_url_path: `/f/${r.public_token}`,
      }));
    },
  },
];

/** Verbs the registry must never contain. Enforced by a test, not convention. */
export const FORBIDDEN_TOOL_VERBS = [
  'send', 'schedule', 'approve', 'deliver', 'dispatch', 'publish',
  'suppress', 'unsubscribe', 'delete', 'drain',
];

export function toolByName(name: string): ToolDef | undefined {
  return MARKETING_AI_TOOLS.find((t) => t.name === name);
}

/** OpenAI tool-calling descriptors. */
export function toolSpecs(): Array<Record<string, unknown>> {
  return MARKETING_AI_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Execute one tool call. Always scoped to the caller's company — the model
 * supplies ids, never a company, so a hallucinated id from another tenant
 * resolves to nothing rather than to someone else's data.
 */
export async function runTool(
  db: D1Database,
  companyId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = toolByName(name);
  if (!tool) return { error: `unknown tool "${name}"` };
  try {
    return await tool.handler(db, companyId, args ?? {});
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e).slice(0, 300) };
  }
}

// ── the draft contract ───────────────────────────────────────────────────────

/**
 * JSON Schema for Structured Outputs. Blocks are described loosely on purpose:
 * a strict per-type union is unwieldy in JSON Schema and normalizeDraft()
 * validates properly anyway, dropping unknown types and filling defaults.
 */
export const CAMPAIGN_DRAFT_SCHEMA = {
  name: 'campaign_draft',
  schema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      preheader: { type: 'string' },
      rationale: { type: 'string', description: 'Why this campaign, in one or two sentences for the operator.' },
      audience_id: { type: 'string', description: 'A saved audience id, or empty if none fits.' },
      blocks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: BLOCK_TYPES },
            headline: { type: 'string' },
            subhead: { type: 'string' },
            body: { type: 'string' },
            text: { type: 'string' },
            quote: { type: 'string' },
            attribution: { type: 'string' },
            caption: { type: 'string' },
            sign_off: { type: 'string' },
            image_asset_id: { type: 'string' },
            service_profile_id: { type: 'string' },
            cta: {
              type: 'object',
              properties: { label: { type: 'string' }, url: { type: 'string' } },
              required: ['label', 'url'],
              additionalProperties: false,
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: { title: { type: 'string' }, body: { type: 'string' } },
                required: ['title', 'body'],
                additionalProperties: false,
              },
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
    },
    required: ['subject', 'preheader', 'rationale', 'audience_id', 'blocks'],
    additionalProperties: false,
  },
} as const;

export interface CampaignDraft {
  subject: string;
  preheader: string;
  rationale: string;
  audience_id: string;
  content: CampaignDoc;
}

/**
 * Turn whatever the model returned into something the editor can open.
 *
 * Never throws. A copilot run that produces a partly malformed draft should
 * cost the operator a missing section, not an error page — they can see what
 * came back and fix it, which is the whole point of the draft being reviewed.
 */
export function normalizeDraft(raw: unknown): CampaignDraft {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    subject: str(o.subject, 300),
    preheader: str(o.preheader, 300),
    rationale: str(o.rationale, 2000),
    audience_id: str(o.audience_id, 60),
    content: parseCampaignDoc({ version: 1, blocks: Array.isArray(o.blocks) ? o.blocks : [] }),
  };
}

/** System prompt. Kept here so the rules travel with the tools they rely on. */
export const COPILOT_SYSTEM_PROMPT = [
  'You draft marketing email campaigns for a landscaping and construction contractor.',
  '',
  'Work from the tools, not from assumptions. Before writing copy about a service,',
  'call get_service_profile and honour its approved_copy and do_not_claim fields —',
  'do_not_claim lists things that are false or legally risky for this company to say.',
  'Read the brand profile for tone. Use search_media to find real image asset ids;',
  'never invent one. Point calls to action at a form from list_forms.',
  '',
  'You produce structure, not markup. Never emit HTML. Compose the email from the',
  'available block types and let the renderer handle presentation.',
  '',
  'You cannot send anything. Your output is a draft a person will review, edit and',
  'approve. Do not claim a campaign has been sent or scheduled.',
  '',
  'Write plainly. No emoji. Avoid superlatives the company cannot substantiate.',
  'Subject lines under 60 characters. Prefer specific, seasonal, locally relevant',
  'reasons to act over generic urgency.',
].join('\n');
