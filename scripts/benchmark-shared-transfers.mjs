#!/usr/bin/env node
/**
 * Simulated before/after transfer benchmark (not a real-device measurement).
 *
 * Models photo-heavy multi-area downloads:
 * - before: per-area concurrency 3, areas sequential
 * - after: shared pool (6 files) across overlapping areas
 *
 * Latency is synthetic. Do not treat these numbers as field performance.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AREAS = 12;
const PHOTOS_PER_AREA = 8;
const PHOTO_MS = 40;
const BEFORE_AREA_CONCURRENCY = 3;
const AFTER_POOL_FILES = 6;
const AFTER_AREA_FANOUT = 4;

async function runWithConcurrency(count, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      await worker(index);
    }
  });
  await Promise.all(workers);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function simulateBefore() {
  const started = performance.now();
  for (let area = 0; area < AREAS; area += 1) {
    await runWithConcurrency(PHOTOS_PER_AREA, BEFORE_AREA_CONCURRENCY, async () => {
      await sleep(PHOTO_MS);
    });
  }
  return performance.now() - started;
}

async function simulateAfter() {
  const started = performance.now();
  let active = 0;
  let peak = 0;
  const queue = [];
  const pump = () => {
    while (queue.length && active < AFTER_POOL_FILES) {
      const job = queue.shift();
      active += 1;
      peak = Math.max(peak, active);
      void sleep(PHOTO_MS).then(() => {
        active -= 1;
        job.resolve();
        pump();
      });
    }
  };
  const schedule = () => new Promise((resolve) => {
    queue.push({ resolve });
    pump();
  });

  await runWithConcurrency(AREAS, AFTER_AREA_FANOUT, async () => {
    await Promise.all(Array.from({ length: PHOTOS_PER_AREA }, () => schedule()));
  });
  return { ms: performance.now() - started, peak };
}

const beforeMs = await simulateBefore();
const after = await simulateAfter();
const report = {
  kind: 'simulated',
  note: 'Synthetic network delay only. Not a real-device measurement.',
  workload: { areas: AREAS, photosPerArea: PHOTOS_PER_AREA, photoMs: PHOTO_MS },
  before: { strategy: 'sequential areas, concurrency 3', ms: Number(beforeMs.toFixed(1)) },
  after: {
    strategy: `area fan-out ${AFTER_AREA_FANOUT}, shared pool ${AFTER_POOL_FILES}`,
    ms: Number(after.ms.toFixed(1)),
    peakActiveFiles: after.peak,
  },
  simulatedSpeedup: Number((beforeMs / after.ms).toFixed(2)),
  realDeviceMeasurements: 'not run in this environment',
};

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'shared-transfer-benchmark.json');
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Wrote ${outFile}`);
