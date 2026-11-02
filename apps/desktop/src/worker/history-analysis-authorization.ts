import { sessionHasProject, type ConversationMapGenerateInput, type ConversationMapScope, type SessionMeta } from '@desktop-agent/contracts';
import { createProjectIdentity } from '@desktop-agent/memory';

export interface HistoryAnalysisAuthorization {
  allowedSessionIds: string[];
  projectDirectory?: string;
  scope: ConversationMapScope;
}

/** Shared authority for on-demand analysis; the repository further filters provenance. */
export async function authorizeHistoryAnalysis(
  input: Pick<ConversationMapGenerateInput, 'scope' | 'currentSessionId'>,
  listSessions: () => Promise<SessionMeta[]>
): Promise<HistoryAnalysisAuthorization> {
  const sessions = await listSessions();
  if (input.scope.kind === 'personal_main') return { allowedSessionIds: sessions.map(s => s.id), scope: input.scope };
  const selected = sessions.find(s => s.id === input.currentSessionId);
  if (!selected || !sessionHasProject(selected)) throw new Error('当前项目已不可用，请重新选择范围。');
  const [identity, requested] = await Promise.all([
    createProjectIdentity(selected.workingDirectory), createProjectIdentity(input.scope.workingDirectory)
  ]);
  if (!identity || identity.id !== requested?.id) throw new Error('项目范围与当前对话不匹配。');
  const matching = await Promise.all(sessions.map(async session => {
    if (!sessionHasProject(session)) return undefined;
    const candidate = await createProjectIdentity(session.workingDirectory);
    return candidate?.id === identity.id ? session.id : undefined;
  }));
  return { allowedSessionIds: matching.filter((id): id is string => !!id), projectDirectory: identity.canonicalPath,
    scope: { kind: 'project', workingDirectory: identity.canonicalPath } };
}
