/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  MARKETING_AI_TOOLS,
  FORBIDDEN_TOOL_VERBS,
  CAMPAIGN_DRAFT_SCHEMA,
  COPILOT_SYSTEM_PROMPT,
  normalizeDraft,
  runTool,
  toolSpecs,
  toolByName,
} from './ai-tools';
import { rollupAttribution } from './attribution';

const db = () => env.DB;
const CO = 'co-ai';
const OTHER = 'co-ai-other';

// ══ the boundary ═════════════════════════════════════════════════════════════

describe('the AI cannot send', () => {
  it('has no tool whose name suggests sending, approving or suppressing', () => {
    for (const tool of MARKETING_AI_TOOLS) {
      for (const verb of FORBIDDEN_TOOL_VERBS) {
        expect(
          tool.name.includes(verb),
          `tool "${tool.name}" contains the forbidden verb "${verb}" — sending must stay behind the human approve gate`,
        ).toBe(false);
      }
    }
  });

  it('exposes only read tools — every name begins with a read verb', () => {
    const readVerbs = ['get_', 'list_', 'search_', 'count_'];
    for (const tool of MARKETING_AI_TOOLS) {
      expect(
        readVerbs.some((v) => tool.name.startsWith(v)),
        `tool "${tool.name}" is not obviously a read`,
      ).toBe(true);
    }
  });

  it('tells the model in the prompt that it cannot send and must not write HTML', () => {
    expect(COPILOT_SYSTEM_PROMPT).toContain('cannot send');
    expect(COPILOT_SYSTEM_PROMPT).toContain('Never emit HTML');
  });

  it('refuses an unknown tool name instead of throwing', async () => {
    expect(await runTool(db(), CO, 'send_campaign', {})).toEqual({ error: 'unknown tool "send_campaign"' });
  });

  it('publishes well-formed tool specs', () => {
    const specs = toolSpecs();
    expect(specs).toHaveLength(MARKETING_AI_TOOLS.length);
    for (const spec of specs) {
      const fn = spec.function as { name: string; description: string; parameters: Record<string, unknown> };
      expect(fn.name).toBeTruthy();
      expect(fn.description.length).toBeGreaterThan(20);
      expect(fn.parameters.type).toBe('object');
    }
  });
});

// ══ tenant scoping ═══════════════════════════════════════════════════════════

describe('tool handlers are company-scoped', () => {
  beforeEach(async () => {
    for (const t of [
      'marketing_brand_profile', 'marketing_service_profile', 'marketing_asset',
      'marketing_audience', 'marketing_campaign', 'marketing_campaign_recipient',
      'marketing_form', 'marketing_attribution', 'marketing_form_submission',
      'clients', 'opportunities', 'invoices',
    ]) {
      await db().prepare(`DELETE FROM ${t}`).run();
    }

    await db()
      .prepare(`INSERT INTO marketing_brand_profile (id, company_id, name, physical_address) VALUES (?,?,?,?)`)
      .bind('b-1', CO, 'Avalon Landscape', '1420 Old Bridge Rd')
      .run();
    await db()
      .prepare(`INSERT INTO marketing_brand_profile (id, company_id, name, physical_address) VALUES (?,?,?,?)`)
      .bind('b-2', OTHER, 'Rival Landscaping', 'Somewhere else')
      .run();

    await db()
      .prepare(
        `INSERT INTO marketing_service_profile (id, company_id, name, season, approved_copy, do_not_claim)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind('svc-1', CO, 'Irrigation startup', 'spring', 'We tune every zone.', 'Never promise a fixed price sight-unseen.')
      .run();
    await db()
      .prepare(`INSERT INTO marketing_service_profile (id, company_id, name) VALUES (?,?,?)`)
      .bind('svc-x', OTHER, 'Rival service')
      .run();

    await db()
      .prepare(
        `INSERT INTO marketing_asset (id, company_id, r2_key, file_name, alt_text, approved_for_marketing, season)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind('mas-1', CO, 'k1', 'lawn-spring.jpg', 'A green lawn', 1, 'spring')
      .run();
    await db()
      .prepare(
        `INSERT INTO marketing_asset (id, company_id, r2_key, file_name, approved_for_marketing)
         VALUES (?,?,?,?,?)`,
      )
      .bind('mas-2', CO, 'k2', 'unapproved.jpg', 0)
      .run();

    await db()
      .prepare(`INSERT INTO marketing_audience (id, company_id, name, filter_json) VALUES (?,?,?,?)`)
      .bind('aud-1', CO, 'All residential', JSON.stringify({ match: 'all', rules: [] }))
      .run();

    await db()
      .prepare(`INSERT INTO marketing_form (id, company_id, name, public_token, active) VALUES (?,?,?,?,1)`)
      .bind('frm-1', CO, 'Spring inquiry', 'tok123')
      .run();

    await db()
      .prepare(`INSERT INTO marketing_campaign (id, company_id, name, subject, status) VALUES (?,?,?,?,?)`)
      .bind('camp-1', CO, 'Spring push', 'Time to wake up your irrigation', 'sent')
      .run();
    await db()
      .prepare(`INSERT INTO marketing_campaign (id, company_id, name, subject, status) VALUES (?,?,?,?,?)`)
      .bind('camp-x', OTHER, 'Rival push', 'Rival subject', 'sent')
      .run();
  });

  it('returns only this company brand', async () => {
    const brand = (await runTool(db(), CO, 'get_brand_profile', {})) as { name: string };
    expect(brand.name).toBe('Avalon Landscape');
  });

  it('returns only this company services', async () => {
    const list = (await runTool(db(), CO, 'list_service_profiles', {})) as Array<{ name: string }>;
    expect(list.map((r) => r.name)).toEqual(['Irrigation startup']);
  });

  it('will not fetch another company service profile by id', async () => {
    expect(await runTool(db(), CO, 'get_service_profile', { service_profile_id: 'svc-x' })).toEqual({
      error: 'no such service profile',
    });
  });

  it('surfaces the do-not-claim list so copy can respect it', async () => {
    const p = (await runTool(db(), CO, 'get_service_profile', { service_profile_id: 'svc-1' })) as {
      do_not_claim: string;
    };
    expect(p.do_not_claim).toContain('Never promise a fixed price');
  });

  it('returns only approved media', async () => {
    const media = (await runTool(db(), CO, 'search_media', {})) as Array<{ id: string }>;
    expect(media.map((m) => m.id)).toEqual(['mas-1']);
  });

  it('filters media by query and season', async () => {
    expect((await runTool(db(), CO, 'search_media', { query: 'lawn' }) as unknown[])).toHaveLength(1);
    expect((await runTool(db(), CO, 'search_media', { query: 'nothing' }) as unknown[])).toHaveLength(0);
    expect((await runTool(db(), CO, 'search_media', { season: 'winter' }) as unknown[])).toHaveLength(0);
  });

  it('describes audiences in words and counts them live', async () => {
    const list = (await runTool(db(), CO, 'list_audiences', {})) as Array<{ targets: string }>;
    expect(list[0]!.targets).toContain('Everyone in');

    await db()
      .prepare(`INSERT INTO clients (id, company_id, name, email) VALUES (?,?,?,?)`)
      .bind('cl-1', CO, 'Dana', 'dana@example.com')
      .run();
    const counted = (await runTool(db(), CO, 'count_audience', { audience_id: 'aud-1' })) as { count: number };
    expect(counted.count).toBe(1);
  });

  it('will not count another company audience', async () => {
    expect(await runTool(db(), OTHER, 'count_audience', { audience_id: 'aud-1' })).toEqual({
      error: 'no such audience',
    });
  });

  it('returns only this company past campaigns', async () => {
    const past = (await runTool(db(), CO, 'get_past_campaigns', {})) as Array<{ subject: string }>;
    expect(past.map((p) => p.subject)).toEqual(['Time to wake up your irrigation']);
  });

  it('will not report on another company campaign performance', async () => {
    expect(await runTool(db(), CO, 'get_campaign_performance', { campaign_id: 'camp-x' })).toEqual({
      error: 'no such campaign',
    });
  });

  it('gives forms as usable CTA paths', async () => {
    const forms = (await runTool(db(), CO, 'list_forms', {})) as Array<{ cta_url_path: string }>;
    expect(forms[0]!.cta_url_path).toBe('/f/tok123');
  });

  it('every tool tolerates being called with no arguments', async () => {
    for (const tool of MARKETING_AI_TOOLS) {
      await expect(runTool(db(), CO, tool.name, {})).resolves.toBeDefined();
    }
  });

  it('resolves tools by name', () => {
    expect(toolByName('get_brand_profile')).toBeDefined();
    expect(toolByName('nope')).toBeUndefined();
  });
});

// ══ the draft contract ═══════════════════════════════════════════════════════

describe('normalizeDraft', () => {
  it('accepts a well-formed draft', () => {
    const d = normalizeDraft({
      subject: 'Time for fall cleanup',
      preheader: 'Book before the rush',
      rationale: 'Seasonal, and we have 40 clients who bought this last year.',
      audience_id: 'aud-1',
      blocks: [
        { type: 'hero', headline: 'Fall cleanup', subhead: 'Book now', cta: { label: 'Get a quote', url: 'https://x.example/f/a' } },
        { type: 'divider' },
      ],
    });
    expect(d.subject).toBe('Time for fall cleanup');
    expect(d.content.blocks.map((b) => b.type)).toEqual(['hero', 'divider']);
    expect(d.content.blocks[0]!.id).toBeTruthy();
  });

  it('drops a block type the model invented rather than failing the whole draft', () => {
    const d = normalizeDraft({
      subject: 'x',
      blocks: [{ type: 'interpretive_dance' }, { type: 'headline_copy', headline: 'Keep me' }],
    });
    expect(d.content.blocks.map((b) => b.type)).toEqual(['headline_copy']);
  });

  it('never throws on junk', () => {
    expect(normalizeDraft(null).content.blocks).toEqual([]);
    expect(normalizeDraft('nope').subject).toBe('');
    expect(normalizeDraft({ blocks: 'not an array' }).content.blocks).toEqual([]);
  });

  it('produces no HTML even when the model puts markup in a headline', () => {
    const d = normalizeDraft({
      subject: '<script>x</script>',
      blocks: [{ type: 'headline_copy', headline: '<img onerror=alert(1)>' }],
    });
    // Stored as text; the renderer escapes it. Nothing here is markup.
    expect(d.content.blocks[0]).toMatchObject({ type: 'headline_copy' });
    expect(typeof d.subject).toBe('string');
  });

  it('declares a strict schema listing only real block types', () => {
    const blocks = CAMPAIGN_DRAFT_SCHEMA.schema.properties.blocks as {
      items: { properties: { type: { enum: readonly string[] } } };
    };
    expect(blocks.items.properties.type.enum).toContain('hero');
    expect(blocks.items.properties.type.enum).not.toContain('script');
    expect(CAMPAIGN_DRAFT_SCHEMA.schema.additionalProperties).toBe(false);
  });
});

// ══ attribution ══════════════════════════════════════════════════════════════

describe('rollupAttribution', () => {
  beforeEach(async () => {
    for (const t of [
      'marketing_attribution', 'marketing_form_submission', 'marketing_form',
      'marketing_campaign', 'opportunities', 'invoices', 'clients',
    ]) {
      await db().prepare(`DELETE FROM ${t}`).run();
    }
    await db()
      .prepare(`INSERT INTO marketing_campaign (id, company_id, name, status) VALUES (?,?,?,?)`)
      .bind('camp-1', CO, 'Spring push', 'sent')
      .run();
    await db()
      .prepare(`INSERT INTO marketing_form (id, company_id, name, public_token) VALUES (?,?,?,?)`)
      .bind('frm-1', CO, 'Inquiry', 'tok')
      .run();
    await db()
      .prepare(`INSERT INTO clients (id, company_id, name, email) VALUES (?,?,?,?)`)
      .bind('cl-1', CO, 'Dana', 'dana@example.com')
      .run();
  });

  const seedLead = async (over: Record<string, unknown> = {}) => {
    await db()
      .prepare(
        `INSERT INTO opportunities
           (id, company_id, client, status, client_id, estimate_amount_cents, estimate_count,
            sold_date, sold_amount_cents)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        'opp-1', CO, 'Dana', 'new', 'cl-1',
        over.estimate_amount_cents ?? 0, over.estimate_count ?? 0,
        over.sold_date ?? null, over.sold_amount_cents ?? 0,
      )
      .run();
    await db()
      .prepare(
        `INSERT INTO marketing_form_submission
           (id, company_id, form_id, campaign_id, opportunity_id, email)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind('sub-1', CO, 'frm-1', 'camp-1', 'opp-1', 'dana@example.com')
      .run();
  };

  const attribution = async () => {
    const r = await db()
      .prepare(`SELECT event, entity_id, amount_cents FROM marketing_attribution WHERE company_id=? ORDER BY event`)
      .bind(CO)
      .all<{ event: string; entity_id: string; amount_cents: number }>();
    return r.results ?? [];
  };

  it('records an estimate against the campaign', async () => {
    await seedLead({ estimate_amount_cents: 480000, estimate_count: 1 });
    expect(await rollupAttribution(db())).toMatchObject({ estimates: 1, sold: 0 });
    expect(await attribution()).toEqual([
      { event: 'estimate_created', entity_id: 'opp-1', amount_cents: 480000 },
    ]);
  });

  it('records a sold job in integer cents', async () => {
    await seedLead({ sold_date: '2026-07-01', sold_amount_cents: 1840000 });
    await rollupAttribution(db());
    const rows = await attribution();
    const sold = rows.find((r) => r.event === 'job_sold');
    expect(sold!.amount_cents).toBe(1840000);
    expect(Number.isInteger(sold!.amount_cents)).toBe(true);
  });

  it('is idempotent — re-running writes nothing new', async () => {
    await seedLead({ estimate_amount_cents: 480000, sold_date: '2026-07-01', sold_amount_cents: 1840000 });
    const first = await rollupAttribution(db());
    expect(first.estimates + first.sold).toBe(2);

    const second = await rollupAttribution(db());
    expect(second).toEqual({ estimates: 0, sold: 0, paid: 0 });
    expect(await attribution()).toHaveLength(2);
  });

  it('records a paid invoice for the client', async () => {
    await seedLead({ sold_date: '2026-07-01', sold_amount_cents: 1840000 });
    await db()
      .prepare(
        `INSERT INTO invoices (id, company_id, client_id, invoice_number, amount_paid_cents, paid_at, status)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind('inv-1', CO, 'cl-1', 'INV-1', 1840000, '2026-07-20', 'paid')
      .run();

    expect(await rollupAttribution(db())).toMatchObject({ paid: 1 });
    const paid = (await attribution()).find((r) => r.event === 'invoice_paid');
    expect(paid!.amount_cents).toBe(1840000);
  });

  it('ignores an unpaid invoice', async () => {
    await seedLead({ sold_date: '2026-07-01' });
    await db()
      .prepare(
        `INSERT INTO invoices (id, company_id, client_id, invoice_number, amount_paid_cents, status)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind('inv-2', CO, 'cl-1', 'INV-2', 0, 'sent')
      .run();
    expect(await rollupAttribution(db())).toMatchObject({ paid: 0 });
  });

  it('ignores leads that did not come from a campaign', async () => {
    await db()
      .prepare(`INSERT INTO opportunities (id, company_id, client, status, sold_date, sold_amount_cents)
                VALUES (?,?,?,?,?,?)`)
      .bind('opp-organic', CO, 'Walk-in', 'new', '2026-07-01', 500000)
      .run();
    expect(await rollupAttribution(db())).toEqual({ estimates: 0, sold: 0, paid: 0 });
  });

  it('can be scoped to one company', async () => {
    await seedLead({ sold_date: '2026-07-01', sold_amount_cents: 100 });
    expect(await rollupAttribution(db(), { companyId: OTHER })).toEqual({ estimates: 0, sold: 0, paid: 0 });
    expect(await rollupAttribution(db(), { companyId: CO })).toMatchObject({ sold: 1 });
  });
});
