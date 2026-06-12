// prepare.js — convert the Step-2 NDJSON file into one JSON array that k6 can load
// with SharedArray. k6 has no efficient line-by-line streaming reader, and open()
// pulls a whole file into memory once per process; a single pre-parsed JSON array is
// the shape SharedArray wants (it parses it once and shares it read-only across VUs).
//
// We cap the array at MAX_INVOICES (default 100k). The k6 load test only needs a large
// enough pool to draw realistic random batches from — it replays/duplicates freely (the
// API is idempotent), so there is no value in materializing millions of rows into RAM.
//
// Usage (from repo root):
//   node loadtest/prepare.js [input.ndjson] [output.json]
// Defaults: ../generator/data/invoices_90d.ndjson  ->  loadtest/data/chunks.json
// Env: MAX_INVOICES (default 100000).

import { createReadStream, mkdirSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const input = resolve(
  process.cwd(),
  process.argv[2] || resolve(here, '../generator/data/invoices_90d.ndjson'),
);
const output = resolve(
  process.cwd(),
  process.argv[3] || resolve(here, 'data/chunks.json'),
);
const MAX_INVOICES = Number(process.env.MAX_INVOICES) || 100000;

async function main() {
  mkdirSync(dirname(output), { recursive: true });

  const rl = createInterface({
    input: createReadStream(input),
    crlfDelay: Infinity,
  });

  // Stream the NDJSON in, but write the output as a single JSON array incrementally so
  // we never hold both the source text and a giant in-memory array at the same time.
  const out = createWriteStream(output);
  out.write('[\n');

  let count = 0;
  let truncated = false;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (count >= MAX_INVOICES) {
      truncated = true;
      break;
    }
    // Re-stringify each parsed object: validates the JSON and normalizes whitespace.
    const obj = JSON.parse(trimmed);
    out.write((count === 0 ? '' : ',\n') + JSON.stringify(obj));
    count += 1;
  }
  rl.close();

  out.write('\n]\n');
  await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));

  console.log(
    JSON.stringify(
      {
        input,
        output,
        invoices: count,
        max_invoices: MAX_INVOICES,
        truncated,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
