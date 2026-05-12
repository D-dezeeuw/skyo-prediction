import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT_RELATIVE_ATTR = /(\b(?:src|href)=)"\/(?!\/)/g;

export function relativizeHtml(html) {
  return html.replace(ROOT_RELATIVE_ATTR, '$1"./');
}

export function build({ srcDir = 'public', outDir = 'dist' } = {}) {
  if (!existsSync(srcDir)) {
    throw new Error(`Source directory "${srcDir}" does not exist`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(srcDir, outDir, { recursive: true });

  const indexPath = resolve(outDir, 'index.html');
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf8');
    writeFileSync(indexPath, relativizeHtml(html));
  }
  return { srcDir, outDir };
}

/* node:coverage disable */
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const result = build();
  console.log(`Build complete: ${result.outDir}/`);
}
/* node:coverage enable */
