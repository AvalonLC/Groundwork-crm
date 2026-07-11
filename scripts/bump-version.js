#!/usr/bin/env node
/**
 * bump-version.js
 * ───────────────
 * Generates a unique build version string from the current UTC timestamp
 * and rewrites every version reference in src/index.tsx automatically.
 *
 * Format: YYYYMMDDbXXX  (e.g. 20260712b001)
 *   - YYYYMMDD = UTC date
 *   - b        = literal separator
 *   - XXX      = zero-padded counter that increments each time this runs
 *               on the same calendar day (restarts at 001 each new day)
 *
 * Version state is persisted in scripts/.build-version so the counter
 * survives across shell sessions without needing git tags.
 *
 * Usage (automatic — wired into npm run build):
 *   node scripts/bump-version.js
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = resolve(__dir, '..');
const IDX     = resolve(ROOT, 'src/index.tsx');
const STATE_F = resolve(__dir, '.build-version');

// ── 1. Generate new version ────────────────────────────────────────────────
const now   = new Date();
const ymd   = now.toISOString().slice(0, 10).replace(/-/g, ''); // "20260712"

// Read persisted state
let lastDate = '', lastCount = 0;
if (existsSync(STATE_F)) {
  try {
    const s = JSON.parse(readFileSync(STATE_F, 'utf8'));
    lastDate  = s.date  || '';
    lastCount = s.count || 0;
  } catch {}
}

const count   = (lastDate === ymd) ? lastCount + 1 : 1;
const version = `${ymd}b${String(count).padStart(3, '0')}`;  // e.g. 20260712b001

// Persist state
writeFileSync(STATE_F, JSON.stringify({ date: ymd, count, version }), 'utf8');

// ── 2. Rewrite src/index.tsx ───────────────────────────────────────────────
let src = readFileSync(IDX, 'utf8');

// Pattern: any existing version tag — matches things like:
//   20260711p50h   20260712b003   20260710gw34   etc.
// We replace ALL ?v=XXXXX asset query strings with the new version.
const V_ASSET = /(\?v=)[A-Za-z0-9]+/g;
src = src.replace(V_ASSET, `$1${version}`);

// Also replace the BUILD constant in the /sw.js route
// Matches:  const BUILD = 'anything';
const V_BUILD = /(const BUILD\s*=\s*')[^']+(')/g;
src = src.replace(V_BUILD, `$1${version}$2`);

writeFileSync(IDX, src, 'utf8');

console.log(`✅  Version bumped → ${version}`);
