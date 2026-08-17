#!/usr/bin/env node
/**
 * The spoiler guard is only as good as this one number.
 *
 * `prompt.ts` renders "the user has read up to and including chapter N" from
 * `SakuraContext.chapterNumber`, verbatim. A number that is too high authorises
 * spoilers the reader has not reached; a number of 0 makes Sakura refuse to
 * discuss a series they are two hundred chapters into. Both shipped once:
 *
 *   - "86 Ch. 12" returned 86, because the old parser took the first integer in
 *     the string and the series title *is* a number.
 *   - "Ch.47" returned null, because the old parser excluded digits preceded by
 *     a dot in order to skip the ".5" of "1.5".
 *   - chapterNumber 0 short-circuited the label fallback, because 0 is not
 *     nullish and the code used `??`.
 *
 *   node scripts/check-ai-chapter-number.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// lib/ai-context.ts is deliberately dependency-free, so it can be transpiled
// and loaded on its own. Use the real TypeScript compiler rather than a regex
// type-stripper: a test that silently fails to load the module under test is
// worse than no test.
const fs = await import('node:fs');
const ts = (await import('typescript')).default;
const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'ai-context.ts'), 'utf8');
const { outputText } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(outputText, 'utf8').toString('base64')}`
);

let failures = 0;
function eq(label, actual, expected) {
  const ok = actual === expected || (Number.isNaN(actual) && Number.isNaN(expected));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${actual}${ok ? '' : `  (expected ${expected})`}`);
  if (!ok) failures++;
}

const { chapterNumberFromLabel, buildReaderContext } = mod;

console.log('--- chapterNumberFromLabel ---');
eq('"Chapter 47"', chapterNumberFromLabel('Chapter 47'), 47);
eq('"Ch. 47"', chapterNumberFromLabel('Ch. 47'), 47);
eq('"Ch.47"  (dotted, no space)', chapterNumberFromLabel('Ch.47'), 47);
eq('"Vol.1 Ch.47"', chapterNumberFromLabel('Vol.1 Ch.47'), 47);
eq('"Ch 47.5 - Title"', chapterNumberFromLabel('Ch 47.5 - Title'), 47.5);
eq('"Chapter 0"  (real prologue)', chapterNumberFromLabel('Chapter 0'), 0);
eq('"47"  (bare number)', chapterNumberFromLabel('47'), 47);

console.log('\n--- must NOT guess from a title ---');
eq('"86 Ch. 12"', chapterNumberFromLabel('86 Ch. 12'), 12);
eq('"5 Toubun no Hanayome"', chapterNumberFromLabel('5 Toubun no Hanayome'), null);
eq('"Omake"', chapterNumberFromLabel('Omake'), null);
eq('"Extra"', chapterNumberFromLabel('Extra'), null);

console.log('\n--- buildReaderContext: 0 must not short-circuit the label ---');
eq(
  'number=0, label="Chapter 214"  (source defaulted to 0)',
  buildReaderContext({ medium: 'manga', chapterNumber: 0, chapterLabel: 'Chapter 214' }).chapterNumber,
  214,
);
eq(
  'number=0, label="Chapter 0"  (a real prologue still works)',
  buildReaderContext({ medium: 'manga', chapterNumber: 0, chapterLabel: 'Chapter 0' }).chapterNumber,
  0,
);
eq(
  'number=0, label="Omake"  (unknowable -> null, guard goes vague not wrong)',
  buildReaderContext({ medium: 'manga', chapterNumber: 0, chapterLabel: 'Omake' }).chapterNumber,
  null,
);
eq(
  'number=NaN, label="Ch.47"',
  buildReaderContext({ medium: 'manga', chapterNumber: NaN, chapterLabel: 'Ch.47' }).chapterNumber,
  47,
);
eq(
  'number=47 wins over a misleading label',
  buildReaderContext({ medium: 'manga', chapterNumber: 47, chapterLabel: '86 Ch. 12' }).chapterNumber,
  47,
);

console.log(`\n${failures === 0 ? 'Chapter-number parsing OK.' : `${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
