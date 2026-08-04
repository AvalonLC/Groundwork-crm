import fs from "node:fs";
import { execSync } from "node:child_process";
const wave = Number(process.argv[2]);
const lines = fs.existsSync("status.log") ? fs.readFileSync("status.log","utf8").trim().split("\n") : [];
const pass = lines.filter(l => l.endsWith("PASS")).map(l => l.split(" ")[0]);
const fail = lines.filter(l => l.endsWith("FAIL")).map(l => l.split(" ")[0]);
console.log(`wave ${wave}: ${pass.length} pass, ${fail.length} fail`);
for (const id of pass) {
  try {
    execSync(`git merge --no-ff --no-edit agent/${id}`, { stdio: "inherit" });
    console.log(`merged ${id}`);
  } catch {
    console.error(`CONFLICT on ${id} — stopping. Resolve by hand, then re-run.`);
    process.exit(1);
  }
}
if (fail.length) console.error(`NOT merged (gate failed): ${fail.join(", ")}`);
