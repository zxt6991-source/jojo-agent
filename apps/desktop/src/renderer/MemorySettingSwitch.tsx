import React from 'react';

export function SettingSwitch({
  id,
  title,
  description,
  checked,
  disabled = false,
  onChange
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <div className={`memory-setting-row ${disabled ? 'is-disabled' : ''}`}>
    <div className="browser-toggle-copy">
      <strong id={id}>{title}</strong>
      <span>{description}</span>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={id}
      disabled={disabled}
      className={`extension-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    ><span /></button>
  </div>;
}

