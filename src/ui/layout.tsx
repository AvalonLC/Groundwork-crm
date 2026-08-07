import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Role } from "./roles";
import type { VocabularyMode } from "./vocabulary";
import { translateTerm, DEFAULT_VOCABULARY_MODE } from "./vocabulary";
import { resolveFinanceRole } from "../config/finance-config";

export interface PageArgs {
  tenant_id: string;
  role: Role;
  vocab: VocabularyMode;
}

/** Set by the CRM's own requireAuth middleware (src/index.tsx) when a page
 * is mounted for real, behind /finance/*. All optional because the
 * standalone dev-server.ts (used for e2e tests) never runs requireAuth. */
export interface FinanceAuthVars {
  repId?: string;
  companyId?: string;
  role?: string;
  isSuperAdmin?: boolean;
}

/**
 * Real auth first: if requireAuth populated c.var.companyId (the live-app
 * mount path), use the real session — companyId as tenant_id, the CRM role
 * string mapped through config/finance/role-map.json. Otherwise falls back
 * to query params (the standalone dev-server.ts path, used only for
 * Playwright e2e tests that don't need a real login).
 */
export function readPageArgs(c: {
  req: { query: (k: string) => string | undefined };
  var: FinanceAuthVars;
}): PageArgs {
  const vocab = (c.req.query("vocab") as VocabularyMode) ?? DEFAULT_VOCABULARY_MODE;

  if (c.var.companyId) {
    return {
      tenant_id: c.var.companyId,
      role: resolveFinanceRole(c.var.role, !!c.var.isSuperAdmin),
      vocab,
    };
  }

  return {
    tenant_id: c.req.query("tenant_id") ?? "",
    role: (c.req.query("role") as Role) ?? "crew",
    vocab,
  };
}

export const Term: FC<{ term: string; vocab: VocabularyMode }> = ({ term, vocab }) => (
  <>{translateTerm(term, vocab)}</>
);

// ── Financial section information architecture ───────────────────────────────
// The 8-item top-level shape confirmed 2026-08-06, matching gwFinancial()'s
// tab strip in public/js/app_premium.js exactly (same labels, same order,
// same /finance/* hrefs) so navigating in from the CRM's own sidebar reads
// as continuing the same tab row rather than leaving into a different app.
// Setup & Config rides along as a 9th, visually separated item — not part
// of the confirmed 8, but the only path to Company Policy / config editing,
// so dropping it isn't an option.
//
// Collections, Obligations, Reconciliation, and Forecast are deliberately
// NOT here — no top-level slot exists for them in the confirmed shape.
// They're reachable as drill-through links FROM Money Loop (Reconciliation,
// Forecast — "how are we tracking") and Work Queue (Collections,
// Obligations — "what needs doing"); see the fin-note blocks in
// money-loop.tsx and queue.tsx. Invoices/Payments/Deposits/Statements'
// old external SPA links are also gone — Invoices & Payments and Ledger
// (both real pages now) absorb them, honestly, per those pages' own notes
// about Deposits/Statements having no D1 table yet.
export interface FinanceNavItem {
  key: string;
  label: string;
  href: string;
}

export const FINANCE_NAV: FinanceNavItem[] = [
  { key: "finControl",  label: "Money Loop",          href: "/finance/money-loop" },
  { key: "finQueue",    label: "Work Queue",          href: "/finance/queue" },
  { key: "finJobCost",  label: "Job Costing",         href: "/finance/job-costing" },
  { key: "finBudget",   label: "Budget & Rates",      href: "/finance/budget" },
  { key: "finRecovery", label: "Overhead Recovery",   href: "/finance/recovery" },
  { key: "finInvPay",   label: "Invoices & Payments", href: "/finance/invoices-payments" },
  { key: "finLedger",   label: "Ledger",              href: "/finance/ledger" },
  { key: "finDocuments", label: "Documents",          href: "/finance/documents" },
];

const FINANCE_NAV_CONFIG: FinanceNavItem = { key: "finConfig", label: "Setup & Config", href: "/finance/config" };

// Design tokens mirror public/js/premium.css so finance pages read as part of
// the same product rather than a separate app. Kept self-contained (rather
// than linking premium.css) because that sheet targets the SPA's DOM shape;
// duplicating only the tokens gives identical color and spacing without
// inheriting rules that assume the SPA shell exists around them.
const SHELL_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
--gw-pine:#113931;--gw-pine-deep:#0E372F;--gw-pine-light:#1A4740;--gw-pine-muted:#4D8A86;
--gw-emerald:#2D7A55;--gw-sky:#4D8A86;--gw-sky-soft:#E5F0EF;--gw-amber:#8B6914;--gw-rose:#8B3A2A;
--gw-ink:#0F1C14;--gw-ink-2:#1E3326;--gw-muted:#5A6B79;--gw-subtle:#6F7E6A;
--gw-line:#E2EBE8;--gw-line-strong:#C8D8D3;
--gw-bg:#F5F9F7;--gw-surface:#FFFFFF;--gw-surface-2:#FDFCF9;--gw-surface-3:#EAF1EE;
--gw-shadow-xs:0 1px 3px rgba(15,28,20,.06);--gw-shadow-sm:0 4px 12px rgba(15,28,20,.07);
--gw-shadow-md:0 8px 28px rgba(15,28,20,.09);
--gw-r-sm:10px;--gw-r-md:14px;--gw-r-lg:18px;
}
body{background:var(--gw-bg);color:var(--gw-ink);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.fin-shell{display:flex;flex-direction:column;min-height:100vh}
/* Top tab-strip — replaces the old vertical sidebar. Colors copied verbatim
   from the CRM SPA's own .nav-subtab / .nav-subtab--active (public/js/
   premium.css) rather than approximated, so navigating in from the CRM's
   own Financial tab strip (gwFinancial() in app_premium.js, same 8 items,
   same order) reads as continuing the same tab row — even though this is
   still a real page load, not a shared DOM (see layout.tsx's own note on
   that ceiling). */
.fin-topbar{background:var(--gw-pine);display:flex;align-items:center;gap:16px;padding:0 20px;position:sticky;top:0;z-index:6;overflow-x:auto}
.fin-crumb{flex-shrink:0;font-size:12px;font-weight:600;color:rgba(255,255,255,.62);padding:12px 0;white-space:nowrap}
.fin-crumb:hover{color:#fff}
.fin-toptabs{display:flex;align-items:center;gap:2px;flex:1;min-width:0}
.fin-toptab{display:flex;align-items:center;padding:9px 12px;font-size:13px;font-weight:400;color:rgba(255,255,255,.52);border-radius:6px;white-space:nowrap;position:relative;transition:color .11s,background .11s}
.fin-toptab:hover{color:rgba(255,255,255,.86);background:rgba(255,255,255,.07)}
.fin-toptab.is-active{color:#fff;font-weight:500;background:rgba(52,211,153,.13);padding-left:17px}
.fin-toptab.is-active::before{content:'';position:absolute;left:7px;top:50%;transform:translateY(-50%);width:4px;height:4px;border-radius:50%;background:#34d399}
.fin-toptab-divider{width:1px;height:16px;background:rgba(255,255,255,.15);margin:0 4px;flex-shrink:0}
.fin-main{flex:1;min-width:0;display:flex;flex-direction:column}
/* Not sticky (unlike .fin-topbar): stacking two independently-sticky
   headers needs a manual top offset matched to the first one's height,
   which is more fragile than it's worth here — only the tab-strip stays
   pinned, this scrolls with the page. */
.fin-top{background:var(--gw-surface);border-bottom:1px solid var(--gw-line);padding:14px 28px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.fin-top-l{min-width:0}
.fin-eyebrow{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--gw-pine-muted)}
.fin-title{font-size:19px;font-weight:800;letter-spacing:-.02em;margin-top:1px}
.fin-top-r{display:flex;align-items:center;gap:10px;flex-shrink:0}
.fin-chip{font-size:11.5px;padding:5px 10px;border-radius:999px;background:var(--gw-surface-3);color:var(--gw-ink-2);font-weight:600;white-space:nowrap}
.fin-toggle{display:inline-flex;background:var(--gw-surface-3);border-radius:999px;padding:2px}
.fin-toggle a{font-size:11.5px;font-weight:700;padding:4px 11px;border-radius:999px;color:var(--gw-muted)}
.fin-toggle a.on{background:var(--gw-surface);color:var(--gw-ink);box-shadow:var(--gw-shadow-xs)}
.fin-body{padding:24px 28px 56px;max-width:1280px;width:100%}
.fin-card{background:var(--gw-surface);border:1px solid var(--gw-line);border-radius:var(--gw-r-md);box-shadow:var(--gw-shadow-xs);padding:18px 20px;margin-bottom:18px}
.fin-card-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}
.fin-card-t{font-size:14px;font-weight:800;letter-spacing:-.01em}
.fin-card-s{font-size:12px;color:var(--gw-muted)}
.fin-grid{display:grid;gap:14px;margin-bottom:18px}
.fin-grid-5{grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
.fin-grid-3{grid-template-columns:repeat(auto-fit,minmax(232px,1fr))}
.fin-tile{background:var(--gw-surface);border:1px solid var(--gw-line);border-radius:var(--gw-r-md);padding:16px 18px;box-shadow:var(--gw-shadow-xs);display:block}
a.fin-tile:hover{border-color:var(--gw-sky);box-shadow:var(--gw-shadow-sm)}
.fin-tile-l{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--gw-muted)}
.fin-tile-v{font-size:28px;font-weight:800;letter-spacing:-.03em;margin-top:7px;line-height:1.1}
.fin-tile-m{font-size:11.5px;color:var(--gw-subtle);margin-top:5px}
.fin-hero{background:linear-gradient(135deg,var(--gw-pine) 0%,#17493F 100%);color:#fff;border-radius:var(--gw-r-lg);padding:26px 28px;margin-bottom:20px;box-shadow:var(--gw-shadow-md)}
.fin-hero-l{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.62)}
.fin-hero-v{font-size:42px;font-weight:800;letter-spacing:-.035em;margin-top:6px;line-height:1.05}
.fin-hero-s{font-size:13.5px;color:rgba(255,255,255,.8);margin-top:9px;max-width:62ch}
.fin-meter{height:9px;background:rgba(255,255,255,.16);border-radius:999px;margin-top:18px;overflow:hidden}
.fin-meter-f{height:100%;background:linear-gradient(90deg,#5FBF8F,#8FD9AE);border-radius:999px}
.fin-table{width:100%;border-collapse:collapse;font-size:13px}
.fin-table th{text-align:left;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--gw-muted);padding:0 12px 9px;border-bottom:1px solid var(--gw-line)}
.fin-table td{padding:11px 12px;border-bottom:1px solid var(--gw-line)}
.fin-table tr:last-child td{border-bottom:0}
.fin-table tbody tr:hover{background:var(--gw-surface-2)}
.fin-num{font-variant-numeric:tabular-nums;font-weight:700}
.fin-badge{display:inline-block;font-size:10.5px;font-weight:800;padding:3px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.05em}
.b-high{background:#DCF2E6;color:#1B5E3A}
.b-med{background:#FBF0D9;color:#6E5210}
.b-low{background:#F7E2DD;color:#7A2E20}
.b-ai{background:var(--gw-sky-soft);color:#2C5F5C}
.b-human{background:var(--gw-surface-3);color:var(--gw-ink-2)}
.fin-empty{text-align:center;padding:34px 20px;color:var(--gw-muted)}
.fin-empty-t{font-size:14px;font-weight:700;color:var(--gw-ink-2);margin-bottom:5px}
.fin-empty-s{font-size:12.5px;max-width:46ch;margin:0 auto}
.fin-note{background:var(--gw-sky-soft);border-left:3px solid var(--gw-sky);border-radius:0 var(--gw-r-sm) var(--gw-r-sm) 0;padding:12px 15px;font-size:12.5px;color:var(--gw-ink-2);margin-bottom:18px}
.fin-lane{border:1px solid var(--gw-line);border-radius:var(--gw-r-sm);overflow:hidden;background:var(--gw-surface)}
.fin-lane-h{background:var(--gw-surface-3);padding:9px 14px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--gw-ink-2);display:flex;justify-content:space-between}
.fin-lane ul{list-style:none}
.fin-lane li{padding:10px 14px;border-bottom:1px solid var(--gw-line);font-size:12.5px}
.fin-lane li:last-child{border-bottom:0}
.fin-lane-empty{padding:16px 14px;font-size:12px;color:var(--gw-subtle);text-align:center}
.fin-why{margin-top:12px;border-top:1px dashed var(--gw-line-strong);padding-top:12px}
.fin-why summary{cursor:pointer;font-size:12px;font-weight:700;color:var(--gw-sky);list-style:none}
.fin-why summary::-webkit-details-marker{display:none}
.fin-why-b{margin-top:9px;font-size:12.5px;color:var(--gw-ink-2);line-height:1.62}
.fin-why-b dt{font-weight:800;color:var(--gw-ink);margin-top:8px;font-size:11.5px}
@media(max-width:860px){
.fin-body{padding:16px 14px 40px}
.fin-top{padding:12px 16px}
.fin-hero-v{font-size:33px}
}
`;

/** The slim top tab-strip — replaces the old vertical Sidebar. Horizontally
 * scrollable rather than wrapping/collapsing (see .fin-topbar's
 * overflow-x:auto) so it stays a single row at any width, same as the CRM
 * SPA's own tab strips never wrap either. */
const Topbar: FC<{ active?: string }> = ({ active }) => (
  <header class="fin-topbar">
    <a class="fin-crumb" href="/">&#8592; Groundwork</a>
    <nav class="fin-toptabs">
      {FINANCE_NAV.map((item) => (
        <a class={`fin-toptab${item.key === active ? " is-active" : ""}`} href={item.href}>
          {item.label}
        </a>
      ))}
      <span class="fin-toptab-divider" />
      <a
        class={`fin-toptab${FINANCE_NAV_CONFIG.key === active ? " is-active" : ""}`}
        href={FINANCE_NAV_CONFIG.href}
      >
        {FINANCE_NAV_CONFIG.label}
      </a>
    </nav>
  </header>
);

/**
 * The finance app shell. Every /finance/* page renders through this, which
 * is what makes them read as part of Groundwork rather than as standalone
 * routes: same tokens, same tab-strip language (copied from the CRM SPA's
 * own .nav-subtab, see Topbar/SHELL_CSS above), same header treatment,
 * plus a way back into the CRM.
 *
 * NOT a shared, persistent nav with the CRM SPA — that would need either
 * turning these pages into SPA-fetched partials or duplicating the SPA's
 * full chrome into every Hono response, both bigger than this build.
 * What's here instead: matching visual language + tab continuity, so the
 * transition *feels* continuous even though it's still a real page load.
 *
 * `title` stays the only required prop so every existing page keeps working
 * unchanged; `active`, `eyebrow`, `tenant`, `role` and `vocab` are optional
 * enrichments a page passes to light up its nav row and header chips.
 */
export const Page: FC<{
  title: string;
  children: unknown;
  active?: string;
  eyebrow?: string;
  tenant?: string;
  role?: string;
  vocab?: VocabularyMode;
}> = ({ title, children, active, eyebrow, tenant, role, vocab }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · Groundwork Financial</title>
      <style>{raw(SHELL_CSS)}</style>
    </head>
    <body>
      <div class="fin-shell">
        <Topbar active={active} />
        <div class="fin-main">
          <header class="fin-top">
            <div class="fin-top-l">
              <div class="fin-eyebrow">{eyebrow ?? "Financial"}</div>
              <h1 class="fin-title">{title}</h1>
            </div>
            <div class="fin-top-r">
              {tenant ? <span class="fin-chip">{tenant}</span> : null}
              {role ? <span class="fin-chip">{role}</span> : null}
              {vocab ? (
                <span class="fin-toggle">
                  <a class={vocab === "simple" ? "on" : ""} href="?vocab=simple">Simple</a>
                  <a class={vocab === "advanced" ? "on" : ""} href="?vocab=advanced">Advanced</a>
                </span>
              ) : null}
            </div>
          </header>
          <main class="fin-body">{children as never}</main>
        </div>
      </div>
    </body>
  </html>
);

// ── shared presentational primitives ─────────────────────────────────────────

export const Card: FC<{ title?: string; sub?: string; children: unknown }> = ({ title, sub, children }) => (
  <section class="fin-card">
    {title ? (
      <div class="fin-card-h">
        <h2 class="fin-card-t">{title}</h2>
        {sub ? <span class="fin-card-s">{sub}</span> : null}
      </div>
    ) : null}
    {children as never}
  </section>
);

export const Empty: FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div class="fin-empty">
    <div class="fin-empty-t">{title}</div>
    {hint ? <div class="fin-empty-s">{hint}</div> : null}
  </div>
);

/** Confidence is a first-class citizen per CLAUDE.md — it must render, not
 * merely travel in the payload. */
export const Confidence: FC<{ level: string }> = ({ level }) => (
  <span class={`fin-badge ${level === "high" ? "b-high" : level === "medium" ? "b-med" : "b-low"}`}>
    {level}
  </span>
);

/**
 * In-context literacy surface — the first step of the "teach on the number,
 * in their own figures" layer. Four fields, always: what it is, where it
 * came from, why it matters, what moves it. Collapsed by default so it
 * never competes with the number itself.
 */
export const Why: FC<{ what: string; source: string; matters: string; moves: string }> = ({
  what, source, matters, moves,
}) => (
  <details class="fin-why">
    <summary>What does this mean?</summary>
    <dl class="fin-why-b">
      <dt>What it is</dt><dd>{what}</dd>
      <dt>Where it comes from</dt><dd>{source}</dd>
      <dt>Why it matters</dt><dd>{matters}</dd>
      <dt>What moves it</dt><dd>{moves}</dd>
    </dl>
  </details>
);

export const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
