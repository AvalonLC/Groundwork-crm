import fs from "node:fs";
const t = JSON.parse(fs.readFileSync("tasks.json","utf8"));
const missing = t.tasks.filter(k => k.spec_ref && !fs.existsSync(k.spec_ref))
                       .map(k => `${k.id} -> ${k.spec_ref}`);
if (missing.length) { console.error("missing spec_ref files:\n" + missing.join("\n")); process.exit(1); }
const stubs = t.tasks.filter(k => k.spec_ref && fs.existsSync(k.spec_ref) &&
                fs.readFileSync(k.spec_ref,"utf8").includes("TODO: paste"))
              .map(k => `${k.id} -> ${k.spec_ref}`);
console.log(`spec_refs: all present. ${stubs.length} still stubs:`);
stubs.forEach(s => console.log("  STUB " + s));
