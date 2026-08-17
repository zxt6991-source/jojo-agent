import { describe, expect, it } from 'vitest';
import { layoutWorkflowDag, layoutWorkflowTimeline } from './workflow-dag.js';

describe('layoutWorkflowDag', () => {
  it('layers a serial chain and a fan-in without flattening definition order', () => {
    const serial = layoutWorkflowDag([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] }
    ]);
    expect(serial.nodes.map((node) => [node.id, node.layer, node.index])).toEqual([
      ['a', 0, 0],
      ['b', 1, 0],
      ['c', 2, 0]
    ]);
    expect(serial.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['a->b', 'b->c']);

    const fanIn = layoutWorkflowDag([
      { id: 'inspect' },
      { id: 'kernel', dependsOn: ['inspect'] },
      { id: 'yocto', dependsOn: ['inspect'] },
      { id: 'summary', dependsOn: ['kernel', 'yocto'] }
    ]);
    expect(fanIn.nodes.map((node) => [node.id, node.layer, node.index])).toEqual([
      ['inspect', 0, 0],
      ['kernel', 1, 0],
      ['yocto', 1, 1],
      ['summary', 2, 0]
    ]);
    expect(fanIn.edges.map((edge) => `${edge.from}->${edge.to}`).sort()).toEqual([
      'inspect->kernel',
      'inspect->yocto',
      'kernel->summary',
      'yocto->summary'
    ]);
  });

  it('ignores unknown and self dependencies and keeps cyclic graphs finite', () => {
    const layout = layoutWorkflowDag([
      { id: 'a', dependsOn: ['missing', 'a'] },
      { id: 'b', dependsOn: ['c'] },
      { id: 'c', dependsOn: ['b'] }
    ]);
    expect(layout.nodes.find((node) => node.id === 'a')).toMatchObject({ layer: 0 });
    expect(layout.nodes.every((node) => Number.isFinite(node.layer))).toBe(true);
    expect(layout.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });
});

describe('layoutWorkflowTimeline', () => {
  it('places started steps on a 0-100 track relative to the run origin', () => {
    const origin = '2026-08-16T10:00:00.000Z';
    const layout = layoutWorkflowTimeline([
      { id: 'pending' },
      { id: 'inspect', startedAt: '2026-08-16T10:00:00.000Z', finishedAt: '2026-08-16T10:00:04.000Z' },
      { id: 'review', startedAt: '2026-08-16T10:00:02.000Z', finishedAt: '2026-08-16T10:00:10.000Z' }
    ], origin, Date.parse('2026-08-16T10:00:10.000Z'));
    expect(layout.durationMs).toBe(10_000);
    expect(layout.items.map((item) => item.id)).toEqual(['inspect', 'review']);
    expect(layout.items[0]).toMatchObject({ id: 'inspect', left: 0, width: 40 });
    expect(layout.items[1]).toMatchObject({ id: 'review', left: 20, width: 80 });
  });
});
