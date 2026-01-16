import type { Application, Request, Response } from 'express';
import axios from 'axios';
import * as crypto from 'crypto';
import { AudioFeedback, FeedbackPriority } from '../tools/AudioFeedback';
import * as path from 'path';
import * as fs from 'fs';
import * as ejs from 'ejs';
import { ErrorFeedback } from '../tools/ErrorFeedback';
import { WebSocket, RawData } from 'ws';
import { AukiAuthService } from './AukiAuthService';
import { CvPipelineService } from './CvPipelineService';

/**
 * Very small logger interface so this service can be used anywhere.
 * It matches the typical shape of console-like loggers used in the app.
 */
type LoggerLike = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/**
 * The minimal "photo" shape we need from the app.
 * This matches the fields produced by Mentra's PhotoData and the app cache.
 */
export type CapturedPhoto = {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string;
  size: number;
};

// Realtime WebSocket endpoint for streaming image inference
const AUKI_COMPUTE_NODE_WS_URL = (process.env.AUKI_COMPUTE_NODE_WS_URL || 'ws://localhost:8080/api/v1/ws').replace(/\/+$/, '');

// VLM compute node URLs for local and cloud
const AUKI_COMPUTE_NODE_URL_LOCAL = process.env.AUKI_COMPUTE_NODE_URL_LOCAL || 'http://0.0.0.0:8080/api/v1/jobs';
const AUKI_COMPUTE_NODE_URL_CLOUD = process.env.AUKI_COMPUTE_NODE_URL_CLOUD || 'https://vlm-node.dev.aukiverse.com/api/v1/jobs';

/**
 * AukiService
 *  - Owns ALL Auki-related state and logic (tokens, domain store, QA/detect, routes).
 *  - The App (index.ts) provides simple callbacks so we can:
 *     • Speak to the user (AudioFeedback)
 *     • Read the latest cached photo
 *     • Mark a user as Auki-authenticated
 *     • Extract the authenticated user id from a request
 *  - Everything else stays self-contained here, which keeps index.ts clean.
 */
export class AukiService {
  // ---- App callbacks ----
  private readonly logger: LoggerLike;
  private readonly getAudioFeedback: (userId: string) => AudioFeedback | undefined;
  private readonly getLatestPhoto: (userId: string) => CapturedPhoto | null | undefined;
  private readonly getAuthUserId: (req: any) => string | undefined;
  private readonly setAukiAuthenticated: (userId: string, authed: boolean) => void;
  private readonly getQuery: (userId: string) => Promise<string | undefined> | string | undefined;
  private readonly setQuery: (userId: string, query: string) => void;

  // ---- Auth service ----
  private readonly authService: AukiAuthService;

  // ---- Per-user state (Auki processing) ----
  private analysisByUser: Map<string, { requestId: string; text: string; at: number }> = new Map();

  private lastDataIdByUser: Map<string, string> = new Map(); // newest stored data id per user (after a capture)


  // In-flight store deduplication: ensures multiple code paths can await the same Domain store
  private inflightStoreByRequest: Map<string, Promise<string>> = new Map();

  // Track job context so webhook responses can be associated back to a user and dataId
  private jobCtxById: Map<string, { userId: string; dataId: string; prompt?: string; domainId?: string; qnaRecordId?: string; requestId?: string }> = new Map();

  // --- Realtime CV WebSocket state ---
  private wsByUser: Map<string, WebSocket> = new Map();
  private wsAccumulatedResponse: Map<string, string> = new Map();

  // --- Analysis SSE clients per user ---
  private analysisSseClients: Map<string, Set<Response>> = new Map();

  // Track latest photo requestId per user to tie analysis to frames
  private latestRequestIdByUser: Map<string, string> = new Map();

  // Prevent duplicate QnA saves per requestId (used by WS auto-save and manual save)
  private savedQnaByReq: Set<string> = new Set();

  // WS association: per-user queue of requestIds in send order, popped when a WS response finishes
  private wsPendingReqIdsByUser: Map<string, string[]> = new Map();

  // Prompt mapping: prompt used for a specific requestId (captured exactly at send time)
  private promptByRequestId: Map<string, string> = new Map();


  constructor(opts: {
    logger: LoggerLike;
    getAudioFeedback: (userId: string) => AudioFeedback | undefined;
    getLatestPhoto: (userId: string) => CapturedPhoto | null | undefined;
    getAuthUserId: (req: any) => string | undefined;
    setAukiAuthenticated: (userId: string, authed: boolean) => void;
    getQuery: (userId: string) => Promise<string | undefined> | string | undefined;
    setQuery: (userId: string, query: string) => void;
  }) {
    this.logger = opts.logger;
    this.getAudioFeedback = opts.getAudioFeedback;
    this.getLatestPhoto = opts.getLatestPhoto;
    this.getAuthUserId = opts.getAuthUserId;
    this.setAukiAuthenticated = opts.setAukiAuthenticated;
    this.getQuery = opts.getQuery;
    this.setQuery = opts.setQuery;
    this.authService = new AukiAuthService({
      logger: this.logger,
      setAukiAuthenticated: this.setAukiAuthenticated,
    });
  }

  /**
   * Call this when a new photo is cached by the app.
   * We do two things:
   *  1) Process the photo (QA/detect) using Auki services (fire-and-forget).
   *  2) Store the photo bytes to Auki Domain (fire-and-forget), and remember its dataId.
   */
  public onPhotoCaptured(photo: CapturedPhoto, userId: string): void {
    // Track latest requestId for this user (used to tie analysis to frame)
    this.latestRequestIdByUser.set(userId, photo.requestId);


    // Fire-and-forget: also store to Auki Domain
    const startedAt = Date.now();
    const mask = (t?: string, head = 8, tail = 6) =>
      t ? (t.length <= head + tail ? t : `${t.slice(0, head)}…${t.slice(-tail)}`) : '(none)';

    // Choose processing mode
    const settings = this.authService.getAukiSettings(userId);
    if (settings.processingMode === 'ws') {
      this.processPhotoViaWebSocket(photo, userId).catch((err) => {
        this.logger.error(`Auki processPhotoViaWebSocket failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    } else {
      this.processPhotoViaHttp(photo, userId).catch((err) => {
        this.logger.error(`Auki processPhotoViaHttp failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    const storePromise = (async (): Promise<string> => {
      const step = (name: string) => {
        const now = Date.now();
        return `${name} (+${now - startedAt}ms)`;
      };

      try {
        const domainIdResolved = this.authService.getAukiSettings(userId).domainId;
        this.logger?.info?.(
          `[DomainStore] ${step('init')} user=${userId} photoReq=${photo?.requestId ?? '(n/a)'} size=${photo?.buffer?.length ?? 0}B mime=${photo?.mimeType ?? 'image/jpeg'} domainId=${domainIdResolved || '(empty)'}`
        );

        // Get or mint per-user cached domain token
        const { domainToken, domainServerUrl } = await this.authService.ensureDomainAuth(userId, domainIdResolved);
        this.logger?.info?.(`[DomainStore] ${step('tokenReady')} serverUrl=${domainServerUrl} token=${mask(domainToken)}`);

        const filename = photo.filename || `photo_${photo.requestId}_${crypto.randomBytes(4).toString('hex')}.jpg`;
        this.logger?.info?.(
          `[DomainStore] ${step('storing')} filename=${filename} contentType=image/jpeg bytes=${photo?.buffer?.length ?? 0} dataType=jpg`
        );

        const { dataId } = await this.domainStore({
          domainToken,
          domainServerUrl,
          domainId: domainIdResolved,
          contentType: 'image/jpeg',
          bytes: photo.buffer,
          dataType: 'mentra-live-image',
          filename,
        });

        this.lastDataIdByUser.set(userId, dataId);
        this.logger?.info?.(`[DomainStore] ${step('done')} Stored latest photo: dataId=${dataId} user=${userId}`);
        return dataId;
      } catch (e: any) {
        const status = e?.response?.status;
        const code = e?.code || e?.response?.data?.code;
        let body: string | undefined;
        try {
          body = e?.response?.data ? JSON.stringify(e.response.data) : undefined;
        } catch {
          body = String(e?.response?.data ?? '');
        }

        const detail = [e?.message || String(e), status ? `status=${status}` : '', code ? `code=${code}` : '', body ? `body=${body}` : '']
          .filter(Boolean)
          .join(' | ');

        this.logger?.warn?.(`[DomainStore] error Domain store skipped (user not authed yet or error): ${detail}`);
        if (e?.stack) {
          this.logger?.warn?.(`[DomainStore] stack: ${e.stack.split('\n').slice(0, 6).join('\n')}`);
        }
        // Surface to webview
        ErrorFeedback.push(userId, 'auki', 'Failed to store photo to Domain', detail);
        throw e;
      }
    })();

    // Track inflight store by requestId so other code paths can await it instead of re-uploading
    this.inflightStoreByRequest.set(photo.requestId, storePromise);
    storePromise.finally(() => {
      this.inflightStoreByRequest.delete(photo.requestId);
    });
  }

  // this is when we Q/A a single image not in streaming mode, but still via websockets
  private async processPhotoViaWebSocket(photo: CapturedPhoto, userId: string): Promise<void> {
    await this.streamFrame(userId, photo);
  }

  private async processPhotoViaHttp(photo: CapturedPhoto, userId: string): Promise<void> {
    const settings = this.authService.getAukiSettings(userId);
    const prompt = await CvPipelineService.latestPrompt(this.getQuery, userId);
    this.setQuery(userId, prompt);
    this.promptByRequestId.set(photo.requestId, prompt);
    if (!prompt) return; // no prompt, skip

    const url = settings.computeNodeUrl;
    const dataId = await this.waitForDataId(userId, photo.requestId, 4000).catch(() => undefined);
    const payload = {
      job_type: 'vlm_only',
      query: { ids: dataId ? [dataId] : [] },
      domain_id: settings.domainId || '',
      input: {
        job_type: 'vlm_only',
        prompt,
        webhook_url: `${process.env.MENTRA_APP_URL || ''}/cvnode/response`,
        vlm_prompt: prompt,
      },
    };

    // Log exactly what is sent (URL + full JSON) and that it was via HTTP
    try {
      const bodyStr = JSON.stringify(payload);
      this.logger.info(`[HTTPJob] sending via http url=${url} body=${bodyStr}`);
    } catch {
      this.logger.info(`[HTTPJob] sending via http url=${url} body=<unserializable>`);
    }

    // Submit job
    const response = await axios.post(url, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    const jobId =
      String(
        response.data?.jobId ??
        response.data?.job_id ??
        response.data?.id ??
        response.data?.job?.id ??
        ''
      ) || 'unknown';

    // Track job context for webhook correlation
    try {
      this.jobCtxById.set(jobId, {
        userId,
        dataId: dataId || '',
        prompt,
        domainId: settings.domainId,
        requestId: photo.requestId,
      });
    } catch {
      // ignore context errors
    }

    this.logger.info(
      `[HTTPJob] submitted via http for user=${userId} req=${photo.requestId} jobId=${jobId}`
    );
  }


  // --------- Public helpers used by index.ts ---------

  public getAnalysisFor(userId: string, requestId: string) {
    const a = this.analysisByUser.get(userId);
    return a && a.requestId === requestId ? a : undefined;
  }

  public getLatestAnalysis(userId: string) {
    return this.analysisByUser.get(userId);
  }


  public onUserStop(userId: string) {
    this.authService.onUserStop(userId);

    // Optional cleanups
    this.inflightStoreByRequest.forEach((_p, key) => {
      // clear any inflight promises tied to this user's last request ids if desired
      // We don't know mapping from requestId to userId here; keep it simple and let them finish.
    });

    // Close realtime WebSocket if open
    const ws = this.wsByUser.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(1000, 'Session closed'); } catch { /* ignore */ }
    }
    this.wsByUser.delete(userId);
    this.wsAccumulatedResponse.delete(userId);
  }

  // --------- Express route registration (Auki-only) ---------

  /**
   * Register all Auki-related routes on your Express app.
   * This keeps index.ts clean and focused on app lifecycle and UI parts.
   */
  public registerRoutes(app: Application) {

    // -----------------------------------------------------------------------------
    // Webhook endpoint for Vision Compute Node (or any external service)
    // Receives a "JSON text file" payload. We support multiple content types:
    //  - application/json (body parsed upstream)
    //  - text/plain (string body containing JSON)
    //  - application/octet-stream (raw bytes containing JSON text)
    // The handler best-effort parses the payload, extracts job/user/request/text
    // fields, stores latest analysis for the user (if userId + text are present),
    // and provides optional audio feedback.
    // NOTE: This endpoint is intentionally unauthenticated to allow external callbacks.
    //       If you need verification (e.g., HMAC), add it here later.
    // -----------------------------------------------------------------------------
    app.post('/cvnode/response', async (req: any, res: any) => {
      try {
        // Helper to read raw body if no parser handled it.
        const readRawBody = async (): Promise<Buffer> => {
          // If the request stream already ended and no body was provided, return empty.
          if ((req as any).readableEnded || (req as any).complete) {
            return Buffer.alloc(0);
          }
          return await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
            req.on('aborted', () => reject(new Error('Request aborted while reading body')));
          });
        };

        // Best-effort parse: handle object, string, Buffer, or raw stream.
        const parsePayload = async (): Promise<any> => {
          const b: any = (req as any).body;
          if (b && typeof b === 'object' && !Buffer.isBuffer(b)) {
            return b;
          }
          if (typeof b === 'string') {
            try { return JSON.parse(b); } catch { /* fall through */ }
          }
          if (Buffer.isBuffer(b)) {
            const s = b.toString('utf8');
            try { return JSON.parse(s); } catch { /* fall through */ }
          }
          const raw = await readRawBody();
          const txt = raw.toString('utf8').trim();
          if (!txt) return {};
          try { return JSON.parse(txt); } catch {
            // As a fallback, wrap raw text so caller can inspect it later if needed.
            return { rawText: txt };
          }
        };

        const payload = await parsePayload();

        // Log raw payload for debugging (exact content up to 10KB)
        try {
          const raw =
            typeof (req as any).body === 'string'
              ? (req as any).body
              : Buffer.isBuffer((req as any).body)
                ? (req as any).body.toString('utf8')
                : JSON.stringify(payload);
          const clipped = raw.length > 10_000 ? `${raw.slice(0, 10_000)}…[+${raw.length - 10_000} more bytes]` : raw;
          this.logger.info(`[CVNodeWebhook] payload.raw: ${clipped}`);
        } catch {
          this.logger.info('[CVNodeWebhook] payload.raw: <unavailable>');
        }

        // Helper to pick first non-empty string
        const pickStr = (...vals: any[]) => {
          for (const v of vals) {
            if (typeof v === 'string' && v.trim().length) return v;
          }
          return '';
        };

        // Extract common fields from a variety of shapes
        const headerUser = (req.headers['x-user-id'] as string | undefined) || (req.headers['x-user'] as string | undefined);
        const userId = pickStr(
          payload?.userId,
          payload?.user?.id,
          headerUser
        );

        const jobId = pickStr(
          payload?.jobId,
          payload?.job_id,
          payload?.id,
          payload?.job?.id,
          payload?.aukiJobId,
          payload?.task?.id
        );

        const requestId = pickStr(
          payload?.requestId,
          payload?.request_id,
          payload?.input?.id,
          payload?.query?.id,
          Array.isArray(payload?.input?.ids) ? String(payload.input.ids[0] ?? '') : '',
          Array.isArray(payload?.query?.ids) ? String(payload.query.ids[0] ?? '') : '',
          payload?.input?.data_id,
          payload?.query?.data_id,
          payload?.input?.cid,
          payload?.query?.cid,
          payload?.id
        ) || 'latest';

        const fromTemporal = typeof payload?.data?.temporal_output === 'string' ? payload.data.temporal_output : '';
        const fromLogs = typeof payload?.data?.logs === 'string' ? this.extractFromLogs(payload.data.logs) : '';

        // Log temporal output preview for debugging
        try {
          if (fromTemporal) {
            const tprev = fromTemporal.length > 140 ? `${fromTemporal.slice(0, 140)}…` : fromTemporal;
            this.logger.info(`[CVNodeWebhook] temporal_output.preview: "${tprev}"`);
          }
        } catch { }

        // Prefer temporal_output (full response) over logs extraction (which can fail on multi-line CSV)
        const textOut = (fromTemporal || fromLogs || '').trim();

        // Resolve user/job context
        const ctx = jobId ? this.jobCtxById.get(String(jobId)) : undefined;
        const resolvedUserId = userId || ctx?.userId || '';
        const resolvedPrompt = pickStr(
          payload?.input?.prompt,
          payload?.prompt,
          payload?.input?.vlm_prompt,
          payload?.vlm_prompt,
          ctx?.prompt
        );
        const resolvedDataId =
          (Array.isArray(payload?.query?.ids) && payload.query.ids[0] && String(payload.query.ids[0])) ||
          (Array.isArray(payload?.input?.ids) && payload.input.ids[0] && String(payload.input.ids[0])) ||
          ctx?.dataId ||
          (resolvedUserId ? this.lastDataIdByUser.get(resolvedUserId) : undefined);
        // For HTTP jobs, use the original photo requestId from context to match inflightStoreByRequest
        const resolvedRequestId = ctx?.requestId || requestId;

        // Log and use as latest Answer for Q/A if present
        if (textOut) {
          this.logger.info(`[CVNodeWebhook] answer="${textOut}"`);
        }

        if (resolvedUserId && textOut) {
          this.analysisByUser.set(resolvedUserId, { requestId: resolvedRequestId, text: textOut, at: Date.now() });
          this.broadcastAnalysis(resolvedUserId, resolvedRequestId, textOut);
          // Persist to Q/A in background
          this.saveQnAFor(resolvedUserId, resolvedRequestId).catch(() => { });
        }

        // Always respond quickly to avoid retries; include parsed hints for debugging.
        return res.status(200).json({
          ok: true,
          received: {
            userId: resolvedUserId || null,
            requestId: resolvedRequestId || null,
            jobId: jobId || null,
            hasText: !!textOut
          },
        });
      } catch (e: any) {
        this.logger.error(`[CVNodeWebhook] error: ${e?.message || String(e)}`);
        return res.status(400).json({ ok: false, error: 'Invalid webhook payload', detail: e?.message || 'unknown' });
      }
    });

    // Auki login: authenticate with Auki Network using email/password
    app.post('/api/auki/login', async (req: any, res: any) => {
      const userId = this.getAuthUserId(req);

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const email: string | undefined = req.body?.email;
      const password: string | undefined = req.body?.password;

      if (!email || !password) {
        res.status(400).json({ error: 'Missing email or password' });
        return;
      }

      try {
        await this.authService.login(userId, email, password);

        // Friendly voice feedback (optional)
        await this.speak(userId, 'Auki authentication completed.', FeedbackPriority.Low).catch(() => { });

        // Pre-mint domain auth for this user and schedule refresh
        await this.authService.ensureDomainAuth(userId).catch(() => { });

        // Warm up websocket for this user
        //this.initRealtimeConnection(userId);

        res.json({ ok: true });
      } catch (e: any) {
        const status = e?.response?.status;
        const detail = e?.response?.data?.message ?? e?.message ?? 'Unknown error';
        res
          .status(typeof status === 'number' && status >= 400 && status < 600 ? status : 500)
          .json({ error: 'Auki login failed', detail });
      }
    });


    // Store latest cached photo to Domain (if not auto-stored)
    app.post('/api/auki/store-latest', async (req: any, res: any) => {
      try {
        const userId = this.getAuthUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const photo = this.getLatestPhoto(userId) || undefined;
        if (!photo) return res.status(404).json({ error: 'No photo to store' });

        const domainId = this.authService.resolveDomainId(req);
        const { domainToken, domainServerUrl } = await this.authService.ensureDomainAuth(userId, domainId);

        const filename = photo.filename || `photo_${photo.requestId}.jpg`;
        const { dataId } = await this.domainStore({
          domainToken,
          domainServerUrl,
          domainId,
          contentType: 'image/jpeg',
          bytes: photo.buffer,
          dataType: 'mentra-live-image',
          filename,
        });
        this.lastDataIdByUser.set(userId, dataId);
        res.json({ dataId });
      } catch (e: any) {
        res.status(500).json({ error: 'Store failed', detail: e?.message || 'unknown' });
      }
    });

    // List latest QnA records on the domain (no per-user filter); fallback to latest images
    app.get('/api/auki/qna/list', async (req: any, res: any) => {
      try {
        const userId = this.getAuthUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const limitRaw = req.query?.limit;
        const limit = Math.min(50, Math.max(1, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 6));
        const dbg = String(req.query?.debug || '').toLowerCase() === '1' || String(req.query?.debug || '').toLowerCase() === 'true';

        const { domainId } = this.authService.getAukiSettings(userId);
        const { domainToken, domainServerUrl } = await this.authService.ensureDomainAuth(userId, domainId);

        this.logger.info(`[QnAList] user=${userId} domain=${domainId} limit=${limit}`);

        // Try to load QnA records first (mentra-qna-record)
        const metas = await this.domainListByType({
          domainToken,
          domainServerUrl,
          domainId,
          type: 'mentra-qna-record',
        });

        this.logger.info(`[QnAList] metas[type=mentra/qna:record] count=${metas.length}`);
        if (dbg) {
          const preview = metas.slice(-10);
          preview.forEach((m: any, idx: number) =>
            this.logger.info(`[QnAList] meta[${idx}] id=${m.id} name=${m.name || '(none)'} type=${m.type || '(none)'} ct=${m.contentType || '(n/a)'}`)
          );
        }

        const sample = metas; // load all records and sort by createdAt
        const records = await Promise.all(
          sample.map(async (m: any) => {
            try {
              const rec = await this.domainLoadJson<any>({
                domainToken,
                domainServerUrl,
                domainId,
                dataId: m.id,
              });
              if (!rec) return undefined;
              return {
                id: m.id,
                ...rec,
                imageUrl: rec.imageUrl,
              };
            } catch (err: any) {
              if (dbg) this.logger.info(`[QnAList] loadJson failed for ${m.id}: ${err?.message || String(err)}`);
              return undefined;
            }
          })
        );

        let parsed = (records.filter(Boolean) as Array<{
          id: string;
          userId?: string;
          jobId?: string;
          photoId?: string;
          imageUrl?: string; // for backward compatibility
          prompt?: string;
          response?: string;
          createdAt?: string;
        }>);

        if (dbg) {
          parsed.slice(0, 10).forEach((r: any, idx: number) => {
            const p = (r.prompt || '').toString();
            const a = (r.response || '').toString();
            const pClip = p.length > 120 ? `${p.slice(0, 120)}…(+${p.length - 120})` : p;
            const aClip = a.length > 160 ? `${a.slice(0, 160)}…(+${a.length - 160})` : a;
            this.logger.info(`[QnAList] rec[${idx}] id=${r.id} img=${r.photoId ? 'url' : '(none)'} at=${r.createdAt || '(n/a)'} prompt="${pClip}" response="${aClip}"`);
          });
        }

        let items = parsed
          .sort((a, b) => this.safeDateTime(b.createdAt) - this.safeDateTime(a.createdAt))
          .slice(0, limit)
          .map(item => ({
            ...item,
            imageUrl: item.photoId ? `/media/${item.photoId}` : item.imageUrl || '',
          }));

        // Fallback: if no QnA records, return latest images
        if (!items.length) {
          this.logger.info('[QnAList] No QnA records parsed; falling back to latest images.');
          const imgMetas = await this.domainListByType({
            domainToken,
            domainServerUrl,
            domainId,
            type: 'jpg',
          });
          this.logger.info(`[QnAList] metas[type=image/jpeg] count=${imgMetas.length}`);
          const imgs = imgMetas.slice(-limit).reverse().map((m: any) => ({
            id: m.id,
            userId: undefined,
            jobId: undefined,
            imageUrl: `/media/${m.id}`,
            prompt: '',
            response: '',
            createdAt: '',
          }));
          if (dbg) {
            imgs.forEach((it: any, idx: number) => this.logger.info(`[QnAList] img[${idx}] id=${it.id}`));
          }
          items = imgs;
        } else {
          this.logger.info(`[QnAList] returning items=${items.length}`);
        }

        res.json({ ok: true, items });
      } catch (e: any) {
        const msg = e?.message || String(e);
        this.logger.info(`[QnAList] error: ${msg}`);
        ErrorFeedback.push(this.getAuthUserId(req), 'auki', 'Failed to load gallery items', msg);
        res.status(500).json({ error: 'Failed to list QnA records', detail: msg });
      }
    });

    // SSE stream for analysis (final responses), per-user
    app.get('/analysis/stream', (req: any, res: any) => {
      const userId = this.getAuthUserId(req);
      if (!userId) {
        res.status(401).end();
        return;
      }
      try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write('retry: 2000\n\n');

        // Add client
        let set = this.analysisSseClients.get(userId);
        if (!set) {
          set = new Set<Response>();
          this.analysisSseClients.set(userId, set);
        }
        set.add(res);

        // Send the latest known analysis immediately (if available)
        try {
          const a = this.getLatestAnalysis(userId);
          if (a?.text) {
            res.write(`data: ${JSON.stringify({ requestId: a.requestId, text: a.text })}\n\n`);
          }
        } catch { /* ignore */ }

        req.on('close', () => {
          try {
            const cur = this.analysisSseClients.get(userId);
            if (cur) cur.delete(res);
            try { res.end(); } catch { }
          } catch { /* ignore */ }
        });
      } catch {
        res.end();
      }
    });

    // Gallery webview (renders EJS; data is loaded via /api/auki/qna/list)
    app.get('/gallery', async (req: any, res: any) => {
      try {
        const userId = this.getAuthUserId(req);
        if (!userId) {
          res.status(401).send('Not authenticated');
          return;
        }
        const templatePath = path.join(process.cwd(), 'views', 'gallery.ejs');
        const html = await (ejs as any).renderFile(templatePath, {});
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch (e: any) {
        this.logger?.warn?.(`[Gallery] Failed to render: ${e?.message || e}`);
        res.status(500).send('Failed to render gallery');
      }
    });

    // ----- AUKI SETTINGS (per-user overrides) -----
    app.get('/api/auki/settings', async (req: any, res: any) => {
      try {
        const userId = this.getAuthUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const s = this.authService.getAukiSettings(userId);
        res.json({ ok: true, settings: s });
      } catch (e: any) {
        res.status(500).json({ error: 'Failed to read settings', detail: e?.message || 'unknown' });
      }
    });

    app.post('/api/auki/settings', async (req: any, res: any) => {
      try {
        const userId = this.getAuthUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const updates: any = {};
        if (typeof req.body?.computeNodeUrl === 'string')
          updates.computeNodeUrl = String(req.body.computeNodeUrl).trim();
        if (typeof req.body?.taskType === 'string') updates.taskType = String(req.body.taskType).trim();
        if (typeof req.body?.domainId === 'string') updates.domainId = String(req.body.domainId).trim();
        if (typeof req.body?.processingMode === 'string') updates.processingMode = String(req.body.processingMode).trim();
        if (typeof req.body?.useCloudVlm === 'boolean') updates.useCloudVlm = req.body.useCloudVlm;
        this.authService.updateAukiSettings(userId, updates);
        res.json({ ok: true, settings: this.authService.getAukiSettings(userId) });
      } catch (e: any) {
        res.status(500).json({ error: 'Failed to update settings', detail: e?.message || 'unknown' });
      }
    });

    // Serve photo by dataId, overriding Content-Type to image/jpeg
    app.get('/api/photo/:dataId', async (req: any, res: any) => {
      try {
        const userId = this.getAuthUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const dataId = req.params.dataId;
        const { domainToken, domainServerUrl } = await this.authService.ensureDomainAuth(userId);
        const domainId = this.authService.getAukiSettings(userId).domainId;
        const { contentType, bytes } = await this.domainLoad({
          domainToken,
          domainServerUrl,
          domainId,
          dataId,
        });
        this.logger.info(`[PhotoEndpoint] dataId=${dataId} contentType=${contentType} status=200`);
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(bytes);
      } catch (e: any) {
        this.logger.info(`[PhotoEndpoint] dataId=${req.params.dataId} error=${e?.message || 'unknown'} status=500`);
        res.status(500).json({ error: 'Failed to load photo', detail: e?.message || 'unknown' });
      }
    });

    // Media proxy route
    app.get('/media/:id', async (req: any, res: any) => {
      try {
        const userId = this.getAuthUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const dataId = req.params.id;
        const domainId = this.authService.resolveDomainId(req);
        const { domainToken, domainServerUrl } = await this.authService.ensureDomainAuth(userId, domainId);
        const { contentType, bytes } = await this.domainLoad({
          domainToken,
          domainServerUrl,
          domainId,
          dataId,
        });
        res.setHeader('Content-Type', contentType);
        res.send(bytes);
      } catch (e: any) {
        res.status(500).json({ error: 'Failed to load media', detail: e?.message || 'unknown' });
      }
    });

  }

  // ---------- Realtime WebSocket helpers (internal) ----------

  private async ensureWebSocket(userId: string): Promise<WebSocket> {
    const existing = this.wsByUser.get(userId);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return existing;
    }

    const settings = this.authService.getAukiSettings(userId);
    const sUrl = settings.computeNodeUrl;
    const url = sUrl && /^wss?:\/\//i.test(sUrl) ? sUrl : AUKI_COMPUTE_NODE_WS_URL;
    const ws = new WebSocket(url);
    this.wsByUser.set(userId, ws);
    this.wsAccumulatedResponse.set(userId, '');

    this.logger.info(`[RealtimeWS] connecting user=${userId} url=${url}`);

    ws.on('open', async () => {
      this.logger.info(`[RealtimeWS] connected user=${userId}`);
      // Prompt is sent immediately before each frame in streamFrame(), where we also
      // track requestId → prompt mapping for precise QnA persistence.
    });

    // Respond to server pings to keep the connection alive (required for non-browser clients)
    ws.on('ping', (data: Buffer) => {
      try { ws.pong(data); } catch {/* ignore */ }
    });

    ws.on('message', async (data: RawData) => {
      try {
        let buf: Buffer;
        if (Buffer.isBuffer(data)) buf = data;
        else if (Array.isArray(data)) buf = Buffer.concat(data as Buffer[]);
        else buf = Buffer.from(data as any);

        const text = buf.toString('utf8');
        let parsed: any;
        try { parsed = JSON.parse(text); } catch {
          this.logger.warn(`[RealtimeWS] non-JSON message for user=${userId}: "${text.slice(0, 120)}"`);
          return;
        }

        const isObj = parsed && typeof parsed === 'object';
        const chunk = isObj ? String(parsed.response ?? '') : '';
        const done = isObj ? Boolean(parsed.done) : false;

        if (chunk) {
          const prev = this.wsAccumulatedResponse.get(userId) || '';
          const next = prev + chunk;
          this.wsAccumulatedResponse.set(userId, next);
        }

        if (done) {
          const finalText = (this.wsAccumulatedResponse.get(userId) || '').trim();
          this.wsAccumulatedResponse.set(userId, '');
          this.logger.info(`[RealtimeWS] done user=${userId} text.len=${finalText.length}`);

          if (finalText) {
            // Pop the exact requestId associated with this response (FIFO)
            let reqId = this.latestRequestIdByUser.get(userId) || 'latest';
            const qArr = this.wsPendingReqIdsByUser.get(userId);
            if (Array.isArray(qArr) && qArr.length > 0) {
              reqId = qArr.shift() as string;
              this.wsPendingReqIdsByUser.set(userId, qArr);
            }

            this.analysisByUser.set(userId, { requestId: reqId, text: finalText, at: Date.now() });
            // Broadcast to UI
            this.broadcastAnalysis(userId, reqId, finalText);

            // TTS on WS path disabled; handled in index via HTTP analysis trigger
            // try { await this.speak(userId, finalText, FeedbackPriority.High); } catch {/* ignore audio errors */}

            // Persist to Q/A store
            this.saveQnAFor(userId, reqId).catch(() => { });
          }
        }
      } catch (e: any) {
        this.logger.warn(`[RealtimeWS] onmessage error user=${userId}: ${e?.message || String(e)}`);
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.logger.info(`[RealtimeWS] closed user=${userId} code=${code} reason="${reason.toString('utf8')}"`);
      this.wsByUser.delete(userId);
      this.wsAccumulatedResponse.delete(userId);
    });

    ws.on('error', (err: any) => {
      this.logger.error(`[RealtimeWS] error user=${userId}: ${err?.message || String(err)}`);
    });

    return ws;
  }

  private async sendPhotoOverWebSocket(userId: string, photo: CapturedPhoto): Promise<void> {
    const ws = await this.ensureWebSocket(userId);
    if (ws.readyState !== WebSocket.OPEN) {
      // Wait for open (with timeout)
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => { ws.off('error', onErr); resolve(); };
        const onErr = (e: any) => { ws.off('open', onOpen); reject(e); };
        ws.once('open', onOpen);
        ws.once('error', onErr);
        setTimeout(() => {
          ws.off('open', onOpen);
          ws.off('error', onErr);
          reject(new Error('WebSocket open timeout'));
        }, 8000);
      });
    }

    try {
      ws.send(photo.buffer);
      this.logger.info(`[RealtimeWS] sent photo user=${userId} bytes=${photo.buffer?.length ?? 0} name=${photo.filename || '(unnamed)'}`);
    } catch (e: any) {
      throw new Error(`Failed to send photo over WS: ${e?.message || 'unknown'}`);
    }
  }

  // Public API: push a single frame via realtime WS with the current prompt
  public async streamFrame(
    userId: string,
    frame: { requestId: string; buffer: Buffer; timestamp: Date; userId: string; mimeType: string; filename: string; size: number }
  ): Promise<void> {
    // Remember latest request id for tying back TTS/QnA
    this.latestRequestIdByUser.set(userId, frame.requestId);

    // Ensure WS, send current prompt, then frame bytes
    const ws = await this.ensureWebSocket(userId);

    if (ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => { ws.off('error', onErr); resolve(); };
        const onErr = (e: any) => { ws.off('open', onOpen); reject(e); };
        ws.once('open', onOpen);
        ws.once('error', onErr);
        setTimeout(() => {
          ws.off('open', onOpen);
          ws.off('error', onErr);
          reject(new Error('WebSocket open timeout'));
        }, 8000);
      });
    }

    try {
      // Send latest user query (prompt) immediately before the frame
      try {
        const q = await CvPipelineService.latestPrompt(this.getQuery, userId);
        this.setQuery(userId, q);
        if (q) {
          ws.send(q);
          this.promptByRequestId.set(frame.requestId, q);
          this.logger.info(`[RealtimeWS] sent prompt (len=${q.length}) user=${userId}`);
        }
      } catch (e: any) {
        this.logger.warn(`[RealtimeWS] failed to send prompt before frame: ${e?.message || String(e)}`);
      }

      // Send the frame bytes
      ws.send(frame.buffer);
      this.logger.info(
        `[RealtimeWS] sent frame user=${userId} bytes=${frame.buffer?.length ?? 0} name=${frame.filename || '(unnamed)'} req=${frame.requestId}`
      );

      // Queue this requestId for association with the next WS 'done' response
      const qArr = this.wsPendingReqIdsByUser.get(userId) || [];
      qArr.push(frame.requestId);
      this.wsPendingReqIdsByUser.set(userId, qArr);

      // Begin background Domain store for this exact frame (keyed by requestId)
      try {
        const storePromise = (async (): Promise<string> => {
          try {
            const settings = this.authService.getAukiSettings(userId);
            const { domainToken, domainServerUrl } = await this.authService.ensureDomainAuth(userId, settings.domainId);
            const filename = frame.filename || `frame_${frame.requestId}.jpg`;
            const { dataId } = await this.domainStore({
              domainToken,
              domainServerUrl,
              domainId: settings.domainId,
              contentType: 'image/jpeg',
              bytes: frame.buffer,
              dataType: 'mentra-live-image',
              filename,
            });
            this.lastDataIdByUser.set(userId, dataId);
            return dataId;
          } catch (e: any) {
            this.logger?.warn?.(
              `[DomainStore] streamFrame store failed user=${userId} req=${frame.requestId}: ${e?.message || String(e)}`
            );
            throw e;
          }
        })();

        // Track and cleanup after resolution
        this.inflightStoreByRequest.set(frame.requestId, storePromise);
        storePromise.finally(() => {
          this.inflightStoreByRequest.delete(frame.requestId);
        });
      } catch (e: any) {
        this.logger?.warn?.(
          `[DomainStore] streamFrame store setup failed user=${userId} req=${frame.requestId}: ${e?.message || String(e)}`
        );
      }
    } catch (e: any) {
      throw new Error(`Failed to stream frame over WS: ${e?.message || 'unknown'}`);
    }
  }

  /**
   * Persist the last received response for a given request to the Q/A store.
   *
   * Intended usage:
   *   1) Call streamFrame(userId, frame) to send a single frame.
   *   2) After you have received the model's final response (e.g., via SSE /analysis/stream or getLatestAnalysis),
   *      call saveQnAFor(userId, requestId). This method will save only if a response is present.
   *
   * - No-ops if no response is available yet.
   * - Skips if the same requestId was already saved (or auto-saved by the WS path).
   * - Returns { saved: true, recordId } on success, otherwise { saved: false }.
   */
  public async saveQnAFor(
    userId: string,
    requestId?: string
  ): Promise<{ saved: boolean; recordId?: string }> {
    try {
      const rid = requestId || this.latestRequestIdByUser.get(userId) || 'latest';
      if (this.savedQnaByReq.has(rid)) {
        this.logger?.info?.(`[QnAStore] manual.save skipped (already saved) user=${userId} req=${rid}`);
        return { saved: false };
      }

      const analysis =
        (requestId ? this.getAnalysisFor(userId, rid) : undefined) ||
        this.getLatestAnalysis(userId);

      const text = analysis?.text?.trim();
      if (!text) {
        this.logger?.info?.(`[QnAStore] manual.save skipped (no response yet) user=${userId} req=${rid}`);
        return { saved: false };
      }

      const settings = this.authService.getAukiSettings(userId);
      const { domainToken, domainServerUrl } = await this.authService.ensureDomainAuth(userId, settings.domainId);

      // Prefer exact frame dataId via inflight store
      let imageDataId: string | undefined;
      const p = this.inflightStoreByRequest.get(rid);
      if (p) {
        try {
          imageDataId = await p;
        } catch {
          // ignore, fallback below
        } finally {
          this.inflightStoreByRequest.delete(rid);
        }
      }
      if (!imageDataId) {
        imageDataId = this.lastDataIdByUser.get(userId);
      }

      // Use the prompt that was actually sent with this requestId (fallback to current query)
      const sentPrompt = this.promptByRequestId.get(rid);
      const qRaw = sentPrompt ?? (await Promise.resolve(this.getQuery(userId)));
      const prompt = (qRaw || '').toString();

      const now = new Date();
      const recName = this.makeQnaRecordName(userId, now);

      const record = {
        userId,
        jobId: '', // realtime stream (no job id)
        photoId: imageDataId,
        prompt,
        response: text,
        status: 'done',
        createdAt: now.toISOString(),
      };
      const bytes = Buffer.from(JSON.stringify(record));
      const { dataId } = await this.domainStore({
        domainToken,
        domainServerUrl,
        domainId: settings.domainId,
        contentType: 'application/json',
        bytes,
        dataType: 'mentra-qna-record',
        filename: recName,
      });

      this.savedQnaByReq.add(rid);
      // Clean up prompt map if present
      this.promptByRequestId.delete(rid);
      this.logger?.info?.(`[QnAStore] manual.save img=${imageDataId ?? '(none)'} name=${recName} req=${rid}`);
      return { saved: true, recordId: dataId };
    } catch (e: any) {
      this.logger?.warn?.(`[QnAStore] manual.save failed: ${e?.message || String(e)}`);
      return { saved: false };
    }
  }

  /**
   * Public: proactively initialize the realtime WebSocket connection for a user.
   * Call this during app/session setup so the connection is ready before the first frame arrives.
   */
  public async initRealtimeConnection(userId: string, timeoutMs: number = 8000): Promise<void> {
    const ws = await this.ensureWebSocket(userId);

    if (ws.readyState !== WebSocket.OPEN) {
      // Wait for open (with timeout)
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          ws.off('error', onErr);
          resolve();
        };
        const onErr = (e: any) => {
          ws.off('open', onOpen);
          reject(e);
        };
        ws.once('open', onOpen);
        ws.once('error', onErr);
        setTimeout(() => {
          ws.off('open', onOpen);
          ws.off('error', onErr);
          reject(new Error('WebSocket warmup open timeout'));
        }, timeoutMs);
      });
      this.logger.info(`[RealtimeWS] warmup: connected user=${userId}`);
    } else {
      this.logger.info(`[RealtimeWS] warmup: already open user=${userId}`);
    }

    // Send warmup prompt and image for GPU warmup
    try {
      const warmupPrompt = 'ignore this image, its for GPU warmup';
      ws.send(warmupPrompt);

      // Try typical project locations for the warmup image
      const candidates = [
        path.join(process.cwd(), 'Mauki.CV', 'images', 'warmup.jpg'),
        path.join(process.cwd(), 'images', 'warmup.jpg'),
      ];

      let warmupPath: string | undefined;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          warmupPath = p;
          break;
        }
      }

      if (warmupPath) {
        const bytes = await fs.promises.readFile(warmupPath);
        ws.send(bytes);
        this.logger.info(`[RealtimeWS] warmup image sent user=${userId} bytes=${bytes.length} path=${warmupPath}`);
      } else {
        this.logger.warn(`[RealtimeWS] warmup image not found; tried: ${candidates.join(', ')}`);
      }
    } catch (e: any) {
      this.logger.warn(`[RealtimeWS] warmup send failed user=${userId}: ${e?.message || String(e)}`);
    }

    // Optional: send a lightweight ping to keep the path hot (control frame; not forwarded as message)
    try {
      if (typeof (ws as any).ping === 'function') {
        (ws as any).ping();
      }
    } catch {
      // ignore ping errors
    }
  }

  // ---------- AUKI Domain helpers (internal) ----------




  private async domainStore(opts: {
    domainToken: string;
    domainServerUrl: string;
    domainId: string;
    contentType: string; // per-part Content-Type is the actual contentType
    bytes: Buffer;
    dataType?: string;
    filename?: string;
  }): Promise<{ dataId: string }> {
    const boundary = `b_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const filename = opts.filename ?? 'blob';
    const dataType = opts.dataType ?? 'mentra-live-image';

    // Domain server expects each part with actual Content-Type:
    // Content-Disposition: form-data; name="<name>"; data-type="<dataType>"
    const parts: Buffer[] = [
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="${filename}"; data-type="${dataType}"\r\n`),
      Buffer.from(`Content-Type: ${opts.contentType}\r\n\r\n`),
      Buffer.from(opts.bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];

    const url = `${opts.domainServerUrl}/api/v1/domains/${opts.domainId}/data`;
    try {
      const res = await axios.post(url, Buffer.concat(parts), {
        headers: {
          Authorization: `Bearer ${opts.domainToken}`,
          'posemesh-client-id': 'mentra-glass',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      const dataId = res.data?.id ?? (Array.isArray(res.data?.data) ? res.data.data[0]?.id : undefined);
      if (!dataId) {
        throw new Error(`Domain store(): unexpected response ${JSON.stringify(res.data)}`);
      }
      return { dataId: String(dataId) };
    } catch (e: any) {
      const status = e?.response?.status;
      let body = '';
      try {
        body = typeof e?.response?.data === 'string' ? e.response.data : JSON.stringify(e?.response?.data ?? {});
      } catch { }
      throw new Error(`Domain store HTTP ${status ?? 'ERR'}: ${body || e?.message || 'unknown'}`);
    }
  }

  private async domainLoad(opts: {
    domainToken: string;
    domainServerUrl: string;
    domainId: string;
    dataId: string;
  }): Promise<{ contentType: string; bytes: Buffer }> {
    const url = `${opts.domainServerUrl}/api/v1/domains/${opts.domainId}/data/${opts.dataId}?raw=1`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${opts.domainToken}`, 'posemesh-client-id': 'mentra-glass' },
      responseType: 'arraybuffer',
    });
    const contentType = res.headers['content-type'] || 'application/octet-stream';
    return { contentType, bytes: Buffer.from(res.data) };
  }

  // List Domain data metadata, optionally filtered by type (Domain expects data_type)
  private async domainListByType(opts: {
    domainToken: string;
    domainServerUrl: string;
    domainId: string;
    type?: string;
  }): Promise<Array<{ id: string; name?: string; type?: string; contentType?: string }>> {
    const qp = [] as string[];
    if (opts.type) qp.push(`data_type=${encodeURIComponent(opts.type)}`);
    const params = qp.length ? `?${qp.join('&')}` : '';
    const url = `${opts.domainServerUrl}/api/v1/domains/${opts.domainId}/data${params}`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${opts.domainToken}`, 'posemesh-client-id': 'mentra-glass' },
    });
    const raw = res.data;
    const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
    return items
      .map((d: any) => ({
        id: String(d?.id ?? ''),
        name: d?.name,
        type: d?.data_type ?? d?.type ?? d?.['data-type'],
        contentType: d?.contentType ?? d?.content_type,
      }))
      .filter((d: any) => !!d.id);
  }

  // Load JSON payload by dataId and parse it
  private async domainLoadJson<T = any>(opts: {
    domainToken: string;
    domainServerUrl: string;
    domainId: string;
    dataId: string;
  }): Promise<T | undefined> {
    const { contentType, bytes } = await this.domainLoad(opts);
    const isJson = (contentType || '').includes('application/json') || (contentType || '').includes('text/json');
    try {
      const txt = bytes.toString('utf8');
      return JSON.parse(txt) as T;
    } catch {
      if (isJson) {
        throw new Error('Failed to parse JSON payload');
      }
      return undefined;
    }
  }

  // Push an analysis update (final response) to all SSE subscribers for this user
  private broadcastAnalysis(userId: string, requestId: string, text: string): void {
    const clients = this.analysisSseClients.get(userId);
    if (!clients || clients.size === 0) return;
    const payload = `data: ${JSON.stringify({ requestId, text })}\n\n`;
    clients.forEach((res) => {
      try { res.write(payload); } catch { /* ignore broken pipes */ }
    });
  }

  // Centralized TTS helper: the only place in this file that calls AudioFeedback.speak
  private async speak(userId: string, text: string, priority: FeedbackPriority = FeedbackPriority.Low): Promise<void> {
    if (!text?.trim()) return;
    const fb = this.getAudioFeedback(userId);
    try {
      await fb?.speak(text.trim(), priority);
    } catch {
      // swallow audio errors to avoid interrupting flows
    }
  }

  // Build a domain-safe QnA record name (no slashes/colons)
  private makeQnaRecordName(userId: string, when: Date): string {
    const ymd = when.toISOString().slice(0, 10).replace(/-/g, '');
    const ts = when.getTime();
    const safeUser = String(userId).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48) || 'anon';
    const rand = crypto.randomBytes(6).toString('hex');
    // Only [a-z0-9_-] and a single dot for extension
    return `qna_u_${safeUser}_d_${ymd}_ts_${ts}_rec_${rand}.json`;
  }

  // Safe date parsing for sorting: returns timestamp or 0 for invalid dates
  private safeDateTime(dateStr: string | undefined): number {
    if (!dateStr) return 0;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  // Wait for a specific photo's dataId produced by the post-capture store, without re-uploading
  private async waitForDataId(userId: string, requestId?: string, timeoutMs: number = 4000): Promise<string | undefined> {
    // If caller knows the requestId, prefer waiting on that exact store promise
    if (requestId) {
      const p = this.inflightStoreByRequest.get(requestId);
      if (p) {
        let resolved: string | undefined;
        await Promise.race([
          p.then((id) => {
            resolved = id;
          }),
          new Promise((r) => setTimeout(r, timeoutMs)),
        ]);
        if (resolved) return resolved;
      }
    }
    // Fallback: latest known for user (may be OK if only latest is needed)
    const existing = this.lastDataIdByUser.get(userId);
    return existing ?? undefined;
  }


  // --- AUKI answer extraction helpers to prevent the full payload to b given to the end user ---
  private extractFromLogs(s: string): string {
    try {
      if (!s) return '';
      const lines = s.split(/\r?\n/).filter((ln) => ln.trim().length > 0);
      if (lines.length < 2) return '';
      const last = lines[lines.length - 1];

      // Expect CSV: id,timestamp,event -> third quoted field is the text we want
      const m = last.match(/^(?:\s*"[^"]*"\s*,){2}\s*"([^"]*)"/);
      if (m && typeof m[1] === 'string') {
        return m[1].trim();
      }

      // Fallback: take last comma-separated field and strip quotes
      const parts = last.split(',');
      const tail = parts[parts.length - 1] || '';
      return tail.replace(/^["']|["']$/g, '').trim();
    } catch {
      return '';
    }
  }

  private postProcessAnswer(s: string): string {
    if (!s) return '';
    let out = s.trim();
    // If it still looks like a JSON payload, don't surface it to the user
    if ((out.startsWith('{') || out.startsWith('[')) && out.includes('":')) {
      return '';
    }
    // Safety: never deliver excessively long text
    const MAX = 800;
    if (out.length > MAX) out = `${out.slice(0, MAX)}…`;
    return out;
  }

  private extractAnswer(obj: any, depth: number = 0): string {
    if (obj == null) return '';
    if (typeof obj === 'string') {
      const s = obj.trim();
      // If the string is JSON, parse and re-extract (limited recursion)
      if ((s.startsWith('{') || s.startsWith('[')) && depth < 2) {
        try {
          return this.extractAnswer(JSON.parse(s), depth + 1);
        } catch {
          return '';
        }
      }
      const cleaned = s.replace(/^\s*["']|["']\s*$/g, '').trim();
      if ((cleaned.startsWith('{') || cleaned.startsWith('[')) && cleaned.length > 40) return '';
      return this.postProcessAnswer(cleaned);
    }

    // Only consider final-style fields; ignore temporal/logs for user-facing output
    const candidates: any[] = [
      obj?.answer,
      obj?.result,
      obj?.text,
      obj?.message,
      obj?.output?.answer,
      obj?.output?.result,
      obj?.output?.text,
      Array.isArray(obj?.outputs) ? obj.outputs[0]?.text : undefined,
      Array.isArray(obj?.outputs) ? obj.outputs[0]?.answer : undefined,
      obj?.choices?.[0]?.message?.content,
    ];

    for (const c of candidates) {
      const res = this.extractAnswer(c, depth + 1);
      if (res) return this.postProcessAnswer(res);
    }

    return '';
  }



}
