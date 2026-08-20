export class TurnTaskRegistry {
  private readonly tasks = new Map<string, Promise<void>>();

  launch(sessionId: string, start: () => Promise<void>): boolean {
    if (this.tasks.has(sessionId)) return false;
    const task = start();
    this.tasks.set(sessionId, task);
    const clear = () => {
      if (this.tasks.get(sessionId) === task) this.tasks.delete(sessionId);
    };
    void task.then(clear, clear);
    return true;
  }

  wait(sessionId: string): Promise<void> {
    return this.tasks.get(sessionId) ?? Promise.resolve();
  }
}
