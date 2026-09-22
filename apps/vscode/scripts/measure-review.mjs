import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const [manifestPath, reviewPath] = process.argv.slice(2);
if (!manifestPath || !reviewPath) throw new Error('Usage: node scripts/measure-review.mjs <manifest.json> <review.json>');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const review = JSON.parse(await readFile(reviewPath, 'utf8'));
const result = await build({ entryPoints: [fileURLToPath(new URL('../../../packages/presentation/src/index.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
const { partitionChanges } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const matches = new Map(manifest.files.flatMap(file => file.items.map(item => [item.id, { file, item }])));
const chapters = review.chapters.map(chapter => {
  const selected = chapter.itemRefs.map(id => { if (!matches.has(id)) throw new Error(`Unknown item ${id}`); return matches.get(id); });
  const partition = partitionChanges(selected);
  const grouped = partition.transformations.flatMap(group => group.matches.map(({ item }) => item.id));
  const covered = [...grouped, ...partition.individual.map(({ item }) => item.id)];
  if (new Set(covered).size !== selected.length || covered.length !== selected.length) throw new Error(`Coverage changed in ${chapter.id}`);
  return { id: chapter.id, items: selected.length, groups: partition.transformations.length, grouped: grouped.length, individual: partition.individual.length };
});
const grouped = chapters.reduce((sum, chapter) => sum + chapter.grouped, 0);
console.log(JSON.stringify({ runId: manifest.runId, capturedFiles: manifest.files.length, skippedPaths: manifest.skipped.length, items: matches.size, grouped, individual: matches.size - grouped, chapters }, null, 2));
