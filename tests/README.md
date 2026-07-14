# E2E Tests (Playwright)

Prereqs: `npm i -D playwright && npx playwright install chromium` (or reuse an existing harness),
local server running on :3000 (`npm run build && pm2 start ecosystem.config.cjs`).

Run: `node tests/e2e_full.js`

Covers: signup UI (+honeypot), onboarding wizard trigger, company badge, trial pill,
non-Avalon financial isolation, tenant marker, forgot-password affordance.

NOTE: each run creates a company — delete it afterwards via Platform Admin → Companies → Delete,
and signups are rate-limited to 3/hour/IP (clear `_signup_rl_*` settings rows locally if needed).
