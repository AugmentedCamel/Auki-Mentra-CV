export interface RecordingFrame {
  index: number;
  timestamp: number;
  dataUri: string;
}

export class RecordingService {
  async uploadFrame(_sessionId: string, _frame: RecordingFrame): Promise<void> {
    // TODO: implement upload
  }

  async createManifest(_sessionId: string, _frames: RecordingFrame[]): Promise<string> {
    // TODO: implement manifest creation
    return 'manifest-id';
  }
}
