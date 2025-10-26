import axios from 'axios';

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
 * AukiSettings interface for user settings.
 */
interface AukiSettings {
  computeNodeUrl: string;
  taskType: string;
  domainId: string;
  processingMode: 'ws' | 'http';
  useCloudVlm: boolean;
}

/**
 * Environment configuration for Auki. We normalize URLs (remove trailing slash)
 * and keep useful defaults to make running locally easier.
 */
const AUKI_API_BASE_URL = (process.env.AUKI_API_BASE_URL || 'https://api.auki.network').replace(/\/+$/, '');
const AUKI_DDS_BASE_URL = (process.env.AUKI_DDS_BASE_URL || 'https://dds.auki.network').replace(/\/+$/, '');
const AUKI_DEFAULT_DOMAIN_ID = process.env.AUKI_DEFAULT_DOMAIN_ID || process.env.AUKI_DOMAIN_ID || '';


if (!AUKI_DEFAULT_DOMAIN_ID) {
  // This is only a warning. We can still work if the client provides x-domain-id per request.
  console.warn('WARN: AUKI_DEFAULT_DOMAIN_ID not set; client must send x-domain-id header.');
}

/**
 * AukiAuthService
 * Handles all Auki authentication, tokens, domain auth, and settings.
 */
export class AukiAuthService {
  private readonly logger: LoggerLike;
  private readonly setAukiAuthenticated: (userId: string, authed: boolean) => void;

  // ---- Per-user state ----
  private aukiTokens: Map<string, { accessToken: string; refreshToken: string; accessTokenExpiresAt: number }> = new Map();
  private perUserAukiSettings: Map<string, Partial<AukiSettings>> = new Map();

  // ---- Per-user+domain cached Domain auth token + server URL, and refresh timers ----
  // Keys are `${userId}:${domainId}` to avoid cross-domain token mixups for the same user.
  private domainAuthCache: Map<string, { domainToken: string; domainServerUrl: string; exp?: number }> = new Map();
  private domainRefreshTimers: Map<string, NodeJS.Timeout> = new Map();
  // Deduplicate concurrent mint attempts per user+domain
  private domainAuthInflight: Map<string, Promise<{ domainToken: string; domainServerUrl: string; exp?: number }>> = new Map();

  constructor(opts: {
    logger: LoggerLike;
    setAukiAuthenticated: (userId: string, authed: boolean) => void;
  }) {
    this.logger = opts.logger;
    this.setAukiAuthenticated = opts.setAukiAuthenticated;
  }

  /**
   * Authenticate with Auki Network using email/password
   */
  public async login(userId: string, email: string, password: string): Promise<void> {
    // 1) Call Auki login API
    const resp = await axios.post(`${AUKI_API_BASE_URL}/user/login`, { email, password }, { timeout: 10000 });
    const data = resp.data || {};
    const accessToken: string | undefined = data.access_token;
    const refreshToken: string | undefined = data.refresh_token;
    const expiresInSec: number = typeof data.expires_in === 'number' ? data.expires_in : 3600;

    if (!accessToken || !refreshToken) {
      throw new Error('Invalid response from Auki login');
    }

    const accessTokenExpiresAt = Date.now() + expiresInSec * 1000;

    // 2) Save tokens for this user (in-memory)
    this.aukiTokens.set(userId, { accessToken, refreshToken, accessTokenExpiresAt });

    // 3) Tell the app this user is now Auki-authenticated
    this.setAukiAuthenticated(userId, true);
  }

  public getUserSessionAccessToken(userId: string): string {
    const t = this.aukiTokens.get(userId);
    if (!t?.accessToken) throw new Error('User not Auki-authenticated.');
    return t.accessToken;
  }

  public resolveDomainId(reqOrUserId: any): string {
    const headerVal = typeof reqOrUserId === 'object' ? (reqOrUserId.headers?.['x-domain-id'] as string | undefined) : undefined;
    const id = headerVal || AUKI_DEFAULT_DOMAIN_ID;
    if (!id) throw new Error('No domainId (set AUKI_DEFAULT_DOMAIN_ID or send x-domain-id).');
    return id;
  }

  public async mintDomainTokenFromSession(
    sessionAccessToken: string,
    domainId: string
  ): Promise<{ domainToken: string; domainServerUrl: string; exp?: number }> {
    // 1) domains-access-token
    const datResp = await axios.post(
      `${AUKI_API_BASE_URL}/service/domains-access-token`,
      {},
      { headers: { Authorization: `Bearer ${sessionAccessToken}` }, timeout: 15000 }
    );
    const dat = datResp.data?.access_token;
    if (!dat) throw new Error('domains-access-token missing access_token');

    // 2) domain auth
    const dAuth = await axios.post(
      `${AUKI_DDS_BASE_URL}/api/v1/domains/${encodeURIComponent(domainId)}/auth`,
      {},
      {
        headers: {
          Authorization: `Bearer ${dat}`,
          'posemesh-client-id': 'mentra-glass',
        },
        timeout: 15000,
      }
    );
    const domainToken = dAuth.data?.access_token;
    const domainServerUrl = dAuth.data?.domain_server?.url;
    if (!domainToken || !domainServerUrl) {
      throw new Error('Domain auth missing access_token or domain_server.url');
    }
    const exp = dAuth.data?.exp;
    return { domainToken, domainServerUrl, exp };
  }

  public async ensureDomainAuth(
    userId: string,
    explicitDomainId?: string
  ): Promise<{ domainToken: string; domainServerUrl: string; exp?: number }> {
    const { domainId } = explicitDomainId ? { domainId: explicitDomainId } : this.getAukiSettings(userId);
    const now = Date.now();
    const key = `${userId}:${domainId}`;

    // Fast-path: valid cache
    const cached = this.domainAuthCache.get(key);
    if (cached && (typeof cached.exp !== 'number' || cached.exp - now > 60_000)) {
      this.logger?.info?.(`[AuthService] Domain token cache hit user=${userId} domain=${domainId}`);
      return cached;
    }

    // Deduplicate concurrent mint attempts
    const inFlight = this.domainAuthInflight.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const sessionAccess = this.getUserSessionAccessToken(userId);
      this.logger?.info?.(`[AuthService] Minting domain token user=${userId} domain=${domainId}`);
      const minted = await this.mintDomainTokenFromSession(sessionAccess, domainId);

      this.domainAuthCache.set(key, minted);
      this.logger?.info?.(
        `[AuthService] Minted domain token user=${userId} domain=${domainId} exp=${typeof minted.exp === 'number' ? new Date(minted.exp).toISOString() : '(n/a)'}`
      );

      // schedule refresh ~40 minutes or 2 min before exp if provided
      const existingTimer = this.domainRefreshTimers.get(key);
      if (existingTimer) clearTimeout(existingTimer);
      let delayMs = 40 * 60 * 1000; // 40 min default
      if (typeof minted.exp === 'number') {
        const until = minted.exp - now - 120_000; // refresh 2m early
        delayMs = Math.max(60_000, until);
      }
      const timer = setTimeout(async () => {
        try {
          // Remove any stale inflight before refresh attempt
          this.domainAuthInflight.delete(key);
          const refreshed = await this.mintDomainTokenFromSession(this.getUserSessionAccessToken(userId), domainId);
          this.domainAuthCache.set(key, refreshed);
          this.logger?.info?.(`[AuthService] Domain token refreshed user=${userId} domain=${domainId}`);
        } catch (e: any) {
          this.logger?.warn?.(`Domain token refresh failed for user ${userId} domain=${domainId}: ${e?.message || e}`);
        } finally {
          // Reschedule regardless
          try {
            await this.ensureDomainAuth(userId, domainId);
          } catch {
            // ignore
          }
        }
      }, delayMs);
      this.domainRefreshTimers.set(key, timer);

      return minted;
    })();

    this.domainAuthInflight.set(key, promise);
    try {
      return await promise;
    } finally {
      // Clear inflight once resolved or rejected
      this.domainAuthInflight.delete(key);
    }
  }

  public getAukiSettings(userId: string): AukiSettings {
    const overrides = this.perUserAukiSettings.get(userId) || {};
    const computeNodeUrl = (overrides.computeNodeUrl || AUKI_COMPUTE_NODE_URL).replace(/\/+$/, '');
    const taskType = overrides.taskType || AUKI_VLM_TASK_TYPE;
    const domainId = overrides.domainId || AUKI_DEFAULT_DOMAIN_ID;
    const processingMode = overrides.processingMode || 'http';
    const useCloudVlm = computeNodeUrl === 'https://vlm-node.dev.aukiverse.com/api/v1/jobs';
    if (!domainId) throw new Error('No domainId configured. Set AUKI_DEFAULT_DOMAIN_ID or provide per-user override.');
    return { computeNodeUrl, taskType, domainId, processingMode, useCloudVlm };
  }

  public updateAukiSettings(userId: string, updates: Partial<AukiSettings>): void {
    const prev = this.perUserAukiSettings.get(userId) || {};
    const newSettings = { ...prev, ...updates };
    if (newSettings.useCloudVlm !== undefined) {
      newSettings.computeNodeUrl = newSettings.useCloudVlm ? 'https://vlm-node.dev.aukiverse.com/api/v1/jobs' : 'http://0.0.0.0:8080/api/v1/jobs';
    }
    this.perUserAukiSettings.set(userId, newSettings);
  }

  public onUserStop(userId: string): void {
    // Clear tokens and domain auth cache/timer for this user
    this.aukiTokens.delete(userId);

    // Clear all per-domain timers, inflight entries, and cached tokens for this user
    const prefix = `${userId}:`;
    // Timers
    for (const [k, t] of Array.from(this.domainRefreshTimers.entries())) {
      if (k.startsWith(prefix)) {
        if (t) clearTimeout(t);
        this.domainRefreshTimers.delete(k);
      }
    }
    // Inflight
    for (const k of Array.from(this.domainAuthInflight.keys())) {
      if (k.startsWith(prefix)) {
        this.domainAuthInflight.delete(k);
      }
    }
    // Cache
    for (const k of Array.from(this.domainAuthCache.keys())) {
      if (k.startsWith(prefix)) {
        this.domainAuthCache.delete(k);
      }
    }

    this.logger?.info?.(`[AuthService] User session stopped; cleared domain auth cache user=${userId}`);
  }
}

// Vision Compute Node defaults (can be overridden per-user via settings endpoint)
const AUKI_COMPUTE_NODE_URL = (process.env.AUKI_COMPUTE_NODE_URL || 'http://0.0.0.0:8080/api/v1/jobs').replace(/\/+$/, '');
const AUKI_VLM_TASK_TYPE = process.env.AUKI_VLM_TASK_TYPE || 'task_timing_v1';