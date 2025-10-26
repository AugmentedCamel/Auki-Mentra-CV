import { wrapText } from './wrapText';

export class TranscriptProcessor {
  constructor(private readonly width = 80) {}

  process(transcript: string): string[] {
    return wrapText(transcript, this.width);
  }
}
