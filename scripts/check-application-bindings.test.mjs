import { test } from 'node:test';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkApplicationBindings } from './check-application-bindings.mjs';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
test('checks every registered Operation and explicitly records transport gaps', () => {
  assert.deepEqual(checkApplicationBindings(read).errors, []);
});
test('rejects missing Operations, stale routes, SDK methods and IPC shared parsers', () => {
  const manifest = JSON.parse(read('packages/contracts/src/application/bindings.json'));
  delete manifest.bindings['session.list'];
  manifest.bindings['session.search'].http.path = '/api/v1/no-route';
  manifest.bindings['session.create'].sdk = 'JojoClient.notImplemented';
  const f = checkApplicationBindings(file => file.endsWith('bindings.json') ? JSON.stringify(manifest)
    : file.endsWith('scheduler-ipc.ts') ? read(file).replace("APPLICATION_OPERATIONS['schedule.save'].input.parse", 'OtherSchema.parse') : read(file));
  assert(f.errors.some(error => error.includes('session.list: missing binding')));
  assert(f.errors.some(error => error.includes('missing HTTP route')));
  assert(f.errors.some(error => error.includes('missing SDK method')));
  assert(f.errors.some(error => error.includes('IPC handler does not parse shared contract')));
});
test('rejects miswired Core routes and missing WS dispatch', () => {
  const f = checkApplicationBindings(file => file.endsWith('/server.ts') && file.includes('server-http')
    ? read(file).replace('core.searchSessionHistory(', 'core.listSessions(')
    : file.includes('server-core') ? read(file).replace("case 'session.search':", "case 'removed.search':") : read(file));
  assert(f.errors.some(error => error.includes('does not call declared Core')));
  assert(f.errors.some(error => error.includes('missing WS dispatch')));
});
