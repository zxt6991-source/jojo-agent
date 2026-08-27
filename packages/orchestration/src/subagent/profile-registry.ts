import { OrchestrationError } from '../errors.js';

export type AgentProfileSource = 'builtin' | 'extension' | 'user' | 'project';

export type AgentProfileDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
  source: AgentProfileSource;
  sourcePath?: string;
  readOnly: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
  model?: string;
  maxIterations?: number;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
};

export type AgentProfileRegistration = Omit<AgentProfileDefinition, 'source'> & {
  source?: AgentProfileSource;
};

function copyProfile(profile: AgentProfileDefinition): AgentProfileDefinition {
  return {
    ...profile,
    ...(profile.allowedTools ? { allowedTools: [...profile.allowedTools] } : {}),
    ...(profile.deniedTools ? { deniedTools: [...profile.deniedTools] } : {}),
    ...(profile.outputSchema ? { outputSchema: structuredClone(profile.outputSchema) } : {})
  };
}

function normalizeProfile(profile: AgentProfileRegistration): AgentProfileDefinition {
  return copyProfile({ ...profile, source: profile.source ?? 'builtin' });
}

function profileMap(profiles: AgentProfileRegistration[]): Map<string, AgentProfileDefinition> {
  const result = new Map<string, AgentProfileDefinition>();
  for (const input of profiles) {
    const profile = normalizeProfile(input);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(profile.name)) {
      throw new OrchestrationError('invalid_profile', `Invalid agent profile name: ${profile.name}`);
    }
    result.set(profile.name, profile);
  }
  return result;
}

export class AgentProfileRegistry {
  private readonly builtinProfiles = new Map<string, AgentProfileDefinition>();
  private readonly extensionProfiles = new Map<string, AgentProfileDefinition>();
  private userProfiles = new Map<string, AgentProfileDefinition>();
  private readonly projectProfiles = new Map<string, Map<string, AgentProfileDefinition>>();
  private registryRevision = 0;

  get revision(): number { return this.registryRevision; }

  constructor(profiles: AgentProfileRegistration[] = []) {
    for (const profile of profiles) this.register(profile);
  }

  register(input: AgentProfileRegistration): { dispose(): void } {
    const profile = normalizeProfile(input);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(profile.name)) {
      throw new OrchestrationError('invalid_profile', `Invalid agent profile name: ${profile.name}`);
    }
    if (profile.source === 'project') {
      throw new OrchestrationError('invalid_profile', 'Project profiles must be installed with replaceProjectProfiles().');
    }
    const target = profile.source === 'user'
      ? this.userProfiles
      : profile.source === 'extension'
        ? this.extensionProfiles
        : this.builtinProfiles;
    const stored = copyProfile(profile);
    target.set(profile.name, stored);
    this.registryRevision += 1;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (target.get(profile.name) === stored) {
          target.delete(profile.name);
          this.registryRevision += 1;
        }
      }
    };
  }

  replaceUserProfiles(profiles: AgentProfileRegistration[]): void {
    this.userProfiles = profileMap(profiles.map((profile) => ({ ...profile, source: 'user' })));
    this.registryRevision += 1;
  }

  replaceProjectProfiles(workingDirectory: string, profiles: AgentProfileRegistration[]): void {
    this.projectProfiles.set(workingDirectory, profileMap(profiles.map((profile) => ({ ...profile, source: 'project' }))));
    this.registryRevision += 1;
  }

  get(name: string, workingDirectory?: string): AgentProfileDefinition {
    const profile = (workingDirectory ? this.projectProfiles.get(workingDirectory)?.get(name) : undefined)
      ?? this.userProfiles.get(name)
      ?? this.extensionProfiles.get(name)
      ?? this.builtinProfiles.get(name);
    if (!profile) throw new OrchestrationError('invalid_profile', `Unknown agent profile: ${name}`);
    return copyProfile(profile);
  }

  list(workingDirectory?: string): AgentProfileDefinition[] {
    const merged = new Map(this.builtinProfiles);
    for (const [name, profile] of this.extensionProfiles) merged.set(name, profile);
    for (const [name, profile] of this.userProfiles) merged.set(name, profile);
    if (workingDirectory) {
      for (const [name, profile] of this.projectProfiles.get(workingDirectory) ?? []) merged.set(name, profile);
    }
    return [...merged.values()].map(copyProfile).sort((left, right) => left.name.localeCompare(right.name));
  }
}

export function createBuiltinAgentProfileRegistry(): AgentProfileRegistry {
  return new AgentProfileRegistry([
    {
      name: 'explore',
      source: 'builtin',
      description: 'Search, inspect, and explain a codebase without modifying it.',
      systemPrompt: 'You are a read-only coding sub-agent. Focus only on the delegated task. Return concise findings with relevant file paths, symbols, and unresolved uncertainties.',
      readOnly: true,
      allowedTools: ['read_file', 'list_files', 'grep', 'glob', 'web_search', 'web_fetch'],
      maxIterations: 8,
      timeoutMs: 120_000
    },
    {
      name: 'general',
      source: 'builtin',
      description: 'Perform a general engineering task in an isolated git worktree. Changes are never merged automatically.',
      systemPrompt: 'You are a general engineering sub-agent running in an isolated git worktree. Complete only the delegated task, stay inside the assigned working directory, report every material change, and do not merge into the default branch.',
      readOnly: false,
      maxIterations: 8,
      timeoutMs: 120_000
    },
    {
      name: 'synthesize',
      source: 'builtin',
      description: 'Synthesize supplied evidence without accessing external tools.',
      systemPrompt: 'You are a synthesis sub-agent. Use only the supplied dependency results. Distinguish consensus, conflicts, missing evidence, and incomplete upstream results.',
      readOnly: true,
      allowedTools: [],
      maxIterations: 8,
      timeoutMs: 120_000
    },
    {
      name: 'code-review',
      source: 'builtin',
      description: 'Review code and diffs for correctness, safety, and maintainability without editing files.',
      systemPrompt: 'You are a read-only code-review sub-agent. Identify concrete defects, regressions, security risks, and missing tests. Cite files and symbols and do not modify the workspace.',
      readOnly: true,
      allowedTools: ['read_file', 'list_files', 'grep', 'glob'],
      maxIterations: 8,
      timeoutMs: 120_000
    }
  ]);
}
