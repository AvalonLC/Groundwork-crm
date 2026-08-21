import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * public/js is the served asset directory. public/static must not shadow it.
 *
 * For months public/static held a full copy of public/js — 60 files, 8 of them
 * STALE copies of the live ones. Nothing referenced them and the build did not
 * use them, but every grep returned each hit twice and an edit to the wrong copy
 * silently did nothing. That is the entire failure mode: it does not break, it
 * wastes an afternoon.
 *
 * style.css belongs to a route that does not exist any more, and is allowed on
 * that basis. A second copy of a live asset is not.
 *
 * mockups/ used to be listed here too, as "genuinely only in static". That is
 * no longer true and the exception is gone: the design mockups now live in
 * docs/mockups/, because public/js/ is SERVED — _routes.json excludes /js/*
 * from the Worker, so Pages was handing every mockup out unauthenticated on the
 * production domain. See docs/mockups/README.md.
 */

// fileURLToPath, not URL.pathname: this repo lives under "Groundwork CRM" and
// pathname percent-encodes the space, so every fs call below would ENOENT — and
// the first test would swallow it and PASS, which is how a guard becomes a lie.
const root = fileURLToPath(new URL('../', import.meta.url));
const ALLOWED = new Set(['style.css']);

test('public/static does not shadow public/js', () => {
  const staticDir = join(root, 'public/static');
  // A missing directory is a valid end state; anything else is a real failure
  // and must not be swallowed.
  if (!existsSync(staticDir)) return;
  const staticFiles = readdirSync(staticDir);
  const jsFiles = new Set(readdirSync(join(root, 'public/js')));

  const shadowed = staticFiles.filter((f) => !ALLOWED.has(f) && jsFiles.has(f));
  assert.deepEqual(
    shadowed, [],
    `public/static/ has ${shadowed.length} file(s) that also exist in public/js/. ` +
    `public/js is the one that ships — delete these, or add a deliberate exception ` +
    `to ALLOWED with a reason. Shadowed: ${shadowed.join(', ')}`,
  );
});

test('every allowed static file is actually still there', () => {
  // Guards the reverse failure: ALLOWED quietly listing files nobody kept, which
  // would let a shadow slip back in under an exception that means nothing.
  if (!existsSync(join(root, 'public/static'))) return;
  for (const name of ALLOWED) {
    assert.ok(
      existsSync(join(root, 'public/static', name)),
      `ALLOWED lists ${name} but it does not exist`,
    );
  }
});

test('nothing in src links to /static/ except known-dead code', () => {
  // src/renderer.tsx references /static/style.css and is imported by nothing.
  // If a LIVE file starts linking to /static/, this fails and the exception
  // above has to be revisited rather than silently widened.
  const src = readFileSync(join(root, 'src/index.tsx'), 'utf8');
  assert.equal(
    src.includes('/static/'), false,
    'src/index.tsx now references /static/ — public/js is the served directory',
  );
});
