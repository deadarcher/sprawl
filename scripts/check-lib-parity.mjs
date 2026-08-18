#!/usr/bin/env node
/**
 * Fail when a SHARED ENGINE FILE has drifted between its copies.
 *
 * WHY THIS EXISTS. The installer-parsing engine lives byte-identical in more than one repo
 * (the public SwitchHunt tool and the hosted copy on the marketing site, with RFF.Web planned).
 * A banner comment at the top of each file asks you to keep them in sync. Banners do not work:
 * measured 2026-07-29, within ONE HOUR of a deliberate sync, installerDetect.ts and burn.ts were
 * both already out of step - in OPPOSITE directions. One had a fix the other lacked, and vice
 * versa. Nobody noticed because nothing was looking.
 *
 * So this looks.
 *
 * Usage:
 *   node scripts/check-lib-parity.mjs                     auto-detect a sibling checkout
 *   node scripts/check-lib-parity.mjs <path>              compare against an explicit path
 *   node scripts/check-lib-parity.mjs --require <path>    CI mode - see below
 *
 * --require is MANDATORY IN CI. Without it, three different mishaps all produce a green build
 * that compared nothing:
 *   - the sibling checkout step failed  -> no candidates      -> exit 0 "skipping"
 *   - the path is wrong                 -> every file MISSING -> exit 0 having skipped them all
 *   - someone renames the shared files  -> zero compared      -> exit 0
 * Under --require each of those is a failure. A check that cannot prove it ran must not pass.
 *
 * NOT CHECKED: catalog.ts. It legitimately diverges - the marketing copy carries catalogSlug()
 * for its /switchhunt/<slug> routes and the public copy has no such pages. Entry parity there is
 * a different question; compare CATALOG.md counts instead.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** Files that MUST be byte-identical everywhere. Pure engine code, no repo-specific logic. */
/**
 * Groups exist so --require stays meaningful: a repo that was never meant to carry a file must
 * not be reported as drifting from it. Each candidate below declares which groups it holds.
 *
 * The `tools` group was briefly removed (2026-08-02) when the RFF.Web copies were deleted and
 * this repo was its only home - a group with no second home compares nothing while still
 * reporting success. It is back because the open-source rff-tools repo is now a real second
 * home. Group and candidate were added back together, which is the rule.
 */
const GROUPS = {
  installer: ['msi.ts', 'installerDetect.ts', 'burn.ts', 'intunewin.ts', 'psadt.ts'],
  // Free-tools analysis engine. Each tool is its own public repo, so a module can live in three
  // or four places at once - collectorScript is in ALL of them. Split per tool so --require does
  // not report a repo as drifting from a file it was never meant to carry: culprit has no
  // driftDiff, works-on-mine has no baselineCheck.
  perf:      ['perfAnalyzer.ts'],
  drift:     ['driftDiff.ts'],
  baseline:  ['baselineCheck.ts', 'hardeningBaseline.ts'],
  collector: ['collectorScript.ts'],
  sprawl:    ['sprawlAnalyzer.ts'],
};
const SHARED = [...new Set(Object.values(GROUPS).flat())];

/**
 * Where the other copies might live locally. Extend when a further home lands.
 *
 * An entry is either a path (its lib is at src/lib) or {path, lib} when the repo nests it
 * elsewhere - RFF.Web is a project inside the platform monorepo, not a repo root.
 */
const ALL_TOOLS = ['perf', 'drift', 'baseline', 'collector', 'sprawl'];
const CANDIDATES = [
  { path: resolve(repoRoot, '..', 'rff-marketing'), groups: ['installer', ...ALL_TOOLS] },
  { path: 'C:/temp/rff-marketing',                  groups: ['installer', ...ALL_TOOLS] },
  { path: resolve(repoRoot, '..', 'SwitchHunt'),    groups: ['installer'] },
  { path: 'C:/Temp/SwitchHunt',                     groups: ['installer'] },
  // One public repo per tool; each carries only the modules its own page imports.
  { path: resolve(repoRoot, '..', 'culprit'),       groups: ['perf', 'collector'] },
  { path: 'C:/temp/culprit',                        groups: ['perf', 'collector'] },
  { path: resolve(repoRoot, '..', 'works-on-mine'), groups: ['drift', 'collector'] },
  { path: 'C:/temp/works-on-mine',                  groups: ['drift', 'collector'] },
  { path: resolve(repoRoot, '..', 'hardened'),      groups: ['drift', 'baseline', 'collector'] },
  { path: 'C:/temp/hardened',                       groups: ['drift', 'baseline', 'collector'] },
  { path: resolve(repoRoot, '..', 'sprawl'),        groups: ['sprawl'] },
  { path: 'C:/temp/sprawl',                         groups: ['sprawl'] },
];

/** Fill in the default lib subpath and expand the group list into concrete filenames. */
const asCandidate = (c) => ({
  ...c,
  lib: c.lib ?? join('src', 'lib'),
  files: c.groups.flatMap((g) => GROUPS[g]),
});

const REQUIRE = process.argv.includes('--require');
const explicit = process.argv.slice(2).find((a) => !a.startsWith('--'));

const others = explicit
  ? [asCandidate({ path: resolve(explicit), groups: Object.keys(GROUPS) })]
  : (() => {
      // De-duplicate by RESOLVED path: the relative and absolute entries above frequently point
      // at the same checkout, which would otherwise compare (and report) everything twice.
      const seen = new Set();
      return CANDIDATES.map(asCandidate)
        .filter((c) => {
          const key = resolve(c.path).toLowerCase();
          if (key === repoRoot.toLowerCase() || seen.has(key)) return false;
          if (!existsSync(join(c.path, c.lib))) return false;
          seen.add(key);
          return true;
        });
    })();

if (others.length === 0) {
  if (REQUIRE) {
    console.error('check-lib-parity: --require was set but no sibling checkout was found.');
    console.error('Nothing was compared. Failing rather than reporting a pass it did not earn.');
    process.exit(1);
  }
  console.log('check-lib-parity: no sibling checkout found locally - skipping (not a failure).');
  process.exit(0);
}

let failed = false;
let compared = 0;

for (const other of others) {
  console.log('');
  console.log('Comparing against ' + other.path + ' (' + other.lib + ')');
  for (const f of other.files) {
    const a = join(repoRoot, 'src', 'lib', f);
    const b = join(other.path, other.lib, f);

    if (!existsSync(a) || !existsSync(b)) {
      // Under --require a missing file is a FAILURE. An explicit-but-wrong path makes `others`
      // non-empty, so every file would "skip" and the script would exit 0 having compared
      // nothing - a check that passes without checking.
      console.log('  ' + f.padEnd(22) + (REQUIRE ? 'MISSING - cannot compare' : 'SKIP (missing on one side)'));
      if (REQUIRE) failed = true;
      continue;
    }

    // Normalise line endings only - the repos disagree about CRLF via .gitattributes, and that
    // is not drift anyone needs to act on.
    const norm = (p) => readFileSync(p, 'utf8').split('\r\n').join('\n');
    const x = norm(a);
    const y = norm(b);
    compared++;

    if (x === y) {
      console.log('  ' + f.padEnd(22) + 'ok');
      continue;
    }

    failed = true;
    const xl = x.split('\n');
    const yl = y.split('\n');
    let i = 0;
    while (i < xl.length && i < yl.length && xl[i] === yl[i]) i++;
    console.log('  ' + f.padEnd(22) + 'DRIFT - first difference at line ' + (i + 1));
    console.log('      this repo : ' + String(xl[i] ?? '(eof)').trim().slice(0, 100));
    console.log('      other repo: ' + String(yl[i] ?? '(eof)').trim().slice(0, 100));
  }
}

if (REQUIRE && compared === 0) {
  console.error('');
  console.error('check-lib-parity: --require was set but ZERO files were actually compared.');
  process.exit(1);
}

if (failed) {
  console.error('');
  console.error('Shared engine files have drifted, or could not be compared.');
  console.error('Apply the change to EVERY copy before committing. See the banner at the top of each file.');
  process.exit(1);
}

console.log('');
console.log('All shared engine files are in sync (' + compared + ' compared).');
