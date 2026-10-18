/** Realtime speech delivery has its own generation; it never cancels an Agent Run. */
export interface VoicePcmChunk {
  segmentId: string;
  generation: number;
  sequence: number;
  bytes: Uint8Array;
  sampleRate: number;
  channels: 1;
  format: 'pcm16le';
  endOfSegment?: boolean;
}

export interface PlaybackCursor {
  generation: number;
  segmentId?: string;
  /** Frames actually rendered, excluding pauses and underrun silence, at output sample rate. */
  playedFrames: number;
  playedMs: number;
  segmentPlayedFrames: number;
  bufferedFrames: number;
  sampleRate: number;
  state: 'idle' | 'playing' | 'ducked' | 'paused';
}

export interface PlaybackReference {
  generation: number;
  sampleRate: number;
  /** AudioContext render position, including silence, for capture/reference alignment. */
  renderFrame: number;
  samples: Float32Array;
}

export interface PlaybackFlushOptions { generation?: number; afterSegmentId?: string }

export type PlaybackCommand =
  | { type: 'enqueue'; requestId: number; chunk: VoicePcmChunk }
  | { type: 'generation'; generation: number }
  | { type: 'duck'; gain: number; reason: string }
  | { type: 'pause'; reason: string }
  | { type: 'resume' }
  | { type: 'volume'; gain: number }
  | { type: 'flush'; options: PlaybackFlushOptions }
  | { type: 'reference'; enabled: boolean }
  | { type: 'stop' };

export type PlaybackEvent =
  | { type: 'enqueued'; requestId: number; cursor: PlaybackCursor }
  | { type: 'rejected'; requestId: number; reason: string }
  | { type: 'cursor'; cursor: PlaybackCursor }
  | { type: 'segment-played'; segmentId: string; generation: number; cursor: PlaybackCursor }
  | { type: 'reference'; reference: PlaybackReference };
