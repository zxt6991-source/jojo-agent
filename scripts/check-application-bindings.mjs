import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import path from 'node:path';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
export function checkApplicationBindings(read = file => readFileSync(path.join(root, file), 'utf8')) {
  const errors = [];
  const parse = file => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const registry = parse('packages/contracts/src/application/operations.ts');
  const ids = new Set();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(registry) === 'APPLICATION_OPERATIONS') {
      const object = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      for (const property of object.properties) ids.add(property.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(registry);
  if (!ids.size) throw new Error('Application Operation registry is empty');
  const manifest = JSON.parse(read('packages/contracts/src/application/bindings.json'));
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported binding manifest version');
  const bindings = manifest.bindings;
  const core = parse('packages/server-core/src/server.ts');
  const client = parse('packages/client/src/client.ts');
  const server = parse('packages/server-http/src/server.ts');
  const methods = new Set(), sdkMethods = new Set(), commands = new Set(), routes = new Map();
  function inspectCore(node) {
    if (ts.isMethodDeclaration(node)) methods.add(node.name.getText(core));
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) commands.add(node.expression.text);
    ts.forEachChild(node, inspectCore);
  }
  inspectCore(core);
  function inspectClient(node) {
    if (ts.isClassDeclaration(node)) for (const member of node.members) {
      if (ts.isMethodDeclaration(member)) sdkMethods.add(`${node.name.text}.${member.name.getText(client)}`);
    }
    ts.forEachChild(node, inspectClient);
  }
  inspectClient(client);
  function inspectHttp(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(server) === 'app' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      routes.set(`${node.expression.name.text} ${node.arguments[0].text}`, node.getText(server));
    }
    ts.forEachChild(node, inspectHttp);
  }
  inspectHttp(server);
  const reason = value => typeof value?.reason === 'string' && value.reason.trim().length >= 10;
  const claimedRoutes = new Set();
  for (const id of ids) {
    const binding = bindings[id];
    if (!binding) { errors.push(`${id}: missing binding`); continue; }
    if (binding.core && !methods.has(binding.core)) errors.push(`${id}: missing Core method ${binding.core}`);
    if (!binding.core && !reason(binding.http)) errors.push(`${id}: Core exemption needs a reason`);
    if (binding.sdk && !sdkMethods.has(binding.sdk)) errors.push(`${id}: missing SDK method ${binding.sdk}`);
    if (!binding.sdk && !reason(binding.http)) errors.push(`${id}: SDK exemption needs a reason`);
    if (binding.http?.path) {
      const key = `${binding.http.method} ${binding.http.path}`;
      const handler = routes.get(key);
      if (!handler) errors.push(`${id}: missing HTTP route ${key}`);
      else if (binding.core && !handler.includes(`core.${binding.core}(`)) errors.push(`${id}: HTTP route does not call declared Core method`);
      if (claimedRoutes.has(key)) errors.push(`${id}: duplicate HTTP route ${key}`);
      claimedRoutes.add(key);
    } else if (!reason(binding.http)) errors.push(`${id}: HTTP exemption needs a reason`);
    if (binding.ws?.command) {
      if (!commands.has(binding.ws.command)) errors.push(`${id}: missing WS dispatch ${binding.ws.command}`);
    } else if (!reason(binding.ws)) errors.push(`${id}: WS exemption needs a reason`);
    if (binding.ipc?.handler) {
      const ipc = read(binding.ipc.file);
      if (!ipc.includes(`ipcMain.handle(IPC.${binding.ipc.handler},`)) errors.push(`${id}: missing IPC handler ${binding.ipc.handler}`);
      if (!ipc.includes(`APPLICATION_OPERATIONS['${id}'].input.parse`)) errors.push(`${id}: IPC handler does not parse shared contract`);
    } else if (!reason(binding.ipc)) errors.push(`${id}: IPC exemption needs a reason`);
  }
  for (const id of Object.keys(bindings)) if (!ids.has(id)) errors.push(`${id}: unknown Operation`);
  return { errors, bindings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, bindings } = checkApplicationBindings();
  if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
  else process.stdout.write(`Application bindings checked: ${Object.keys(bindings).length} Operations. Explicit transport gaps remain documented.\n`);
}
