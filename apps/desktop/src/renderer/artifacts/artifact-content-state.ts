import type { ArtifactContentInfoV2, ArtifactErrorCode, ArtifactReadValueV2 } from '@desktop-agent/contracts';

export type LoadedArtifact = { info: ArtifactContentInfoV2; text: string; imageUrl: string; hasBytes: boolean };
export type PreviewState = { requestId: number; saving: boolean; notice: string } & (
  | { phase: 'idle' | 'loading' }
  | { phase: 'ready'; loaded: LoadedArtifact; refreshing: boolean }
  | { phase: 'stale'; loaded: LoadedArtifact; error: ArtifactErrorCode }
  | { phase: 'error'; error: ArtifactErrorCode }
);
export const initialArtifactState: PreviewState = { phase: 'idle', requestId: 0, saving: false, notice: '' };
export type ArtifactAction =
  | { type: 'read'; requestId: number }
  | { type: 'loaded'; requestId: number; loaded: LoadedArtifact }
  | { type: 'failure'; requestId: number; error: ArtifactErrorCode }
  | { type: 'saving'; requestId: number; temporary?: boolean }
  | { type: 'saved'; requestId: number; notice: string; error?: ArtifactErrorCode };
export function canSaveArtifact(state: PreviewState): boolean {
  return state.phase === 'ready' && !state.refreshing && !state.saving;
}
export function artifactContentReducer(state: PreviewState, action: ArtifactAction): PreviewState {
  if (action.type === 'read') {
    if (state.saving || action.requestId <= state.requestId) return state;
    return 'loaded' in state ? { phase: 'ready', loaded: state.loaded, refreshing: true, requestId: action.requestId, saving: false, notice: '' }
      : { phase: 'loading', requestId: action.requestId, saving: false, notice: '' };
  }
  if (action.requestId !== state.requestId) return state;
  if (action.type === 'loaded') return { phase: 'ready', loaded: action.loaded, refreshing: false, requestId: state.requestId, saving: false, notice: '' };
  if (action.type === 'saving') return (!state.saving && (canSaveArtifact(state) || action.temporary)) ? { ...state, saving: true, notice: '' } : state;
  if (action.type === 'saved' && !action.error) return { ...state, saving: false, notice: action.notice };
  if (action.type === 'saved' && ['EXPORT_BUSY', 'EXPORT_TARGET_IS_SOURCE', 'WRITE_FAILED'].includes(action.error!)) {
    return { ...state, saving: false, notice: artifactErrorMessages[action.error!] };
  }
  const error = action.type === 'failure' ? action.error : action.type === 'saved' ? action.error! : 'IO_ERROR';
  return 'loaded' in state ? { phase: 'stale', loaded: state.loaded, error, requestId: state.requestId, saving: false, notice: '' }
    : { phase: 'error', error, requestId: state.requestId, saving: false, notice: '' };
}
/** Scope every response to the mounted panel and latest request, including errors and saves. */
export class ArtifactRequestGeneration {
  private generation = 0;
  next(): number { return ++this.generation; }
  isCurrent(id: number): boolean { return this.generation === id; }
  invalidate(): void { this.generation++; }
}
export function loadArtifactValue(value: ArtifactReadValueV2, previous: LoadedArtifact | undefined, image: boolean): LoadedArtifact | undefined {
  if (value.delivery === 'not-modified') {
    if (!previous || previous.info.sessionId !== value.info.sessionId || previous.info.artifactId !== value.info.artifactId
      || previous.info.currentRevision !== value.info.currentRevision) return undefined;
    return { ...previous, info: value.info };
  }
  if (value.delivery === 'metadata') return { info: value.info, text: '', imageUrl: '', hasBytes: false };
  const bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
  return { info: value.info, text: image ? '' : new TextDecoder().decode(bytes),
    imageUrl: image ? `data:${value.info.mimeType};base64,${value.data}` : '', hasBytes: true };
}
export const artifactErrorMessages: Record<ArtifactErrorCode, string> = {
  INVALID_REQUEST: '请求格式不兼容，请更新应用。', UNAUTHENTICATED: '登录状态已失效，请重新认证。',
  FORBIDDEN: '当前会话无权读取此文件。', NOT_FOUND: '当前会话中没有此交付物。',
  CONTENT_MISSING: '源文件已删除或移动。', CONTENT_TOO_LARGE: '文件超过 20 MiB，暂时无法读取或导出。',
  CONTENT_UNSTABLE: '文件正在变化，请稍后刷新。', REVISION_MISMATCH: '文件已更改，请刷新后再保存。',
  EXPORT_BUSY: '已有保存操作，请先完成或取消。', EXPORT_TARGET_IS_SOURCE: '不能覆盖源文件，请选择另存位置。',
  WRITE_FAILED: '保存失败，请检查位置权限或磁盘空间。', IO_ERROR: '读取失败，请重试。'
};
