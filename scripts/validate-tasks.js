import fs from "node:fs";
const t = JSON.parse(fs.readFileSync("tasks.json","utf8"));
const ids = new Set(t.tasks.map(x=>x.id));
const bad = t.tasks.flatMap(x => (x.deps??[]).filter(d=>!ids.has(d)).map(d=>`${x.id} -> ${d}`));
const owned = {};
for (const x of t.tasks) for (const f of x.files_owned) {
  if (owned[f]) bad.push(`FILE COLLISION ${f}: ${owned[f]} and ${x.id}`);
  owned[f] = x.id;
}
for (const x of t.tasks) if (!x.gate) bad.push(`${x.id} has no gate`);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log(`ok: ${t.tasks.length} tasks, ${Object.keys(owned).length} owned files, no collisions`);
