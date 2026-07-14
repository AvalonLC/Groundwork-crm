const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const results = [];
  const ok = (name, cond) => results.push((cond ? 'PASS' : 'FAIL') + ' — ' + name);

  // ── 1. Signup via /onboard UI ──
  await page.goto('http://localhost:3000/signup', { waitUntil: 'networkidle' });
  ok('onboard page loads', await page.locator('#signupForm').count() === 1);
  const hpBox = await page.locator('#website_url').boundingBox();
  ok('honeypot present + off-screen', hpBox !== null && hpBox.x < -5000);
  await page.fill('#companyName', 'PW Test Co');
  await page.fill('#ownerName', 'PW Owner');
  await page.fill('#email', 'pwowner5@gwtest.com');
  await page.fill('#password', 'pwtestpass1');
  await page.click('#submitBtn');
  await page.waitForURL('http://localhost:3000/', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(4000);
  ok('redirected to app after signup', page.url().startsWith('http://localhost:3000/') && page.url().replace(/[#?].*$/,'') === 'http://localhost:3000/');

  // ── 2. Onboarding wizard appears for new company ──
  const wizardVisible = await page.evaluate(() => !!document.getElementById('onb-overlay'));
  ok('onboarding wizard shown for new company', wizardVisible);

  // ── 3. Company badge + trial pill in topbar ──
  const badgeText = await page.evaluate(() => (document.getElementById('gw-company-badge')||{}).textContent || '');
  ok('company badge shows PW Test Co', badgeText.includes('PW Test Co'));
  const pillText = await page.evaluate(() => (document.getElementById('gw-trial-pill')||{}).textContent || '');
  ok('trial pill shows days left', /Trial · 1[0-4] days left/.test(pillText));

  // ── 4. No avalon data leakage (blank FY for non-avalon) ──
  const fyLeak = await page.evaluate(() => {
    try { const fy = window.getResolvedFY ? window.getResolvedFY() : null;
      return fy ? (fy.annual && fy.annual.budgetedRevenue) : 'n/a'; } catch(e){ return 'err:'+e.message; }
  });
  ok('non-avalon FY budget is 0 (no Avalon seed leak), got: ' + JSON.stringify(fyLeak), fyLeak === 0 || fyLeak === 'n/a');

  // ── 5. gwLastCompany marker set ──
  const lastCo = await page.evaluate(() => localStorage.getItem('gwLastCompany'));
  ok('gwLastCompany set to new company', !!lastCo && lastCo.startsWith('co_'));

  // ── 6. Login screen forgot-password panel exists ──
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await p2.waitForTimeout(2500);
  const hasLoginUI = await p2.evaluate(() => !!document.getElementById('forgotPanel') || document.body.innerHTML.includes('Forgot'));
  ok('login screen has forgot-password affordance', hasLoginUI);

  console.log(results.join('\n'));
  console.log('JS errors:', errors.length ? errors.slice(0,5).join(' | ') : 'none');
  await browser.close();
})().catch(e => { console.error('HARNESS FAIL:', e.message); process.exit(1); });
