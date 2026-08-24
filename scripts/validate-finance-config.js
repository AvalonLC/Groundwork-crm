// Validates config/finance/*.json against the same structural checks
// src/config/finance-config-runtime.ts's validateConfigShape() applies to
// an admin-submitted override — run this after hand-editing any of these
// files directly (instead of through /finance/config, which validates on
// save automatically) to catch a broken edit before it ships. Also runs in
// CI (.github/workflows/ci.yml).
import fs from "node:fs";
import path from "node:path";

const DIR = "config/finance";
const bad = [];

function requireArray(obj, key, file) {
  if (!Array.isArray(obj[key])) bad.push(`${file}: "${key}" must be an array`);
}
function requireObject(obj, key, file) {
  if (typeof obj[key] !== "object" || obj[key] === null) bad.push(`${file}: "${key}" must be an object`);
}
function requireString(obj, key, file) {
  if (typeof obj[key] !== "string") bad.push(`${file}: "${key}" must be a string`);
}

const CHECKS = {
  "classifier.rules.json": (obj, file) => {
    requireArray(obj, "categories", file);
    requireArray(obj, "stage1_vendor_patterns", file);
    requireArray(obj, "stage2_keyword_rules", file);
    requireArray(obj, "stage3_amount_review_rules", file);
    requireArray(obj, "forced_review_categories", file);
    requireObject(obj, "confidence_thresholds", file);
    const categoryIds = new Set((obj.categories ?? []).map((c) => c.id));
    for (const rule of obj.stage1_vendor_patterns ?? []) {
      try { new RegExp(rule.pattern, "i"); }
      catch (e) { bad.push(`${file}: stage1 rule "${rule.id}" has an invalid regex pattern: ${e.message}`); }
      if (!categoryIds.has(rule.category)) bad.push(`${file}: stage1 rule "${rule.id}" references unknown category "${rule.category}"`);
    }
    for (const rule of obj.stage2_keyword_rules ?? []) {
      if (!categoryIds.has(rule.category)) bad.push(`${file}: stage2 rule "${rule.id}" references unknown category "${rule.category}"`);
    }
    for (const cat of obj.forced_review_categories ?? []) {
      if (!categoryIds.has(cat)) bad.push(`${file}: forced_review_categories entry "${cat}" is not a defined category`);
    }
  },
  "ingest.sources.json": (obj, file) => {
    requireArray(obj, "sources", file);
    requireObject(obj, "fallback", file);
    for (const source of obj.sources ?? []) {
      if (!Array.isArray(source.detect?.required_headers)) {
        bad.push(`${file}: source "${source.id}" must have a detect.required_headers array`);
        continue;
      }
      // csv sources detect off the header row, so they need at least one
      // required header or every upload would match. xlsx sources detect
      // off file type + `shape` instead (see src/ai/ingest.ts's
      // detectSource) — an empty array there is intentional, not a typo.
      if (source.format === "csv" && source.detect.required_headers.length === 0) {
        bad.push(`${file}: csv source "${source.id}" must have a non-empty detect.required_headers array`);
      }
      if (source.format === "xlsx" && !source.shape) {
        bad.push(`${file}: xlsx source "${source.id}" must set a "shape"`);
      }
    }
  },
  "division-map.json": (obj, file) => {
    requireArray(obj, "canonical_divisions", file);
    requireObject(obj, "aliases", file);
  },
  "role-map.json": (obj, file) => {
    requireObject(obj, "crm_role_to_finance_role", file);
    requireString(obj, "default_finance_role", file);
    requireString(obj, "super_admin_finance_role", file);
    const VALID_ROLES = ["crew", "crew_lead", "office", "owner"];
    for (const [crmRole, financeRole] of Object.entries(obj.crm_role_to_finance_role ?? {})) {
      if (!VALID_ROLES.includes(financeRole)) {
        bad.push(`${file}: "${crmRole}" maps to "${financeRole}", not one of ${VALID_ROLES.join("|")}`);
      }
    }
  },
  "document-intake.json": (obj, file) => {
    requireObject(obj, "channels", file);
    requireArray(obj, "accepted_mime_types", file);
    requireArray(obj, "accepted_extensions", file);
    if (typeof obj.max_file_size_bytes !== "number") bad.push(`${file}: "max_file_size_bytes" must be a number`);
  },
  // Flat config bags — no structural requirements beyond valid JSON.
  "automation-policy.json": () => {},
  "approval-thresholds.json": () => {},
  "tenant-defaults.json": () => {},
};

for (const [file, check] of Object.entries(CHECKS)) {
  const filePath = path.join(DIR, file);
  if (!fs.existsSync(filePath)) { bad.push(`${filePath}: file is missing`); continue; }
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    bad.push(`${filePath}: invalid JSON — ${e.message}`);
    continue;
  }
  check(obj, filePath);
}

if (bad.length) { console.error("FINANCE CONFIG VALIDATION FAILED:\n" + bad.join("\n")); process.exit(1); }
console.log(`finance config ok: ${Object.keys(CHECKS).length} files validated`);
