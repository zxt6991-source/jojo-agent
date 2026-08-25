import type { BrowserFramePath, BrowserTarget, BrowserWaitCondition } from '@desktop-agent/contracts';

export type BrowserSessionOptions = {
  sessionId: string;
  workingDirectory?: string;
  allowedDomains?: string[];
};

export type BrowserPageInfo = {
  id: string;
  url: string;
  title: string;
  active: boolean;
};

export type BrowserSnapshot = {
  url: string;
  title: string;
  text?: string;
  elements?: BrowserSnapshotElement[];
};

export type BrowserSnapshotElement = {
  selector: string;
  tag: string;
  role?: string;
  accessibleName?: string;
  visible: boolean;
};

export type ResolvedBrowserTarget = {
  selector: string;
  relocated: boolean;
  score?: number;
  frame?: BrowserFramePath;
};

export type BrowserImage = { mimeType: 'image/png' | 'image/jpeg'; data: Uint8Array };
export type BrowserReadOptions = { maxNodes?: number; frame?: BrowserFramePath };
export type ResolveTargetOptions = { allowMissing?: boolean; ambiguityMargin?: number; minimumScore?: number };
export type BrowserScreenshotOptions = { fullPage?: boolean; format?: 'png' | 'jpeg' };

export type BrowserSessionEvent =
  | { type: 'page_opened'; page: BrowserPageInfo }
  | { type: 'page_closed'; pageId: string }
  | { type: 'page_selected'; pageId: string }
  | { type: 'navigation'; pageId: string; url: string }
  | { type: 'download'; pageId: string; path: string; suggestedFilename?: string };

export type BrowserSessionEventListener = (event: BrowserSessionEvent) => void;

export interface BrowserPage {
  navigate(url: string, signal?: AbortSignal): Promise<void>;
  read(options?: BrowserReadOptions, signal?: AbortSignal): Promise<BrowserSnapshot>;
  resolveTarget(target: BrowserTarget, options?: ResolveTargetOptions, signal?: AbortSignal): Promise<ResolvedBrowserTarget | undefined>;
  click(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<void>;
  hover(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<void>;
  type(target: ResolvedBrowserTarget, text: string, signal?: AbortSignal): Promise<void>;
  press(target: ResolvedBrowserTarget | undefined, key: string, signal?: AbortSignal): Promise<void>;
  select(target: ResolvedBrowserTarget, values: string[], signal?: AbortSignal): Promise<void>;
  upload?(target: ResolvedBrowserTarget, paths: string[], signal?: AbortSignal): Promise<void>;
  download?(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<{ path: string }>;
  extract?(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<unknown>;
  getValue?(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<string>;
  scroll?(target: ResolvedBrowserTarget | undefined, deltaX: number, deltaY: number, signal?: AbortSignal): Promise<void>;
  back?(signal?: AbortSignal): Promise<void>;
  reload?(signal?: AbortSignal): Promise<void>;
  wait(condition: BrowserWaitCondition, timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  screenshot(options?: BrowserScreenshotOptions, signal?: AbortSignal): Promise<BrowserImage>;
  getUrl(): Promise<string>;
  getTitle(): Promise<string>;
}

export interface BrowserSession {
  listPages(): Promise<BrowserPageInfo[]>;
  newPage(url?: string, signal?: AbortSignal): Promise<BrowserPage>;
  selectPage(pageId: string): Promise<void>;
  closePage(pageId: string): Promise<void>;
  activePage(): Promise<BrowserPage>;
  subscribe(listener: BrowserSessionEventListener): () => void;
  close(): Promise<void>;
}

export interface BrowserDriver {
  openSession(options: BrowserSessionOptions, signal: AbortSignal): Promise<BrowserSession>;
}
