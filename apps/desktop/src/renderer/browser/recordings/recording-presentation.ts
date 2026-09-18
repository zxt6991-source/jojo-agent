import type { BrowserRecordingStep } from '@desktop-agent/contracts';

export const recordingScope = { user: '个人', project: '项目', builtin: '内置' };
export const recordingScopeHelp = { user: '保存在你的电脑上，可在所有项目中使用。', project: '由当前项目提供，首次使用或内容变化后可能需要重新信任。', builtin: '由应用提供。' };
const actions: Record<string, string> = { navigate: '打开网页', click: '点击', hover: '悬停', type: '输入内容', press: '按键', select: '选择选项', upload: '上传文件', download: '下载文件', wait: '等待页面', scroll: '滚动页面', extract: '读取内容', assert: '检查页面', screenshot: '截图', back: '返回上一页', reload: '刷新页面' };
export const recordingAction = (action: string) => actions[action] ?? '网页操作';
export function recordingStepLabel(step: BrowserRecordingStep): string {
  if (step.label) return step.label;
  if (step.action === 'navigate') return `打开 ${step.url ?? '网页'}`;
  const fingerprint = step.target?.fingerprint;
  const target = fingerprint?.accessibleName ?? fingerprint?.placeholder ?? fingerprint?.fieldName;
  if (step.action === 'press') return `按下 ${step.key ?? '按键'}`;
  return `${recordingAction(step.action)}${target ? `：${target}` : step.target ? '（页面元素）' : ''}`;
}
export function recordingRunState(state: string): string {
  if (state.includes('failed')) return '失败';
  if (state === 'run_completed') return '运行完成';
  if (state.includes('verified')) return '验证通过';
  if (state.includes('started')) return '开始执行';
  if (state.includes('completed')) return '步骤完成';
  if (state.includes('heal')) return '修复选择器';
  return '执行中';
}
