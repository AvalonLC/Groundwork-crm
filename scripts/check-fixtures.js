import fs from "node:fs";
const g = JSON.parse(fs.readFileSync("fixtures/golden.json", "utf8"));
const need = ["burden_labor_with_equipment","burden_labor_no_equipment",
              "equipment_rate","overhead_allocation","recovery","tolerance"];
const missing = need.filter(k => !(k in g));
if (missing.length) { console.error("missing fixture keys: " + missing.join(", ")); process.exit(1); }
const on  = g.burden_labor_no_equipment.expect.burdened_rate;
const off = g.burden_labor_with_equipment.expect.burdened_rate;
const delta = off - on;
const expected = 2400 / 1622;
if (Math.abs(delta - expected) > 0.001) {
  console.error(`FIXTURE CORRUPT: delta ${delta.toFixed(4)} != 2400/1622 (${expected.toFixed(4)})`);
  process.exit(1);
}
if (Math.abs(on - 39.49) < 0.01) { console.error("FIXTURE CORRUPT: 39.49 reintroduced"); process.exit(1); }
console.log(`fixtures ok: ${off.toFixed(4)} / ${on.toFixed(4)}, delta ${delta.toFixed(4)}`);
