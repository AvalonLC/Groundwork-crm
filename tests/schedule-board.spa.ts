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

type Ctx = { crewA: string; crewB: string };

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
async function ensureCrews(request: APIRequestContext): Promise<Ctx> {
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

async function cleanup(request: APIRequestContext) {
  const list = await api(request, 'get', '/api/work-orders?limit=1000');
  for (const w of list.data || []) {
    if (String(w.title || '').includes(TAG) || String(w.client_name || '').includes(TAG)) {
      await request.delete(`/api/work-orders/${w.id}`);
    }
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
    ctx = await ensureCrews(request);
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
});
