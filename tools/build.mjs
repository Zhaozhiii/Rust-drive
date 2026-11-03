import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { watch } from 'node:fs';

const root = resolve(import.meta.dirname, '..');
let building = false, again = false;
async function compile() {
  if (building) { again = true; return; }
  building = true;
  try {
    const license = await readFile(resolve(root, 'frontend/vendor/react-bits/LICENSE.md'), 'utf8');
    const iconLicenses = await Promise.all(['react-file-icon/LICENSE','colord/LICENSE.md','prop-types/LICENSE'].map(async path => `${path.split('/')[0]}\n${await readFile(resolve(root,'node_modules',path),'utf8')}`));
    const result = await build({
      absWorkingDir: root, entryPoints: ['frontend/main.jsx'], outfile: 'web/app.js',
      bundle: true, write: false, format: 'iife', platform: 'browser', target: ['es2022'],
      jsx: 'automatic', minify: true, legalComments: 'inline',
      define: { 'process.env.NODE_ENV': '"production"' },
      banner: { js: `/*! React Bits — adapted for Rust-drive.\n${license}\n*/\n/*! ${iconLicenses.join('\n\n')} */` }
    });
    const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replace(/[\t ]+$/gm, '');
    const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
    const template = await readFile(resolve(root, 'frontend/index.html'), 'utf8');
    const html = template.replace('/* @component-styles */', css);
    if (process.argv.includes('--check')) {
      if (await readFile(resolve(root, 'web/app.js'), 'utf8') !== js || await readFile(resolve(root, 'web/index.html'), 'utf8') !== html) throw new Error('Generated frontend differs; run npm run build before Cargo.');
    } else {
      await writeFile(resolve(root, 'web/app.js'), js);
      await writeFile(resolve(root, 'web/index.html'), html);
    }
    console.log(`Frontend built: ${(Buffer.byteLength(js) / 1024).toFixed(1)} KiB JS; ${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB HTML/CSS`);
  } finally {
    building = false;
    if (again) { again = false; await compile(); }
  }
}
await compile();
if (process.argv.includes('--watch')) {
  let timer;
  const trigger = () => { clearTimeout(timer); timer = setTimeout(() => compile().catch(console.error), 100); };
  watch(resolve(root, 'frontend'), { recursive: true }, trigger);
  console.log('Watching frontend/; reload http://localhost:4173 after edits.');
}
