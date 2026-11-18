// Launch Radar entry point (Node 22, standard library only, no network).
//
// Reads the sealed snapshot, scores every qualifying pre-token protocol with the model in
// lib/model.ts, and writes the run's outputs:
//   board.json    the ranked board
//   data.js       the dashboard's dataset, rendered by the page with no fetch
//   dashboard/    a copy of this repository's dashboard/
//   screenshots/  a copy of this repository's screenshots/
//   dossier.json  the judge's summary, written by buildDossier from vendor/makefun-board.ts
//
// The grader sets MAKEFUN_OUTPUT_DIR for /output outside its container:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
// The run is deterministic: the only date it knows is the snapshot's own as_of.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Read `--name value` or `--name=value` from the arguments, else the fallback. */
function option(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at !== -1 && at + 1 < args.length) return args[at + 1]!;
  const joined = args.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

const inputArg = option('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  process.stderr.write(`launch radar: no snapshot at ${snapshotPath} (pass --input <snapshot.json|directory>)\n`);
  process.exit(2);
}
const outDir = option('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launch radar: refusing to hand in this board: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory tree of regular files, skipping dot names; returns the file count. */
function copyTree(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) count += copyTree(src, dst);
    else if (statSync(src).isFile()) {
      copyFileSync(src, dst);
      count += 1;
    }
  }
  return count;
}

const pageFiles = copyTree(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shotFiles = copyTree(join(root, 'screenshots'), join(outDir, 'screenshots'));
if (shotFiles < 3) {
  process.stderr.write(`launch radar: screenshots/ holds ${shotFiles} files: hand in 3 (the board, a detail view, a filtered view)\n`);
  process.exit(1);
}

// Written last, from the finished output, exactly as the gate rebuilds it.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65_536 }));

process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols read, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked\n` +
    `launch radar: wrote board.json, data.js, dashboard/ (${pageFiles} files), screenshots/ (${shotFiles} images), dossier.json\n`,
);
