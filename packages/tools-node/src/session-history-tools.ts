import { SessionSearchQuerySchema, SessionReadWindowQuerySchema, type Tool } from '@desktop-agent/contracts';
export function createSessionHistoryTools(): Tool[] {
  return [{
    risk: 'read', replay: 'safe', definition: {
      name: 'session_search',
      description: 'Find original user/assistant text in allowed durable session history. Local main user turns search the current project; channel, team and API turns are limited to their own session. Defaults to main conversations; source=all includes lower-ranked automation. Returns original entry IDs, sequence, time and project. This is lexical search; do not assume semantic recall or invent evidence.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, source: { type: 'string', enum: ['main', 'scheduler', 'team', 'spawn', 'all'] } }, required: ['query'], additionalProperties: false }
    },
    async execute(input, context) {
      const query = SessionSearchQuerySchema.parse(input);
      if (!context.searchSessionHistory) return { callId: '', ok: false, code: 'history_unavailable', content: 'Durable session search is unavailable in this host.' };
      const hits = await context.searchSessionHistory(query);
      return { callId: '', ok: true, content: JSON.stringify(hits), structuredResult: { hits } };
    }
  }, {
    risk: 'read', replay: 'safe', definition: {
      name: 'session_read_window', description: 'Read a bounded original text window around an entry sequence returned by session_search. Same session access policy; internal events, attachments and raw tool payloads are excluded. Maximum 12,000 characters total and 3,000 per message.',
      inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, anchorSeq: { type: 'integer', minimum: 0 }, before: { type: 'integer', minimum: 0, maximum: 10 }, after: { type: 'integer', minimum: 0, maximum: 10 }, maxCharacters: { type: 'integer', minimum: 1, maximum: 12000 } }, required: ['sessionId', 'anchorSeq'], additionalProperties: false }
    },
    async execute(input, context) {
      const query = SessionReadWindowQuerySchema.parse(input);
      if (!context.readSessionHistoryWindow) return { callId: '', ok: false, code: 'history_unavailable', content: 'Durable history windows are unavailable in this host.' };
      const window = await context.readSessionHistoryWindow(query);
      return { callId: '', ok: true, content: JSON.stringify(window), structuredResult: window };
    }
  }];
}
