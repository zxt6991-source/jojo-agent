import { describe, expect, it } from 'vitest';
import { parseShellSecret } from './shell-secret-import';

describe('parseShellSecret', () => {
  it('reads exact exported and quoted assignments without executing the shell', () => {
    expect(parseShellSecret("export WEREAD_API_KEY='cookie=a; b=c'", 'WEREAD_API_KEY')).toBe('cookie=a; b=c');
    expect(parseShellSecret('WEREAD_API_KEY="plain-value" # comment', 'WEREAD_API_KEY')).toBe('plain-value');
  });

  it('uses the last safe assignment', () => {
    expect(parseShellSecret('TOKEN=old\nexport TOKEN=new', 'TOKEN')).toBe('new');
  });

  it('rejects expansions, commands, and different names', () => {
    expect(parseShellSecret('TOKEN=$(security find-generic-password)', 'TOKEN')).toBeUndefined();
    expect(parseShellSecret('TOKEN="$HOME/secret"', 'TOKEN')).toBeUndefined();
    expect(parseShellSecret('OTHER_TOKEN=safe', 'TOKEN')).toBeUndefined();
  });
});
