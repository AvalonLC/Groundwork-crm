// Shared MSW/Cloudflare outbound-request mock — see Cloudflare's own docs:
// https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/
//
// setupNetwork() intercepts fetch() calls made FROM inside the workerd
// runtime (not just from the vitest/node host process) — this is the only
// documented way to stub an upstream HTTP call made by a route under test
// with @cloudflare/vitest-pool-workers. Used by src/ai/lead-import-routes.test.ts
// to exercise the AI-call-succeeds branch of POST /:id/extract without ever
// making a real OpenAI request.
import { setupNetwork } from "@msw/cloudflare";

export const network = setupNetwork();
