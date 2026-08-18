/**
 * The Worker's environment, declared once.
 *
 * src/index.tsx owned these and src/portal.tsx could not import them without a
 * cycle (index imports portal), so portal took `Hono<any>` and re-guessed the
 * shape. That is why `c.env.DB` was `unknown` there and every `c.var.repId` was
 * an error the moment the file was type-checked at all.
 *
 * A leaf module both sides import breaks the cycle and makes the two views of
 * the environment the same view by construction, rather than by two lists that
 * happen to agree today.
 */

export type Bindings = {
  DB: D1Database
  MEDIA: R2Bucket
  CRON_SECRET?: string
  SENDGRID_API_KEY?: string
  STRIPE_SECRET_KEY?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

/** Set by requireAuth. See also the ContextVariableMap augmentation in hono-env.d.ts. */
export type Variables = {
  repId: string
  companyId: string
  role: string
  isSuperAdmin: boolean
  /** Migration 0074. */
  canViewCompensation: boolean
}

export type AppEnv = { Bindings: Bindings; Variables: Variables }
