import type { AppSession } from '@mentra/sdk';

export type TTSOptions = {
  voice_id?: string;
  model_id?: string;
  voice_settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    speed?: number;
  };
};

export enum FeedbackPriority {
  High = 'high',
  Low = 'low',
}

type TTSItem = {
  kind: 'tts';
  text: string;
  options?: TTSOptions;
  priority: FeedbackPriority;
};

type SFXItem = {
  kind: 'sfx';
  name: string;
  url: string;
  priority: FeedbackPriority;
};

type QueueItem = TTSItem | SFXItem;

type LoggerLike = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// Optional fallback phrases to use if URL playback isn't supported on device
const SFX_FALLBACK_TTS: Record<string, string> = {
  photo_take: 'Photo captured.',
};

// Simple SFX library
const SFX_LIBRARY: Record<string, string> = {
  photo_take: 'https://codeskulptor-demos.commondatastorage.googleapis.com/descent/spring.mp3',
};

export class AudioFeedback {
  private queue: QueueItem[] = [];
  private playing = false;
  private processing = false;
  private disposed = false;

  constructor(private readonly session: AppSession, private readonly logger?: LoggerLike) {}

  /**
   * Speak text to the user.
   * - High priority: plays immediately if idle; if already speaking, it clears pending low-priority items and plays next ASAP.
   * - Low priority: enqueued and played when idle.
   */
  async speak(text: string, priority: FeedbackPriority = FeedbackPriority.Low, options?: TTSOptions): Promise<void> {
    if (this.disposed) return;
    if (!text?.trim()) return;

    const item: TTSItem = { kind: 'tts', text: text.trim(), options, priority };

    if (priority === FeedbackPriority.High) {
      if (this.playing || this.processing) {
        // Gracefully interrupt current playback and any ongoing processing,
        // replace the queue with only this high-priority item, and restart processor.
        await this.tryStopTransport();
        this.queue = [item];
        this.processing = false;
        this.playing = false;
        this.ensureProcessing();
        return;
      }
      // No current playback: play immediately
      await this.playNow(item);
      return;
    }

    this.queue.push(item);
    this.ensureProcessing();
  }

  /**
   * Play a named sound effect from the built-in library.
   */
  async playSFX(name: string, priority: FeedbackPriority = FeedbackPriority.Low): Promise<void> {
    if (this.disposed) return;

    const url = SFX_LIBRARY[name];
    if (!url) {
      this.logger?.warn?.(`SFX "${name}" not found`);
      return;
    }

    const item: SFXItem = { kind: 'sfx', name, url, priority };

    if (priority === FeedbackPriority.High) {
      if (this.playing) {
        this.queue = [item, ...this.queue.filter((q) => q.priority === FeedbackPriority.High)];
        this.ensureProcessing();
        return;
      }
      await this.playNow(item);
      this.ensureProcessing();
      return;
    }

    this.queue.push(item);
    this.ensureProcessing();
  }

  /**
   * Alias with requested name format.
   */
  async PlaySFX(name: string, priority: FeedbackPriority = FeedbackPriority.Low): Promise<void> {
    return this.playSFX(name, priority);
  }

  clear(): void {
    this.queue = [];
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  /**
   * Public: stop any currently playing audio (TTS or SFX) and clear the queue.
   * Attempts a graceful stop via underlying transport (stop/cancel if available).
   */
  async stopAll(): Promise<void> {
    try {
      this.clear();
      await this.tryStopTransport();
      // Ensure clean state for next requests
      this.processing = false;
      this.playing = false;
    } catch {
      // ignore
    }
  }

  // Best-effort: ask the underlying transport to stop/cancel current audio playback
  private async tryStopTransport(timeoutMs: number = 700): Promise<void> {
    try {
      const audioApi: any = (this.session as any)?.audio;
      const candidates = ['stop', 'cancel', 'cancelSpeech', 'stopAudio', 'halt'];
      for (const fn of candidates) {
        if (typeof audioApi?.[fn] === 'function') {
          // Race against a small timeout to avoid hanging if transport misbehaves
          await Promise.race([
            Promise.resolve(audioApi[fn]()).catch(() => {}),
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
          ]);
          this.logger?.info?.(`Audio transport ${fn} invoked`);
          break;
        }
      }
    } catch {
      // ignore
    } finally {
      // Force-clear state so the processor can be restarted safely
      this.playing = false;
      this.processing = false;
    }
  }

  private ensureProcessing(): void {
    if (this.disposed) return;
    if (this.processing || this.playing) return;
    if (this.queue.length === 0) return;
    this.processing = true;
    this.processQueue()
      .catch((e) => this.logger?.warn?.(`AudioFeedback queue stopped: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.processing = false;
      });
  }

  private async processQueue(): Promise<void> {
    while (!this.disposed && this.queue.length > 0) {
      const next = this.queue.shift()!;
      await this.playNow(next);
    }
  }

  private async playNow(item: QueueItem): Promise<void> {
    if (this.disposed) return;
    this.playing = true;
    try {
      if (!this.isSessionConnected()) {
        this.logger?.warn?.(`Audio skipped: session not connected (disposed=${this.disposed}).`);
        return;
      }

      if (item.kind === 'tts') {
        const res = await this.session.audio.speak(item.text, item.options);
        if (!res?.success) {
          const errMsg = res?.error ?? 'unknown error';
          if (/websocket not connected|closed/i.test(errMsg)) {
            this.logger?.warn?.(`TTS skipped: ${errMsg}`);
          } else {
            this.logger?.error?.(`TTS failed: ${errMsg}`);
          }
        } else {
          this.logger?.info?.(`TTS played${item.priority === FeedbackPriority.High ? ' (high)' : ''}`);
        }
      } else {
        // SFX via documented Mentra API: session.audio.playAudio({ audioUrl })
        let success = false;
        let error: string | undefined;
        let duration: number | undefined;

        const audioApi: any = (this.session as any).audio;
        if (typeof audioApi?.playAudio === 'function') {
          const res = await audioApi.playAudio({ audioUrl: item.url });
          success = !!res?.success;
          error = res?.error;
          duration = res?.duration;
        } else {
          // API not available: use TTS fallback phrase if provided
          const fallback = SFX_FALLBACK_TTS[item.name];
          if (fallback) {
            const res = await this.session.audio.speak(fallback);
            if (res?.success) {
              this.logger?.warn?.(
                `Audio.playAudio not available; used TTS fallback for "${item.name}".`
              );
              success = true;
            } else {
              error = res?.error ?? 'TTS fallback failed';
            }
          } else {
            error = 'Audio.playAudio API not available on this device';
          }
        }

        if (!success) {
          this.logger?.error?.(`SFX failed: ${error ?? 'unknown error'}`);
        } else {
          const extra = duration ? ` (${duration} ms)` : '';
          this.logger?.info?.(
            `SFX played (${item.name}): ${item.url}${item.priority === FeedbackPriority.High ? ' (high)' : ''}${extra}`
          );
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/websocket not connected|closed/i.test(msg)) {
        this.logger?.warn?.(`${item.kind.toUpperCase()} skipped: ${msg}`);
      } else {
        this.logger?.error?.(`${item.kind.toUpperCase()} exception: ${msg}`);
      }
    } finally {
      this.playing = false;
      // Do not auto-resume here; queue processing is explicitly controlled by callers.
      // This prevents previously queued low-priority items from restarting after a forced stop.
    }
  }

  // Best-effort check if session transport is connected
  private isSessionConnected(): boolean {
    try {
      const s: any = this.session as any;
      const st = s?.connectionState || s?._connectionState;
      if (typeof st === 'string') {
        const v = st.toLowerCase();
        if (['open', 'opened', 'connected', 'ready'].includes(v)) return true;
        if (['closed', 'closing', 'disconnected'].includes(v)) return false;
      }
      const ws = s?.ws || s?._ws || s?.socket;
      if (ws && typeof ws.readyState === 'number') {
        return ws.readyState === 1; // OPEN
      }
    } catch {
      // ignore
    }
    return true; // default to true if unknown
  }
}
