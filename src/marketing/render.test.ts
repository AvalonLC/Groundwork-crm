import { describe, it, expect } from 'vitest';
import {
  parseCampaignDoc,
  serializeCampaignDoc,
  newBlock,
  normalizeBlock,
  emptyDoc,
  BLOCK_TYPES,
  type CampaignDoc,
} from './blocks';
import { renderCampaign, safeUrl, escapeHtml, resolveColors, type RenderContext } from './render';

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  mode: 'preview',
  brand: {
    company_name: 'Avalon Landscape Contracting',
    physical_address: '1420 Old Bridge Rd, Woodbridge, VA 22192',
    logo_url: 'https://cdn.example.com/logo.png',
    colors: null,
  },
  theme: 'brand_dark',
  preheader: 'Book your fall cleanup',
  assetUrl: (id: string) => `https://cdn.example.com/a/${id}.jpg`,
  baseUrl: 'https://groundwork-crm.com',
  ...over,
});

const doc = (...blocks: unknown[]): CampaignDoc =>
  parseCampaignDoc({ version: 1, blocks });

describe('safeUrl', () => {
  it('accepts http, https, mailto and tel', () => {
    expect(safeUrl('https://avalon-lc.com/fall')).toBe('https://avalon-lc.com/fall');
    expect(safeUrl('http://avalon-lc.com')).toBe('http://avalon-lc.com');
    expect(safeUrl('mailto:hello@avalon-lc.com')).toBe('mailto:hello@avalon-lc.com');
    expect(safeUrl('tel:+17035550100')).toBe('tel:+17035550100');
  });

  it('rejects every scheme that can execute or smuggle content', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox',
      '//evil.example/path',
      '/relative/path',
      'file:///etc/passwd',
      '',
      null,
      undefined,
    ]) {
      expect(safeUrl(bad)).toBe('');
    }
  });

  it('rejects urls carrying quotes, angle brackets or control characters', () => {
    expect(safeUrl('https://a.com/"onload="x')).toBe('');
    expect(safeUrl('https://a.com/<script>')).toBe('');
    expect(safeUrl('https://a.com/\nSet-Cookie: x')).toBe('');
    expect(safeUrl('https://a.com/a b')).toBe('');
  });
});

describe('renderCampaign — invariants that hold for every document', () => {
  it('always emits the postal address and an unsubscribe link, even for an empty doc', () => {
    const { html } = renderCampaign(emptyDoc(), ctx());
    expect(html).toContain('1420 Old Bridge Rd, Woodbridge, VA 22192');
    expect(html).toContain('Unsubscribe');
  });

  it('emits the compliance footer even when the document has no footer block', () => {
    const d = doc({ type: 'headline_copy', headline: 'Hi', body: 'There' });
    expect(d.blocks.some((b) => b.type === 'footer')).toBe(false);
    const { html } = renderCampaign(d, ctx());
    expect(html).toContain('Avalon Landscape Contracting');
    expect(html).toContain('1420 Old Bridge Rd');
    expect(html).toContain('Unsubscribe');
  });

  it('never emits a script or style element for any block type', () => {
    // One document containing every block type, each with hostile content.
    const blocks = BLOCK_TYPES.map((type) => {
      const b = newBlock(type) as Record<string, unknown>;
      const poison = '<script>alert(1)</script>';
      for (const key of ['headline', 'subhead', 'body', 'text', 'quote', 'caption', 'sign_off', 'attribution', 'role']) {
        if (key in b) b[key] = poison;
      }
      if ('items' in b) b.items = [{ title: poison, body: poison }];
      if ('image_asset_id' in b) b.image_asset_id = 'asset-1';
      if ('cta' in b) b.cta = { label: poison, url: 'https://avalon-lc.com/x' };
      return b;
    });
    const { html } = renderCampaign(doc(...blocks), ctx());
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/onerror=/i);
    expect(html).not.toMatch(/onload=/i);
    // The poison survives only as escaped text.
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops a javascript: CTA rather than rendering it as a link', () => {
    const d = doc({
      type: 'cta_section',
      headline: 'Book now',
      body: '',
      cta: { label: 'Go', url: 'javascript:alert(1)' },
    });
    const { html, links } = renderCampaign(d, ctx({ mode: 'send' }));
    expect(links).toHaveLength(0);
    expect(html).not.toContain('javascript:');
    // The section still renders; only the button is gone.
    expect(html).toContain('Book now');
  });

  it('rejects a non-hex brand color override instead of inlining it', () => {
    const c = resolveColors('brand_dark', { accent: 'red;}</style><script>x' } as never);
    expect(c.accent).toBe('#3f7d5a');
    expect(resolveColors('brand_dark', { accent: '#ff8800' }).accent).toBe('#ff8800');
  });
});

describe('renderCampaign — preview mode versus send mode', () => {
  const withCta = () =>
    doc({
      type: 'hero',
      headline: 'Fall cleanup for {{first_name}}',
      subhead: 'From {{company}}',
      image_asset_id: 'hero-1',
      cta: { label: 'Get a quote', url: 'https://avalon-lc.com/fall' },
      align: 'left',
    });

  it('preview mode substitutes sample values and makes links inert', () => {
    const { html } = renderCampaign(withCta(), ctx({ mode: 'preview' }));
    expect(html).toContain('Fall cleanup for Dana');
    expect(html).toContain('From Avalon Landscape Contracting');
    expect(html).not.toContain('-firstName-');
    expect(html).not.toContain('-trackBase-');
    expect(html).not.toContain('-unsubUrl-');
    expect(html).toContain('href="#"');
  });

  it('send mode emits SendGrid substitution tokens instead of values', () => {
    const { html } = renderCampaign(withCta(), ctx({ mode: 'send' }));
    expect(html).toContain('-firstName-');
    expect(html).toContain('-unsubUrl-');
    expect(html).toContain('-trackBase-/lnk_1');
    expect(html).not.toContain('Dana');
    // The raw destination never appears in the body; only the tracked href does.
    expect(html).not.toContain('https://avalon-lc.com/fall');
  });

  it('records each CTA destination once, in document order, with stable ids', () => {
    const d = doc(
      { type: 'cta_section', headline: 'A', body: '', cta: { label: 'One', url: 'https://a.example/1' } },
      { type: 'banner', text: 'B', tone: 'accent', cta: { label: 'Two', url: 'https://a.example/2' } },
    );
    const first = renderCampaign(d, ctx({ mode: 'send' }));
    expect(first.links.map((l) => [l.id, l.target_url])).toEqual([
      ['lnk_1', 'https://a.example/1'],
      ['lnk_2', 'https://a.example/2'],
    ]);
    // Re-rendering the same document must produce the same ids, or links
    // already sitting in someone's inbox would resolve to the wrong target.
    const second = renderCampaign(d, ctx({ mode: 'send' }));
    expect(second.links).toEqual(first.links);
  });

  it('produces a plain-text alternative carrying the same tokens', () => {
    const { text } = renderCampaign(withCta(), ctx({ mode: 'send' }));
    expect(text).toContain('-firstName-');
    expect(text).toContain('-trackBase-/lnk_1');
    expect(text).toContain('Avalon Landscape Contracting');
    expect(text).toContain('-unsubUrl-');
    expect(text).not.toMatch(/<[a-z]/i);
  });
});

describe('renderCampaign — per-block output', () => {
  it('renders a benefit grid as a table with the requested column count', () => {
    const d = doc({
      type: 'benefit_grid',
      headline: 'Why Avalon',
      columns: 2,
      items: [
        { title: 'Licensed', body: 'VA class A' },
        { title: 'Insured', body: '2M liability' },
        { title: 'Local', body: 'Since 2009' },
      ],
    });
    const { html } = renderCampaign(d, ctx());
    expect(html).toContain('Why Avalon');
    expect(html).toContain('Licensed');
    expect(html).toContain('Since 2009');
    // 3 items at 2 columns = 2 rows.
    const rows = html.split('Why Avalon')[1]!.match(/<tr>/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('numbers the steps of a numbered_steps block', () => {
    const d = doc({
      type: 'numbered_steps',
      headline: 'How it works',
      items: [{ title: 'Call', body: '' }, { title: 'Quote', body: '' }, { title: 'Done', body: '' }],
    });
    const { html } = renderCampaign(d, ctx());
    expect(html).toMatch(/>1</);
    expect(html).toMatch(/>2</);
    expect(html).toMatch(/>3</);
  });

  it('shows a placeholder for a missing image in preview but omits it when sending', () => {
    const d = doc({ type: 'full_width_image', image_asset_id: '', caption: '' });
    expect(renderCampaign(d, ctx({ mode: 'preview' })).html).toContain('No image selected');
    expect(renderCampaign(d, ctx({ mode: 'send' })).html).not.toContain('No image selected');
  });

  it('puts the image before the copy for image_text and after it for text_image', () => {
    const fields = { headline: 'H', body: 'B', image_asset_id: 'img-9', cta: null };
    const a = renderCampaign(doc({ type: 'image_text', ...fields }), ctx()).html;
    const b = renderCampaign(doc({ type: 'text_image', ...fields }), ctx()).html;
    expect(a.indexOf('img-9')).toBeLessThan(a.indexOf('>H<'));
    expect(b.indexOf('img-9')).toBeGreaterThan(b.indexOf('>H<'));
  });
});

describe('parseCampaignDoc', () => {
  it('returns an empty document for malformed json rather than throwing', () => {
    // The editor must always be able to open a campaign in order to repair it.
    expect(parseCampaignDoc('not json').blocks).toEqual([]);
    expect(parseCampaignDoc('').blocks).toEqual([]);
    expect(parseCampaignDoc(null).blocks).toEqual([]);
    expect(parseCampaignDoc({ blocks: 'nope' }).blocks).toEqual([]);
  });

  it('drops unknown block types but keeps the blocks around them', () => {
    const d = parseCampaignDoc({
      version: 1,
      blocks: [
        { id: 'a', type: 'headline_copy', headline: 'Keep me' },
        { id: 'b', type: 'wormhole', headline: 'Invented by the model' },
        { id: 'c', type: 'divider' },
      ],
    });
    expect(d.blocks.map((b) => b.type)).toEqual(['headline_copy', 'divider']);
  });

  it('reassigns duplicate ids so a copilot update_block is never ambiguous', () => {
    const d = parseCampaignDoc({
      version: 1,
      blocks: [
        { id: 'same', type: 'divider' },
        { id: 'same', type: 'divider' },
      ],
    });
    expect(d.blocks).toHaveLength(2);
    expect(d.blocks[0]!.id).not.toBe(d.blocks[1]!.id);
  });

  it('clamps an absurd spacer height', () => {
    expect((normalizeBlock({ type: 'spacer', height: 4000 }) as { height: number }).height).toBe(96);
    expect((normalizeBlock({ type: 'spacer', height: -5 }) as { height: number }).height).toBe(4);
    expect((normalizeBlock({ type: 'spacer', height: 'x' }) as { height: number }).height).toBe(24);
  });

  it('drops a CTA that is missing a label or a url', () => {
    const b = normalizeBlock({ type: 'cta_section', cta: { label: 'Go' } }) as { cta: unknown };
    expect(b.cta).toBeNull();
  });

  it('round-trips through serialize without losing blocks', () => {
    const d = doc(
      { type: 'hero', headline: 'H', subhead: 'S', image_asset_id: 'i', cta: { label: 'L', url: 'https://x.example' } },
      { type: 'divider' },
    );
    const back = parseCampaignDoc(serializeCampaignDoc(d));
    expect(back).toEqual(d);
  });

  it('can construct every declared block type', () => {
    for (const type of BLOCK_TYPES) {
      const b = newBlock(type);
      expect(b.type).toBe(type);
      expect(b.id).toBeTruthy();
      expect(normalizeBlock(b)).toEqual(b);
    }
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter in markup', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
