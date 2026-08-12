/**
 * Campaign content model.
 *
 * A campaign is an ordered list of typed blocks, stored as JSON in
 * marketing_campaign.content_json. That JSON is the EDITABLE SOURCE OF TRUTH.
 * HTML is a derived artifact produced by src/marketing/render.ts and only ever
 * persisted as rendered_html, a snapshot of what was actually sent.
 *
 * Why a block model rather than an HTML field:
 *   1. The AI copilot drafts structure, never markup. It cannot emit a broken
 *      table, an unclosed tag, or a tracking pixel we did not put there.
 *   2. Every block carries a stable `id`, so the copilot can address one part
 *      of a draft (update_block, insert_block after, reorder) without
 *      rewriting the whole email and losing the operator's manual edits.
 *   3. Rebranding is a re-render, not a find-and-replace across stored markup.
 *
 * Everything here is pure data and pure functions — no D1, no fetch, no env.
 */

export const CONTENT_VERSION = 1 as const;

/** Horizontal alignment shared by several blocks. */
export type Align = 'left' | 'center' | 'right';

/** A call to action. `url` is the raw destination; the renderer wraps it. */
export interface Cta {
  label: string;
  url: string;
}

export interface HeroBlock {
  id: string;
  type: 'hero';
  headline: string;
  subhead: string;
  image_asset_id: string;
  cta: Cta | null;
  align: Align;
}

/** Image beside copy. `image_text` puts the image first, `text_image` second. */
export interface SplitBlock {
  id: string;
  type: 'image_text' | 'text_image';
  headline: string;
  body: string;
  image_asset_id: string;
  cta: Cta | null;
}

export interface HeadlineCopyBlock {
  id: string;
  type: 'headline_copy';
  headline: string;
  body: string;
  align: Align;
}

export interface BenefitGridBlock {
  id: string;
  type: 'benefit_grid';
  headline: string;
  columns: 2 | 3;
  items: Array<{ title: string; body: string }>;
}

/**
 * A service pulled from marketing_service_profile. The profile is the source of
 * approved claims; the block stores the copy actually used so a sent campaign
 * stays reproducible even after the profile is edited.
 */
export interface ServiceFeatureBlock {
  id: string;
  type: 'service_feature';
  service_profile_id: string;
  headline: string;
  body: string;
  image_asset_id: string;
  cta: Cta | null;
}

export interface NumberedStepsBlock {
  id: string;
  type: 'numbered_steps';
  headline: string;
  items: Array<{ title: string; body: string }>;
}

export interface FullWidthImageBlock {
  id: string;
  type: 'full_width_image';
  image_asset_id: string;
  caption: string;
}

export interface BannerBlock {
  id: string;
  type: 'banner';
  text: string;
  tone: 'accent' | 'muted';
  cta: Cta | null;
}

export interface CtaSectionBlock {
  id: string;
  type: 'cta_section';
  headline: string;
  body: string;
  cta: Cta | null;
}

export interface TestimonialBlock {
  id: string;
  type: 'testimonial';
  quote: string;
  attribution: string;
  role: string;
}

export interface SpacerBlock {
  id: string;
  type: 'spacer';
  height: number;
}

export interface DividerBlock {
  id: string;
  type: 'divider';
}

/**
 * Sign-off copy above the compliance footer. The postal address and the
 * unsubscribe link are NOT stored here — the renderer always emits them,
 * whether or not this block is present, so they cannot be edited away.
 */
export interface FooterBlock {
  id: string;
  type: 'footer';
  sign_off: string;
}

export type Block =
  | HeroBlock
  | SplitBlock
  | HeadlineCopyBlock
  | BenefitGridBlock
  | ServiceFeatureBlock
  | NumberedStepsBlock
  | FullWidthImageBlock
  | BannerBlock
  | CtaSectionBlock
  | TestimonialBlock
  | SpacerBlock
  | DividerBlock
  | FooterBlock;

export type BlockType = Block['type'];

export interface CampaignDoc {
  version: number;
  blocks: Block[];
}

export const BLOCK_TYPES: BlockType[] = [
  'hero',
  'image_text',
  'text_image',
  'headline_copy',
  'benefit_grid',
  'service_feature',
  'numbered_steps',
  'full_width_image',
  'banner',
  'cta_section',
  'testimonial',
  'spacer',
  'divider',
  'footer',
];

/** Human labels for the editor's block palette. */
export const BLOCK_LABELS: Record<BlockType, string> = {
  hero: 'Hero',
  image_text: 'Image + text',
  text_image: 'Text + image',
  headline_copy: 'Headline and copy',
  benefit_grid: 'Benefit grid',
  service_feature: 'Service feature',
  numbered_steps: 'Numbered steps',
  full_width_image: 'Full width image',
  banner: 'Banner',
  cta_section: 'Call to action',
  testimonial: 'Testimonial',
  spacer: 'Spacer',
  divider: 'Divider',
  footer: 'Sign-off',
};

// ── coercion helpers ─────────────────────────────────────────────────────────
// Input reaches this module from three directions: the editor, the AI copilot,
// and rows written by an older build. All three are treated as untrusted shape.

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : v == null ? fallback : String(v);

const align = (v: unknown): Align =>
  v === 'left' || v === 'center' || v === 'right' ? v : 'left';

const cta = (v: unknown): Cta | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const label = str(o.label).trim();
  const url = str(o.url).trim();
  if (!label || !url) return null;
  return { label, url };
};

const pairs = (v: unknown): Array<{ title: string; body: string }> => {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 12).map((raw) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return { title: str(o.title), body: str(o.body) };
  });
};

let idCounter = 0;

/**
 * Block ids only need to be unique inside one document, and they are addressed
 * by the AI copilot, so they are short and readable rather than UUIDs.
 */
export function newBlockId(type: BlockType): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${type}_${rand}${idCounter.toString(36)}`;
}

/** A new block of the given type, with every field present and empty. */
export function newBlock(type: BlockType): Block {
  const id = newBlockId(type);
  switch (type) {
    case 'hero':
      return { id, type, headline: '', subhead: '', image_asset_id: '', cta: null, align: 'left' };
    case 'image_text':
    case 'text_image':
      return { id, type, headline: '', body: '', image_asset_id: '', cta: null };
    case 'headline_copy':
      return { id, type, headline: '', body: '', align: 'left' };
    case 'benefit_grid':
      return { id, type, headline: '', columns: 3, items: [] };
    case 'service_feature':
      return { id, type, service_profile_id: '', headline: '', body: '', image_asset_id: '', cta: null };
    case 'numbered_steps':
      return { id, type, headline: '', items: [] };
    case 'full_width_image':
      return { id, type, image_asset_id: '', caption: '' };
    case 'banner':
      return { id, type, text: '', tone: 'accent', cta: null };
    case 'cta_section':
      return { id, type, headline: '', body: '', cta: null };
    case 'testimonial':
      return { id, type, quote: '', attribution: '', role: '' };
    case 'spacer':
      return { id, type, height: 24 };
    case 'divider':
      return { id, type };
    case 'footer':
      return { id, type, sign_off: '' };
  }
}

/**
 * Normalize one untrusted object into a Block, or null if the type is unknown.
 *
 * Unknown types are dropped rather than rejected: a copilot that invents a
 * block name should cost the operator one missing section, not a 500 on a
 * draft they have been editing for ten minutes.
 */
export function normalizeBlock(raw: unknown): Block | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = str(o.type) as BlockType;
  if (!BLOCK_TYPES.includes(type)) return null;
  const id = str(o.id).trim() || newBlockId(type);

  switch (type) {
    case 'hero':
      return {
        id, type,
        headline: str(o.headline),
        subhead: str(o.subhead),
        image_asset_id: str(o.image_asset_id),
        cta: cta(o.cta),
        align: align(o.align),
      };
    case 'image_text':
    case 'text_image':
      return {
        id, type,
        headline: str(o.headline),
        body: str(o.body),
        image_asset_id: str(o.image_asset_id),
        cta: cta(o.cta),
      };
    case 'headline_copy':
      return { id, type, headline: str(o.headline), body: str(o.body), align: align(o.align) };
    case 'benefit_grid':
      return {
        id, type,
        headline: str(o.headline),
        columns: o.columns === 2 ? 2 : 3,
        items: pairs(o.items),
      };
    case 'service_feature':
      return {
        id, type,
        service_profile_id: str(o.service_profile_id),
        headline: str(o.headline),
        body: str(o.body),
        image_asset_id: str(o.image_asset_id),
        cta: cta(o.cta),
      };
    case 'numbered_steps':
      return { id, type, headline: str(o.headline), items: pairs(o.items) };
    case 'full_width_image':
      return { id, type, image_asset_id: str(o.image_asset_id), caption: str(o.caption) };
    case 'banner':
      return { id, type, text: str(o.text), tone: o.tone === 'muted' ? 'muted' : 'accent', cta: cta(o.cta) };
    case 'cta_section':
      return { id, type, headline: str(o.headline), body: str(o.body), cta: cta(o.cta) };
    case 'testimonial':
      return { id, type, quote: str(o.quote), attribution: str(o.attribution), role: str(o.role) };
    case 'spacer': {
      const n = Number(o.height);
      // Clamped: a 4000px spacer is always a mistake, and in an email client it
      // pushes the unsubscribe link past the point anyone will scroll.
      const height = Number.isFinite(n) ? Math.min(96, Math.max(4, Math.round(n))) : 24;
      return { id, type, height };
    }
    case 'divider':
      return { id, type };
    case 'footer':
      return { id, type, sign_off: str(o.sign_off) };
  }
  return null;
}

export function emptyDoc(): CampaignDoc {
  return { version: CONTENT_VERSION, blocks: [] };
}

/**
 * Parse content_json (or an already-parsed object) into a CampaignDoc.
 * Never throws: malformed content yields an empty document, because the editor
 * must always be able to open a campaign in order to fix it.
 */
export function parseCampaignDoc(input: unknown): CampaignDoc {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return emptyDoc();
    }
  }
  if (!raw || typeof raw !== 'object') return emptyDoc();
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.blocks) ? o.blocks : [];
  const blocks: Block[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, 100)) {
    const block = normalizeBlock(item);
    if (!block) continue;
    // Duplicate ids would make update_block ambiguous for the copilot.
    if (seen.has(block.id)) block.id = newBlockId(block.type);
    seen.add(block.id);
    blocks.push(block);
  }
  const version = Number(o.version);
  return { version: Number.isFinite(version) && version > 0 ? version : CONTENT_VERSION, blocks };
}

export function serializeCampaignDoc(doc: CampaignDoc): string {
  return JSON.stringify({ version: doc.version || CONTENT_VERSION, blocks: doc.blocks });
}

/** Every CTA url in document order — used to pre-register tracked links. */
export function collectCtaUrls(doc: CampaignDoc): Array<{ blockId: string; label: string; url: string }> {
  const out: Array<{ blockId: string; label: string; url: string }> = [];
  for (const b of doc.blocks) {
    const c = (b as { cta?: Cta | null }).cta;
    if (c && c.url) out.push({ blockId: b.id, label: c.label, url: c.url });
  }
  return out;
}
