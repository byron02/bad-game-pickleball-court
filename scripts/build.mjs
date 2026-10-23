import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public');
const output = path.join(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true, filter: (entry) => !entry.endsWith('.js') });
await build({
  entryPoints: [
    path.join(source, 'signup.js'),
    path.join(source, 'admin.js'),
    path.join(source, 'play.js'),
    path.join(source, 'event.js'),
    path.join(source, 'events-admin.js'),
  ],
  outbase: source,
  outdir: output,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  logLevel: 'info'
});
