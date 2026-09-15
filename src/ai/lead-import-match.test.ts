/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import {
  findClientMatches, findPropertyMatches,
  type ExistingClientRow, type ExistingPropertyRow,
} from "./lead-import-match";

const client = (over: Partial<ExistingClientRow>): ExistingClientRow => ({
  id: "cli_1", name: "", phone: "", email: "", address: "", type: "Commercial", ...over,
});

const property = (over: Partial<ExistingPropertyRow>): ExistingPropertyRow => ({
  id: "prop_1", client_id: "cli_1", label: "Primary", street: "", street2: "", city: "", state: "", zip: "", ...over,
});

// ── findClientMatches — deterministic email/phone, fuzzy name/address ──────

describe("findClientMatches", () => {
  it("MATCH-01 an exact email match is deterministic, regardless of casing/whitespace", () => {
    const existing = [client({ id: "cli_1", email: "  Jane@Example.com " })];
    const hits = findClientMatches({ email: "jane@example.com" }, existing);
    expect(hits).toHaveLength(1);
    expect(hits[0].strength).toBe("deterministic");
    expect(hits[0].basis).toContain("email");
  });

  it("MATCH-02 an exact phone match is deterministic, regardless of formatting", () => {
    const existing = [client({ id: "cli_1", phone: "(555) 123-4567" })];
    const hits = findClientMatches({ phone: "555.123.4567" }, existing);
    expect(hits).toHaveLength(1);
    expect(hits[0].strength).toBe("deterministic");
    expect(hits[0].basis).toContain("phone");
  });

  it("MATCH-03 a short/garbage phone value never matches every phone-less client (no false-positive on empty vs empty)", () => {
    const existing = [client({ id: "cli_1", phone: "" }), client({ id: "cli_2", phone: "123" })];
    const hits = findClientMatches({ phone: "" }, existing);
    expect(hits).toHaveLength(0);
    const hits2 = findClientMatches({ phone: "123" }, existing);
    expect(hits2).toHaveLength(0); // both sides too short to count as a real phone match
  });

  it("MATCH-04 a company-name-only match is a fuzzy suggestion, never deterministic", () => {
    const existing = [client({ id: "cli_1", name: "Yorktowne Property Management" })];
    const hits = findClientMatches({ companyName: "Yorktowne Property Management" }, existing);
    expect(hits).toHaveLength(1);
    expect(hits[0].strength).toBe("fuzzy_suggestion");
    expect(hits[0].basis).toEqual(["company_name"]);
  });

  it("MATCH-05 a person-name-only match is a fuzzy suggestion, never deterministic", () => {
    const existing = [client({ id: "cli_1", name: "John Smith" })];
    const hits = findClientMatches({ personName: "John Smith" }, existing);
    expect(hits[0].strength).toBe("fuzzy_suggestion");
    expect(hits[0].basis).toEqual(["person_name"]);
  });

  it("MATCH-06 an address-only match is a fuzzy suggestion, never deterministic", () => {
    const existing = [client({ id: "cli_1", address: "123 Main St" })];
    const hits = findClientMatches({ address: "123 Main St" }, existing);
    expect(hits[0].strength).toBe("fuzzy_suggestion");
    expect(hits[0].basis).toEqual(["address"]);
  });

  it("MATCH-07 an email match upgrades the candidate to deterministic even when other fields also happen to match", () => {
    const existing = [client({ id: "cli_1", email: "jane@example.com", name: "Jane Doe", address: "123 Main St" })];
    const hits = findClientMatches({ email: "jane@example.com", personName: "Jane Doe", address: "123 Main St" }, existing);
    expect(hits[0].strength).toBe("deterministic");
    expect(hits[0].basis).toEqual(expect.arrayContaining(["email", "person_name", "address"]));
  });

  it("MATCH-08 deterministic candidates are always sorted before fuzzy ones", () => {
    const existing = [
      client({ id: "cli_fuzzy", name: "John Smith" }),
      client({ id: "cli_det", email: "match@example.com" }),
    ];
    const hits = findClientMatches({ personName: "John Smith", email: "match@example.com" }, existing);
    expect(hits[0].client.id).toBe("cli_det");
    expect(hits[0].strength).toBe("deterministic");
    expect(hits[1].client.id).toBe("cli_fuzzy");
    expect(hits[1].strength).toBe("fuzzy_suggestion");
  });

  it("MATCH-09 a client that matches nothing at all is excluded entirely, not returned as a zero-confidence candidate", () => {
    const existing = [client({ id: "cli_1", name: "Nobody Related", phone: "999-999-9999", email: "unrelated@x.com", address: "999 Nowhere Ave" })];
    const hits = findClientMatches({ personName: "Jane Doe", phone: "555-123-4567", email: "jane@example.com", address: "123 Main St" }, existing);
    expect(hits).toHaveLength(0);
  });

  it("MATCH-10 an empty query against real clients matches nothing (never a default/wildcard match)", () => {
    const existing = [client({ id: "cli_1", name: "Jane Doe", phone: "555-123-4567", email: "jane@example.com" })];
    const hits = findClientMatches({}, existing);
    expect(hits).toHaveLength(0);
  });

  it("MATCH-11 never throws on an empty existing-client list", () => {
    expect(() => findClientMatches({ email: "x@y.com" }, [])).not.toThrow();
    expect(findClientMatches({ email: "x@y.com" }, [])).toEqual([]);
  });
});

// ── findPropertyMatches — always fuzzy, optionally client-scoped ───────────

describe("findPropertyMatches", () => {
  it("MATCH-12 an exact structured-address match is returned as a fuzzy_suggestion (properties are never deterministic)", () => {
    const existing = [property({ id: "prop_1", street: "123 Main St", city: "Springfield", state: "IL", zip: "62701" })];
    const hits = findPropertyMatches("123 Main St, Springfield, IL 62701", existing);
    expect(hits).toHaveLength(1);
    expect(hits[0].strength).toBe("fuzzy_suggestion");
    expect(hits[0].property.id).toBe("prop_1");
  });

  it("MATCH-13 tolerates unit/suite noise on either side of the comparison", () => {
    const existing = [property({ id: "prop_1", street: "123 Main St" })];
    const hits = findPropertyMatches("123 Main St Suite 200", existing);
    expect(hits).toHaveLength(1);
  });

  it("MATCH-14 an empty query address matches nothing", () => {
    const existing = [property({ id: "prop_1", street: "123 Main St" })];
    expect(findPropertyMatches("", existing)).toEqual([]);
    expect(findPropertyMatches(null, existing)).toEqual([]);
    expect(findPropertyMatches(undefined, existing)).toEqual([]);
  });

  it("MATCH-15 a property with no address data on file never matches (both sides must be non-empty)", () => {
    const existing = [property({ id: "prop_1", street: "", city: "", state: "", zip: "" })];
    expect(findPropertyMatches("123 Main St", existing)).toEqual([]);
  });

  it("MATCH-16 clientId scoping restricts candidates to that client's own properties", () => {
    const existing = [
      property({ id: "prop_a", client_id: "cli_a", street: "123 Main St" }),
      property({ id: "prop_b", client_id: "cli_b", street: "123 Main St" }),
    ];
    const hits = findPropertyMatches("123 Main St", existing, { clientId: "cli_a" });
    expect(hits).toHaveLength(1);
    expect(hits[0].property.id).toBe("prop_a");
  });

  it("MATCH-17 an unrelated address matches nothing", () => {
    const existing = [property({ id: "prop_1", street: "999 Nowhere Ave" })];
    expect(findPropertyMatches("123 Main St", existing)).toEqual([]);
  });

  it("MATCH-18 never throws on an empty existing-property list", () => {
    expect(() => findPropertyMatches("123 Main St", [])).not.toThrow();
  });
});
