/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import {
  compileAudience,
  compileAudienceCount,
  compileSuppressedCount,
  parseFilter,
  normalizeSources,
  splitName,
  describeFilter,
  AUDIENCE_FIELDS,
} from './audience';

const db = () => env.DB;
const CO = 'co-audience';
const OTHER = 'co-other-tenant';

interface Row {
  email: string;
  full_name: string;
  contact_id: string | null;
  client_id: string | null;
  source: string;
}

const run = async (c: { sql: string; binds: unknown[] }): Promise<Row[]> => {
  const res = await db().prepare(c.sql).bind(...c.binds).all<Row>();
  return res.results ?? [];
};

const count = async (c: { sql: string; binds: unknown[] }): Promise<number> => {
  const r = await db().prepare(c.sql).bind(...c.binds).first<{ n: number }>();
  return Number(r?.n ?? 0);
};

const emails = (rows: Row[]) => rows.map((r) => r.email.toLowerCase()).sort();

beforeAll(async () => {
  const client = (id: string, co: string, name: string, email: string, extra: Record<string, string> = {}) =>
    db()
      .prepare(
        `INSERT INTO clients (id, company_id, name, email, type, status, tags, city, state, zip, since)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id, co, name, email,
        extra.type ?? 'Residential', extra.status ?? 'active', extra.tags ?? '',
        extra.city ?? 'Woodbridge', extra.state ?? 'VA', extra.zip ?? '22192',
        extra.since ?? '2019-04-01',
      )
      .run();

  const contact = (id: string, co: string, clientId: string, name: string, email: string, primary = 1, active = 1) =>
    db()
      .prepare(
        `INSERT INTO client_contacts (id, company_id, client_id, name, email, is_primary, active)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(id, co, clientId, name, email, primary, active)
      .run();

  // Residential client, one primary contact.
  await client('cl-1', CO, 'Dana Whitfield', 'dana@example.com');
  await contact('ct-1', CO, 'cl-1', 'Dana Whitfield', 'dana@example.com', 1);

  // Commercial client whose six contacts all share one inbox — the dedupe case.
  await client('cl-2', CO, 'Ridgeline HOA', 'info@ridgeline.example', { type: 'Commercial', city: 'Fairfax' });
  for (let i = 1; i <= 6; i += 1) {
    await contact(`ct-2${i}`, CO, 'cl-2', `Board Member ${i}`, 'info@ridgeline.example', i === 3 ? 1 : 0);
  }

  // Client with an inactive contact — must fall back to the client address.
  await client('cl-3', CO, 'Marcus Bell', 'marcus@example.com', { city: 'Manassas', type: 'Residential' });
  await contact('ct-3', CO, 'cl-3', 'Marcus Bell', 'marcus@example.com', 1, 0);

  // Suppressed client.
  await client('cl-4', CO, 'Priya Raman', 'priya@example.com');
  await contact('ct-4', CO, 'cl-4', 'Priya Raman', 'priya@example.com', 1);
  await db()
    .prepare(`INSERT INTO marketing_suppression (id, company_id, email, reason) VALUES (?,?,?,?)`)
    .bind('sup-1', CO, 'priya@example.com', 'unsubscribe')
    .run();

  // Client with no email at all — must never appear.
  await client('cl-5', CO, 'No Email Co', '');

  // A different tenant with an identical address. Nothing may cross.
  await client('cl-x', OTHER, 'Other Tenant Client', 'dana@example.com');
  await contact('ct-x', OTHER, 'cl-x', 'Other Tenant Client', 'dana@example.com', 1);

  // Unconverted lead.
  await db()
    .prepare(
      `INSERT INTO opportunities (id, company_id, client, email, status, client_type, client_id)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind('opp-1', CO, 'Lena Ortiz', 'lena@example.com', 'new', 'Residential', '')
    .run();

  // Converted lead — reachable through the client arms, must not double up.
  await db()
    .prepare(
      `INSERT INTO opportunities (id, company_id, client, email, status, client_type, client_id, sold_date)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind('opp-2', CO, 'Dana Whitfield', 'dana@example.com', 'sold', 'Residential', 'cl-1', '2025-06-01')
    .run();

  // Service history for the serviced_type / serviced_since rules.
  await db()
    .prepare(
      `INSERT INTO work_orders (id, company_id, wo_number, client_id, type, scheduled_date)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind('wo-1', CO, 'WO-1', 'cl-1', 'Irrigation', '2025-05-10')
    .run();
  await db()
    .prepare(
      `INSERT INTO work_orders (id, company_id, wo_number, client_id, type, scheduled_date)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind('wo-2', CO, 'WO-2', 'cl-2', 'Hardscape', '2021-03-02')
    .run();
});

describe('compiled SQL shape', () => {
  it('binds every value instead of interpolating it', () => {
    const { sql, binds } = compileAudience(CO, {
      match: 'all',
      rules: [
        { field: 'city', op: 'in', value: ["Fairfax'); DROP TABLE clients;--", 'Manassas'] },
        { field: 'client_type', op: 'contains', value: '100%_commercial' },
      ],
    });
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('Fairfax');
    expect(sql).not.toContain('commercial');
    expect(binds).toContain("fairfax'); drop table clients;--");
    // LIKE wildcards inside a user value are escaped, not honoured.
    expect(binds).toContain('%100\\%\\_commercial%');
  });

  it('scopes every arm and every subquery to the company', () => {
    const { sql, binds } = compileAudience(CO, {
      match: 'all',
      sources: ['contacts', 'clients', 'leads'],
      rules: [{ field: 'serviced_type', op: 'in', value: ['Irrigation'] }],
    });
    // Three pool arms + one EXISTS subquery + one suppression check.
    expect(sql.match(/company_id = \?/g) ?? []).toHaveLength(5);
    expect(binds.filter((b) => b === CO)).toHaveLength(5);
  });

  it('drops an unknown field with a warning rather than emitting it', () => {
    const { sql, warnings } = compileAudience(CO, {
      match: 'all',
      rules: [{ field: 'secret_column', op: 'eq', value: 'x' }],
    });
    expect(sql).not.toContain('secret_column');
    expect(warnings).toEqual(['unknown field "secret_column"']);
  });

  it('rejects an operator that does not apply to the field kind', () => {
    const { warnings } = compileAudience(CO, {
      match: 'all',
      rules: [{ field: 'client_since', op: 'contains', value: 'x' }],
    });
    expect(warnings[0]).toContain('not valid for "client_since"');
  });

  it('matches nobody, not everybody, when an "any" filter has no usable rules', () => {
    const { sql, warnings } = compileAudience(CO, {
      match: 'any',
      rules: [{ field: 'bogus', op: 'eq', value: 'x' }],
    });
    expect(sql).toContain('1=0');
    expect(warnings.join(' ')).toContain('matching nobody');
  });

  it('treats an empty "all" filter as the whole pool', () => {
    const { sql } = compileAudience(CO, { match: 'all', rules: [] });
    expect(sql).toContain('1=1');
  });
});

describe('executed against D1', () => {
  it('returns one row per address, preferring the primary contact', async () => {
    const rows = await run(compileAudience(CO, { match: 'all', rules: [] }));
    // Ridgeline has six contacts on one inbox; exactly one row may come back.
    const ridgeline = rows.filter((r) => r.email.toLowerCase() === 'info@ridgeline.example');
    expect(ridgeline).toHaveLength(1);
    expect(ridgeline[0]!.full_name).toBe('Board Member 3');
  });

  it('excludes suppressed addresses', async () => {
    const rows = await run(compileAudience(CO, { match: 'all', rules: [] }));
    expect(emails(rows)).not.toContain('priya@example.com');

    const withThem = await run(compileAudience(CO, { match: 'all', rules: [] }, { includeSuppressed: true }));
    expect(emails(withThem)).toContain('priya@example.com');
  });

  it('reports how many the suppression list removed', async () => {
    expect(await count(compileSuppressedCount(CO, { match: 'all', rules: [] }))).toBe(1);
  });

  it('never returns another tenant rows even for an identical address', async () => {
    const rows = await run(compileAudience(CO, { match: 'all', rules: [] }));
    expect(rows.every((r) => r.full_name !== 'Other Tenant Client')).toBe(true);

    const otherRows = await run(compileAudience(OTHER, { match: 'all', rules: [] }));
    expect(emails(otherRows)).toEqual(['dana@example.com']);
    expect(otherRows[0]!.full_name).toBe('Other Tenant Client');
  });

  it('skips records with no email', async () => {
    const rows = await run(compileAudience(CO, { match: 'all', rules: [] }));
    expect(rows.every((r) => r.email.trim() !== '')).toBe(true);
    expect(rows.every((r) => r.full_name !== 'No Email Co')).toBe(true);
  });

  it('falls back to the client address when the only contact is inactive', async () => {
    const rows = await run(compileAudience(CO, { match: 'all', rules: [] }));
    const marcus = rows.find((r) => r.email.toLowerCase() === 'marcus@example.com');
    expect(marcus).toBeDefined();
    expect(marcus!.source).toBe('client');
    expect(marcus!.contact_id).toBeNull();
  });

  it('includes unconverted leads only when the leads source is selected', async () => {
    const without = await run(compileAudience(CO, { match: 'all', rules: [] }));
    expect(emails(without)).not.toContain('lena@example.com');

    const withLeads = await run(
      compileAudience(CO, { match: 'all', sources: ['contacts', 'clients', 'leads'], rules: [] }),
    );
    expect(emails(withLeads)).toContain('lena@example.com');
    // The converted lead shares Dana's address and must not add a second row.
    expect(withLeads.filter((r) => r.email.toLowerCase() === 'dana@example.com')).toHaveLength(1);
  });

  it('filters on a client column', async () => {
    const rows = await run(
      compileAudience(CO, { match: 'all', rules: [{ field: 'client_type', op: 'in', value: ['Commercial'] }] }),
    );
    expect(emails(rows)).toEqual(['info@ridgeline.example']);
  });

  it('matches case-insensitively', async () => {
    const rows = await run(
      compileAudience(CO, { match: 'all', rules: [{ field: 'city', op: 'eq', value: 'FAIRFAX' }] }),
    );
    expect(emails(rows)).toEqual(['info@ridgeline.example']);
  });

  it('combines rules with AND for "all" and OR for "any"', async () => {
    const and = await run(
      compileAudience(CO, {
        match: 'all',
        rules: [
          { field: 'client_type', op: 'eq', value: 'Residential' },
          { field: 'city', op: 'eq', value: 'Manassas' },
        ],
      }),
    );
    expect(emails(and)).toEqual(['marcus@example.com']);

    const or = await run(
      compileAudience(CO, {
        match: 'any',
        rules: [
          { field: 'city', op: 'eq', value: 'Manassas' },
          { field: 'city', op: 'eq', value: 'Fairfax' },
        ],
      }),
    );
    expect(emails(or)).toEqual(['info@ridgeline.example', 'marcus@example.com']);
  });

  it('filters on service history', async () => {
    const serviced = await run(
      compileAudience(CO, { match: 'all', rules: [{ field: 'serviced_type', op: 'in', value: ['Irrigation'] }] }),
    );
    expect(emails(serviced)).toEqual(['dana@example.com']);

    const notServiced = await run(
      compileAudience(CO, { match: 'all', rules: [{ field: 'not_serviced_type', op: 'in', value: ['Irrigation'] }] }),
    );
    expect(emails(notServiced)).not.toContain('dana@example.com');

    const recent = await run(
      compileAudience(CO, { match: 'all', rules: [{ field: 'serviced_since', op: 'after', value: '2024-01-01' }] }),
    );
    expect(emails(recent)).toEqual(['dana@example.com']);
  });

  it('filters on whether the client ever bought', async () => {
    const sold = await run(
      compileAudience(CO, { match: 'all', rules: [{ field: 'has_sold_job', op: 'eq', value: '' }] }),
    );
    expect(emails(sold)).toEqual(['dana@example.com']);
  });

  it('counts the same population the row query returns', async () => {
    const filter = { match: 'all', rules: [{ field: 'client_type', op: 'eq', value: 'Residential' }] };
    const rows = await run(compileAudience(CO, filter));
    expect(await count(compileAudienceCount(CO, filter))).toBe(rows.length);
  });

  it('honours a limit for the preview sample', async () => {
    const rows = await run(compileAudience(CO, { match: 'all', rules: [] }, { limit: 2 }));
    expect(rows).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('defaults sources to contacts and clients', () => {
    expect(normalizeSources(undefined)).toEqual(['contacts', 'clients']);
    expect(normalizeSources(['leads'])).toEqual(['leads']);
    expect(normalizeSources(['nonsense'])).toEqual(['contacts', 'clients']);
    expect(normalizeSources(['leads', 'leads'])).toEqual(['leads']);
  });

  it('survives malformed filter json', () => {
    expect(parseFilter('not json').rules).toEqual([]);
    expect(parseFilter(null).match).toBe('all');
  });

  it('splits a full name into merge-tag parts', () => {
    expect(splitName('Dana Whitfield')).toEqual({ first: 'Dana', last: 'Whitfield' });
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: '' });
    expect(splitName('  Mary  Ann  Kelly ')).toEqual({ first: 'Mary', last: 'Ann Kelly' });
    expect(splitName('')).toEqual({ first: '', last: '' });
  });

  it('describes a filter in words for the review screen', () => {
    expect(describeFilter({ match: 'all', rules: [] })).toBe('Everyone in contacts + clients');
    expect(
      describeFilter({ match: 'all', rules: [{ field: 'client_type', op: 'eq', value: 'Commercial' }] }),
    ).toContain('Client type eq Commercial');
  });

  it('exposes a closed field whitelist', () => {
    expect(Object.keys(AUDIENCE_FIELDS)).toContain('city');
    expect(Object.keys(AUDIENCE_FIELDS)).not.toContain('password');
  });
});
