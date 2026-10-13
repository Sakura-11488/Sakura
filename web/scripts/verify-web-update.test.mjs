import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const file = new URL('../../sakura-mobile/components/WebUpdateBanner.tsx', import.meta.url);
const source = ts.createSourceFile('banner.tsx', fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'activateLatestWorker');
const code = ts.transpileModule(fn.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function load(serviceWorker) {
  const exports = {};
  vm.runInNewContext(code, { exports, navigator: { serviceWorker }, setTimeout, clearTimeout });
  return exports.activateLatestWorker;
}

test('refresh deadline includes both a stuck registration lookup and a stuck update', async () => {
  const never = () => new Promise(() => {});
  for (const getRegistration of [never, async () => ({ update: never })]) {
    await Promise.race([
      load({ getRegistration })(20),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Refresh ignored its deadline')), 300);
        timer.unref();
      }),
    ]);
  }
});

test('refresh watches the app worker until activation and removes its listener', async () => {
  const worker = new EventTarget();
  worker.state = 'installing';
  let listeners = 0;
  const add = worker.addEventListener.bind(worker);
  const remove = worker.removeEventListener.bind(worker);
  worker.addEventListener = (...args) => { listeners++; add(...args); };
  worker.removeEventListener = (...args) => { listeners--; remove(...args); };
  const refresh = load({ getRegistration: async scope => {
    assert.equal(scope, '/app/');
    return { update: async () => {}, installing: worker };
  } })(100);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(listeners, 1);
  worker.state = 'activated';
  worker.dispatchEvent(new Event('statechange'));
  await refresh;
  assert.equal(listeners, 0);
});

test('late update completion never attaches a listener after the deadline', async () => {
  let finishUpdate;
  const updating = new Promise(resolve => { finishUpdate = resolve; });
  let listeners = 0;
  const worker = { state: 'installing', addEventListener: () => { listeners++; } };
  await load({ getRegistration: async () => ({ update: () => updating, installing: worker }) })(10);
  finishUpdate();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(listeners, 0);
});

test('update errors resolve so the reload can continue', async () => {
  await load({ getRegistration: async () => ({ update: async () => { throw new Error('offline'); } }) })(100);
});
