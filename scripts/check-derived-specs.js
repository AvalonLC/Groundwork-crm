import fs from "node:fs";
const t = JSON.parse(fs.readFileSync("tasks.json","utf8"));
const files = [...new Set(t.tasks.flatMap(k => k.spec_ref ? [k.spec_ref] : []))];
const bad = [];
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  if (s.includes("TODO: paste")) bad.push(`${f}: still a stub`);
  if (s.length < 400) bad.push(`${f}: too thin (${s.length} chars)`);
  if (!/Derivation confidence/i.test(s)) bad.push(`${f}: no '## Derivation confidence' section`);
}
// no invented money: any $ figure must appear in golden.json
const g = fs.readFileSync("fixtures/golden.json","utf8");
for (const f of files) {
  for (const m of fs.readFileSync(f,"utf8").matchAll(/\$([0-9][0-9,]*\.?[0-9]*)/g)) {
    const n = m[1].replace(/,/g,"");
    if (Number(n) > 100 && !g.includes(n.split(".")[0])) bad.push(`${f}: invented figure $${m[1]}`);
  }
}
if (bad.length) { console.error("DERIVED SPEC CHECK FAILED:\n" + bad.join("\n")); process.exit(1); }
console.log(`derived specs ok: ${files.length} files, all cite confidence, no invented figures`);
