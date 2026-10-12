import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import scratchHome from '../../helpers/scratch-home.cjs';
scratchHome.refuseEntry(import.meta.url);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)

// Platform scope: top-level JS and every file under pages/components, excluding mocks and the office.
export function uiCodeFiles(root) {
  const walk = dir => readdirSync(join(root, dir), { withFileTypes:true }).flatMap(entry => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return entry.isFile() ? [rel] : [];
  });
  return [
    ...readdirSync(root, { withFileTypes:true }).filter(e => e.isFile() && e.name.endsWith('.js')).map(e => e.name),
    ...['pages', 'components'].flatMap(walk),
  ].sort();
}
