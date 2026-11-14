// Builds the Discord client into dist/activity: one page, one script, one
// stylesheet and the font files. The page's markup comes from the test page, so
// the two can't drift apart.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'activity');

const template = await readFile(join(root, 'games', 'jacks', 'page.html'), 'utf8');
const start = template.indexOf('<style>/*__CSS__*/</style>');
const end = template.indexOf('<script>/*__JS__*/</script>');
if (start === -1 || end === -1) throw new Error('page.html has lost its markers.');
const body = template.slice(start + '<style>/*__CSS__*/</style>'.length, end).trim();
if (/<script|<form|\son[a-z]+=/i.test(body)) throw new Error('page.html has something the Discord page must not carry.');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: { app: join(root, 'client', 'main.js'), style: join(root, 'client', 'activity.css') },
  outdir: out,
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['chrome110', 'safari16', 'firefox115'],
  loader: { '.woff2': 'file', '.woff': 'file' },
  assetNames: 'fonts/[name]',
  logLevel: 'warning',
});

const page = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="jacks-mode" content="online">
<title>Jacks</title>
<link rel="stylesheet" href="./style.css">
</head>
<body>
${body}
<script type="module" src="./app.js"></script>
</body>
</html>
`;
await writeFile(join(out, 'index.html'), page);
console.log('Built dist/activity');
