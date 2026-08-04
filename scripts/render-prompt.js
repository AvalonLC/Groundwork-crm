import fs from "node:fs";
const id = process.argv[2];
const t = JSON.parse(fs.readFileSync("tasks.json", "utf8"));
const k = t.tasks.find(x => x.id === id);
if (!k) { console.error(`unknown task ${id}`); process.exit(1); }
const fx = k.fixture_key
  ? JSON.stringify(JSON.parse(fs.readFileSync(t.fixtures, "utf8"))[k.fixture_key], null, 2)
  : "(none — behavioural task, write tests from spec_ref)";

console.log(`TASK ${k.id} — ${k.title}

Read CLAUDE.md first. It is binding. Then read ${k.spec_ref ?? "(no spec ref)"}.

FILES YOU MAY EDIT (nothing else, ever):
${k.files_owned.map(f => "  " + f).join("\n")}
${k.files_readonly?.length ? `\nREAD-ONLY (never modify):\n${k.files_readonly.map(f => "  " + f).join("\n")}` : ""}

FIXTURE — this is a TEST, not an example. It must pass to the cent:
${fx}

GATE — done means this command exits 0. Your opinion does not count:
  ${k.gate}
${k.gate_must_include?.length ? `  These test IDs must actually run: ${k.gate_must_include.join(", ")}` : ""}

FORBIDDEN:
${(k.forbidden ?? ["(none beyond CLAUDE.md)"]).map(f => "  - " + f).join("\n")}

PROCEDURE:
  1. Write the failing test first.
  2. Implement until the gate exits 0.
  3. Commit exactly once: [${k.id}] <what changed>
  4. Max ${k.max_attempts} attempts. If still failing:
     ${k.on_fail ?? `write BLOCKED-${k.id}.md with the failing assertion and STOP`}
     Do NOT invent a workaround. Do NOT delete or skip a test. Do NOT widen scope.
`);
