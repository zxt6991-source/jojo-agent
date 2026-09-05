import { parentPort, workerData } from 'node:worker_threads';
import { importFileAttachments } from './file-attachments';

const { paths, mode } = workerData as { paths: string[]; mode: 'files' | 'folder' };
void importFileAttachments(paths, mode).then(
  (result) => parentPort?.postMessage(result),
  (cause: unknown) => { throw cause; }
);
