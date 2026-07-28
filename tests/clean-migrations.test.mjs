import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const migrationsDirectory = new URL('../migrations/', import.meta.url);

function assertUniqueMigrationPrefixes(names) {
  const seen = new Map();
  for (const name of names) {
    const prefix = name.slice(0, 4);
    assert.ok(!seen.has(prefix), `duplicate migration prefix ${prefix}: ${seen.get(prefix)} and ${name}`);
    seen.set(prefix, name);
  }
}

test('numbered migration prefixes are unique', () => {
  const migrations = readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name));
  assertUniqueMigrationPrefixes(migrations);
});

test('every numbered migration applies to a clean database', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'groundwork-migrations-'));
  const databasePath = join(temporaryDirectory, 'clean.sqlite');

  try {
    const migrations = readdirSync(migrationsDirectory)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right));

    assert.ok(migrations.length > 0, 'no numbered migrations found');
    assertUniqueMigrationPrefixes(migrations);
    migrations.forEach((name, index) => {
      const expectedNumber = String(index + 1).padStart(4, '0');
      assert.equal(name.slice(0, 4), expectedNumber, `missing migration ${expectedNumber}`);

      try {
        execFileSync('sqlite3', ['-bail', databasePath], {
          input: readFileSync(new URL(name, migrationsDirectory)),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        const details = error.stderr?.toString().trim() || error.message;
        assert.fail(`${name} failed: ${details}`);
      }
    });

    const requiredTables = [
      'sales_processes',
      'sales_process_versions',
      'sales_process_stages',
      'sales_stage_assignments',
      'sales_migration_mappings',
      'sales_stage_transitions',
      'sales_stage_transition_events',
      'sales_process_company_state',
      'sales_migration_snapshots',
      'sales_migration_snapshot_items',
      'sales_stage_checklist_evidence',
    ];
    const tableList = execFileSync(
      'sqlite3',
      [databasePath, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);

    for (const table of requiredTables) {
      assert.ok(tableList.includes(table), `latest sales-process table is missing: ${table}`);
    }

    const requiredIndexes = ['idx_sales_snapshot_company', 'idx_sales_snapshot_items_opportunity', 'idx_sales_transition_company'];
    const indexList = execFileSync('sqlite3', [databasePath, "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;"], { encoding: 'utf8' });
    for (const index of requiredIndexes) assert.match(indexList, new RegExp(`^${index}$`, 'm'));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
