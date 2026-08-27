import type { ContributionOwner, Disposable } from '@desktop-agent/contracts';

export type PreviewRegistration<T> = {
  id: string;
  owner: ContributionOwner;
  contribution: T;
};

/** Small typed bridge for preview ABIs that do not yet have a stable kernel registry. */
export class PreviewContributionRegistry<T extends { id: string }> {
  private readonly registrations = new Map<string, PreviewRegistration<T>>();
  private registryVersion = 0;

  get version(): number { return this.registryVersion; }

  register(owner: ContributionOwner, contribution: T): Disposable {
    const id = owner.source === 'builtin' ? contribution.id : `${owner.id}:${contribution.id}`;
    if (this.registrations.has(id)) throw new Error(`extension_preview_duplicate_id: ${id}`);
    const registration = { id, owner: { ...owner }, contribution };
    this.registrations.set(id, registration);
    this.registryVersion += 1;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.registrations.get(id) === registration) {
          this.registrations.delete(id);
          this.registryVersion += 1;
        }
      }
    };
  }

  snapshot(): PreviewRegistration<T>[] {
    return [...this.registrations.values()].map((registration) => ({
      ...registration,
      owner: { ...registration.owner }
    }));
  }
}
