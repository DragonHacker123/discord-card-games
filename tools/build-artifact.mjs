// Builds the one-file Jacks test page by inlining the engine, bots, tutorial, UI and styles.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const game = join(root, 'games', 'jacks');
const read = (name) => readFile(join(game, name), 'utf8');

/** Removes import and export syntax, so the modules can share one script. */
function unmodule(source) {
  return source.replace(/^import\s[\s\S]*?from\s+'[^']+';\s*$/gm, '').replace(/^export\s+/gm, '');
}

const [template, css, engine, bots, tutorial, ui] = await Promise.all(
  ['page.html', 'style.css', 'engine.js', 'bots.js', 'tutorial.js', 'ui.js'].map(read),
);

const script = `(() => {\n'use strict';\n${[engine, bots, tutorial, ui].map(unmodule).join('\n')}\n})();`;
if (script.includes('</script')) throw new Error('A script contains a closing script tag.');

const page = template.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => script);
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist', 'jacks.html'), page);
console.log(`Built dist/jacks.html (${Math.round(page.length / 1024)} KB)`);
