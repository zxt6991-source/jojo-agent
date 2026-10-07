import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { BUILD_COMPATIBILITY } from '../packages/contracts/src/build-compatibility.ts';
import { CAPABILITY_MANIFEST, SCHEDULER_TARGETS } from '../packages/contracts/src/capability-manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const appVersion = JSON.parse(read('package.json')).version;
if (appVersion !== BUILD_COMPATIBILITY.appVersion) throw new Error('Root package version differs from BUILD_COMPATIBILITY.appVersion');
const support = (value) => value ? '支持' : '未内置';
const table = [
  '| 能力 | Desktop | Headless Server | 所需 Adapter |',
  '|---|---|---|---|',
  ...CAPABILITY_MANIFEST.map((item) => `| ${item.id} | ${support(item.desktop)} | ${support(item.server)} | ${item.requiredAdapters.join(', ')} |`)
].join('\n');
const generated = `# 当前版本与内置能力（自动生成）

由 \`pnpm docs:generate\` 生成；请修改 contracts 中的 build-compatibility.ts / capability-manifest.ts。

## 格式版本

| 格式 | 当前版本 |
|---|---|
${Object.entries(BUILD_COMPATIBILITY).map(([name, value]) => `| ${name} | ${value ?? '尚未实现版本握手'} |`).join('\n')}

这些数值表示当前写入格式，不承诺旧版本兼容；兼容性必须由迁移测试验证。

## 内置 Host 能力

${table}

这里描述内置 Host 的可用能力；Scheduler、Channel 等可选服务的实际启用状态由 ServerCapabilities 返回，定制 Host 可以覆盖默认能力。CLI 与 Client 应读取服务端能力，不能把此表当作当前连接的实时状态。

- Desktop Scheduler targets：${SCHEDULER_TARGETS.desktop.join(', ')}。
- Headless Scheduler targets：${SCHEDULER_TARGETS.server.join(', ')}。
- Desktop 的功能可见性尚未全部接入此 Manifest。
`;
const start = '<!-- generated:compatibility:start -->';
const end = '<!-- generated:compatibility:end -->';
const summary = `${start}
当前应用版本：\`${BUILD_COMPATIBILITY.appVersion}\`；Server 协议版本：\`${BUILD_COMPATIBILITY.serverProtocol}\`。完整格式版本与内置能力见 [自动生成的能力清单](docs/current-features.generated.md)。
${end}`;
const readme = read('README.md');
const from = readme.indexOf(start);
const to = readme.indexOf(end);
if (from < 0 || to < from) throw new Error('README compatibility markers are missing');
// Read literal operation metadata without evaluating application dependencies in Node.
const operationSource = ts.createSourceFile('operations.ts', read('packages/contracts/src/application/operations.ts'), ts.ScriptTarget.Latest, true);
let operationObject;
for (const statement of operationSource.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.name.getText(operationSource) !== 'APPLICATION_OPERATIONS') continue;
    const value = declaration.initializer;
    operationObject = value && ts.isAsExpression(value) ? value.expression : value;
  }
}
if (!operationObject || !ts.isObjectLiteralExpression(operationObject)) throw new Error('Operation registry must be an object literal');
const operationRows = operationObject.properties.map((property) => {
  if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isCallExpression(property.initializer)) throw new Error('Unsupported operation descriptor');
  const descriptor = property.initializer.arguments[0];
  if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) throw new Error('Operation metadata must be literal');
  const fields = new Map(descriptor.properties.map((field) => {
    if (!ts.isPropertyAssignment(field)) throw new Error('Unsupported operation metadata');
    const value = field.initializer;
    return [field.name.getText(operationSource), ts.isStringLiteral(value) ? value.text : value.getText(operationSource)];
  }));
  return `| ${property.name.text} | ${fields.get('kind')} | ${fields.get('permission')} | ${fields.get('idempotent')} |`;
});
const operationDoc = `# 应用操作目录（自动生成）

由 contracts/application/operations.ts 的 APPLICATION_OPERATIONS 生成。
输入为业务 body/query，资源 ID 由 Transport 路由携带；输出为中立应用结果，Transport 可增加自己的 envelope。

| 操作 | 类型 | 权限 scope | 无幂等键可安全重试 |
|---|---|---|---|
${operationRows.join('\n')}

Registry 描述已纳入本轮的操作，并不表示所有 Host 都实现了每项能力。
Server Core 使用这些 scope；Desktop 仍使用本地权限治理。Desktop 的审批 scope、密钥引用、附件限制和 Session 元数据格式由 Host 适配层保留。
`;
const outputs = new Map([
  ['docs/current-features.generated.md', generated],
  ['docs/current-operations.generated.md', operationDoc],
  ['README.md', readme.slice(0, from) + summary + readme.slice(to + end.length)]
]);
for (const [file, expected] of outputs) {
  let current;
  try { current = read(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current === expected) continue;
  if (check) {
    process.stderr.write(`${file} is stale; run pnpm docs:generate\n`);
    process.exitCode = 1;
  } else writeFileSync(path.join(root, file), expected);
}
