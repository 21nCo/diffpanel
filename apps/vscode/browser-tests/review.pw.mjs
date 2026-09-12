import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

function fixture() {
  const files = Array.from({ length: 320 }, (_, index) => {
    const path = `src/feature-${index}/consumer.ts`;
    const item = { id: `item-${index}`, kind: 'hunk', filePath: path, oldPath: null, status: 'modified', ordinal: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: '@@ -1 +1 @@\n-import { foo } from "@/old";\n+import { foo } from "@/new";', contentHash: `h${index}` };
    return { id: `file-${index}`, filePath: path, oldPath: null, status: 'modified', beforeBlob: `b${index}`, afterBlob: `a${index}`, additions: 1, deletions: 1, language: 'typescript', size: 50, items: [item] };
  });
  files[0].items.push({ ...files[0].items[0], id: 'logic', ordinal: 1, oldStart: 10, newStart: 10, patch: '@@ -10 +10 @@\n-return false;\n+return true;' });
  const chapters = [
    { id: 'migration', parentId: null, title: 'Move shared utilities', summary: 'Consumers use the shared package.', order: 1, itemRefs: files.map((file) => file.items[0].id), keyChanges: [], diagram: 'flowchart LR\nOld["src/utils"] --> New["packages/shared"]', diagramItemRefs: ['item-0'] },
    { id: 'logic', parentId: null, title: 'Change fallback behavior', summary: 'The fallback now succeeds.', order: 2, itemRefs: ['logic'], keyChanges: [] },
  ];
  return { summary: { runId: 'review-1', repositoryName: 'example', reviewTitle: 'Shared utilities migration', status: 'ready', fileCount: 320, itemCount: 321, chapterCount: 2 }, manifest: { files }, review: { chapters, prologue: { motivation: 'Consolidate shared imports.', outcome: 'Consumers use the shared package.', diagram: null, focusAreas: [], complexity: { level: 'medium', reasoning: 'Confirm package exports.' } } } };
}

async function load(page, run, chapter, diagramDocument) {
  const bundle = diagramDocument ? "diagram-editor" : "webview";
  await page.route('http://diffpanel.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (['/webview.js', '/webview.css', '/diagram-editor.js', '/diagram-editor.css'].includes(path)) {
      return route.fulfill({ body: await readFile(new URL(`../dist${path}`, import.meta.url)), contentType: path.endsWith('.js') ? 'application/javascript' : 'text/css' });
    }
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-test';"><style>:root{--vscode-font-family:system-ui,sans-serif;--vscode-foreground:#d4d4d4;--vscode-descriptionForeground:#a8a8a8;--vscode-sideBar-background:#181818;--vscode-editor-background:#202020;--vscode-panel-border:#404040;--vscode-textLink-foreground:#75beff;--vscode-focusBorder:#007fd4;--vscode-badge-background:#454545;--vscode-badge-foreground:#fff;--vscode-textBlockQuote-background:#252525;--vscode-button-secondaryBackground:#333;--vscode-button-secondaryForeground:#fff;--vscode-list-hoverBackground:#2a2d2e;--vscode-textCodeBlock-background:#262626;--vscode-editor-font-family:monospace;font-size:13px;}</style><link rel="stylesheet" href="/${bundle}.css"></head><body><div id="root"></div><script nonce="test">window.messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m)});</script><script nonce="test" src="/${bundle}.js"></script></body></html>` });
  });
  await page.goto('http://diffpanel.test/');
  if (diagramDocument) {
    await expect(page.getByText('Loading diagram…')).toBeVisible();
    await page.evaluate(document => window.postMessage({ type: 'diagram', payload: document }, '*'), diagramDocument);
    return;
  }
  await expect(page.getByText('Select a review')).toBeVisible();
  await page.evaluate(({ run, chapter }) => window.postMessage({ type: 'selection', payload: { run, chapter } }, '*'), { run, chapter });
}

test('compresses 320 files, opens immutable evidence and navigates cross-chapter files', async ({ page }) => {
  const run = fixture();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await load(page, run, run.review.chapters[0]);
  await expect(page.locator('.diagram-canvas')).toHaveCount(0);
  await expect(page.locator('.transformation > summary')).toHaveText('@/old → @/new · 320 files · 320 changes');
  await expect(page.locator('.transformation .file-group:visible')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('grouped-review.png'), fullPage: false });
  await page.locator('.transformation > summary').click();
  await page.getByRole('button', { name: 'Open representative saved diff' }).click();
  expect(await page.evaluate(() => window.messages.at(-1))).toEqual({ type: 'openItem', runId: 'review-1', itemId: 'item-0' });
  await page.getByText('Browse all 320 affected files', { exact: true }).click();
  await expect(page.locator('.transformation .file-group:visible')).toHaveCount(30);
  await page.getByRole('button', { name: 'Show next 30 files (290 remaining)' }).click();
  await expect(page.locator('.transformation .file-group:visible')).toHaveCount(60);
  const firstFile = page.locator('.transformation .file-group').first();
  await firstFile.getByText('Also in 1 chapter', { exact: true }).click();
  await firstFile.getByRole('button', { name: 'Change fallback behavior' }).click();
  await expect(page.locator('h1')).toHaveText('Change fallback behavior');
  await expect(page.locator('.file-group')).toHaveCount(1);
  await page.getByRole('button', { name: 'All review files', exact: true }).click();
  await expect(page.locator('.file-group')).toHaveCount(30);
  const globalFirst = page.locator('.file-group').first();
  const toggle = globalFirst.getByRole('button', { name: '2 changes in src/feature-0/consumer.ts', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const singleFile = page.locator('.file-group').nth(1);
  await expect(singleFile.locator('.hunk-toggle')).toHaveCount(0);
  await expect(singleFile.locator('summary')).toHaveCount(0);
  await singleFile.getByRole('button', { name: 'Open saved diff for src/feature-1/consumer.ts', exact: true }).click();
  expect(await page.evaluate(() => window.messages.at(-1).itemId)).toBe('item-1');
  await globalFirst.getByRole('button', { name: 'line 10', exact: true }).click();
  expect(await page.evaluate(() => window.messages.at(-1).itemId)).toBe('logic');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('all-files.png'), fullPage: false });
  expect(errors).toEqual([]);
});

test('keeps mixed edits visible without inline diagrams', async ({ page }) => {
  const run = fixture();
  run.review.chapters[0].itemRefs.push('logic');
  run.review.chapters[1].itemRefs = [];
  run.review.chapters[0].diagram = 'this is not mermaid';
  await load(page, run, run.review.chapters[0]);
  await expect(page.getByText('Exceptions and other edits', { exact: true })).toBeVisible();
  const exception = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Exceptions and other edits', exact: true }) }).last().locator('.file-group');
  await expect(exception).toHaveCount(1);
  await page.setViewportSize({ width: 260, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('exceptions-narrow.png'), fullPage: false });
});

test('renders exact and edited moves as evidence-linked paths', async ({ page }) => {
  const run = fixture();
  run.manifest.files = run.manifest.files.slice(0, 3);
  for (const [index, file] of run.manifest.files.entries()) {
    file.status = 'renamed';
    file.oldPath = `old/${index}.ts`;
    file.items = [{ ...file.items[0], status: 'renamed', patch: '' }];
    if (index < 2) file.afterBlob = file.beforeBlob;
  }
  run.review.chapters[0].itemRefs = run.manifest.files.map((file) => file.items[0].id);
  await load(page, run, run.review.chapters[0]);
  await page.getByText('Observed path changes · 3 files', { exact: true }).click();
  await expect(page.locator('.move-map button.mapping')).toHaveCount(3);
  await expect(page.locator('.move-map')).toContainText('Moved and edited');
  await page.locator('.move-map button.mapping').first().click();
  expect(await page.evaluate(() => window.messages.at(-1).itemId)).toBe('item-0');
  await expect(page.locator('.transformation > summary')).toHaveText('Exact-content moves · 2 files · 2 changes');
});

test('discovers a chapter diagram and explains missing overview and skipped coverage', async ({ page }) => {
  const run = fixture();
  run.manifest.skipped = [{ filePath: 'old/unchanged.ts', reason: 'no textual hunks' }];
  run.review.diagramAssessment = { kind: 'architectural', reasoning: 'Host initialization needs a focused flow.', overviewOmissionReason: 'The saved subset does not establish the full ownership graph.' };
  await load(page, run);
  const directory = page.getByRole('region', { name: 'Available diagrams' });
  await expect(directory).toContainText('Diagrams · 1');
  await expect(directory).toContainText('No overview diagram generated. The saved subset does not establish the full ownership graph.');
  await directory.getByRole('button', { name: 'Move shared utilities' }).click();
  expect(await page.evaluate(() => window.messages.at(-1))).toEqual({ type: 'openDiagram', runId: 'review-1', chapterId: 'migration' });
  await expect(page.locator('h1')).toHaveText('Shared utilities migration');
  await expect(page.locator('.diagram-canvas')).toHaveCount(0);
  await page.getByText('Snapshot coverage · 320 captured files · 1 skipped path', { exact: true }).click();
  await expect(page.locator('.capture-coverage')).toContainText('old/unchanged.ts');
  await expect(page.locator('.capture-coverage')).toContainText('Prepare a fresh review');
  await page.screenshot({ path: test.info().outputPath('diagram-discovery.png'), fullPage: false });
  for (const chapter of [run.review.chapters[0], { ...run.review.chapters[0], id: 'nested', parentId: 'migration' }, { ...run.review.chapters[1], parentId: 'migration' }]) {
    await page.evaluate(({run, chapter}) => window.postMessage({ type: 'selection', payload: { run, chapter } }, '*'), {run, chapter});
    await expect(directory).toHaveCount(0);
    await expect(page.locator('.diagram-canvas')).toHaveCount(0);
    const openChapter = page.getByRole('button', { name: 'Open chapter diagram', exact: true });
    if (chapter.diagram) {
      await openChapter.click();
      expect(await page.evaluate(() => window.messages.at(-1))).toEqual({ type: 'openDiagram', runId: 'review-1', chapterId: chapter.id });
      await expect(page.locator('h1')).toHaveText(chapter.title);
    } else {
      await expect(openChapter).toHaveCount(0);
    }
  }
  await page.getByRole('button', { name: 'Review overview', exact: true }).click();
  await expect(directory).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open chapter diagram', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'All review files', exact: true }).click();
  await expect(directory).toHaveCount(0);
});

test('compresses renamed prefix migrations while retaining separate and mixed logic edits', async ({ page }) => {
  const run = fixture();
  run.manifest.files = run.manifest.files.slice(0, 4);
  for (const [index, file] of run.manifest.files.entries()) {
    file.status = 'renamed'; file.oldPath = `old/${index}.ts`;
    file.items[0].status = 'renamed';
    file.items[0].patch = `@@ -1 +1 @@\n-import { value } from "@old/utils/module${index}";\n+import { value } from "@shared/utils/module${index}";`;
    if (index === 3) file.items[0].patch += '\n-return false;\n+return true;';
  }
  run.review.chapters[0].itemRefs = run.manifest.files.flatMap(file => file.items.map(item => item.id));
  run.review.chapters[0].diagram = null;
  await load(page, run, run.review.chapters[0]);
  await expect(page.locator('.transformation > summary')).toHaveText('@old/* → @shared/* · 3 files · 3 changes');
  await expect(page.locator('.compression-summary')).toHaveText('3 changes in 1 transformation group · 2 individual changes');
  await expect(page.getByRole('heading', { name: 'Exceptions and other edits' })).toBeVisible();
  await page.locator('.transformation > summary').click();
  await page.getByText('Browse all 3 affected files', { exact: true }).click();
  await expect(page.locator('.transformation .file-group').nth(1)).toContainText('Moved + import rewrite');
  await expect(page.locator('.transformation .file-group').first()).toContainText('Moved and edited');
  await page.getByRole('button', { name: 'Open representative saved diff' }).click();
  expect(await page.evaluate(() => window.messages.at(-1).itemId)).toBe('item-0');
  await page.screenshot({ path: test.info().outputPath('renamed-prefix-review.png'), fullPage: false });
});


test('editor preview renders diagrams and evidence with malformed-source fallback', async ({ page }) => {
  const document = { title: 'Host initialization', source: 'flowchart LR\nShell-->Hosts', markdown: '# Host initialization', evidence: [{ itemId: 'item-0', label: 'src/hosts.ts — line 1' }] };
  await load(page, null, null, document);
  expect(await page.evaluate(() => window.messages[0])).toEqual({ type: 'ready' });
  await expect(page.locator('.diagram-canvas svg')).toBeVisible();
  await page.getByText('Saved evidence · 1', { exact: true }).click();
  await page.getByRole('button', { name: 'src/hosts.ts — line 1' }).click();
  expect(await page.evaluate(() => window.messages.at(-1))).toEqual({ type: 'openItem', itemId: 'item-0' });
  await page.screenshot({ path: test.info().outputPath('diagram-editor.png'), fullPage: false });
  document.source = 'not a mermaid diagram';
  await page.evaluate(document => window.postMessage({ type: 'diagram', payload: document }, '*'), document);
  await expect(page.getByRole('status')).toContainText('Could not render');
  document.source = 'flowchart LR\nA["<img src=x onerror=alert(1)>"]';
  await page.evaluate(document => window.postMessage({ type: 'diagram', payload: document }, '*'), document);
  await expect(page.getByRole('status')).toContainText('cannot be rendered');
  await expect(page.locator('.diagram-canvas img')).toHaveCount(0);
});
