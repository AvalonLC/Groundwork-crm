/**
 * What lives on the Hono context across this app.
 *
 * Augmenting ContextVariableMap rather than threading a generic through every
 * signature, because these variables are set by middleware and read in files
 * that never see the app's type — src/portal.tsx takes `Hono<any>`, so `c.var`
 * had no shape there at all and every `c.var.repId` was an error the moment
 * anything type-checked it. Nothing did until src/index.tsx joined the gate.
 *
 * Declaring them here also makes the set side checked: `c.set('portalScope', x)`
 * with a typo in the key used to be silent, and every reader would have got
 * undefined forever.
 */
import type { PortalScope } from './portal';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by requireAuth (src/index.tsx). */
    repId: string;
    companyId: string;
    role: string;
    isSuperAdmin: boolean;
    /** Migration 0074 — see requireAuth. */
    canViewCompensation: boolean;
    /** Set by requirePortalAuth (src/portal.tsx). */
    portalScope: PortalScope;
  }
}
