import type { FC } from "hono/jsx";
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

/**
 * True when the request wants a partial (inner-content-only) render — sent
 * only by the CRM SPA's own in-app navigation (public/js/app_premium.js's
 * financeFetch()), never by a direct browser navigation, a bookmark, or any
 * of the existing *.e2e.ts suites (they hit routers via request.get/
 * page.goto, which never set this header). A header rather than a query
 * param specifically so it can't leak into a saved/shared link or get
 * preserved by a redirect a user follows manually.
 */
export function isPartialRequest(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return c.req.header("X-GW-Partial") === "1";
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
//
// The actual CSS lives in public/js/finance-shell.css (moved out of an
// inlined <style> block during the finance-spa-integration work) — /js/* is
// this repo's real static-asset path (see src/index.tsx's own premium.css/
// styles.css/groundwork-design.css links, all under /js/); public/static/*
// is an unused, unwired leftover (nothing in src/index.tsx or dev-server.ts
// serves it — confirmed by grep before choosing /js/ here over the /static/
// path this comment used to suggest).

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
 * own .nav-subtab, see Topbar above / public/js/finance-shell.css), same header treatment,
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
 *
 * `partial`, when true, renders ONLY the `.fin-main` content (the page
 * header + body) — no `<html>/<head>/<body>`, no Topbar, no stylesheet
 * link. This is the CRM SPA's in-app-navigation path (see isPartialRequest
 * above and public/js/app_premium.js's financeFetch()): the SPA's own
 * sidebar takes over Topbar's job, and public/js/finance-shell.css is
 * already linked once in the SPA's own <head> rather than being re-fetched
 * per navigation. Defaults to false so every existing full-page caller
 * (and all pre-existing *.e2e.ts tests, which never set X-GW-Partial)
 * keeps rendering the complete standalone document unchanged.
 */
export const Page: FC<{
  title: string;
  children: unknown;
  active?: string;
  eyebrow?: string;
  tenant?: string;
  role?: string;
  vocab?: VocabularyMode;
  partial?: boolean;
}> = ({ title, children, active, eyebrow, tenant, role, vocab, partial }) => {
  const inner = (
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
  );

  if (partial) return inner;

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} · Groundwork Financial</title>
        <link rel="stylesheet" href="/js/finance-shell.css" />
      </head>
      <body>
        <div class="fin-shell">
          <Topbar active={active} />
          {inner}
        </div>
      </body>
    </html>
  );
};

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
