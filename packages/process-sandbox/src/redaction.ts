const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY)(?:_|$)/iu;

export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of [...knownSecrets].sort((left, right) => right.length - left.length)) {
    if (secret.length >= 4) safe = safe.split(secret).join('[REDACTED]');
  }
  safe = safe.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]');
  safe = safe.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+@/giu, '$1[REDACTED]@');
  safe = safe.replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/giu, '[REDACTED PRIVATE KEY]');
  return safe.split('\n').map((line) => {
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(=.*)$/u.exec(line);
    return match && SENSITIVE_ENV_NAME.test(match[2]!)
      ? `${match[1]}${match[2]}=[REDACTED]`
      : line;
  }).join('\n');
}

export interface StreamingSecretRedactor {
  push(chunk: Buffer): string;
  flush(): string;
}

export class DefaultStreamingSecretRedactor implements StreamingSecretRedactor {
  private readonly decoder = new TextDecoder();
  private pending = '';

  constructor(private readonly knownSecrets: readonly string[] = []) {}

  push(chunk: Buffer): string {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const privateKeyStart = this.pending.search(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu);
    if (privateKeyStart >= 0 && !/-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/iu.test(this.pending.slice(privateKeyStart))) return '';
    const completeThrough = this.pending.lastIndexOf('\n');
    if (completeThrough < 0) return '';
    const emitted = this.pending.slice(0, completeThrough + 1);
    this.pending = this.pending.slice(completeThrough + 1);
    return redactSecrets(emitted, this.knownSecrets);
  }

  flush(): string {
    this.pending += this.decoder.decode();
    const emitted = redactSecrets(this.pending, this.knownSecrets);
    this.pending = '';
    return emitted;
  }
}

export type SecretRedactorFactory = {
  create(knownSecrets?: readonly string[]): StreamingSecretRedactor;
};

export const defaultSecretRedactorFactory: SecretRedactorFactory = {
  create: (knownSecrets = []) => new DefaultStreamingSecretRedactor(knownSecrets)
};
