import type { FC } from "hono/jsx";
import type { Role } from "./roles";
import type { VocabularyMode } from "./vocabulary";
import { translateTerm } from "./vocabulary";

export interface PageArgs {
  tenant_id: string;
  role: Role;
  vocab: VocabularyMode;
}

/** Reads the common query params every Finance OS dev page accepts.
 * See src/ui/dev-server.ts for why this is query-param-based for now. */
export function readPageArgs(c: { req: { query: (k: string) => string | undefined } }): PageArgs {
  return {
    tenant_id: c.req.query("tenant_id") ?? "",
    role: (c.req.query("role") as Role) ?? "crew",
    vocab: (c.req.query("vocab") as VocabularyMode) ?? "simple",
  };
}

export const Term: FC<{ term: string; vocab: VocabularyMode }> = ({ term, vocab }) => (
  <>{translateTerm(term, vocab)}</>
);

export const Page: FC<{ title: string; children: unknown }> = ({ title, children }) => (
  <html>
    <head>
      <meta charset="utf-8" />
      <title>{title}</title>
    </head>
    <body>
      <main>{children as never}</main>
    </body>
  </html>
);
