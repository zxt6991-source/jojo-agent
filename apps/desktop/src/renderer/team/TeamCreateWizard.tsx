import React from 'react';
import { TEAM_TEMPLATES, type TeamTemplate } from './presets';
export function TeamCreateWizard({ onTemplate }: { onTemplate: (template: TeamTemplate) => void }) {
  return <section className="settings-section-card team-template-picker"><h2>你希望这个团队主要做什么？</h2><p>选择用途，再确认成员和团队工作方式。</p>
    <div className="team-template-grid">{TEAM_TEMPLATES.map((template) => <button key={template.id} type="button" onClick={() => onTemplate(template)}><strong>{template.title}</strong><span>{template.description}</span></button>)}</div>
    <p className="team-help">根据当前项目自动生成团队：后续提供。</p>
  </section>;
}
