import fs from "node:fs";
const wave = Number(process.argv[2]);
const t = JSON.parse(fs.readFileSync("tasks.json", "utf8"));
const w = t.waves.find(x => x.id === wave);
if (!w) { console.error(`no wave ${wave}`); process.exit(1); }
const ids = t.tasks.filter(x => x.wave === wave).map(x => x.id);
// PLAN=pro throttles parallelism to survive Claude Pro usage limits.
const cap = process.env.PLAN === "pro"
  ? (w.max_agents_pro ?? 1)
  : w.max_agents;
console.log(ids.slice(0, w.parallel ? cap : 1).join("\n"));
