import { describe, it, expect } from "vitest";
import { readPageArgs } from "./layout";

function fakeContext(query: Record<string, string>, vars: Record<string, unknown> = {}) {
  return { req: { query: (k: string) => query[k] }, var: vars } as never;
}

describe("readPageArgs — real auth vs dev-server fallback", () => {
  it("LA-01 real auth path: companyId present maps role through role-map.json", () => {
    const args = readPageArgs(fakeContext({}, { companyId: "company-123", role: "office_manager", isSuperAdmin: false }));
    expect(args.tenant_id).toBe("company-123");
    expect(args.role).toBe("office");
  });

  it("LA-02 real auth path: isSuperAdmin always resolves to owner regardless of role string", () => {
    const args = readPageArgs(fakeContext({}, { companyId: "company-123", role: "laborer", isSuperAdmin: true }));
    expect(args.role).toBe("owner");
  });

  it("LA-03 dev-server fallback: no companyId in vars, falls back to query params", () => {
    const args = readPageArgs(fakeContext({ tenant_id: "t-test", role: "owner", vocab: "advanced" }, {}));
    expect(args.tenant_id).toBe("t-test");
    expect(args.role).toBe("owner");
    expect(args.vocab).toBe("advanced");
  });

  it("LA-04 vocab defaults to simple in either path when not specified", () => {
    const real = readPageArgs(fakeContext({}, { companyId: "c1", role: "admin", isSuperAdmin: false }));
    const dev = readPageArgs(fakeContext({}, {}));
    expect(real.vocab).toBe("simple");
    expect(dev.vocab).toBe("simple");
  });
});
