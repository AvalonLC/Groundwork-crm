/* The test runner must actually run the tests.
 *
 * Written after this failed twice in one day, both silently:
 *
 *   tests/pipeline-totals.test.mjs sat in the repo passing 23 assertions that
 *   nothing ever executed, because it was never added to a package.json script.
 *
 *   Three PRs each added a test file and each edited the same test:browser-js
 *   line. GitHub's auto-merge did not raise a conflict — it produced a
 *   package.json with FOUR "test:browser-js" keys. Duplicate keys are legal
 *   JSON and the last one silently wins, so two of the three new test files
 *   stopped running the moment they landed on main. Neither npm nor CI said a
 *   word.
 *
 * Both failures share a shape: a test that exists, passes, and is not run is
 * indistinguishable from one that does not exist — except it looks like
 * coverage. These two assertions make that state loud.
 *
 * Run: node --test tests/test-runner-integrity.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const pkg = JSON.parse(raw);

/**
 * Known orphans, pre-existing and deliberately not adopted here: they belong to
 * the sales-process feature, not to anything this file's author touched, and
 * wiring up another area's tests is that area's call to make. Listed rather than
 * ignored so the debt is visible and someone can decide.
 */
const KNOWN_UNRUN = [
  'sales-process-platform.test.mjs',
  'sales-process-safety.test.mjs',
];

test('TR-01 package.json declares no duplicate script keys', () => {
  // JSON.parse silently keeps only the last of a duplicated key, so this has to
  // read the raw text. This is the exact defect that disabled two test files.
  const seen = new Map();
  const scriptsBlock = raw.slice(raw.indexOf('"scripts"'));
  for (const m of scriptsBlock.matchAll(/^\s*"([^"]+)":/gm)) {
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(
    dupes, [],
    `package.json has duplicate keys: ${dupes.join(', ')}. Duplicate keys are ` +
    `legal JSON and the LAST one silently wins, so whatever the earlier ones ` +
    `declared is quietly discarded. This usually comes from a merge that ` +
    `resolved two branches editing the same line by keeping both.`,
  );
});

test('TR-02 every test file under tests/ is referenced by some npm script', () => {
  const scripts = Object.values(pkg.scripts).join(' ');
  const orphans = readdirSync(new URL('../tests', import.meta.url))
    .filter(f => f.endsWith('.test.mjs'))
    .filter(f => !scripts.includes(`tests/${f}`))
    .filter(f => !KNOWN_UNRUN.includes(f));

  assert.deepEqual(
    orphans, [],
    `these test files are never executed by any npm script: ${orphans.join(', ')}. ` +
    `A test that exists and never runs looks like coverage and is not. Add it to ` +
    `package.json's test:browser-js, or to KNOWN_UNRUN with a reason.`,
  );
});

test('TR-03 every file test:browser-js names actually exists', () => {
  // The mirror of TR-02: a runner pointed at a renamed or deleted file fails the
  // whole suite for a reason that reads like a broken test rather than a typo.
  const named = (pkg.scripts['test:browser-js'] ?? '').match(/tests\/[\w.-]+\.mjs/g) ?? [];
  assert.ok(named.length > 0, 'test:browser-js names no test files at all');
  const present = new Set(readdirSync(new URL('../tests', import.meta.url)));
  for (const path of named) {
    assert.ok(
      present.has(path.replace('tests/', '')),
      `test:browser-js runs ${path}, which does not exist`,
    );
  }
});
