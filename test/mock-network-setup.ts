/// <reference types="@cloudflare/vitest-pool-workers" />
// Vitest setupFiles entry pairing with test/network.ts — enables the MSW
// network mock before any test in a file runs, resets handlers registered
// via network.use() after each test (so one test's stub can never leak into
// the next), and tears it down after the whole file finishes. Additive to
// test/apply-migrations.ts, not a replacement — every existing test that
// never calls network.use() is completely unaffected because MSW only
// intercepts requests when a matching handler exists; unmatched requests
// (there are none in this suite's existing tests, since none call fetch())
// would otherwise be a MSW config decision, but no route under test issues
// an unstubbed outbound fetch today.
import { afterAll, afterEach, beforeAll } from "vitest";
import { network } from "./network";

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
