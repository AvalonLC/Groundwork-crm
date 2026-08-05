// Hard scope enforcement. Run INSIDE the agent's worktree after it finishes.
// Compares files actually changed on the branch against the task's files_owned.
import fs from "node:fs";
import { execSync } from "node:child_process";

const id = process.argv[2];
const root = process.argv[3] ?? ".";
const t = JSON.parse(fs.readFileSync(`${root}/tasks.json`, "utf8"));
const task = t.tasks.find(x => x.id === id);
if (!task) { console.error(`unknown task ${id}`); process.exit(1); }

// Incidental files an agent may legitimately touch in any task.
const ALLOW = new Set(["package-lock.json", ".agent-protected"]);
const allowPrefix = ["BLOCKED-", "logs/"];

let changed = [];
try {
  changed = execSync("git diff --name-only main...HEAD", { encoding: "utf8" })
    .split("\n").map(s => s.trim()).filter(Boolean);
} catch {
  console.error("SCOPE: cannot diff against main"); process.exit(1);
}

const owned = new Set(task.files_owned);
const violations = changed.filter(f =>
  !owned.has(f) && !ALLOW.has(f) && !allowPrefix.some(p => f.startsWith(p))
);

// Protected files are an absolute stop, even if somehow declared.
let protectedHits = [];
const protFile = `${root}/.agent-protected`;
if (fs.existsSync(protFile)) {
  const prot = fs.readFileSync(protFile, "utf8").split("\n")
    .map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  protectedHits = changed.filter(f => prot.includes(f));
}

if (protectedHits.length) {
  console.error(`SCOPE VIOLATION (protected): ${protectedHits.join(", ")}`);
  process.exit(1);
}
if (violations.length) {
  console.error(`SCOPE VIOLATION — ${id} edited files it does not own:`);
  violations.forEach(f => console.error("  " + f));
  console.error(`  owned: ${task.files_owned.join(", ")}`);
  process.exit(1);
}
console.log(`scope ok: ${id} touched ${changed.length} file(s), all owned`);
