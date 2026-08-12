/**
 * Composition: everything needed to turn a stored campaign into HTML.
 *
 * Sits between the pure renderer (src/marketing/render.ts, which touches no
 * database) and the API layer. Both the editor preview and the approve step go
 * through here, which is what keeps them producing identical output.
 */

import { parseCampaignDoc, type CampaignDoc } from './blocks';
import { renderCampaign, type RenderContext, type RenderResult } from './render';

export interface BrandRow {
  id: string;
  company_id: string;
  name: string;
  colors_json: string;
  logo_light_asset_id: string | null;
  physical_address: string;
  footer_json: string;
}

export interface CampaignRow {
  id: string;
  company_id: string;
  name: string;
  status: string;
  subject: string;
  preheader: string;
  from_email: string;
  from_name: string;
  reply_to: string;
  sender_identity_id: string | null;
  audience_id: string | null;
  theme: string;
  content_json: string;
  content_revision: number;
  rendered_html: string;
  rendered_text: string;
  recipient_count: number;
  suppressed_count: number;
}

/**
 * Marketing images have to be fetchable by an email client with no session, so
 * they are served from a public route that only resolves ids present in
 * marketing_asset — never an arbitrary R2 key.
 */
export function assetUrl(origin: string, assetId: string): string {
  return `${origin}/m/a/${encodeURIComponent(assetId)}`;
}

export function originOf(requestUrl: string): string {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return 'https://groundwork-crm.com';
  }
}

export async function loadBrand(db: D1Database, companyId: string): Promise<BrandRow | null> {
  return await db
    .prepare(`SELECT * FROM marketing_brand_profile WHERE company_id = ? AND active = 1 ORDER BY created_at LIMIT 1`)
    .bind(companyId)
    .first<BrandRow>();
}

/** Company display name, used when no brand profile has been set up yet. */
async function companyName(db: D1Database, companyId: string): Promise<string> {
  const row = await db.prepare(`SELECT name FROM companies WHERE id = ? LIMIT 1`).bind(companyId).first<{ name: string }>();
  return row?.name ?? '';
}

function parseColors(json: string): Record<string, string> | null {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' ? (v as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export interface ComposeArgs {
  db: D1Database;
  companyId: string;
  campaign: CampaignRow;
  /** Overrides the stored document — used for the unsaved editor preview. */
  doc?: CampaignDoc;
  mode: 'preview' | 'send';
  origin: string;
}

export async function composeCampaign(args: ComposeArgs): Promise<RenderResult> {
  const { db, companyId, campaign, mode, origin } = args;
  const brand = await loadBrand(db, companyId);
  const doc = args.doc ?? parseCampaignDoc(campaign.content_json);

  const ctx: RenderContext = {
    mode,
    theme: campaign.theme,
    preheader: campaign.preheader,
    brand: {
      company_name: brand?.name || (await companyName(db, companyId)) || 'Our company',
      physical_address: brand?.physical_address ?? '',
      logo_url: brand?.logo_light_asset_id ? assetUrl(origin, brand.logo_light_asset_id) : '',
      colors: brand ? parseColors(brand.colors_json) : null,
    },
    assetUrl: (id: string) => assetUrl(origin, id),
    baseUrl: origin,
  };

  return renderCampaign(doc, ctx);
}

/**
 * Store the approved render and the link table it produced.
 *
 * The link rows are replaced wholesale. That is safe because renderCampaign
 * assigns ids deterministically in document order, so a re-render of the same
 * document yields the same ids and a link already in an inbox keeps resolving.
 */
export async function persistRender(
  db: D1Database,
  companyId: string,
  campaignId: string,
  result: RenderResult,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE marketing_campaign
         SET rendered_html = ?, rendered_text = ?, rendered_at = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .bind(result.html, result.text, now, now, campaignId, companyId)
    .run();

  await db.prepare(`DELETE FROM marketing_link WHERE campaign_id = ?`).bind(campaignId).run();
  if (!result.links.length) return;

  // l.id is the per-campaign key that appears in the URL and repeats across
  // campaigns by design; the row id has to be campaign-qualified to stay
  // unique. See migrations/0063_marketing_link_key.sql.
  const statements = result.links.map((l) =>
    db
      .prepare(
        `INSERT INTO marketing_link (id, company_id, campaign_id, block_id, label, target_url, link_key)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(`${campaignId}_${l.id}`, companyId, campaignId, l.block_id, l.label, l.target_url, l.id),
  );
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }
}

/**
 * Everything that must be true before a campaign may be approved.
 *
 * Returned as a list rather than a single error so the review screen can show
 * the operator all of it at once instead of one blocker per attempt.
 */
export async function approvalBlockers(
  db: D1Database,
  companyId: string,
  campaign: CampaignRow,
): Promise<string[]> {
  const problems: string[] = [];

  if (!campaign.subject.trim()) problems.push('Add a subject line.');
  if (!campaign.audience_id) problems.push('Choose an audience.');

  const doc = parseCampaignDoc(campaign.content_json);
  if (!doc.blocks.length) problems.push('The email has no content blocks.');

  const brand = await loadBrand(db, companyId);
  if (!brand) {
    problems.push('Set up the brand kit first.');
  } else if (!brand.physical_address.trim()) {
    // CAN-SPAM requires a real postal address in every commercial email, and
    // the renderer emits whatever is here — so an empty value is a legal
    // problem, not a cosmetic one.
    problems.push('Add a postal address to the brand kit. Commercial email is required by law to carry one.');
  }

  if (!campaign.sender_identity_id) {
    problems.push('Choose a sender address.');
  } else {
    const sender = await db
      .prepare(`SELECT verified, from_email FROM marketing_sender_identity WHERE id = ? AND company_id = ? LIMIT 1`)
      .bind(campaign.sender_identity_id, companyId)
      .first<{ verified: number; from_email: string }>();
    if (!sender) problems.push('The chosen sender address no longer exists.');
    else if (!sender.verified) {
      problems.push(`Verify the sending domain for ${sender.from_email} before sending.`);
    }
  }

  return problems;
}
