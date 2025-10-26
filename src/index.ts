// index.ts
import { AppServer, AppSession, ViewType, AuthenticatedRequest, PhotoData } from '@mentra/sdk';
import { Request, Response } from 'express';
import * as ejs from 'ejs';
import * as path from 'path';
import { AudioFeedback, FeedbackPriority } from './tools/AudioFeedback';
import axios from 'axios';
import crypto from 'crypto';
import { AukiService } from './services/AukiService';
import { CvPipelineService } from './services/CvPipelineService';
import { ErrorFeedback } from './tools/ErrorFeedback';

/**
 * Interface representing a stored photo with metadata
 */
interface StoredPhoto {
    requestId: string;
    buffer: Buffer;
    timestamp: Date;
    userId: string;
    mimeType: string;
    filename: string;
    size: number;
}

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error('PACKAGE_NAME is not set in .env file'); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error('MENTRAOS_API_KEY is not set in .env file'); })();
const PORT = parseInt(process.env.PORT || '3000');


/**
 * Photo Taker App with webview functionality for displaying photos
 * Extends AppServer to provide photo taking and webview display capabilities
 */
class MaukiApp extends AppServer {
    private auki: AukiService;
    private cv: CvPipelineService;
    private photos: Map<string, StoredPhoto> = new Map(); // Store photos by userId
    private latestPhotoTimestamp: Map<string, number> = new Map(); // Track latest photo timestamp per user
    private isStreamingPhotos: Map<string, boolean> = new Map(); // Track if we are streaming photos for a user
    private nextPhotoTime: Map<string, number> = new Map(); // Track next photo time for a user
    private audioFeedback: Map<string, AudioFeedback> = new Map(); // Per-user audio feedback managers
    // Connected users and their Auki auth state
    private connectedUsers: Map<string, { sessionId: string; aukiAuthenticated: boolean; lastSeen: number }> = new Map();
    // Last time we reminded users about Auki authentication
    private aukiLastReminderAt: Map<string, number> = new Map();
    // Latest analysis result per user (cleared on new photo)
    private analysisByUser: Map<string, { requestId: string; text: string; at: number }> = new Map();
    // Ensure TTS for analysis is spoken only once per requestId (per user)
    private ttsSpokenByUser: Map<string, Set<string>> = new Map();


    // --- Simple per-user rate limiting for chatty webview endpoints (ngrok cap) ---
    // TODO(ngrok): loosen/remove these limits when not hosted behind ngrok
    private rateLimitLatestPhoto: Map<string, number> = new Map();
    private rateLimitAnalysis: Map<string, number> = new Map();

    // SSE clients for immediate photo updates
    private photoSSEClients: Map<string, Response[]> = new Map();

    // Only consider a photo "recent" within this window
    // TODO(ngrok): consider extending or removing this gate when not behind ngrok
    private readonly PHOTO_RECENT_WINDOW_MS = 60_000;

    constructor() {
        super({
            packageName: PACKAGE_NAME,
            apiKey: MENTRAOS_API_KEY,
            port: PORT,
        });

        // Initialize CV Pipeline service (single source of truth for the CV query)
        this.cv = new CvPipelineService({
            logger: this.logger,
            getAuthUserId: (req) => (req as AuthenticatedRequest).authUserId,
        });

        // Initialize Auki service
        this.auki = new AukiService({
            logger: this.logger,
            getAudioFeedback: (uid) => this.audioFeedback.get(uid),
            getLatestPhoto: (uid) => this.photos.get(uid),
            getAuthUserId: (req) => (req as AuthenticatedRequest).authUserId,
            setAukiAuthenticated: (uid, authed) => {
                const existing = this.connectedUsers.get(uid) ?? { sessionId: '', aukiAuthenticated: false, lastSeen: 0 };
                existing.aukiAuthenticated = authed;
                existing.lastSeen = Date.now();
                this.connectedUsers.set(uid, existing);
            },
            getQuery: (uid) => this.cv.getQuery(uid),
            setQuery: (uid, q) => this.cv.setQuery(uid, q),
        });

        // Forward every CV frame to Auki: streamFrame for streaming, onPhotoCaptured for single
        this.cv.setFrameSink((uid, frame) => {
            if ((frame as any).isStreaming) {
                this.auki
                    .streamFrame(uid, frame as any)
                    .catch((e: any) => this.logger.warn(`Frame sink forward failed for ${uid}: ${e?.message || String(e)}`));
            } else {
                this.auki.onPhotoCaptured(frame as any, uid);
            }
        });

        this.setupWebviewRoutes();
    }

    /**
     * Handle new session creation and button press events
     */
    protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
        // this gets called whenever a user launches the app
        this.logger.info(`Session started for user ${userId}`);

        // Init audio feedback for this user
        const feedback = new AudioFeedback(session, this.logger);
        this.audioFeedback.set(userId, feedback);
        // Example greeting (low priority so it waits if anything is already playing)
        feedback.speak('Session started. Welcome to Mauki.', FeedbackPriority.Low);

        // Track connected user and default Auki auth state
        this.connectedUsers.set(userId, { sessionId, aukiAuthenticated: false, lastSeen: Date.now() });

        // Provide immediate feedback to unauthenticated users
        await feedback.speak(
            'You are not connected to the Auki network. Please login on your mobile phone, using the Mentra webview.',
            FeedbackPriority.High
        );
        // Initialize last reminder timestamp
        this.aukiLastReminderAt.set(userId, Date.now());

        // this gets called whenever a user presses a button
        session.events.onButtonPress(async (button) => {
            this.logger.info(`Button pressed: ${button.buttonId}, type: ${button.pressType}`);

            if (button.pressType === 'long') {
                // Toggle streaming mode
                const nowActive = !this.cv.isStreaming(userId);
                this.cv.setStreaming(userId, nowActive, { intervalMs: 2000, capacity: 30 });
                this.nextPhotoTime.set(userId, Date.now()); // schedule immediate capture
                const fb = this.audioFeedback.get(userId);
                if (nowActive) {
                    await fb?.speak('Streaming started.', FeedbackPriority.Low).catch(() => {});
                } else {
                    await fb?.speak('Streaming stopped.', FeedbackPriority.Low).catch(() => {});
                }
                return;
            } else {
                // Short press behavior depends on mode
                if (this.cv.isStreaming(userId)) {
                    // Publish latest buffered frame to Auki (no auto uploads in streaming)
                    const latest = this.cv.getLatestFrame(userId);
                    if (!latest) {
                        const fb = this.audioFeedback.get(userId);
                        await fb?.speak('No frame yet, please wait.', FeedbackPriority.Low).catch(() => {});
                        return;
                    }
                    try {
                        // Convert to our StoredPhoto-like shape and send via CV pipeline to Auki
                        const publish = {
                            requestId: latest.requestId,
                            buffer: latest.buffer,
                            timestamp: latest.timestamp,
                            userId: userId,
                            mimeType: latest.mimeType,
                            filename: latest.filename,
                            size: latest.size,
                        };
                        this.cv.processSingleFrame(userId, publish);
                        const fb = this.audioFeedback.get(userId);
                        await fb?.PlaySFX('photo_take', FeedbackPriority.High);
                    } catch (error) {
                        this.logger.error(`Error publishing latest frame: ${error}`);
                    }
                    return;
                }

                // Normal single-shot mode (not streaming): take and process a single photo
                try {
                    const photo = await session.camera.requestPhoto();
                    const feedbackNow = this.audioFeedback.get(userId);
                    await feedbackNow?.PlaySFX('photo_take', FeedbackPriority.High);
                    this.logger.info(`Photo taken for user ${userId}, timestamp: ${photo.timestamp}`);
                    this.cachePhoto(photo, userId);
                } catch (error) {
                    this.logger.error(`Error taking photo: ${error}`);
                }
            }

            // Reset next-photo schedule baseline
            this.nextPhotoTime.set(userId, Date.now());
        });

        // repeatedly check if we are in streaming mode and if we are ready to take another photo
        setInterval(async () => {
            // Repeat unauthenticated reminder every 60 seconds
            const info = this.connectedUsers.get(userId);
            if (info && !info.aukiAuthenticated) {
                const last = this.aukiLastReminderAt.get(userId) ?? 0;
                if (Date.now() - last >= 60000) {
                    const fb = this.audioFeedback.get(userId);
                    if (fb) {
                        await fb.speak(
                            'You are not connected to the Auki network. Please login on your mobile phone, using the Mentra webview.',
                            FeedbackPriority.Low
                        );
                        this.aukiLastReminderAt.set(userId, Date.now());
                    }
                }
            }

            if (this.cv.isStreaming(userId) && Date.now() > (this.nextPhotoTime.get(userId) ?? 0)) {
                try {
                    const { intervalMs } = this.cv.getStreamingConfig(userId);
                    // Schedule next capture first to avoid drift on errors
                    this.nextPhotoTime.set(userId, Date.now() + Math.max(250, intervalMs));

                    // Capture a frame
                    const photo = await session.camera.requestPhoto();

                    // Push into per-user ring buffer (no uploads here)
                    this.cv.pushFrame(userId, {
                        requestId: photo.requestId,
                        buffer: photo.buffer,
                        timestamp: photo.timestamp,
                        userId,
                        mimeType: photo.mimeType,
                        filename: photo.filename,
                        size: photo.size,
                    });
                } catch (error) {
                    this.logger.error(`Error streaming capture: ${error}`);
                }
            }
        }, 1000);
    }


    protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
        // clean up the user's state
        this.cv.setStreaming(userId, false);
        this.cv.clearUser(userId);
        this.isStreamingPhotos.set(userId, false);
        this.nextPhotoTime.delete(userId);

        // dispose audio feedback for this user
        const feedback = this.audioFeedback.get(userId);
        feedback?.dispose();
        this.audioFeedback.delete(userId);

        // remove from connected users list
        this.connectedUsers.delete(userId);
        // clear last reminder timestamp
        this.aukiLastReminderAt.delete(userId);
        // clear any stored Auki tokens

        this.logger.info(`Session stopped for user ${userId}, reason: ${reason}`);

        // clear photo SSE clients
        this.photoSSEClients.get(userId)?.forEach(client => {
            try {
                client.end();
            } catch {}
        });
        this.photoSSEClients.delete(userId);

        // Also notify AukiService to cleanup per-user resources (e.g., WebSocket)
        this.auki.onUserStop(userId);
    }

    /**
     * Cache a photo for display
     */
    private async cachePhoto(photo: PhotoData, userId: string) {
        // create a new stored photo object which includes the photo data and the user id
        const cachedPhoto: StoredPhoto = {
            requestId: photo.requestId,
            buffer: photo.buffer,
            timestamp: photo.timestamp,
            userId: userId,
            mimeType: photo.mimeType,
            filename: photo.filename,
            size: photo.size
        };

        // clear previous analysis result for this user (new photo invalidates old text)
        this.analysisByUser.delete(userId);

        // cache the photo for display
        this.photos.set(userId, cachedPhoto);
        // update the latest photo timestamp
        this.latestPhotoTimestamp.set(userId, cachedPhoto.timestamp.getTime());
        this.logger.info(`Photo cached for user ${userId}, timestamp: ${cachedPhoto.timestamp}`);

        // Send to CV pipeline for processing and forwarding to AukiService
        this.cv.processSingleFrame(userId, cachedPhoto);

        // Emit to SSE clients for immediate photo updates
        const clients = this.photoSSEClients.get(userId) || [];
        if (clients.length > 0) {
            const data = {
                requestId: cachedPhoto.requestId,
                timestamp: cachedPhoto.timestamp.getTime(),
            };
            clients.forEach(client => {
                try {
                    client.write(`data: ${JSON.stringify(data)}\n\n`);
                } catch (e) {
                    // client might be closed
                }
            });
        }
    }

    /**
     * Set up webview routes for photo display functionality
     */
    private setupWebviewRoutes(): void {
        const app = this.getExpressApp();

        // API endpoint to get the latest photo for the authenticated user
        app.get('/api/latest-photo', (req: any, res: any) => {
            const userId = (req as AuthenticatedRequest).authUserId;

            if (!userId) {
                res.status(401).json({ error: 'Not authenticated' });
                return;
            }

            // TODO(ngrok): lower the throttle when not behind ngrok (currently ~2s)
            const now = Date.now();
            const last = this.rateLimitLatestPhoto.get(userId) ?? 0;
            const MIN_INTERVAL_MS = 2000;
            if (now - last < MIN_INTERVAL_MS) {
                const retrySec = Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000);
                res.status(429).set('Retry-After', String(retrySec)).json({ error: 'Too Many Requests', detail: 'Please slow down polling latest-photo' });
                return;
            }
            this.rateLimitLatestPhoto.set(userId, now);

            const photo = this.photos.get(userId);
            if (!photo) {
                res.status(404).json({ error: 'No photo available' });
                return;
            }

            const ts = photo.timestamp.getTime();
            const isRecent = now - ts <= this.PHOTO_RECENT_WINDOW_MS;

            // TODO(ngrok): relax the recency gate when not hosted behind ngrok
            res.json({
                requestId: photo.requestId,
                timestamp: ts,
                hasPhoto: isRecent,
                recent: isRecent
            });
        });

        // API endpoint to get photo data
        app.get('/api/photo/:requestId', (req: any, res: any) => {
            const userId = (req as AuthenticatedRequest).authUserId;
            const requestId = req.params.requestId;

            if (!userId) {
                res.status(401).json({ error: 'Not authenticated' });
                return;
            }

            const photo = this.photos.get(userId);
            if (!photo || photo.requestId !== requestId) {
                res.status(404).json({ error: 'Photo not found' });
                return;
            }

            res.set({
                'Content-Type': photo.mimeType,
                'Cache-Control': 'no-cache'
            });
            res.send(photo.buffer);
        });

        // API endpoint to get analysis for a specific photo (latest only per user)
        app.get('/api/photo-analysis/:requestId', (req: any, res: any) => {
            const userId = (req as AuthenticatedRequest).authUserId;
            const requestId = req.params.requestId;

            if (!userId) {
                res.status(401).json({ error: 'Not authenticated' });
                return;
            }

            // TODO(ngrok): lower the throttle when not behind ngrok (currently ~2.5s)
            const now = Date.now();
            const last = this.rateLimitAnalysis.get(userId) ?? 0;
            const MIN_INTERVAL_MS = 2500;
            if (now - last < MIN_INTERVAL_MS) {
                const retrySec = Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000);
                res.status(429).set('Retry-After', String(retrySec)).json({ error: 'Too Many Requests', detail: 'Please slow down polling analysis' });
                return;
            }
            this.rateLimitAnalysis.set(userId, now);

            // Prefer AukiService's analysis
            const analysis = this.auki.getAnalysisFor(userId, requestId);

            if (!analysis) {
                res.status(404).json({ error: 'No analysis available yet' });
                return;
            }

            // Trigger TTS once per requestId (per user)
            let spoken = this.ttsSpokenByUser.get(userId);
            if (!spoken) {
                spoken = new Set<string>();
                this.ttsSpokenByUser.set(userId, spoken);
            }
            if (!spoken.has(requestId)) {
                const fb = this.audioFeedback.get(userId);
                if (!fb) {
                    this.logger?.warn?.(`AudioFeedback missing for user ${userId}; cannot speak analysis for ${requestId}`);
                } else {
                    try {
                        const maybePromise = fb.speak(analysis.text, FeedbackPriority.High);
                        if (typeof (maybePromise as any)?.catch === 'function') {
                            (maybePromise as Promise<void>).catch((err: any) => {
                                this.logger?.error?.(
                                    `TTS speak failed for user ${userId} req=${requestId}: ${err?.message || String(err)}`
                                );
                            });
                        }
                    } catch (err: any) {
                        this.logger?.error?.(
                            `TTS speak threw for user ${userId} req=${requestId}: ${err?.message || String(err)}`
                        );
                    }
                }
                spoken.add(requestId);
            }

            res.json({ requestId, text: analysis.text, at: analysis.at });
        });

        // Stop current TTS playback and clear queue
        app.post('/audio/stop', async (req: any, res: any) => {
          const userId = (req as AuthenticatedRequest).authUserId;
          if (!userId) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
          }
          try {
            const fb = this.audioFeedback.get(userId);
            await fb?.stopAll();
            res.json({ ok: true });
          } catch (e: any) {
            res.status(500).json({ error: 'Failed to stop audio', detail: e?.message || 'unknown' });
          }
        });

        // API endpoint to list connected users and their Auki auth state
        app.get('/api/users', (req: any, res: any) => {
            const users = Array.from(this.connectedUsers.entries()).map(([userId, info]) => ({
                userId,
                sessionId: info.sessionId,
                aukiAuthenticated: info.aukiAuthenticated,
                lastSeen: info.lastSeen,
            }));
            res.json({ users });
        });

        // Auki login route is handled by AukiService.registerRoutes(app)

        // Main webview route - displays login if unauthenticated with Auki, otherwise the photo viewer
        app.get('/webview', async (req: any, res: any) => {
            const userId = (req as AuthenticatedRequest).authUserId;

            if (!userId) {
                res.status(401).send(`
          <html>
            <head><title>Photo Viewer - Not Authenticated</title></head>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
              <h1>Please open this page from the MentraOS app</h1>
            </body>
          </html>
        `);
                return;
            }

            const aukiState = this.connectedUsers.get(userId);
            if (!aukiState || !aukiState.aukiAuthenticated) {
                const templatePath = path.join(process.cwd(), 'views', 'auki-signin.ejs');
                const html = await ejs.renderFile(templatePath, {});
                res.send(html);
                return;
            }

            const templatePath = path.join(process.cwd(), 'views', 'photo-viewer.ejs');
            const html = await ejs.renderFile(templatePath, {});
            res.send(html);
        });

        // Settings route - displays settings if authenticated with Auki, otherwise login
        app.get('/settings', async (req: any, res: any) => {
            const userId = (req as AuthenticatedRequest).authUserId;

            if (!userId) {
                res.status(401).send(`
          <html>
            <head><title>Settings - Not Authenticated</title></head>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
              <h1>Please open this page from the MentraOS app</h1>
            </body>
          </html>
        `);
                return;
            }

            const aukiState = this.connectedUsers.get(userId);
            if (!aukiState || !aukiState.aukiAuthenticated) {
                const templatePath = path.join(process.cwd(), 'views', 'auki-signin.ejs');
                const html = await ejs.renderFile(templatePath, {});
                res.send(html);
                return;
            }

            const templatePath = path.join(process.cwd(), 'views', 'auki-settings.ejs');
            const html = await ejs.renderFile(templatePath, {});
            res.send(html);
        });

        // ------------- AUKI DOMAIN ROUTES -------------
        // Register CV Pipeline API (single source of truth for the query)
        this.cv.registerRoutes(app);

        // Error feedback SSE stream for webviews (per-user)
        ErrorFeedback.registerRoutes(app, (req: any) => (req as AuthenticatedRequest).authUserId);

        // Backward-compat shim: /api/change-query → /api/cv/query
        // TODO: remove this shim after the webview is updated everywhere
        app.post('/api/change-query', async (req: any, res: any) => {
            try {
                const userId = (req as AuthenticatedRequest).authUserId;
                if (!userId) return res.status(401).json({ error: 'Not authenticated' });
                const qRaw = (req.body && (req.body.query ?? req.body.q)) ?? (req.query && (req.query.q ?? req.query.query));
                const query = typeof qRaw === 'string' ? qRaw.trim() : '';
                if (!query) return res.status(400).json({ error: 'Missing query' });
                this.cv.setQuery(userId, query);
                res.json({ ok: true, query, via: 'shim' });
            } catch (e: any) {
                res.status(500).json({ error: 'Failed to update query', detail: e?.message ?? 'unknown' });
            }
        });

        // SSE stream for immediate photo updates
        app.get('/photo/stream', (req: any, res: any) => {
            const userId = (req as AuthenticatedRequest).authUserId;

            if (!userId) {
                res.status(401).json({ error: 'Not authenticated' });
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Cache-Control',
            });

            // Store the response object to send updates later
            if (!this.photoSSEClients.has(userId)) {
                this.photoSSEClients.set(userId, []);
            }
            this.photoSSEClients.get(userId)!.push(res);

            req.on('close', () => {
                const clients = this.photoSSEClients.get(userId) || [];
                const index = clients.indexOf(res);
                if (index > -1) {
                    clients.splice(index, 1);
                }
            });
        });

        // Delegate all Auki-related API routes to AukiService
        this.auki.registerRoutes(app);
    }

}

// Start the server
// DEV CONSOLE URL: https://console.mentra.glass/
// Get your webhook URL from ngrok (or whatever public URL you have)
const app = new MaukiApp();

app.start().catch(console.error);
