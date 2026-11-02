import React from 'react';
import type { InsightCard as InsightCardValue, MessageReference } from '@desktop-agent/contracts';
import { conversationPlainText } from '../conversation-map';
import { localTime, natureLabels } from './state';

export function InsightCard({ card, disabled, onReadSource }: {
  card: InsightCardValue; disabled: boolean; onReadSource(reference: MessageReference): void;
}) {
  return <article className="conversation-map-card insight-card">
    <span className={`insight-nature ${card.nature}`}>{natureLabels[card.nature]}</span>
    <h3>{conversationPlainText(card.title)}</h3>
    <p className="insight-explanation">{conversationPlainText(card.explanation)}</p>
    {card.uncertainty && <p><strong>不确定性：</strong>{conversationPlainText(card.uncertainty)}</p>}
    {card.verificationQuestion && <div className="insight-question"><strong>值得验证</strong><p>{conversationPlainText(card.verificationQuestion)}</p></div>}
    <div className="conversation-map-reference-buttons" aria-label="原文依据">{card.supportingReferences.map(reference =>
      <button type="button" key={`${reference.sessionId}:${reference.entryId}`} disabled={disabled} onClick={() => onReadSource(reference)}>
        {reference.role === 'user' ? '用户原文' : 'AI 回复原文'} · {localTime(reference.createdAt)}
      </button>)}</div>
  </article>;
}
