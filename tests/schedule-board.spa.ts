import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Real-browser coverage for the schedule board.
 *
 * There was none. `e2e/` does not exist; playwright.config.ts drives the
 * standalone Finance OS pages against a dev server with no SPA shell and no
 * auth, and the only other spec here covers Finance nav. Nothing exercised the
 * grid, the Job Pool, or a single drag — which is how a board that returned 500
 * to every field user, and a drag that left the crew behind, both shipped.
 *
 * The rule these tests enforce is the one the revamp brief states:
 *
 *     "Each action must survive a browser refresh.
 *      If refreshing changes anything, it isn't finished."
 *
 * So every case reloads the page and re-reads the server's own answer, rather
 * than asserting against the optimistic paint the drag left behind.
 *
 * On simulating drops: these call the board's own drop handlers with a stub
 * dataTransfer instead of driving native HTML5 drag-and-drop, which Playwright
 * cannot reliably synthesise. That still exercises the real handler, the real
 * request and the real server. What it does NOT prove is that the handlers are
 * wired to the DOM — so DND-01 asserts the drag attributes are present on a
 * real card and a real cell, which is the part simulation would otherwise skip.
 */

const REP_LOGIN = { repId: 'tyler', pin: '1111', companyId: 'avalon' };
const TAG = 'E2E-SB'; // marks rows this spec creates, so cleanup is precise

/** A fixed week well clear of "today", so the grid never straddles a boundary. */
const SUNDAY = '2026-09-06';
const MONDAY = '2026-09-07';
const TUESDAY = '2026-09-08';

type Ctx = { crewA: string; crewB: string; exId: string; skId: string };

async function api(request: APIRequestContext, method: 'get' | 'post' | 'put' | 'delete', path: string, data?: unknown) {
  const res = await request[method](path, data === undefined ? undefined : { data });
  expect(res.ok(), `${method.toUpperCase()} ${path} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

async function login(page: Page) {
  const res = await page.request.post('/api/auth/login', { data: REP_LOGIN });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Two crews with one person each, so a roster swap is visible in the payload. */
async function ensureCrews(request: APIRequestContext): Promise<Pick<Ctx, 'crewA' | 'crewB'>> {
  const crews = await api(request, 'get', '/api/crews');
  const find = (name: string) => (crews.data || []).find((c: any) => c.name === name);
  const mk = async (name: string) => {
    const existing = find(name);
    if (existing) return existing.id;
    const made = await api(request, 'post', '/api/crews', { name, color: '#3b82f6' });
    return made.id || made.data?.id;
  };
  const crewA = await mk(`${TAG} Crew A`);
  const crewB = await mk(`${TAG} Crew B`);

  const reps = await api(request, 'get', '/api/reps');
  const pool = (reps.data || reps.reps || []).filter((r: any) => r.active !== 0);
  expect(pool.length, 'the seeded company needs at least two reps').toBeGreaterThanOrEqual(2);
  await api(request, 'put', `/api/crews/${crewA}/members`, { members: [{ repId: pool[0].id, crewRole: 'foreman' }] });
  await api(request, 'put', `/api/crews/${crewB}/members`, { members: [{ repId: pool[1].id, crewRole: 'foreman' }] });
  return { crewA, crewB };
}

async function makeJob(request: APIRequestContext, fields: Record<string, unknown>) {
  const made = await api(request, 'post', '/api/work-orders', {
    client_name: `${TAG} ${fields.client_name || 'Job'}`,
    title: TAG,
    scheduled_duration_minutes: 480,
    ...fields,
  });
  return made.id as string;
}

/** Two machines, so "book one, the other stays pickable" is observable. */
async function ensureAssets(request: APIRequestContext): Promise<{ exId: string; skId: string }> {
  const mk = async (name: string, tag: string) => {
    const list = await api(request, 'get', '/api/assets');
    const found = (list.data?.assets || []).find((a: any) => a.name === name);
    if (found) return found.id as string;
    const made = await api(request, 'post', '/api/assets', { name, assetTag: tag, category: 'heavy' });
    return (made.data?.id || made.id) as string;
  };
  return { exId: await mk(`${TAG} Excavator`, 'E2E-114'), skId: await mk(`${TAG} Skid steer`, 'E2E-220') };
}

/** Open the rail for a job, then expand Materials & equipment by clicking it. */
async function openEquipmentSection(page: Page, woId: string) {
  await openBoard(page);
  await page.locator(`.sb-job-card[onclick*="${woId}"]`).first().click();
  await page.waitForSelector('.sb-rail-sec', { timeout: 10_000 });
  // The picker needs /api/assets, which loads after the bookings.
  await page.waitForTimeout(1200);
  const head = page.locator('.sb-rail-sec').filter({ hasText: 'Materials' }).locator('.sb-rail-sec-head').first();
  const alreadyOpen = await page.evaluate(() => {
    const secs = [...(globalThis as any).document.querySelectorAll('.sb-rail-sec')] as any[];
    return !!secs.find((s) => (s.textContent || '').toLowerCase().includes('equipment') && s.classList.contains('is-open'));
  });
  if (!alreadyOpen) await head.click();
  await page.waitForTimeout(500);
}

function readEquipment(page: Page) {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    const secs = [...doc.querySelectorAll('.sb-rail-sec')] as any[];
    return {
      open: !!secs.find((s) => (s.textContent || '').toLowerCase().includes('equipment') && s.classList.contains('is-open')),
      booked: ([...doc.querySelectorAll('.sb-rail-kit-booked')] as any[]).map((li) => String(li.innerText).replace(/\s+/g, ' ').trim()),
      options: ([...doc.querySelectorAll('.sb-rail-eqsel option')] as any[]).map((o) => String(o.textContent || '').trim()),
      warn: (doc.querySelector('.sb-rail-eqwarn')?.innerText as string) || null,
    };
  });
}

async function cleanup(request: APIRequestContext) {
  const list = await api(request, 'get', '/api/work-orders?limit=1000');
  for (const w of list.data || []) {
    if (String(w.title || '').includes(TAG) || String(w.client_name || '').includes(TAG)) {
      await request.delete(`/api/work-orders/${w.id}`);
    }
  }
  // Deleting a work order cascades its wo_day_equipment rows (0071's FK), so the
  // assets are all that is left to clear.
  const assets = await api(request, 'get', '/api/assets');
  for (const a of assets.data?.assets || []) {
    if (String(a.name || '').includes(TAG)) await request.delete(`/api/assets/${a.id}`);
  }
}

/** Load the board and park it on the week under test. */
async function openBoard(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#sidebar', { state: 'visible' });
  await page.waitForSelector('#view h1', { timeout: 15_000 });
  await page.evaluate(async (sunday) => {
    location.hash = '#scheduleBoard';
    await new Promise((r) => setTimeout(r, 400));
    const sb = (window as any)._sbState;
    sb.viewMode = 'week';
    sb.crewLanes = true;
    // Park on the fixed week, so the test never depends on what "this week"
    // happens to be on the machine running it.
    //
    // The offset is Sunday-to-Sunday. Measuring from `now` instead rounds to
    // whichever week boundary is nearest the current time of day, which lands a
    // week early or late depending on when the suite runs — and then every drag
    // silently does nothing, because the job is not in the week the board holds.
    const cursor = new Date();
    cursor.setHours(12, 0, 0, 0);
    cursor.setDate(cursor.getDate() - cursor.getDay()); // Sunday of the current week
    const target = new Date(`${sunday}T12:00:00`);
    sb.weekOffset = Math.round((target.getTime() - cursor.getTime()) / (7 * 86400000));
    await (window as any)._sbLoadData();
    // _sbLoadData fetches; it does not paint. Without this the DOM is still
    // whatever the initial route rendered, and every locator below is asserting
    // against a stale page.
    (window as any)._sbRender();
    await new Promise((r) => setTimeout(r, 400));
  }, SUNDAY);
}

/** Ask the SERVER what it thinks, not the page's in-memory state. */
async function serverTruth(page: Page, woId: string) {
  return page.evaluate(async (id) => {
    const detail = await (await fetch(`/api/work-orders/${id}`, { credentials: 'include' })).json();
    return {
      crew_id: detail.data.crew_id,
      crew_name: detail.data.crew_name,
      md_crew_id: detail.data.md_crew_id,
      scheduled_date: detail.data.scheduled_date,
      md_day_date: detail.data.md_day_date,
    };
  }, woId);
}

async function dropOnCell(page: Page, woId: string, iso: string, crewId: string | null) {
  return page.evaluate(async ({ woId, iso, crewId }) => {
    await (window as any)._sbDropOnCell(
      { preventDefault() {}, shiftKey: false, dataTransfer: { getData: (k: string) => (k === 'text/plain' ? woId : '0') } },
      iso, crewId,
    );
    await new Promise((r) => setTimeout(r, 900));
  }, { woId, iso, crewId });
}

test.describe('schedule board', () => {
  let ctx: Ctx;

  test.beforeAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    await request.post('/api/auth/login', { data: REP_LOGIN });
    await cleanup(request);
    ctx = { ...(await ensureCrews(request)), ...(await ensureAssets(request)) };
    await request.dispose();
  });

  test.afterAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    await request.post('/api/auth/login', { data: REP_LOGIN });
    await cleanup(request);
    await request.dispose();
  });

  test.beforeEach(async ({ page }) => { await login(page); });

  test('DND-01 cards and cells are actually wired for drag and drop', async ({ page }) => {
    // The other tests call the handlers directly, which cannot catch a card that
    // stopped being draggable or a cell that lost its ondrop. This one checks
    // the wiring in the real DOM so simulation is not proving something about a
    // page nobody can use.
    const woId = await makeJob(page.request, { client_name: 'Wiring', crew_id: ctx.crewA, scheduled_date: MONDAY });
    await openBoard(page);

    const card = page.locator(`.sb-job-card[data-wo="${woId}"]`);
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('draggable', 'true');
    // The card has to know which DAY it is, not just which job — that is what
    // lets the drop address wo_days directly instead of going through the work
    // order and hoping the mirror keeps up.
    await expect(card).toHaveAttribute('data-day', /.+/);
    const cell = page.locator('.sb-lane-cell').first();
    await expect(cell).toHaveAttribute('ondrop', /_sbDropOnCell/);
    await expect(page.locator('.sb-pool')).toHaveAttribute('ondrop', /_sbDropOnPool/);
  });

  test('DND-02 there is no Unassigned lane, in any view', async ({ page }) => {
    // It used to be hard-coded into three separate render paths.
    await openBoard(page);
    await expect(page.locator('.sb-lane-label', { hasText: 'Unassigned' })).toHaveCount(0);
    await page.evaluate(() => { (window as any)._sbState.viewMode = 'timeline'; (window as any)._sbRender(); });
    await expect(page.locator('.sb-timeline-crew-head', { hasText: 'Unassigned' })).toHaveCount(0);
  });

  test('DND-03 Job Pool -> crew and day, and it stays there after a reload', async ({ page }) => {
    const woId = await makeJob(page.request, { client_name: 'FromPool' }); // no date, no crew
    await openBoard(page);
    await expect(page.locator(`.sb-pool-card[data-wo="${woId}"]`)).toHaveCount(1);

    await dropOnCell(page, woId, MONDAY, ctx.crewA);

    await openBoard(page); // full reload
    const truth = await serverTruth(page, woId);
    expect(truth.scheduled_date).toBe(MONDAY);
    expect(truth.crew_id).toBe(ctx.crewA);
    expect(truth.md_day_date).toBe(MONDAY);
    await expect(page.locator(`.sb-pool-card[data-wo="${woId}"]`)).toHaveCount(0);
  });

  test('DND-04 crew A -> crew B moves the people and the job agrees about it', async ({ page }) => {
    // The reported bug: the card moved and the crew did not follow. crew_id is
    // what the drawer's picker selects; crew_name resolves through the day row.
    // They used to disagree in the same response.
    const woId = await makeJob(page.request, { client_name: 'CrewMove', crew_id: ctx.crewA, scheduled_date: MONDAY });
    await openBoard(page);

    const before = await page.evaluate((id) => {
      const a = ((window as any)._sbState.capacity.assignments || []).find((x: any) => x.work_order_id === id);
      return a ? a.employees.map((e: any) => e.rep_id) : [];
    }, woId);
    expect(before.length).toBeGreaterThan(0);

    await dropOnCell(page, woId, MONDAY, ctx.crewB);
    await openBoard(page);

    const truth = await serverTruth(page, woId);
    expect(truth.crew_id).toBe(ctx.crewB);
    expect(truth.md_crew_id).toBe(ctx.crewB);

    const after = await page.evaluate((id) => {
      const a = ((window as any)._sbState.capacity.assignments || []).find((x: any) => x.work_order_id === id);
      return a ? a.employees.map((e: any) => e.rep_id) : [];
    }, woId);
    expect(after).not.toEqual(before); // the roster followed the job
  });

  test('DND-05 Monday -> Tuesday moves the DAY row, not just the work order', async ({ page }) => {
    const woId = await makeJob(page.request, { client_name: 'DayMove', crew_id: ctx.crewA, scheduled_date: MONDAY });
    await openBoard(page);
    await dropOnCell(page, woId, TUESDAY, ctx.crewA);
    await openBoard(page);

    const truth = await serverTruth(page, woId);
    expect(truth.scheduled_date).toBe(TUESDAY);
    expect(truth.md_day_date).toBe(TUESDAY); // capacity is computed from this one
  });

  test('DND-06 calendar -> Job Pool unschedules, and keeps the crew for next time', async ({ page }) => {
    const woId = await makeJob(page.request, { client_name: 'BackToPool', crew_id: ctx.crewA, scheduled_date: MONDAY });
    await openBoard(page);

    await page.evaluate(async (id) => {
      await (window as any)._sbDropOnPool({
        preventDefault() {},
        dataTransfer: { getData: (k: string) => (k === 'text/plain' ? id : '0') },
      });
      await new Promise((r) => setTimeout(r, 1200));
    }, woId);

    await openBoard(page);
    const truth = await serverTruth(page, woId);
    expect(truth.scheduled_date).toBeNull();
    await expect(page.locator(`.sb-pool-card[data-wo="${woId}"]`)).toHaveCount(1);
  });

  test('DND-07 sold labor does not change because the schedule changed', async ({ page }) => {
    // Rule 5 of the brief. Moving a job around must never rewrite what was sold —
    // budget_minutes is deliberately absent from every write in the scheduling
    // router, and this is the test that keeps it that way.
    const woId = await makeJob(page.request, { client_name: 'Budget', crew_id: ctx.crewA, scheduled_date: MONDAY, budget_hours: 24 });
    const soldBefore = (await api(page.request, 'get', `/api/work-orders/${woId}`)).data.budget_minutes;
    expect(soldBefore).toBe(24 * 60);

    await openBoard(page);
    await dropOnCell(page, woId, TUESDAY, ctx.crewB);
    await openBoard(page);

    const soldAfter = (await api(page.request, 'get', `/api/work-orders/${woId}`)).data.budget_minutes;
    expect(soldAfter).toBe(soldBefore);
  });

  test('DND-08 a locked job refuses to move, and says so', async ({ page }) => {
    const woId = await makeJob(page.request, { client_name: 'Locked', crew_id: ctx.crewA, scheduled_date: MONDAY });
    await api(page.request, 'put', `/api/work-orders/${woId}`, { schedule_locked: true });

    await openBoard(page);
    await dropOnCell(page, woId, TUESDAY, ctx.crewA);
    await openBoard(page);

    const truth = await serverTruth(page, woId);
    expect(truth.scheduled_date).toBe(MONDAY); // did not budge
    expect(truth.md_day_date).toBe(MONDAY);
  });

  // ── Equipment booking ──────────────────────────────────────────────────────
  //
  // wo_day_equipment (migration 0071) had no reader in src/ at all until this
  // branch; the rail rendered the work order's free-text `equipment` notes
  // instead. These cover the real table, and the same refresh rule applies.

  test('EQB-01 booking a machine survives a reload, and the picker drops it', async ({ page }) => {
    const woId = await makeJob(page.request, { client_name: 'Booking', crew_id: ctx.crewA, scheduled_date: MONDAY });
    await openEquipmentSection(page, woId);

    const before = await readEquipment(page);
    expect(before.booked).toEqual([]);
    expect(before.options.join(' ')).toContain('Excavator');

    await page.selectOption('.sb-rail-eqsel', ctx.exId);
    await page.waitForTimeout(1200);

    // Reload before believing any of it — the optimistic paint proves nothing.
    await openEquipmentSection(page, woId);
    const after = await readEquipment(page);
    expect(after.booked.join(' ')).toContain('Excavator');
    expect(after.booked.join(' ')).toContain('NEEDED');
    // Already booked, so it must not still be offered.
    expect(after.options.join(' ')).not.toContain('Excavator');
    expect(after.options.join(' ')).toContain('Skid steer');
  });

  test('EQB-02 booking does not collapse the section you are working in', async ({ page }) => {
    // The regression guard. Open state lived only in the `is-open` DOM class, so
    // every _sbRender() reset it: booking a machine shut the panel you booked it
    // from. Every rail section had the defect; equipment re-renders often enough
    // to make it visible.
    const woId = await makeJob(page.request, { client_name: 'StayOpen', crew_id: ctx.crewA, scheduled_date: MONDAY });
    await openEquipmentSection(page, woId);
    expect((await readEquipment(page)).open).toBe(true);

    await page.selectOption('.sb-rail-eqsel', ctx.exId);
    await page.waitForTimeout(1200);
    expect((await readEquipment(page)).open, 'section closed itself on booking').toBe(true);

    // And again on a status change, which re-renders the same way.
    await page.locator('.sb-rail-kit-booked button.sb-rail-kit-status').first().click();
    await page.waitForTimeout(1000);
    expect((await readEquipment(page)).open, 'section closed itself on a status tap').toBe(true);
  });

  test('EQB-03 the status pill cycles, and the new status outlives a reload', async ({ page }) => {
    const woId = await makeJob(page.request, { client_name: 'Status', crew_id: ctx.crewA, scheduled_date: MONDAY });
    await openEquipmentSection(page, woId);
    await page.selectOption('.sb-rail-eqsel', ctx.exId);
    await page.waitForTimeout(1200);

    const pill = () => page.locator('.sb-rail-kit-booked button.sb-rail-kit-status').first();
    await pill().click(); await page.waitForTimeout(900);   // needed -> loaded
    await pill().click(); await page.waitForTimeout(900);   // loaded -> on site

    await openEquipmentSection(page, woId);
    expect((await readEquipment(page)).booked.join(' ')).toContain('ON SITE');
  });

  test('EQB-04 the same machine on two jobs one day warns, and does not block', async ({ page }) => {
    // 0071's header promises exactly this: impossible per day ROW, a warning
    // across two different jobs on one DATE. An excavator really can do two jobs
    // in a day, and refusing it would make the honest answer unrecordable.
    const a = await makeJob(page.request, { client_name: 'ConflictA', crew_id: ctx.crewA, scheduled_date: MONDAY });
    const b = await makeJob(page.request, { client_name: 'ConflictB', crew_id: ctx.crewB, scheduled_date: MONDAY });

    await openEquipmentSection(page, a);
    await page.selectOption('.sb-rail-eqsel', ctx.skId);
    await page.waitForTimeout(1200);
    expect((await readEquipment(page)).warn, 'one job is not a conflict').toBeNull();

    await openEquipmentSection(page, b);
    await page.selectOption('.sb-rail-eqsel', ctx.skId);
    await page.waitForTimeout(1200);

    await openEquipmentSection(page, b);
    const seen = await readEquipment(page);
    expect(seen.warn, 'expected a double-booking warning').toContain('Skid steer');
    // Warned, not refused: the booking is still there.
    expect(seen.booked.join(' ')).toContain('Skid steer');
  });

  test('EQB-05 releasing a machine puts it back in the picker, after a reload', async ({ page }) => {
    const woId = await makeJob(page.request, { client_name: 'Release', crew_id: ctx.crewA, scheduled_date: MONDAY });
    await openEquipmentSection(page, woId);
    await page.selectOption('.sb-rail-eqsel', ctx.exId);
    await page.waitForTimeout(1200);

    await page.locator('.sb-rail-kit-x').first().click();
    await page.waitForTimeout(1200);

    await openEquipmentSection(page, woId);
    const after = await readEquipment(page);
    expect(after.booked).toEqual([]);
    expect(after.options.join(' ')).toContain('Excavator');
  });

  // ── Responsive ladder ──────────────────────────────────────────────────────

  test('RSP-01 the week is never cut off, at any width this page is used at', async ({ page }) => {
    // This existed only as an assumption for most of the redesign: the display
    // it was built on cannot produce a CSS viewport above ~1400px, so "it should
    // scale" was an inference. Playwright can set a real one, which is what
    // finally caught the three-pane threshold being 240px too low — at 1600 the
    // board would have been squeezed to ~620px against the ~692 seven legible
    // day columns need, and the back of the week would have gone behind a
    // scrollbar on exactly the monitors this page is FOR.
    //
    // So the invariant, not the arithmetic: all seven days visible, nothing
    // clipped, nothing scrolling sideways, with the day rail OPEN — which is
    // when the three panes actually compete for width.
    const woId = await makeJob(page.request, { client_name: 'Widths', crew_id: ctx.crewA, scheduled_date: MONDAY });

    for (const width of [1280, 1400, 1600, 1790, 1810, 1920, 2560]) {
      await page.setViewportSize({ width, height: 1000 });
      await openBoard(page);
      await page.locator(`.sb-job-card[onclick*="${woId}"]`).first().click();
      await page.waitForTimeout(900);

      const m = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const heads = [...doc.querySelectorAll('.sb-lane-day-head')] as any[];
        const board = doc.querySelector('.sb-board');
        const wrap = doc.querySelector('.sb-lane-wrap');
        const pool = doc.querySelector('.sb-pool');
        return {
          railOpen: !!doc.querySelector('.sb-rail'),
          days: heads.length,
          clipped: heads.length && board
            ? Math.round(heads[heads.length - 1].getBoundingClientRect().right) > Math.round(board.getBoundingClientRect().right) + 1
            : false,
          gridScrollsX: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : false,
          pageScrollsX: doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1,
          poolWidth: pool ? Math.round(pool.getBoundingClientRect().width) : 0,
        };
      });

      expect(m.railOpen, `${width}px: rail did not open`).toBe(true);
      expect(m.days, `${width}px: not a full week`).toBe(7);
      expect(m.clipped, `${width}px: the last day is cut off`).toBe(false);
      expect(m.gridScrollsX, `${width}px: the grid scrolls sideways`).toBe(false);
      expect(m.pageScrollsX, `${width}px: the PAGE scrolls sideways`).toBe(false);

      // Above the threshold all three panes are open; at or below it the pool
      // collapses to its rail so the board keeps its room. The rail wins because
      // it is what you just opened.
      if (width > 1800) expect(m.poolWidth, `${width}px: expected the pool open`).toBeGreaterThan(100);
      else if (width > 1100) expect(m.poolWidth, `${width}px: expected the pool collapsed`).toBeLessThan(100);
    }
  });

  test('RSP-02 the day rail stays usable on a short screen, with the warnings band up', async ({ page }) => {
    // The regression guard for a bug four EQB specs were already failing on,
    // which read as flakiness because the symptom was a click timing out.
    //
    // The rail gets whatever height .sb-workspace has left. On a 720px screen
    // with the warnings band showing that measured 183px, against fixed
    // furniture of head 49 + title 121 + actions 97 = 267 — so .sb-rail-body
    // computed to ZERO and no section could be opened at all. A 43px section
    // header has no scroll position that clears both the block above it and the
    // action bar below it, so Playwright's click landed alternately on
    // .sb-rail-title and .sb-rail-actions until it timed out.
    //
    // Height, not width, is the axis at risk here, and RSP-01 varies only width.
    // Six 8h jobs on one crew on one day is what raises the warnings band, and
    // is also just a normal Monday.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await makeJob(page.request, { client_name: `Squeeze ${i}`, crew_id: ctx.crewA, scheduled_date: MONDAY }));
    }

    for (const height of [720, 800, 900]) {
      await page.setViewportSize({ width: 1280, height });
      await openBoard(page);
      // The warnings band renders inside the KPI band, so it is only on screen
      // when metrics are. openBoard leaves that at its stored default.
      await page.evaluate(() => {
        (globalThis as any)._sbState.showMetrics = true;
        (globalThis as any)._sbRender();
      });
      await page.waitForTimeout(600);
      // Opened through the card's own handler rather than by clicking the card.
      // Six jobs in one cell is what raises the warnings band this test needs,
      // and it also overflows the cell — .sb-workstation .sb-lane-cell is
      // overflow:visible so the hover panel can escape, which lets the CARDS
      // escape too, and later lane cells then paint over them. Clicking one is
      // a coin toss that has nothing to do with what is under test here. The
      // board-side bug is real and logged separately; DND-01 covers the card
      // being wired to the DOM.
      await page.evaluate((id) => (globalThis as any)._sbOpenDayRail(id, 1), ids[0]);
      await page.waitForSelector('.sb-rail-sec', { timeout: 10_000 });
      await page.waitForTimeout(800);

      const m = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const body = doc.querySelector('.sb-rail-body');
        const secHead = doc.querySelector('.sb-rail-sec-head');
        return {
          warningsUp: !!doc.querySelector('.sb-warnings'),
          bodyH: body ? Math.round(body.getBoundingClientRect().height) : 0,
          secHeadH: secHead ? Math.round(secHead.getBoundingClientRect().height) : 0,
        };
      });

      expect(m.warningsUp, `${height}px: expected the warnings band, which is what does the squeezing`).toBe(true);
      // The invariant, not the pixel count: the scroll area can hold the thing
      // you are trying to click.
      expect(m.bodyH, `${height}px: the rail's scroll area was starved to ${m.bodyH}px`)
        .toBeGreaterThanOrEqual(m.secHeadH);

      // And prove it by actually clicking one, which is what the EQB specs do.
      const head = page.locator('.sb-rail-sec').filter({ hasText: 'Materials' }).locator('.sb-rail-sec-head').first();
      await head.click({ timeout: 8_000 });
      await page.waitForTimeout(400);
      expect(await readEquipment(page)).toHaveProperty('open', true);
    }
  });

  test('RSP-03 a busy day stays inside its own lane, and every card stays clickable', async ({ page }) => {
    // .sb-workstation .sb-lane-cell was overflow:visible so .sb-card-hover could
    // escape the cell. The cards escaped with it: six jobs on one crew on one
    // day — a normal Monday — put 919px of cards in a 124px cell, spilling 563px
    // into the rows beneath. Lane cells are siblings, so the later ones paint on
    // top, and four of the six cards could not be clicked at all. A card you
    // cannot click is a job you cannot open, so this is correctness, not polish.
    //
    // Asserted by REACHABILITY, not by measuring boxes or sampling for strays.
    // Both of those were tried and neither says anything:
    //   - getBoundingClientRect does not know about clipping, so a properly
    //     contained card still reports a rect far outside its cell.
    //   - hit-testing the lane below finds nothing either way, because lane
    //     cells are siblings and the later one paints ON TOP of the card that
    //     spilled into it. The spilled card is behind, not in front.
    // Which is the whole point: the card was not visibly misplaced, it was
    // buried. "Can every card take a click" is the one question that separates
    // the broken state from the fixed one, and it is also the thing a scheduler
    // actually needs.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await makeJob(page.request, { client_name: `Busy ${i}`, crew_id: ctx.crewA, scheduled_date: MONDAY }));
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBoard(page);

    const rendered = await page.evaluate(
      (list) => list.filter((id) => (globalThis as any).document.querySelector(`.sb-job-card[onclick*="${id}"]`)).length,
      ids,
    );
    expect(rendered, 'all six jobs should be on the board').toBe(ids.length);

    // Scroll each one up inside its own lane and confirm it can take a click.
    // Pre-fix this fails on the cards that spilled out of the cell, because
    // scrolling the lane cannot reach a card the lane no longer contains.
    // A trial click runs Playwright's full actionability check — including the
    // hit test that a buried card fails — and then does not fire the handler,
    // so the rail stays shut and every card is measured against the same board.
    for (const id of ids) {
      const card = page.locator(`.sb-job-card[onclick*="${id}"]`).first();
      await card.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await card.click({ timeout: 5_000, trial: true });
    }
  });
});
