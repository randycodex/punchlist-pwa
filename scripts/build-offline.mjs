import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';

const buildId = randomUUID();
const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
  stdio: 'inherit', env: { ...process.env, PUNCHLIST_BUILD_ID: buildId },
});
if (result.status !== 0) process.exit(result.status ?? 1);
const files = await readdir('.next/static', { recursive: true });
// Voice model/runtime downloads are separately disclosed; they are not site-readiness prerequisites.
const assets = files.filter((file) => /\.(js|css|woff2?|png|svg)$/.test(file)).map((file) => `/_next/static/${file}`);
assets.push('/uai-logo.png', '/manifest.json', '/icons/icon-192x192.png', '/icons/icon-512x512.png', '/icons/apple-touch-icon.png');
const source = await readFile('scripts/offline-worker.js', 'utf8');
await writeFile('public/inspection-sw.js', source.replace('__PUNCHLIST_BUILD__', JSON.stringify({ id: buildId, assets })));
console.log(`Offline worker: ${assets.length} versioned assets, build ${buildId}`);
