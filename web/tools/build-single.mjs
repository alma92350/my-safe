// Bundles the app into ONE self-contained HTML file for hosts that only take a single page (e.g. Claude Artifacts).
// Usage: node tools/build-single.mjs [out.html]      Output runs in "sandbox mode": passphrase-only, backup as text.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'dist', 'my-safe-single.html');
const read = (p) => readFileSync(join(root, p), 'utf8');

const order = ['core', 'vault', 'auth', 'app'];
let bundle = "'use strict';\n";
for (const name of order) {
  let src = read(`js/${name}.js`);
  const names = [];
  src = src.replace(/^export\s+(async\s+)?(function|const|let|class)\s+([A-Za-z0-9_$]+)/gm, (m, a, kind, id) => { names.push(id); return `${a || ''}${kind} ${id}`; });
  src = src.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+'\.\/(\w+)\.js';?$/gm, (m, id, mod) => `const ${id} = __${mod};`);
  src = src.replace(/^import\s+\{([^}]+)\}\s+from\s+'\.\/(\w+)\.js';?$/gm, (m, ids, mod) => `const {${ids}} = __${mod};`);
  if (/^(import|export)\s/m.test(src)) throw new Error(`unhandled import/export in ${name}.js`);
  bundle += `const __${name} = (() => {\n${src}\nreturn { ${names.join(', ')} };\n})();\n`;
}

let css = read('css/app.css').replace(/\/\* @standalone \*\/[\s\S]*?\/\* @end-standalone \*\//, '');
// The host already pads the page for the phone's safe areas and owns the top of the frame: don't stick bars to it.
css += `
.topbar { position: static; } .tabs { position: static; }
body { padding-left: max(0px, env(safe-area-inset-left, 0px)); padding-right: max(0px, env(safe-area-inset-right, 0px)); }
`;

const html = `<title>My-Safe</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
</style>
<div id="app"><p class="boot">Loading…</p></div>
<script>window.__MYSAFE_SANDBOX__ = true;</script>
<script>
${bundle}
</script>
`;
import('node:fs').then(({ mkdirSync }) => { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, html); console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB`); });
