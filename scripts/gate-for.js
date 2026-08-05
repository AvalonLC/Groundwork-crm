import fs from "node:fs";
const id = process.argv[2];
const t = JSON.parse(fs.readFileSync("tasks.json", "utf8"));
const task = t.tasks.find(x => x.id === id);
if (!task) { console.error(`unknown task ${id}`); process.exit(1); }
console.log(task.gate);
