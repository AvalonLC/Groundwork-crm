import fs from "node:fs";
import { execSync } from "node:child_process";
const wave = Number(process.argv[2]);
const t = JSON.parse(fs.readFileSync("tasks.json", "utf8"));
const tags = execSync("git tag", { encoding: "utf8" }).split("\n");
const need = t.waves.filter(w => w.id < wave).map(w => `wave-${w.id}-green`);
const missing = need.filter(tag => !tags.includes(tag));
if (missing.length) { console.error(`BLOCKED: missing ${missing.join(", ")}`); process.exit(1); }
console.log(`wave ${wave}: dependencies green`);
