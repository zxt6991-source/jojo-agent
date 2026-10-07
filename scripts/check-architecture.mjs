import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import process from 'node:process';

const ignored = new Set(['node_modules', '.git', '.vite', 'dist', 'out', 'coverage']);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  });
}

const prefix = '@desktop-agent/';
const allowed = {
  contracts: ['channel-core'], // channel-core contains only transport-neutral contracts/primitives.
  'channel-core': [],
  'agent-runtime': ['agent', 'contracts', 'attachment-access'],
  'app-service': ['agent-runtime', 'contracts'],
  'server-protocol': ['contracts']
};
const hostIndependent = new Set(['contracts', 'agent-runtime', 'app-service', 'server-protocol', 'runtime-composition']);
const hostModules = new Set(['electron', 'fastify', 'ws']);
const nodeModules = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

export function checkArchitecture(root) {
  const errors = [];
  const packages = new Map();
  for (const base of ['packages', 'apps']) {
    for (const entry of readdirSync(path.join(root, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, base, entry.name);
      let manifest;
      try { manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      packages.set(manifest.name, { directory, manifest });
    }
  }
  const graph = new Map([...packages.keys()].map((name) => [name, new Set()]));
  const checkBoundary = (owner, dependency, location) => {
    const shortName = owner.slice(prefix.length);
    if (dependency.startsWith(prefix) && allowed[shortName] && !allowed[shortName].includes(dependency.slice(prefix.length))) {
      errors.push(`${location}: forbidden dependency ${owner} -> ${dependency}`);
    }
    if (hostIndependent.has(shortName) && hostModules.has(dependency)) {
      errors.push(`${location}: host/transport dependency ${dependency} in ${owner}`);
    }
  };
  for (const [name, pkg] of packages) {
    for (const dependency of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies, ...pkg.manifest.peerDependencies })) {
      checkBoundary(name, dependency, `${name}/package.json`);
      if (packages.has(dependency)) graph.get(name).add(dependency);
      else if (dependency.startsWith(prefix)) errors.push(`${name}: unknown workspace dependency ${dependency}`);
    }
    for (const filename of files(pkg.directory).filter((file) => /\.[cm]?[jt]sx?$/.test(file))) {
      const relative = path.relative(pkg.directory, filename).split(path.sep).join('/');
      const production = relative.startsWith('src/') && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(relative) && !relative.includes('/test/');
      const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
      const imports = [];
      function visit(node) {
        if (production && name === '@desktop-agent/desktop' && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression) && ['store', 'sessionStore'].includes(node.expression.expression.text)
          && ['appendMessage', 'messages'].includes(node.expression.name.text)) {
          errors.push(`${path.relative(root, filename)}: Desktop conversation must use Runtime, not online JSONL ${node.expression.name.text}`);
        }
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imports.push(node.argument.literal.text);
        ts.forEachChild(node, visit);
      }
      visit(source);
      for (const specifier of imports) {
        const location = path.relative(root, filename).split(path.sep).join('/');
        if (production && relative.startsWith('src/renderer/') && (specifier.startsWith('node:') || nodeModules.has(specifier) || specifier === 'electron')) errors.push(`${location}: renderer imports Node/host module ${specifier}`);
        if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(filename), specifier);
          if (production && !target.startsWith(pkg.directory + path.sep)) errors.push(`${location}: cross-package relative import ${specifier}`);
          continue;
        }
        const dependency = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        if (production) checkBoundary(name, dependency, location);
        if (!specifier.startsWith(prefix)) continue;
        if (production && relative.startsWith('src/renderer/') && dependency !== '@desktop-agent/contracts') errors.push(`${location}: renderer imports workspace implementation ${dependency}`);
        const target = packages.get(dependency);
        if (!target) { errors.push(`${location}: unknown workspace import ${specifier}`); continue; }
        const subpath = specifier === dependency ? '.' : `.${specifier.slice(dependency.length)}`;
        if (!(subpath === '.' && typeof target.manifest.exports === 'string') && !Object.hasOwn(target.manifest.exports ?? {}, subpath)) errors.push(`${location}: non-public workspace import ${specifier}`);
        if (production && dependency !== name) {
          graph.get(name).add(dependency);
          if (!pkg.manifest.dependencies?.[dependency] && !pkg.manifest.optionalDependencies?.[dependency] && !pkg.manifest.peerDependencies?.[dependency]) errors.push(`${location}: undeclared production dependency ${dependency}`);
        }
      }
    }
  }
  const visited = new Set();
  const active = [];
  function visit(name) {
    const index = active.indexOf(name);
    if (index !== -1) { errors.push(`package cycle: ${[...active.slice(index), name].join(' -> ')}`); return; }
    if (visited.has(name)) return;
    active.push(name);
    for (const dependency of graph.get(name)) visit(dependency);
    active.pop();
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name);
  return [...new Set(errors)].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkArchitecture(path.resolve(fileURLToPath(new URL('..', import.meta.url))));
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write('Architecture checks passed.\n');
}
