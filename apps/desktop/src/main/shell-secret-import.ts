const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function trailingCommentOnly(value: string): boolean {
  return /^\s*(?:#.*)?$/u.test(value);
}

function parseDoubleQuoted(value: string): string | undefined {
  let result = '';
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') return trailingCommentOnly(value.slice(index + 1)) ? result : undefined;
    if (character === '`' || character === '$') return undefined;
    if (character === '\\') {
      const next = value[index + 1];
      if (!next) return undefined;
      if (['\\', '"', '$', '`'].includes(next)) {
        result += next;
        index += 1;
        continue;
      }
      result += character;
      continue;
    }
    result += character;
  }
  return undefined;
}

export function parseShellSecret(source: string, name: string): string | undefined {
  if (!ENV_NAME.test(name)) return undefined;
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'u');
  let found: string | undefined;
  for (const line of source.split(/\r?\n/u)) {
    const match = assignment.exec(line);
    if (!match) continue;
    const raw = match[1] ?? '';
    let value: string | undefined;
    if (raw.startsWith("'")) {
      const closing = raw.indexOf("'", 1);
      if (closing > 0 && trailingCommentOnly(raw.slice(closing + 1))) value = raw.slice(1, closing);
    } else if (raw.startsWith('"')) {
      value = parseDoubleQuoted(raw);
    } else if (raw && !/[\s;&|<>`$()]/u.test(raw)) {
      value = raw;
    }
    if (value) found = value;
  }
  return found;
}
