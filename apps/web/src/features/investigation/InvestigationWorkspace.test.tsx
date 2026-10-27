import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium, type Browser, type Page} from 'playwright';

const inventoryPaths = ['', '/analysis-context', '/evidence', '/hypotheses', '/reports', '/comments', '/follow-ups', '/snapshots'];
type Read = {id: number; path: string; suffix: string; caseId: string; cycle: number; settled: boolean; aborted: boolean};
type Harness = {reads: Read[]; maximum: number; active: number; ignoreAbort: boolean; publications: string[]; complete: (id: number, data: unknown, failure?: boolean) => void};
declare global {interface Window {inventoryTest: Harness; changeCase: (caseId: string) => void; unmountWorkspace: () => void;}}

let bundle: Promise<string> | undefined;
let browser: Browser;
before(async () => {
  await componentBundle();
  browser = await chromium.launch({headless: true, chromiumSandbox: true, ...(process.platform === 'win32' ? {channel: 'msedge'} : {})});
});
after(async () => {await browser?.close();});
function componentBundle() {
  return bundle ??= build({stdin: {contents: `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import {InvestigationWorkspace} from './apps/web/src/features/investigation/InvestigationWorkspace';
    const root = createRoot(document.getElementById('root'));
    function Fixture() {const [caseId,setCaseId] = useState('case-one'); window.changeCase=setCaseId; return <InvestigationWorkspace workspace={{id:'workspace',name:'Local test',role:'owner',revision:1,created_at:''}} csrf="unit-token" currentUserId="unit-user" caseId={caseId} navigate={()=>{}} onChanged={()=>window.inventoryTest.publications.push(caseId)} />;}
    window.unmountWorkspace=()=>root.unmount(); root.render(<Fixture />);`, resolveDir: process.cwd(), loader: 'tsx'}, bundle: true, write: false, format: 'iife', platform: 'browser', tsconfig: 'apps/web/tsconfig.json', logLevel: 'silent', plugins: [{name: 'isolated-child-panels', setup(builder) {
      // Keep the actual workspace, resource transport, state, effects and navigation.
      // Child probes expose their received props without starting unrelated reads.
      builder.onLoad({filter: /[\\/]features[\\/](?:investigation[\\/](?:AnalyticsPanel|CommentsPanel|EvidencePanel|TimelinePanel|FollowUpsPanel|HypothesesPanel|ReportsPanel|ExternalVerificationPanel)|providers[\\/]ModelProposals|targets[\\/]StagingRegistryPanel)\.tsx$/}, args => {
        const name = args.path.split(/[\\/]/).at(-1)!.replace('.tsx', '');
        return {loader: 'tsx', contents: `export function ${name}(props) {return <section data-testid="${name}"><pre>{JSON.stringify(props)}</pre>${name === 'ReportsPanel' ? '<button onClick={()=>props.onSelect("report-second")}>Select second report</button><button onClick={()=>void props.onChanged("report-old-refresh")}>First child refresh</button><button onClick={()=>void props.onChanged("report-new-refresh")}>Second child refresh</button>' : ''}</section>;}`};
      });
    }}]}).then(result => result.outputFiles[0]!.text);
}

async function withWorkspace(run: (page: Page) => Promise<void>) {
  const script = await componentBundle();
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(({paths}) => {
      const pending = new Map<number, {resolve: (value: Response) => void; reject: (error: unknown) => void; active: boolean}>();
      const cycles = new WeakMap<AbortSignal, number>();
      let nextCycle = 0;
      const state: Harness = {reads: [], maximum: 0, active: 0, ignoreAbort: false, publications: [], complete(id, data, failure = false) {
        const task = pending.get(id), read = state.reads.find(item => item.id === id);
        if (!task || !read || read.settled) return;
        read.settled = true;
        if (task.active) {task.active = false; state.active -= 1;}
        task.resolve(failure ? Response.json({error: {code: 'UNIT_READ_FAILED', message: String(data)}}, {status: 503}) : Response.json({data}));
      }};
      window.inventoryTest = state;
      window.fetch = async (input, options) => {
        if ((options?.method ?? 'GET') !== 'GET') throw new Error('This test permits reads only.');
        const path = String(input), match = /\/cases\/([^/]+)(.*)$/.exec(path);
        if (!match) throw new Error('Unexpected non-investigation read.');
        const [,caseId,suffix] = match;
        if (!paths.includes(suffix)) {
          state.reads.push({id: state.reads.length, path, caseId, suffix, cycle: 0, settled: true, aborted: false});
          if (suffix.startsWith('/reports/')) return Response.json({data: {id: suffix.slice('/reports/'.length), value: {title: `Exact ${suffix.slice('/reports/'.length)}`}}});
          throw new Error('Unexpected investigation read.');
        }
        const signal = options?.signal as AbortSignal;
        let cycle = cycles.get(signal);
        if (!cycle) {cycle = ++nextCycle; cycles.set(signal, cycle);}
        const read: Read = {id: state.reads.length, path, caseId, suffix, cycle, settled: false, aborted: false};
        state.reads.push(read); state.active += 1; state.maximum = Math.max(state.maximum, state.active);
        return new Promise<Response>((resolve, reject) => {
          const task = {resolve, reject, active: true, abort() {read.aborted = true; if (task.active) {task.active = false; state.active -= 1;} if (!state.ignoreAbort) {read.settled = true; reject(new DOMException('Aborted test read.', 'AbortError'));}}}; pending.set(read.id, task);
          if (signal.aborted) task.abort(); else signal.addEventListener('abort', () => task.abort(), {once: true});
        });
      };
    }, {paths: inventoryPaths});
    await page.route('http://inventory.localhost/**', route => route.fulfill({contentType: 'text/html', body: `<div id="root"></div><script>${script}</script>`}));
    await page.goto('http://inventory.localhost/investigation');
    await page.waitForFunction(() => window.inventoryTest.reads.length === 2);
    await run(page);
    assert.deepEqual(errors, [], 'The actual workspace must render without browser errors.');
  } catch (error) {
    console.error('Workspace test state:', JSON.stringify(await page.evaluate(() => ({text: document.body.textContent?.slice(0, 1200), reads: window.inventoryTest?.reads, publications: window.inventoryTest?.publications}))), 'Browser errors:', errors);
    throw error;
  } finally {await page.close();}
}

function valueFor(read: Read, marker: string): unknown {
  if (read.suffix === '') return {id: read.caseId, title: `${marker} investigation`, question: `${marker} question`, workspace_id: 'workspace', active_revision_id: marker, archived: false, lifecycle: 'open', revision: 1};
  if (read.suffix === '/analysis-context') return {binding: {revision_id: marker}, marker};
  if (read.suffix === '/reports') return [{id: 'report-first', marker}, {id: 'report-second', marker}];
  return [{id: `${marker}${read.suffix}`, marker}];
}

async function completeCycle(page: Page, cycle: number, marker: string, failure?: string, malformed?: string) {
  for (;;) {
    const reads = await page.evaluate(cycle => window.inventoryTest.reads.filter(read => read.cycle === cycle), cycle);
    if (reads.length === 8 && reads.every(read => read.settled)) return;
    const pending = reads.filter(read => !read.settled);
    assert.ok(pending.length, 'A current inventory cycle must have a dispatched read until all eight settle.');
    for (const read of pending) await page.evaluate(({id, data, failed}) => window.inventoryTest.complete(id, data, failed), {id: read.id, data: read.suffix === failure ? `${marker} ${failure} failed` : read.suffix === malformed ? {unexpected: true} : valueFor(read, marker), failed: read.suffix === failure});
    await page.waitForFunction(({cycle, count}) => {const reads = window.inventoryTest.reads.filter(read => read.cycle === cycle); return reads.length > count || reads.length === 8 && reads.every(read => read.settled);}, {cycle, count: reads.length});
  }
}

async function panelProps(page: Page, name: string) {
  return JSON.parse((await page.getByTestId(name).locator('pre').textContent())!);
}

test('workspace inventories run at most two reads, publish all eight together and retain tab/report navigation', {timeout: 60000}, async () => {
  await withWorkspace(async page => {
    assert.equal(await page.getByText('Loading investigation…').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.reads.map(read => read.suffix)), ['', '/analysis-context']);
    // Let the second worker progress while the first read is still outstanding.
    await page.evaluate(() => window.inventoryTest.complete(1, {binding: {revision_id: 'complete'}}));
    await page.waitForFunction(() => window.inventoryTest.reads.length === 3);
    assert.equal(await page.getByText('Loading investigation…').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.publications), []);
    await completeCycle(page, 1, 'complete');
    await page.getByRole('heading', {name: 'complete investigation', exact: true}).waitFor();
    const reads = await page.evaluate(() => window.inventoryTest.reads.filter(read => read.cycle === 1));
    assert.deepEqual(reads.map(read => read.suffix), inventoryPaths);
    assert.equal(await page.evaluate(() => window.inventoryTest.maximum), 2);
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.publications), ['case-one']);
    assert.equal((await panelProps(page, 'AnalyticsPanel')).context.binding.revision_id, 'complete');
    for (const [panel, property] of [['EvidencePanel','evidence'], ['HypothesesPanel','hypotheses'], ['ReportsPanel','reports'], ['CommentsPanel','comments'], ['FollowUpsPanel','followups'], ['FollowUpsPanel','snapshots']]) assert.equal((await panelProps(page, panel))[property][0].marker, 'complete', `${property} reaches its current panel`);
    assert.equal((await panelProps(page, 'EvidencePanel')).known, true);
    await page.getByLabel('Work area').selectOption('reports');
    assert.equal(await page.locator('#panel-reports').isVisible(), true);
    assert.equal(await page.locator('#panel-evidence').isHidden(), true);
    await page.getByRole('button', {name: 'Select second report'}).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('report') === 'report-second');
    await page.waitForFunction(() => document.querySelector('[data-testid="ReportsPanel"] pre')?.textContent?.includes('Exact report-second'));
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'reports');
    assert.equal((await panelProps(page, 'ReportsPanel')).selectedReport.id, 'report-second');
  });
});

test('one failed or malformed inventory remains visible without skipping independent reads, and refresh recovers', {timeout: 60000}, async () => {
  await withWorkspace(async page => {
    await completeCycle(page, 1, 'partial', '/hypotheses', '/comments');
    await page.getByRole('heading', {name: 'partial investigation', exact: true}).waitFor();
    assert.equal(await page.evaluate(() => window.inventoryTest.maximum), 2);
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.reads.filter(read => read.cycle === 1).map(read => read.suffix)), inventoryPaths);
    assert.match((await page.locator('body').textContent())!, /partial \/hypotheses failed/);
    assert.match((await page.locator('body').textContent())!, /comments is unavailable/);
    assert.equal((await panelProps(page, 'HypothesesPanel')).known, false);
    assert.deepEqual((await panelProps(page, 'HypothesesPanel')).hypotheses, []);
    assert.equal((await panelProps(page, 'CommentsPanel')).known, false);
    assert.equal((await panelProps(page, 'FollowUpsPanel')).snapshots[0].marker, 'partial');
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.publications), []);
    await page.getByRole('button', {name: 'Refresh', exact: true}).click();
    await page.waitForFunction(() => window.inventoryTest.reads.some(read => read.cycle === 2));
    await completeCycle(page, 2, 'recovered');
    await page.getByRole('heading', {name: 'recovered investigation', exact: true}).waitFor();
    assert.equal((await panelProps(page, 'HypothesesPanel')).known, true);
    assert.equal((await panelProps(page, 'CommentsPanel')).comments[0].marker, 'recovered');
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.publications), ['case-one']);
  });
});

test('obsolete case loads and unmount abort outstanding reads and cannot dispatch queued resources or publish late data', {timeout: 60000}, async () => {
  await withWorkspace(async page => {
    // Ignore transport cancellation deliberately: late replies must still be fenced.
    await page.evaluate(() => {window.inventoryTest.ignoreAbort = true; window.changeCase('case-two');});
    await page.waitForFunction(() => window.inventoryTest.reads.filter(read => read.cycle === 2).length === 2);
    const oldReads = await page.evaluate(() => window.inventoryTest.reads.filter(read => read.cycle === 1));
    assert.equal(oldReads.every(read => read.aborted), true);
    for (const read of oldReads) await page.evaluate(({id,data}) => window.inventoryTest.complete(id,data), {id: read.id, data: valueFor(read, 'obsolete')});
    await page.evaluate(() => Promise.resolve());
    assert.equal(await page.evaluate(() => window.inventoryTest.reads.filter(read => read.cycle === 1).length), 2);
    assert.equal(await page.getByText('Loading investigation…').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.publications), []);
    await completeCycle(page, 2, 'current');
    await page.getByRole('heading', {name: 'current investigation', exact: true}).waitFor();
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.publications), ['case-two']);
    assert.doesNotMatch((await page.locator('body').textContent())!, /obsolete investigation/);
    await page.evaluate(() => window.changeCase('discarded-case'));
    await page.waitForFunction(() => window.inventoryTest.reads.filter(read => read.cycle === 3).length === 2);
    await page.evaluate(() => window.unmountWorkspace());
    const discarded = await page.evaluate(() => window.inventoryTest.reads.filter(read => read.cycle === 3));
    assert.equal(discarded.every(read => read.aborted), true);
    for (const read of discarded) await page.evaluate(({id,data}) => window.inventoryTest.complete(id,data), {id: read.id, data: valueFor(read, 'discarded')});
    await page.evaluate(() => Promise.resolve());
    assert.equal(await page.evaluate(() => window.inventoryTest.reads.filter(read => read.cycle === 3).length), 2);
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.publications), ['case-two']);
  });
});

test('a newer child refresh owns publication, busy state and exact report selection when an obsolete refresh replies late', {timeout: 60000}, async () => {
  await withWorkspace(async page => {
    await completeCycle(page, 1, 'initial');
    await page.getByRole('heading', {name: 'initial investigation', exact: true}).waitFor();
    await page.getByLabel('Work area').selectOption('reports');
    await page.evaluate(() => {window.inventoryTest.ignoreAbort = true;});
    await page.getByRole('button', {name: 'First child refresh'}).click();
    await page.waitForFunction(() => window.inventoryTest.reads.filter(read => read.cycle === 2).length === 2);
    await page.getByRole('button', {name: 'Second child refresh'}).click();
    await page.waitForFunction(() => window.inventoryTest.reads.filter(read => read.cycle === 3).length === 2);
    const obsolete = await page.evaluate(() => window.inventoryTest.reads.filter(read => read.cycle === 2));
    assert.equal(obsolete.every(read => read.aborted), true);
    for (const read of obsolete) await page.evaluate(({id,data}) => window.inventoryTest.complete(id,data), {id: read.id, data: valueFor(read, 'obsolete-refresh')});
    await page.evaluate(() => Promise.resolve());
    assert.equal(await page.getByRole('button', {name: 'Refreshing…', exact: true}).isDisabled(), true);
    await completeCycle(page, 3, 'latest-refresh');
    await page.getByRole('heading', {name: 'latest-refresh investigation', exact: true}).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="ReportsPanel"] pre')?.textContent?.includes('Exact report-new-refresh'));
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'reports');
    assert.equal(new URL(page.url()).searchParams.get('report'), 'report-new-refresh');
    assert.equal((await panelProps(page, 'ReportsPanel')).selectedReport.id, 'report-new-refresh');
    assert.equal(await page.getByRole('button', {name: 'Refresh', exact: true}).isEnabled(), true);
    assert.equal(await page.evaluate(() => window.inventoryTest.reads.filter(read => read.cycle === 2).length), 2);
    assert.equal(await page.evaluate(() => window.inventoryTest.reads.some(read => read.suffix === '/reports/report-old-refresh')), false);
    assert.equal(await page.evaluate(() => window.inventoryTest.maximum), 2);
    assert.deepEqual(await page.evaluate(() => window.inventoryTest.publications), ['case-one', 'case-one']);
  });
});
