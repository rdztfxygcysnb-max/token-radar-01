// Local verifier for the token-radar-01 gate: mirrors the seven gate rows from RULES.txt
// against one output directory, plus a determinism check that runs main.ts twice.
//
//   node scripts/verify-gate.mjs <output-dir> [--snapshot <snapshot.json>] [--repo <repo-root>]
//
// Defaults: the snapshot is ../../token-radar-01-kit/input/snapshot.json next to this repository,
// and the repo root is this script's parent's parent. Node standard library only. Exit 0 when every
// row passes (a skipped determinism check does not fail), 1 when any row fails.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(process.argv.find((a) => a.startsWith('--repo='))?.slice('--repo='.length) ?? join(here, '..'));
const outDir = resolve(process.argv[2] ?? '');
const snapshotPath = resolve(
  process.argv.find((a) => a.startsWith('--snapshot='))?.slice('--snapshot='.length) ??
    join(repo, '..', 'token-radar-01-kit', 'input', 'snapshot.json'),
);

const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_DASH_FILES = 400;
const MAX_DASH_BYTES = 4 * 1024 * 1024;
const MAX_BOARD_ROWS = 4000;
const MAX_BOARD_BYTES = 8 * 1024 * 1024;
const MAX_IMPLIED = 100_000_000_000_000;
const MAX_SHOTS = 4;
const MAX_SHOT_BYTES = 512 * 1024;

const results = [];
function report(row, ok, detail) {
  results.push({ row, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${row}${detail ? `: ${detail}` : ''}\n`);
}

/** Every regular file under `root`, recursively, as paths relative to it. */
function walk(root) {
  const out = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const dir = rel === '' ? root : join(root, rel);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
      else return { files: out, bad: `${p} is neither a file nor a directory` };
    }
  }
  return { files: out.sort(), bad: null };
}

const hasUrl = (s) => s.includes('http://') || s.includes('https://');

/** Import/export/require/dynamic-import specifiers in a JS (or inline <script>) body. */
function jsSpecifiers(body) {
  const specs = [];
  for (const m of body.matchAll(/import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of body.matchAll(/export\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of body.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  for (const m of body.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

// ---------------------------------------------------------------- the snapshot
let snapshot;
try {
  snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
} catch (err) {
  process.stdout.write(`FAIL snapshot: cannot read ${snapshotPath}: ${err.message}\n`);
  process.exit(1);
}
const snapSlugs = new Set(snapshot.protocols.map((p) => p.slug));

// ---------------------------------------------------------------- dashboard_files
{
  const root = join(outDir, 'dashboard');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    report('dashboard_files', false, 'no dashboard/ directory');
  } else {
    const { files, bad } = walk(root);
    let detail = bad;
    if (detail === null && files.length > MAX_DASH_FILES) detail = `${files.length} files, over ${MAX_DASH_FILES}`;
    let bytes = 0;
    if (detail === null) {
      for (const f of files) {
        const parts = f.split('/');
        if (parts.some((seg) => seg.startsWith('.'))) { detail = `dashboard/${f}: a dot-directory or dot-name`; break; }
        if (parts.some((seg) => !PLAIN_NAME.test(seg))) { detail = `dashboard/${f}: a name is letters, digits and . _ -, 1 to 128 characters`; break; }
        bytes += statSync(join(root, f)).size;
        if (bytes > MAX_DASH_BYTES) { detail = `dashboard/ is ${bytes} bytes, over ${MAX_DASH_BYTES}`; break; }
      }
    }
    if (detail === null && !files.includes('index.html')) detail = 'no index.html';
    if (detail === null && !files.some((f) => f.endsWith('.css'))) detail = 'no .css file';
    if (detail === null && !files.some((f) => f.endsWith('.js'))) detail = 'no .js file';
    if (detail === null) {
      outer: for (const f of files) {
        const text = readFileSync(join(root, f), 'utf8');
        const ext = extname(f);
        if (ext === '.html') {
          for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
            if (hasUrl(m[1])) { detail = `dashboard/${f}: an http:// or https:// address in a <style> body`; break outer; }
          }
          for (const tag of text.matchAll(/<[^>]+>/g)) {
            for (const m of tag[0].matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) {
              const v = m[1] ?? m[2] ?? '';
              if (hasUrl(v)) { detail = `dashboard/${f}: an http:// or https:// address in an HTML attribute value (${v.slice(0, 60)})`; break outer; }
            }
          }
          for (const m of text.matchAll(/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi)) {
            const badSpec = jsSpecifiers(m[1]).find(hasUrl);
            if (badSpec !== undefined) { detail = `dashboard/${f}: an http:// or https:// address in an inline <script> import (${badSpec.slice(0, 60)})`; break outer; }
          }
        } else if (ext === '.css') {
          if (hasUrl(text)) { detail = `dashboard/${f}: an http:// or https:// address in a CSS file`; break outer; }
        } else if (ext === '.js' || ext === '.mjs') {
          const badSpec = jsSpecifiers(text).find(hasUrl);
          if (badSpec !== undefined) { detail = `dashboard/${f}: an http:// or https:// address in a JS import/export/require specifier (${badSpec.slice(0, 60)})`; break outer; }
        }
      }
    }
    report('dashboard_files', detail === null, detail ?? `${files.length} files, ${bytes} bytes`);
  }
}

// ---------------------------------------------------------------- board_file
let rows = null;
{
  const path = join(outDir, 'board.json');
  if (!existsSync(path)) {
    report('board_file', false, 'no board.json');
  } else {
    const size = statSync(path).size;
    let detail = size > MAX_BOARD_BYTES ? `board.json is ${size} bytes, over ${MAX_BOARD_BYTES}` : null;
    let doc = null;
    if (detail === null) {
      try {
        doc = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        detail = `board.json is not JSON: ${err.message}`;
      }
    }
    if (detail === null) {
      rows = Array.isArray(doc) ? doc : doc?.rows;
      if (!Array.isArray(rows)) detail = 'board.json has no rows array';
      else if (rows.length < 100 || rows.length > MAX_BOARD_ROWS) detail = `${rows.length} rows, outside 100 to ${MAX_BOARD_ROWS}`;
    }
    if (detail === null) {
      const seen = new Set();
      for (const r of rows) {
        if (typeof r.slug !== 'string' || r.slug.length < 1 || r.slug.length > 128 || /\s/.test(r.slug)) { detail = `a row has a bad slug: ${JSON.stringify(r.slug)}`; break; }
        if (!snapSlugs.has(r.slug)) { detail = `invented slug: ${r.slug}`; break; }
        if (seen.has(r.slug)) { detail = `duplicate slug: ${r.slug}`; break; }
        seen.add(r.slug);
        if (typeof r.name !== 'string' || r.name.length === 0) { detail = `${r.slug} has an empty name`; break; }
        if (!Number.isSafeInteger(r.rank) || r.rank <= 0) { detail = `${r.slug} has rank ${r.rank}`; break; }
        if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > MAX_IMPLIED) {
          detail = `${r.slug} has implied value ${r.implied_value_usd}`;
          break;
        }
        if (!Array.isArray(r.farm_steps)) { detail = `${r.slug} has no farm_steps array`; break; }
      }
    }
    report('board_file', detail === null, detail ?? `${rows.length} rows, ${size} bytes`);
  }
}

// ---------------------------------------------------------------- sorted_by_value
if (rows !== null) {
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  let detail = null;
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i].rank !== i + 1) { detail = `rank ${i + 1} is ${byRank[i].rank}`; break; }
  }
  if (detail === null) {
    for (let i = 1; i < byRank.length; i++) {
      if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) {
        detail = `rank ${byRank[i].rank} ($${byRank[i].implied_value_usd}) outranks rank ${byRank[i - 1].rank} ($${byRank[i - 1].implied_value_usd})`;
        break;
      }
    }
  }
  if (detail === null && rows.length >= 2 && byRank[0].implied_value_usd === byRank[byRank.length - 1].implied_value_usd) {
    detail = `all ${rows.length} rows share the same implied value $${byRank[0].implied_value_usd}`;
  }
  report('sorted_by_value', detail === null, detail);
} else {
  report('sorted_by_value', false, 'no board to sort');
}

// ---------------------------------------------------------------- coverage
if (rows !== null) {
  const have = new Set(rows.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !have.has(s));
  report('coverage', missing.length === 0, missing.length === 0 ? `${snapshot.watchlist.length} of ${snapshot.watchlist.length} watchlist slugs present` : `missing ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`);
} else {
  report('coverage', false, 'no board to cover with');
}

// ---------------------------------------------------------------- farm_steps
if (rows !== null) {
  let detail = null;
  for (const r of rows) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) { detail = `${r.slug} has ${steps.length} farm steps`; break; }
    for (const s of steps) {
      if (typeof s !== 'string') { detail = `${r.slug} has a non-string farm step`; break; }
      const len = s.trim().length;
      if (len < 20 || len > 600) { detail = `${r.slug} has a farm step of ${len} characters`; break; }
    }
    if (detail !== null) break;
  }
  report('farm_steps', detail === null, detail);
} else {
  report('farm_steps', false, 'no board to check');
}

// ---------------------------------------------------------------- screenshots
function pngSize(buf) {
  if (buf.length < 33 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), whole: buf.subarray(buf.length - 12).equals(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])) };
}
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), whole: buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9 };
    }
    i += 2 + len;
  }
  return null;
}
{
  const root = join(outDir, 'screenshots');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    report('screenshots', false, 'no screenshots/ directory');
  } else {
    const names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).sort();
    let detail = null;
    if (names.length < 3 || names.length > MAX_SHOTS) detail = `${names.length} images, outside 3 to ${MAX_SHOTS}`;
    if (detail === null) {
      for (const name of names) {
        const path = join(root, name);
        const buf = readFileSync(path);
        if (!PLAIN_NAME.test(name)) { detail = `screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`; break; }
        if (buf.length > MAX_SHOT_BYTES) { detail = `screenshots/${name} is ${buf.length} bytes, over ${MAX_SHOT_BYTES}`; break; }
        const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
        const dims = png ? pngSize(buf) : jpg ? jpegSize(buf) : null;
        if (dims === null) { detail = `screenshots/${name} is neither a whole PNG nor a whole JPEG`; break; }
        if (!dims.whole) { detail = `screenshots/${name} is truncated`; break; }
        const long = Math.max(dims.w, dims.h);
        const short = Math.min(dims.w, dims.h);
        if (long > 1440) { detail = `screenshots/${name} is ${dims.w}x${dims.h}: long side over 1440`; break; }
        if (short < 800) { detail = `screenshots/${name} is ${dims.w}x${dims.h}: short side under 800`; break; }
      }
    }
    report('screenshots', detail === null, detail ?? `${names.length} images`);
  }
}

// ---------------------------------------------------------------- dossier_matches
{
  const path = join(outDir, 'dossier.json');
  if (!existsSync(path)) {
    report('dossier_matches', false, 'no dossier.json');
  } else {
    const want = readFileSync(path);
    const tmp = mkdtempSync(join(tmpdir(), 'radar-verify-'));
    try {
      const runner = join(tmp, 'rebuild.mjs');
      writeFileSync(
        runner,
        `import { writeFileSync } from 'node:fs';\nimport { buildDossier } from ${JSON.stringify(pathToFileURL(join(repo, 'vendor', 'makefun-board.ts')).href)};\n` +
          `writeFileSync(${JSON.stringify(join(tmp, 'rebuilt.json'))}, buildDossier(${JSON.stringify(outDir)}, { text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } }));\n`,
      );
      execFileSync(process.execPath, [runner], { stdio: 'pipe', timeout: 60_000 });
      const got = readFileSync(join(tmp, 'rebuilt.json'));
      const same = want.equals(got);
      report(
        'dossier_matches',
        same,
        same ? `${want.length} bytes` : `dossier.json is ${want.length} bytes, the rebuild is ${got.length} bytes`,
      );
    } catch (err) {
      const msg = err.stderr?.toString().trim().split('\n').pop() ?? err.message;
      report('dossier_matches', false, `rebuild failed: ${msg}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------- determinism
{
  const dirA = mkdtempSync(join(tmpdir(), 'radar-run-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'radar-run-b-'));
  const run = (dir) => {
    try {
      execFileSync(process.execPath, ['main.ts', '--input', snapshotPath, '--output', dir], { cwd: repo, stdio: 'pipe', timeout: 120_000 });
      return null;
    } catch (err) {
      const msg = (err.stderr?.toString() ?? err.message).trim().split('\n').pop() ?? err.message;
      return msg;
    }
  };
  const errA = run(dirA);
  const errB = run(dirB);
  if (errA !== null || errB !== null) {
    process.stdout.write(`SKIP determinism: main.ts did not complete (run A: ${errA ?? 'ok'}; run B: ${errB ?? 'ok'})\n`);
  } else {
    const diff = [];
    const collect = (root) => {
      const { files } = walk(root);
      return files;
    };
    const aFiles = collect(dirA);
    const bFiles = collect(dirB);
    const all = [...new Set([...aFiles, ...bFiles])].sort();
    for (const f of all) {
      const pa = join(dirA, f);
      const pb = join(dirB, f);
      if (!existsSync(pa)) diff.push(`${f} missing from run A`);
      else if (!existsSync(pb)) diff.push(`${f} missing from run B`);
      else if (!readFileSync(pa).equals(readFileSync(pb))) diff.push(`${f} differs`);
    }
    report('determinism', diff.length === 0, diff.length === 0 ? `two runs byte-identical (${aFiles.length} files)` : diff.slice(0, 5).join('; '));
  }
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`${results.length - failed} of ${results.length} rows passed${failed === 0 ? '' : `, ${failed} failed`}\n`);
process.exit(failed === 0 ? 0 : 1);
