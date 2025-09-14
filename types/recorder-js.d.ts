declare module 'recorder-js' {
    class Recorder {
      constructor(context: AudioContext);
      init(stream: MediaStream): Promise<void>;
      start(): void;
      stop(): Promise<{ blob: Blob; buffer: ArrayBuffer[] }>;
    }
    
    export default Recorder;
  }