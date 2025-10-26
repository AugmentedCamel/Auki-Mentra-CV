import type { Application } from 'express';

type LoggerLike = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export class CvPipelineService {
  private readonly logger: LoggerLike;
  private readonly getAuthUserId: (req: any) => string | undefined;

  // Single source of truth: per-user query (in-memory for now)
  private readonly queries = new Map<string, string>();

  // Optional low rate-limit per user (change no more than once per second)
  private readonly lastSetAt = new Map<string, number>();

  // --- Streaming config per user (simple and extensible) ---
  private readonly streamingCfg = new Map<string, { active: boolean; intervalMs: number; capacity: number }>();

  // Optional frame sink: invoked for every frame pushed to the ring (e.g., to stream over WS)
  private onFrameSink?: (userId: string, frame: {
    requestId: string; buffer: Buffer; timestamp: Date; userId: string; mimeType: string; filename: string; size: number;
  }) => void;

  // --- Per-user in-memory ring buffer of frames ---
  // Minimal frame shape aligns with Mentra PhotoData; buffer is Node Buffer
  private readonly rings = new Map<
    string,
    { capacity: number; buf: Array<{
      requestId: string; buffer: Buffer; timestamp: Date; userId: string; mimeType: string; filename: string; size: number;
    } | undefined>; idx: number; len: number }
  >();

  constructor(opts: { logger: LoggerLike; getAuthUserId: (req: any) => string | undefined }) {
    this.logger = opts.logger;
    this.getAuthUserId = opts.getAuthUserId;
  }

  // Register a sink to receive every pushed frame (e.g., to forward via WebSocket Q/A)
  public setFrameSink(sink: (userId: string, frame: {
    requestId: string; buffer: Buffer; timestamp: Date; userId: string; mimeType: string; filename: string; size: number;
  }) => void): void {
    this.onFrameSink = sink;
    this.logger.info?.('CV frame sink registered.');
  }

  // Read the current query for a user (used by AukiService)
  public getQuery(userId: string): string | undefined {
    return this.queries.get(userId);
  }

  // Helper to resolve the latest prompt using a provided getQuery function
  public static async latestPrompt(
    getter: (userId: string) => Promise<string | undefined> | string | undefined,
    userId: string
  ): Promise<string> {
    const qRaw = await Promise.resolve(getter(userId));
    const prompt = (qRaw || '').toString().trim();
    return prompt || 'Describe what you see in minimum tokens';
  }

  // Internal setter used by our routes and by the shim in index.ts
  public setQuery(userId: string, query: string): void {
    this.queries.set(userId, query);
    this.lastSetAt.set(userId, Date.now());
    this.logger.info?.(`CV query set for ${userId}: ${query.slice(0, 80)}`);
  }

  // --- Streaming: simple API (toggle + ring buffer) ---

  public setStreaming(userId: string, active: boolean, opts?: { intervalMs?: number; capacity?: number }): void {
    const prev = this.streamingCfg.get(userId) || { active: false, intervalMs: 1000, capacity: 30 };
    const cfg = {
      active,
      intervalMs: typeof opts?.intervalMs === 'number' && opts.intervalMs > 0 ? opts.intervalMs : prev.intervalMs,
      capacity: typeof opts?.capacity === 'number' && opts.capacity > 0 ? opts.capacity : prev.capacity,
    };
    this.streamingCfg.set(userId, cfg);

    // Ensure ring exists with desired capacity
    const ring = this.rings.get(userId);
    if (!ring || ring.capacity !== cfg.capacity) {
      this.rings.set(userId, { capacity: cfg.capacity, buf: new Array(cfg.capacity), idx: 0, len: 0 });
    }

    this.logger.info?.(`Streaming ${active ? 'ON' : 'OFF'} for ${userId} (interval=${cfg.intervalMs}ms, cap=${cfg.capacity})`);
  }

  public isStreaming(userId: string): boolean {
    return this.streamingCfg.get(userId)?.active === true;
  }

  public getStreamingConfig(userId: string): { active: boolean; intervalMs: number; capacity: number } {
    const cfg = this.streamingCfg.get(userId) || { active: false, intervalMs: 500, capacity: 30 };
    return cfg;
  }

  // Push a frame into the per-user ring buffer
  public pushFrame(userId: string, frame: {
    requestId: string; buffer: Buffer; timestamp: Date; userId: string; mimeType: string; filename: string; size: number;
  }): void {
    let ring = this.rings.get(userId);
    if (!ring) {
      const cfg = this.getStreamingConfig(userId);
      ring = { capacity: cfg.capacity, buf: new Array(cfg.capacity), idx: 0, len: 0 };
      this.rings.set(userId, ring);
    }

    // Enforce strictly increasing order by filename (IMG_YYYYMMDD_HHMMSS.jpg → YYYYMMDDHHMMSS)
    if (ring.len > 0) {
      const lastIdx = (ring.idx - 1 + ring.capacity) % ring.capacity;
      const prev = ring.buf[lastIdx]!;
      const prevKey = this.getSortableFromFilename(prev.filename);
      const nextKey = this.getSortableFromFilename(frame.filename);

      let outOfOrder = false;
      if (prevKey && nextKey) {
        // lexicographic compare of sortable strings
        if (!(nextKey > prevKey)) outOfOrder = true;
      } else {
        // Fallback to timestamp if filename pattern not available
        const prevTs = prev.timestamp?.getTime?.() ?? 0;
        const nextTs = frame.timestamp?.getTime?.() ?? 0;
        if (!(nextTs > prevTs)) outOfOrder = true;
      }

      if (outOfOrder) {
        this.logger.info?.(
          `Streaming: dropped out-of-order/duplicate frame user=${userId} new="${frame.filename}" prev="${prev.filename}"`
        );
        return; // drop frame
      }
    }

    ring.buf[ring.idx] = frame;
    ring.idx = (ring.idx + 1) % ring.capacity;
    ring.len = Math.min(ring.len + 1, ring.capacity);

    // Push this frame to the registered sink (if any), so it can be sent to WebSocket Q/A immediately
    const frameWithFlag = { ...frame, isStreaming: true };
    try {
      this.onFrameSink?.(userId, frameWithFlag as any);
    } catch (e: any) {
      this.logger.warn?.(`Frame sink error for ${userId}: ${e?.message || String(e)}`);
    }
  }

  // Process a single frame (not for streaming)
  public processSingleFrame(userId: string, frame: {
    requestId: string; buffer: Buffer; timestamp: Date; userId: string; mimeType: string; filename: string; size: number;
  }): void {
    const frameWithFlag = { ...frame, isStreaming: false };
    try {
      this.onFrameSink?.(userId, frameWithFlag as any);
    } catch (e: any) {
      this.logger.warn?.(`Single frame sink error for ${userId}: ${e?.message || String(e)}`);
    }
  }

  // Extract sortable key YYYYMMDDHHMMSS from IMG_YYYYMMDD_HHMMSS.jpg
    // Because Mentra image request can't be accepted to arrive consistent.
  private getSortableFromFilename(name?: string): string | undefined {
    if (!name) return undefined;
    // Match IMG_YYYYMMDD_HHMMSS or IMG-YYYYMMDD-HHMMSS (flexible separators)
    const m = name.match(/img[_-]?(\d{8})[_-]?(\d{6})/i);
    if (m && m[1] && m[2]) {
      return `${m[1]}${m[2]}`; // YYYYMMDDHHMMSS
    }
    // As a loose fallback, strip to alnum to retain comparable sequence if consistently named
    const fallback = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return fallback || undefined;
  }

  // Get the latest frame for a user (undefined if no frames yet)
  public getLatestFrame(userId: string): {
    requestId: string; buffer: Buffer; timestamp: Date; userId: string; mimeType: string; filename: string; size: number;
  } | undefined {
    const ring = this.rings.get(userId);
    if (!ring || ring.len === 0) return undefined;
    const lastIdx = (ring.idx - 1 + ring.capacity) % ring.capacity;
    return ring.buf[lastIdx];
  }

  // Clear per-user streaming state and ring buffer to prevent leaks
  public clearUser(userId: string): void {
    if (this.streamingCfg.has(userId)) this.streamingCfg.delete(userId);
    if (this.rings.has(userId)) this.rings.delete(userId);
    this.logger.info?.(`Cleared CV streaming state for ${userId}`);
  }

  public registerRoutes(app: Application) {
    // GET /api/cv/query → { query }
    app.get('/api/cv/query', (req: any, res: any) => {
      const userId = this.getAuthUserId(req);
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      const query = this.queries.get(userId) ?? '';
      res.json({ query });
    });

    // POST /api/cv/query { query } → { ok: true, query }
    app.post('/api/cv/query', (req: any, res: any) => {
      const userId = this.getAuthUserId(req);
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const raw = (req.body && (req.body.query ?? req.body.q)) ?? (req.query && (req.query.query ?? req.query.q));
      const query = typeof raw === 'string' ? raw.trim() : '';

      if (!query) return res.status(400).json({ error: 'Missing query' });

      // Simple per-user rate limiting (1 change/second)
      const now = Date.now();
      const last = this.lastSetAt.get(userId) ?? 0;
      if (now - last < 1000) {
        const retrySec = Math.ceil((1000 - (now - last)) / 1000);
        return res.status(429).set('Retry-After', String(retrySec)).json({ error: 'Too Many Requests' });
      }

      this.setQuery(userId, query);
      res.json({ ok: true, query });
    });
  }
}
