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
// One list, rendered into the sidebar of every finance page. `href: null`
// means the page is specced but not built yet — it renders as a dimmed
// "soon" row rather than a link, so the intended structure is visible
// without shipping dead links. `external` items live in the main CRM SPA
// and navigate back out to it.
export interface FinanceNavItem {
  key: string;
  label: string;
  href: string | null;
  external?: boolean;
  group: string;
}

export const FINANCE_NAV: FinanceNavItem[] = [
  { key: "control",     label: "Control Center",    href: "/finance/money-loop",  group: "Operate" },
  { key: "queue",       label: "Work Queue",        href: "/finance/queue",       group: "Operate" },
  { key: "collections", label: "Collections",       href: "/finance/collections",   group: "Operate" },
  { key: "obligations", label: "Obligations",       href: "/finance/obligations",   group: "Operate" },
  { key: "recon",       label: "Reconciliation",    href: "/finance/reconciliation", group: "Operate" },

  { key: "jobcost",     label: "Job Costing",       href: "/finance/job-costing", group: "Understand" },
  { key: "recovery",    label: "Overhead Recovery", href: "/finance/recovery",    group: "Understand" },
  { key: "budget",      label: "Budget & Rates",    href: "/finance/budget",      group: "Understand" },
  { key: "forecast",    label: "Forecast",          href: "/finance/forecast",    group: "Understand" },

  { key: "invoices",    label: "Invoices",   href: "/#invoices",   external: true, group: "Records" },
  { key: "payments",    label: "Payments",   href: "/#gwStripe",   external: true, group: "Records" },
  { key: "ledger",      label: "Ledger",     href: "/#payments",   external: true, group: "Records" },
  { key: "statements",  label: "Statements", href: "/#statements", external: true, group: "Records" },
  { key: "documents",   label: "Documents",  href: "/finance/documents",           group: "Records" },

  { key: "config",      label: "Setup & Config", href: "/finance/config", group: "Configure" },
];

const NAV_GROUPS = ["Operate", "Understand", "Records", "Configure"];

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
.fin-shell{display:flex;min-height:100vh}
.fin-side{width:248px;flex:0 0 248px;background:var(--gw-pine);color:#fff;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto}
.fin-brand{padding:18px 18px 14px;border-bottom:1px solid rgba(255,255,255,.09)}
.fin-brand-name{font-size:15px;font-weight:800;letter-spacing:-.01em}
.fin-brand-sub{font-size:11px;color:rgba(255,255,255,.55);margin-top:2px}
.fin-back{display:block;padding:11px 18px;font-size:12.5px;color:rgba(255,255,255,.62);border-bottom:1px solid rgba(255,255,255,.07)}
.fin-back:hover{color:#fff;background:var(--gw-pine-deep)}
.fin-nav{padding:10px 10px 24px;flex:1}
.fin-nav-group{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.38);padding:16px 8px 6px}
.fin-nav-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:8px;font-size:13px;color:rgba(255,255,255,.72);margin-bottom:1px}
.fin-nav-item:hover{background:rgba(255,255,255,.07);color:#fff}
.fin-nav-item.is-active{background:var(--gw-pine-light);color:#fff;font-weight:700;box-shadow:inset 3px 0 0 var(--gw-sky)}
.fin-nav-item.is-soon{color:rgba(255,255,255,.34);cursor:default}
.fin-nav-item.is-soon:hover{background:none;color:rgba(255,255,255,.34)}
.fin-soon-tag{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,.09);color:rgba(255,255,255,.45)}
.fin-ext{font-size:10px;color:rgba(255,255,255,.3)}
.fin-main{flex:1;min-width:0;display:flex;flex-direction:column}
.fin-top{background:var(--gw-surface);border-bottom:1px solid var(--gw-line);padding:14px 28px;display:flex;align-items:center;justify-content:space-between;gap:16px;position:sticky;top:0;z-index:5}
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
.fin-side{display:none}
.fin-body{padding:16px 14px 40px}
.fin-top{padding:12px 16px}
.fin-hero-v{font-size:33px}
}
`;

const Sidebar: FC<{ active?: string }> = ({ active }) => (
  <aside class="fin-side">
    <div class="fin-brand">
      <div class="fin-brand-name">Financial</div>
      <div class="fin-brand-sub">Groundwork Control</div>
    </div>
    <a class="fin-back" href="/">&#8592; Back to Groundwork</a>
    <nav class="fin-nav">
      {NAV_GROUPS.map((group) => (
        <>
          <div class="fin-nav-group">{group}</div>
          {FINANCE_NAV.filter((i) => i.group === group).map((item) =>
            item.href ? (
              <a class={`fin-nav-item${item.key === active ? " is-active" : ""}`} href={item.href}>
                <span>{item.label}</span>
                {item.external ? <span class="fin-ext">&#8599;</span> : null}
              </a>
            ) : (
              <div class="fin-nav-item is-soon">
                <span>{item.label}</span>
                <span class="fin-soon-tag">soon</span>
              </div>
            ),
          )}
        </>
      ))}
    </nav>
  </aside>
);

/**
 * The finance app shell. Every /finance/* page renders through this, which
 * is what makes them read as part of Groundwork rather than as standalone
 * routes: same tokens, same sidebar language, same header treatment, plus a
 * way back into the CRM.
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
        <Sidebar active={active} />
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
