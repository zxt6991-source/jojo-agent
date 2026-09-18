import React from 'react';
import type { BrowserRecordingStep } from '@desktop-agent/contracts';
import { recordingStepLabel } from './recording-presentation';

export function BrowserRecordingSteps({ steps }: { steps: BrowserRecordingStep[] }) {
  return <ol className="browser-studio-timeline">{steps.map((step, index) => <li key={step.id}><b>{index + 1}</b><div><strong>{recordingStepLabel(step)}</strong></div></li>)}{steps.length === 0 && <li>没有步骤。</li>}</ol>;
}
