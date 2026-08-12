/**
 * The one and only campaign email renderer.
 *
 * This module is deliberately the single place in the codebase that turns a
 * CampaignDoc into HTML. The editor's live preview does NOT re-implement it in
 * the browser — it POSTs the in-flight document to
 * /api/marketing/campaigns/:id/preview and drops the response into an iframe.
 * What the operator approves is byte-identical to what SendGrid delivers.
 *
 * That constraint is not stylistic. docs/AGENTS.md records the standing cost of
 * the estimate portal being rendered twice (client-side in estimates.js and
 * server-side in index.tsx): the two drift, and "keep them in sync" is a
 * permanent tax paid by every future change. An email is worse than a portal
 * page in this respect, because a drifted preview is discovered only after the
 * send, by the customer.
 *
 * Output targets Outlook/Windows as the floor: tables for layout, inline
 * styles, no <style> block, no <script>, no flexbox, no CSS grid, no web fonts.
 *
 * Pure: no D1, no fetch, no env. Everything it needs arrives in RenderContext.
 */

import type { Block, CampaignDoc, Cta } from './blocks';

// ── theme ────────────────────────────────────────────────────────────────────

export interface BrandColors {
  bg: string;
  panel: string;
  text: string;
  muted: string;
  heading: string;
  accent: string;
  accent_text: string;
  border: string;
}

const DARK: BrandColors = {
  bg: '#0f1115',
  panel: '#171a21',
  text: '#d7dbe3',
  muted: '#8b93a3',
  heading: '#ffffff',
  accent: '#3f7d5a',
  accent_text: '#ffffff',
  border: '#252932',
};

const LIGHT: BrandColors = {
  bg: '#f4f5f7',
  panel: '#ffffff',
  text: '#2b3038',
  muted: '#6b7280',
  heading: '#11141a',
  accent: '#2f6b4a',
  accent_text: '#ffffff',
  border: '#e3e6ea',
};

export function resolveColors(theme: string | undefined, overrides?: Partial<BrandColors> | null): BrandColors {
  const base = theme === 'brand_light' ? LIGHT : DARK;
  if (!overrides) return { ...base };
  const out: BrandColors = { ...base };
  for (const key of Object.keys(base) as Array<keyof BrandColors>) {
    const v = overrides[key];
    // Only accept values that are safely inlineable into a style attribute.
    if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim())) out[key] = v.trim();
  }
  return out;
}

// ── context ──────────────────────────────────────────────────────────────────

export interface RenderBrand {
  company_name: string;
  /** Required by CAN-SPAM. Approve is blocked upstream when this is empty. */
  physical_address: string;
  logo_url?: string;
  colors?: Partial<BrandColors> | null;
}

export interface RenderContext {
  /**
   * 'send' emits SendGrid substitution tokens (-firstName-, -unsubUrl-,
   * -trackBase-) that are filled per recipient at delivery.
   * 'preview' emits sample values and inert hrefs.
   */
  mode: 'preview' | 'send';
  brand: RenderBrand;
  theme?: string;
  preheader?: string;
  /** Resolves a marketing_asset id to a publicly fetchable URL. */
  assetUrl: (assetId: string) => string;
  /** Absolute origin, e.g. https://groundwork-crm.com — no trailing slash. */
  baseUrl: string;
}

export interface RenderedLink {
  id: string;
  block_id: string;
  label: string;
  target_url: string;
}

export interface RenderResult {
  html: string;
  text: string;
  links: RenderedLink[];
}

// ── escaping and URL safety ──────────────────────────────────────────────────

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only http(s), mailto and tel survive. Anything else — javascript:, data:,
 * vbscript:, a protocol-relative //evil.example — collapses to '#'.
 *
 * CTA urls reach us from the AI copilot and from free text the operator typed,
 * and the rendered result is mailed to hundreds of customers under Avalon's
 * own authenticated domain. This is the last gate before that happens.
 */
export function safeUrl(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) {
    // Reject whitespace, quotes, angle brackets and control characters,
    // any of which could break out of the href attribute.
    if (/[\s<>"'\\]/.test(s) || /[\u0000-\u001f\u007f]/.test(s)) return '';
    return s;
  }
  return '';
}

// ── merge tags ───────────────────────────────────────────────────────────────

/**
 * Copy may contain {{first_name}} / {{last_name}} / {{company}}. In send mode
 * these become SendGrid substitution tokens so one rendered body serves the
 * whole batch; in preview mode they become sample values.
 *
 * Applied AFTER escaping, so a merge tag cannot be used to inject markup.
 */
function mergeTags(escaped: string, ctx: RenderContext): string {
  const send = ctx.mode === 'send';
  return escaped
    .replace(/\{\{\s*first_name\s*\}\}/gi, send ? '-firstName-' : 'Dana')
    .replace(/\{\{\s*last_name\s*\}\}/gi, send ? '-lastName-' : 'Whitfield')
    .replace(/\{\{\s*company\s*\}\}/gi, escapeHtml(ctx.brand.company_name));
}

/** Escape, apply merge tags, convert blank lines to paragraph breaks. */
function copy(v: string, ctx: RenderContext): string {
  const escaped = mergeTags(escapeHtml(v), ctx);
  return escaped.replace(/\r?\n/g, '<br>');
}

function plain(v: string, ctx: RenderContext): string {
  const send = ctx.mode === 'send';
  return String(v ?? '')
    .replace(/\{\{\s*first_name\s*\}\}/gi, send ? '-firstName-' : 'Dana')
    .replace(/\{\{\s*last_name\s*\}\}/gi, send ? '-lastName-' : 'Whitfield')
    .replace(/\{\{\s*company\s*\}\}/gi, ctx.brand.company_name);
}

// ── renderer ─────────────────────────────────────────────────────────────────

const WIDTH = 600;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

class LinkTable {
  private n = 0;
  readonly links: RenderedLink[] = [];
  constructor(private ctx: RenderContext) {}

  /**
   * Register a destination and return the href to place in the email.
   *
   * In send mode the href is -trackBase-/<link_id>, where -trackBase- is
   * substituted per recipient to <origin>/c/<track_token>. The recipient's
   * identity therefore rides the click into the inquiry form, which is the
   * whole reason this module does its own click tracking instead of using
   * SendGrid's link wrapping (which must be disabled for campaign sends, or
   * the two wrappers nest).
   *
   * Ids are sequential and deterministic for a given document, so re-rendering
   * a campaign produces the same ids and marketing_link rows can be replaced
   * wholesale without invalidating a link that is already in someone's inbox.
   */
  href(blockId: string, label: string, url: string): string {
    const target = safeUrl(url);
    if (!target) return '';
    this.n += 1;
    const id = `lnk_${this.n}`;
    this.links.push({ id, block_id: blockId, label, target_url: target });
    return this.ctx.mode === 'send' ? `-trackBase-/${id}` : '#';
  }
}

function button(href: string, label: string, c: BrandColors, ctx: RenderContext): string {
  if (!href) return '';
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;">` +
    `<tr><td bgcolor="${c.accent}" style="border-radius:6px;">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};` +
    `font-size:15px;font-weight:600;color:${c.accent_text};text-decoration:none;border-radius:6px;">` +
    `${mergeTags(escapeHtml(label), ctx)}</a>` +
    `</td></tr></table>`
  );
}

function image(assetId: string, alt: string, ctx: RenderContext, c: BrandColors, width: number): string {
  const src = assetId ? ctx.assetUrl(assetId) : '';
  const safe = safeUrl(src);
  if (!safe) {
    // A missing image must not collapse the layout in the preview — the
    // operator needs to see that a slot is empty, not wonder why it is short.
    if (ctx.mode !== 'preview') return '';
    return (
      `<div style="background:${c.border};color:${c.muted};font-family:${FONT};font-size:13px;` +
      `text-align:center;padding:44px 12px;border-radius:6px;">No image selected</div>`
    );
  }
  return (
    `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" width="${width}" ` +
    `style="display:block;width:100%;max-width:${width}px;height:auto;border:0;border-radius:6px;">`
  );
}

function h(text: string, c: BrandColors, ctx: RenderContext, size = 24, alignAttr = 'left'): string {
  if (!text) return '';
  return (
    `<div style="font-family:${FONT};font-size:${size}px;line-height:1.25;font-weight:700;` +
    `color:${c.heading};text-align:${alignAttr};margin:0 0 10px 0;">${mergeTags(escapeHtml(text), ctx)}</div>`
  );
}

function p(text: string, c: BrandColors, ctx: RenderContext, alignAttr = 'left'): string {
  if (!text) return '';
  return (
    `<div style="font-family:${FONT};font-size:15px;line-height:1.6;color:${c.text};` +
    `text-align:${alignAttr};margin:0;">${copy(text, ctx)}</div>`
  );
}

function section(inner: string, c: BrandColors, pad = '28px'): string {
  if (!inner) return '';
  return `<tr><td style="padding:${pad};background:${c.panel};">${inner}</td></tr>`;
}

function renderBlock(b: Block, ctx: RenderContext, c: BrandColors, lt: LinkTable): string {
  const ctaHtml = (cta: Cta | null, blockId: string): string =>
    cta ? button(lt.href(blockId, cta.label, cta.url), cta.label, c, ctx) : '';

  switch (b.type) {
    case 'hero': {
      const img = b.image_asset_id ? image(b.image_asset_id, b.headline, ctx, c, WIDTH) : '';
      const body =
        h(b.headline, c, ctx, 30, b.align) +
        p(b.subhead, c, ctx, b.align) +
        (b.cta
          ? `<div style="text-align:${b.align};">${ctaHtml(b.cta, b.id)}</div>`
          : '');
      return (
        (img ? `<tr><td style="padding:0;background:${c.panel};">${img}</td></tr>` : '') +
        section(body, c)
      );
    }

    case 'image_text':
    case 'text_image': {
      // Two 50% cells that stack on narrow clients via align + width. Kept as a
      // table rather than a media query because Outlook ignores the query.
      const half = Math.floor((WIDTH - 56 - 20) / 2);
      const imgCell =
        `<td width="${half}" valign="top" style="padding:0 10px 0 0;">` +
        `${image(b.image_asset_id, b.headline, ctx, c, half)}</td>`;
      const txtCell =
        `<td width="${half}" valign="top" style="padding:0 0 0 10px;">` +
        `${h(b.headline, c, ctx, 20)}${p(b.body, c, ctx)}${ctaHtml(b.cta, b.id)}</td>`;
      const row = b.type === 'image_text' ? imgCell + txtCell : txtCell + imgCell;
      return section(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${row}</tr></table>`,
        c,
      );
    }

    case 'headline_copy':
      return section(h(b.headline, c, ctx, 24, b.align) + p(b.body, c, ctx, b.align), c);

    case 'benefit_grid': {
      const cols = b.columns === 2 ? 2 : 3;
      const cellW = Math.floor((WIDTH - 56) / cols);
      let rows = '';
      for (let i = 0; i < b.items.length; i += cols) {
        const cells = b.items
          .slice(i, i + cols)
          .map(
            (it) =>
              `<td width="${cellW}" valign="top" style="padding:0 8px 18px 0;">` +
              `<div style="font-family:${FONT};font-size:15px;font-weight:700;color:${c.heading};margin:0 0 6px 0;">` +
              `${mergeTags(escapeHtml(it.title), ctx)}</div>` +
              `<div style="font-family:${FONT};font-size:14px;line-height:1.55;color:${c.text};">` +
              `${copy(it.body, ctx)}</div></td>`,
          )
          .join('');
        rows += `<tr>${cells}</tr>`;
      }
      const table = rows
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`
        : '';
      return section(h(b.headline, c, ctx, 22) + table, c);
    }

    case 'service_feature': {
      const img = b.image_asset_id ? image(b.image_asset_id, b.headline, ctx, c, WIDTH - 56) : '';
      return section(
        (img ? `<div style="margin:0 0 16px 0;">${img}</div>` : '') +
          h(b.headline, c, ctx, 22) +
          p(b.body, c, ctx) +
          ctaHtml(b.cta, b.id),
        c,
      );
    }

    case 'numbered_steps': {
      const items = b.items
        .map(
          (it, i) =>
            `<tr><td width="34" valign="top" style="padding:0 12px 16px 0;">` +
            `<div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:${c.accent};` +
            `color:${c.accent_text};font-family:${FONT};font-size:13px;font-weight:700;text-align:center;">${i + 1}</div>` +
            `</td><td valign="top" style="padding:0 0 16px 0;">` +
            `<div style="font-family:${FONT};font-size:15px;font-weight:700;color:${c.heading};margin:0 0 4px 0;">` +
            `${mergeTags(escapeHtml(it.title), ctx)}</div>` +
            `<div style="font-family:${FONT};font-size:14px;line-height:1.55;color:${c.text};">${copy(it.body, ctx)}</div>` +
            `</td></tr>`,
        )
        .join('');
      const table = items
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>`
        : '';
      return section(h(b.headline, c, ctx, 22) + table, c);
    }

    case 'full_width_image': {
      const img = image(b.image_asset_id, b.caption, ctx, c, WIDTH);
      if (!img) return '';
      const cap = b.caption
        ? `<div style="font-family:${FONT};font-size:12px;color:${c.muted};padding:8px 28px 0 28px;">` +
          `${mergeTags(escapeHtml(b.caption), ctx)}</div>`
        : '';
      return `<tr><td style="padding:0 0 ${cap ? '18px' : '0'} 0;background:${c.panel};">${img}${cap}</td></tr>`;
    }

    case 'banner': {
      const bg = b.tone === 'muted' ? c.border : c.accent;
      const fg = b.tone === 'muted' ? c.text : c.accent_text;
      return (
        `<tr><td style="padding:18px 28px;background:${bg};text-align:center;">` +
        `<div style="font-family:${FONT};font-size:16px;font-weight:600;color:${fg};">` +
        `${copy(b.text, ctx)}</div>` +
        (b.cta ? `<div style="text-align:center;">${ctaHtml(b.cta, b.id)}</div>` : '') +
        `</td></tr>`
      );
    }

    case 'cta_section':
      return section(
        `<div style="text-align:center;">` +
          h(b.headline, c, ctx, 22, 'center') +
          p(b.body, c, ctx, 'center') +
          ctaHtml(b.cta, b.id) +
          `</div>`,
        c,
      );

    case 'testimonial': {
      if (!b.quote) return '';
      const who = [b.attribution, b.role].filter(Boolean).join(', ');
      return section(
        `<div style="border-left:3px solid ${c.accent};padding:2px 0 2px 16px;">` +
          `<div style="font-family:${FONT};font-size:17px;line-height:1.55;font-style:italic;color:${c.heading};">` +
          `${copy(b.quote, ctx)}</div>` +
          (who
            ? `<div style="font-family:${FONT};font-size:13px;color:${c.muted};margin:10px 0 0 0;">` +
              `${mergeTags(escapeHtml(who), ctx)}</div>`
            : '') +
          `</div>`,
        c,
      );
    }

    case 'spacer':
      return `<tr><td style="height:${b.height}px;line-height:${b.height}px;font-size:0;background:${c.panel};">&nbsp;</td></tr>`;

    case 'divider':
      return `<tr><td style="padding:0 28px;background:${c.panel};"><div style="height:1px;background:${c.border};font-size:0;line-height:0;">&nbsp;</div></td></tr>`;

    case 'footer':
      return b.sign_off ? section(p(b.sign_off, c, ctx), c, '24px 28px 8px 28px') : '';
  }
  return '';
}

/**
 * The compliance footer. Always emitted, in both modes, whether or not the
 * document contains a footer block — the postal address and a working
 * unsubscribe link are legal requirements under CAN-SPAM, not content.
 */
function complianceFooter(ctx: RenderContext, c: BrandColors): string {
  const unsubHref = ctx.mode === 'send' ? '-unsubUrl-' : '#';
  const addr = ctx.brand.physical_address
    ? `<div style="margin:0 0 8px 0;">${escapeHtml(ctx.brand.physical_address)}</div>`
    : '';
  return (
    `<tr><td style="padding:22px 28px 30px 28px;background:${c.bg};text-align:center;">` +
    `<div style="font-family:${FONT};font-size:12px;line-height:1.6;color:${c.muted};">` +
    `<div style="margin:0 0 8px 0;">${escapeHtml(ctx.brand.company_name)}</div>` +
    addr +
    `<div><a href="${escapeHtml(unsubHref)}" style="color:${c.muted};text-decoration:underline;">Unsubscribe</a>` +
    ` from these emails.</div>` +
    `</div></td></tr>`
  );
}

/** Plain-text alternative. Every multipart email needs one; spam filters read it. */
function renderText(doc: CampaignDoc, ctx: RenderContext, links: RenderedLink[]): string {
  const out: string[] = [];
  const linkFor = (blockId: string): string => {
    const l = links.find((x) => x.block_id === blockId);
    if (!l) return '';
    return ctx.mode === 'send' ? `-trackBase-/${l.id}` : l.target_url;
  };
  const t = plain;
  for (const b of doc.blocks) {
    switch (b.type) {
      case 'hero':
        out.push(t(b.headline, ctx), t(b.subhead, ctx));
        if (b.cta) out.push(`${b.cta.label}: ${linkFor(b.id)}`);
        break;
      case 'image_text':
      case 'text_image':
      case 'service_feature':
        out.push(t(b.headline, ctx), t(b.body, ctx));
        if (b.cta) out.push(`${b.cta.label}: ${linkFor(b.id)}`);
        break;
      case 'headline_copy':
        out.push(t(b.headline, ctx), t(b.body, ctx));
        break;
      case 'benefit_grid':
      case 'numbered_steps':
        out.push(t(b.headline, ctx));
        b.items.forEach((it, i) => {
          const bullet = b.type === 'numbered_steps' ? `${i + 1}. ` : '- ';
          out.push(`${bullet}${t(it.title, ctx)}${it.body ? ` — ${t(it.body, ctx)}` : ''}`);
        });
        break;
      case 'full_width_image':
        if (b.caption) out.push(t(b.caption, ctx));
        break;
      case 'banner':
        out.push(t(b.text, ctx));
        if (b.cta) out.push(`${b.cta.label}: ${linkFor(b.id)}`);
        break;
      case 'cta_section':
        out.push(t(b.headline, ctx), t(b.body, ctx));
        if (b.cta) out.push(`${b.cta.label}: ${linkFor(b.id)}`);
        break;
      case 'testimonial':
        out.push(`"${t(b.quote, ctx)}"`, [b.attribution, b.role].filter(Boolean).join(', '));
        break;
      case 'footer':
        if (b.sign_off) out.push(t(b.sign_off, ctx));
        break;
      default:
        break;
    }
  }
  out.push('', ctx.brand.company_name);
  if (ctx.brand.physical_address) out.push(ctx.brand.physical_address);
  out.push(`Unsubscribe: ${ctx.mode === 'send' ? '-unsubUrl-' : '(preview)'}`);
  return out.filter((l) => l !== undefined && l !== null && String(l).trim() !== '').join('\n\n');
}

export function renderCampaign(doc: CampaignDoc, ctx: RenderContext): RenderResult {
  const c = resolveColors(ctx.theme, ctx.brand.colors);
  const lt = new LinkTable(ctx);

  const logo = safeUrl(ctx.brand.logo_url || '');
  const header = logo
    ? `<tr><td style="padding:24px 28px 8px 28px;background:${c.panel};">` +
      `<img src="${escapeHtml(logo)}" alt="${escapeHtml(ctx.brand.company_name)}" height="34" ` +
      `style="display:block;height:34px;width:auto;border:0;"></td></tr>`
    : `<tr><td style="padding:24px 28px 8px 28px;background:${c.panel};">` +
      `<div style="font-family:${FONT};font-size:17px;font-weight:700;color:${c.heading};">` +
      `${escapeHtml(ctx.brand.company_name)}</div></td></tr>`;

  const body = doc.blocks.map((b) => renderBlock(b, ctx, c, lt)).join('');

  // Hidden preheader: the grey line an inbox shows after the subject. The
  // trailing whitespace run stops the client from spilling body copy into it.
  const preheader = ctx.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${c.bg};">` +
      `${mergeTags(escapeHtml(ctx.preheader), ctx)}${'&#8199;&#65279;&#847; '.repeat(30)}</div>`
    : '';

  const html =
    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ` +
    `"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head>` +
    `<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark">` +
    `<title>${escapeHtml(ctx.preheader || ctx.brand.company_name)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${c.bg};-webkit-text-size-adjust:100%;">` +
    preheader +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="background:${c.bg};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:${WIDTH}px;border-radius:10px;overflow:hidden;">` +
    header +
    body +
    complianceFooter(ctx, c) +
    `</table></td></tr></table></body></html>`;

  return { html, text: renderText(doc, ctx, lt.links), links: lt.links };
}
