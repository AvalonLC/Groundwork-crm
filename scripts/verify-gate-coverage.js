// Fails if a required test ID never actually RAN (agent deleted or renamed it).
import fs from "node:fs";
const id = process.argv[2];
const t = JSON.parse(fs.readFileSync("tasks.json", "utf8"));
const task = t.tasks.find(x => x.id === id);
const must = task?.gate_must_include ?? [];
if (!must.length) process.exit(0);
if (!fs.existsSync("test-results.json")) { console.error("no test-results.json"); process.exit(1); }
const res = JSON.parse(fs.readFileSync("test-results.json", "utf8"));
const names = JSON.stringify(res);
const absent = must.filter(m => !names.includes(m));
if (absent.length) { console.error(`GATE COVERAGE FAIL: ${absent.join(", ")} did not run`); process.exit(1); }
console.log(`gate coverage ok: ${must.join(", ")}`);
