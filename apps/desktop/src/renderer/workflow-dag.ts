export const DAG_NODE_WIDTH = 148;
export const DAG_NODE_HEIGHT = 52;
export const DAG_COL_GAP = 40;
export const DAG_ROW_GAP = 16;

export type WorkflowDagStep = {
  id: string;
  dependsOn?: string[] | undefined;
};

export type WorkflowDagNode = {
  id: string;
  layer: number;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkflowDagEdge = {
  from: string;
  to: string;
  d: string;
};

export type WorkflowDagLayout = {
  nodes: WorkflowDagNode[];
  edges: WorkflowDagEdge[];
  width: number;
  height: number;
};

export function layoutWorkflowDag(steps: WorkflowDagStep[]): WorkflowDagLayout {
  const ids = new Set(steps.map((step) => step.id));
  const dependencies = new Map(steps.map((step) => [
    step.id,
    [...new Set((step.dependsOn ?? []).filter((dependency) => ids.has(dependency) && dependency !== step.id))]
  ]));
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = dependencies.get(id) ?? [];
    let layer = 0;
    for (const parent of parents) {
      if (visiting.has(parent)) continue;
      layer = Math.max(layer, visit(parent) + 1);
    }
    visiting.delete(id);
    layers.set(id, layer);
    return layer;
  };
  for (const step of steps) visit(step.id);

  const columns: string[][] = [];
  for (const step of steps) {
    const layer = layers.get(step.id) ?? 0;
    (columns[layer] ??= []).push(step.id);
  }

  const nodes: WorkflowDagNode[] = [];
  const byId = new Map<string, WorkflowDagNode>();
  columns.forEach((column, layer) => {
    column.forEach((id, index) => {
      const node: WorkflowDagNode = {
        id,
        layer,
        index,
        x: layer * (DAG_NODE_WIDTH + DAG_COL_GAP),
        y: index * (DAG_NODE_HEIGHT + DAG_ROW_GAP),
        width: DAG_NODE_WIDTH,
        height: DAG_NODE_HEIGHT
      };
      nodes.push(node);
      byId.set(id, node);
    });
  });

  const edges: WorkflowDagEdge[] = [];
  for (const step of steps) {
    for (const from of dependencies.get(step.id) ?? []) {
      const source = byId.get(from);
      const target = byId.get(step.id);
      if (!source || !target || source.layer >= target.layer) continue;
      const x1 = source.x + source.width;
      const y1 = source.y + source.height / 2;
      const x2 = target.x;
      const y2 = target.y + target.height / 2;
      const mid = (x1 + x2) / 2;
      edges.push({
        from,
        to: step.id,
        d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
      });
    }
  }

  return {
    nodes,
    edges,
    width: Math.max(DAG_NODE_WIDTH, ...nodes.map((node) => node.x + node.width), 0),
    height: Math.max(DAG_NODE_HEIGHT, ...nodes.map((node) => node.y + node.height), 0)
  };
}

export type WorkflowTimelineStep = {
  id: string;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
};

export type WorkflowTimelineItem = {
  id: string;
  startMs: number;
  endMs: number;
  left: number;
  width: number;
};

export function layoutWorkflowTimeline(
  steps: WorkflowTimelineStep[],
  origin: string,
  now: number
): { items: WorkflowTimelineItem[]; durationMs: number } {
  const originMs = Date.parse(origin);
  const timed = steps.flatMap((step) => {
    if (!step.startedAt) return [];
    const start = Date.parse(step.startedAt);
    if (!Number.isFinite(start)) return [];
    const finished = step.finishedAt ? Date.parse(step.finishedAt) : now;
    const end = Number.isFinite(finished) ? Math.max(finished, start) : start;
    return [{
      id: step.id,
      startMs: Math.max(0, start - originMs),
      endMs: Math.max(0, end - originMs)
    }];
  });
  const durationMs = Math.max(1, ...timed.map((item) => item.endMs), 1);
  return {
    durationMs,
    items: timed.map((item) => ({
      ...item,
      left: (item.startMs / durationMs) * 100,
      width: Math.max(1.5, ((item.endMs - item.startMs) / durationMs) * 100)
    }))
  };
}
