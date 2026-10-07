import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describeTestProvider } from '@desktop-agent/agent-runtime/testing';
import { ServerDataOwnership, SqliteAgentRuntimeStore, SqliteServerStateStore } from '@desktop-agent/storage';
import { createHeadlessServer } from '../../../apps/server/src/index.js';
import { DesktopApprovalBroker } from '../../../apps/desktop/src/worker/approval-broker.js';
import { createDesktopSchedulerRuntime } from '../../../apps/desktop/src/worker/scheduler-runtime.js';
import { AgentScheduleTargetValidator } from '@desktop-agent/scheduler';
import type { RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import { createProductRuntime } from '../src/index.js';
import { describeApplicationHostContract, type ApplicationHostFactory } from './application-host-contract.js';

for (const kind of ['desktop', 'server'] as const) {
  const factory: ApplicationHostFactory = async options => {
    const directory = await mkdtemp(path.join(os.tmpdir(), `jojo-contract-${kind}-`));
    const executions: RuntimeResolutionContext[] = [];
    const open = async () => {
      const common = {
        providers: { describe: describeTestProvider, resolve: (context: RuntimeResolutionContext) => { executions.push(context); return options.provider; } },
        permissions: options.permissions ?? { check: async () => ({ decision: 'allow' as const }) },
        tools: { resolve: () => ({ snapshot: () => options.tools ?? [] }) }
      };
      if (kind === 'server') {
        const ownership = ServerDataOwnership.acquire(directory);
        const store = new SqliteAgentRuntimeStore(path.join(directory, 'runtime.sqlite'));
        try {
          const server = await createHeadlessServer({ ...common, store, ownership, dataDir: directory });
          return { app: server.appService, scheduler: server.scheduleService!, close: async () => { try { await server.close(); } finally { store.close(); } } };
        } catch (error) { store.close(); ownership.release(); throw error; }
      }
      const store = new SqliteAgentRuntimeStore(path.join(directory, 'runtime.sqlite'));
      const stateStore = new SqliteServerStateStore(path.join(directory, 'application.sqlite'));
      try {
        const product = await createProductRuntime({ runtime: { ...common, store, host: { kind: 'desktop' } }, application: { stateStore, approvalBroker: new DesktopApprovalBroker(stateStore) }, recovery: 'preserve' });
        const unsupported = () => { throw new Error('Non-Agent targets are outside this conformance suite'); };
        let scheduler;
        try {
          scheduler = await createDesktopSchedulerRuntime({
            dataDirectory: directory, runtime: product.runtime, application: product.application,
            teamManager: { getTask: unsupported, delegate: unsupported, cancel: unsupported },
            workflowManager: { get: unsupported, start: unsupported, cancel: unsupported },
            subscribeOrchestration: () => () => undefined,
            prepareAgent: async () => undefined,
            validateTarget: target => new AgentScheduleTargetValidator(product.runtime).validate(target),
            emit: () => undefined
          });
        } catch (error) { await product.close(); throw error; }
        return { app: product.application, scheduler: scheduler.service, close: async () => {
          try { await scheduler.close(); } finally { try { await product.close(); } finally { store.close(); } }
        } };
      } catch (error) { store.close(); throw error; }
    };
    let current: Awaited<ReturnType<typeof open>>;
    try { current = await open(); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    return {
      app: current.app,
      executions,
      scheduler: () => current.scheduler,
      persistedRun: async id => {
        const state = new SqliteServerStateStore(path.join(directory, kind === 'server' ? 'server-state.sqlite' : 'application.sqlite'));
        try { return await state.runs.get(id); } finally { await state.close(); }
      },
      restart: async () => { await current.close(); current = await open(); return current.app; },
      close: async () => { try { await current.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    };
  };
  describeApplicationHostContract(kind, factory);
}
