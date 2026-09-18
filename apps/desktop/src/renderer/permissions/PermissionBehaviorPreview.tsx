import React from 'react';
import { permissionModes } from './permission-copy';
export function PermissionBehaviorPreview({ mode }: { mode: keyof typeof permissionModes }) {
  const rows = [
    ['项目内读取', '通常自动允许'],
    ['项目内修改', mode === 'ask' ? '询问' : '自动允许'],
    ['不联网、不使用密钥的普通隔离命令', mode === 'ask' ? '询问' : '自动允许'],
    ['高风险命令、联网与外部操作', mode === 'yolo' ? '普通审批自动允许' : '通常询问'],
    ['系统保护操作', '始终询问或阻止']
  ];
  return <section className="permission-block" aria-label="行为预览"><h3>按当前模式，Jojo 通常会</h3>
    <dl className="permission-behavior">{rows.map(([name, result]) => <div key={name}><dt>{name}</dt><dd>{result}</dd></div>)}</dl>
    <p>这是模式的基础行为预览。例外规则、对话授权和工具安全检查会影响最终结果。</p>
  </section>;
}
export function PermissionSystemGuards() {
  return <section className="permission-block"><h3>🔒 系统保护</h3><p>这些保护无法通过确认策略或自动执行规则关闭。阻止规则仍可进一步限制操作。</p>
    <ul><li>向项目外写入文件：始终阻止</li><li>访问项目外文件、安装技能、信任项目钩子：需要确认</li><li>命令同时使用主机网络和密钥：需要确认</li><li>极高风险命令且隔离保护不足：需要确认</li></ul>
  </section>;
}
