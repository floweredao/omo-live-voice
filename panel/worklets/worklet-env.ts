// Ambient AudioWorkletGlobalScope declarations (not part of the DOM lib).
declare global {
  const sampleRate: number;
  const currentFrame: number;
  class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor();
  }
  function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
}

export {};
