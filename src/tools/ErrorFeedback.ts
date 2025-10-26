import type { Application, Response } from 'express';
import crypto from 'crypto';

export type ErrorSource = 'auki' | 'cvnode' | 'mentra';
export type ErrorEvent = {
  id: string;
  source: ErrorSource;
  message: string;
  time: number;
  detail?: any;
};

export class ErrorFeedbackHub {
  private clientsByUser = new Map<string, Set<Response>>();
  private historyByUser = new Map<string, ErrorEvent[]>();
  private readonly maxHistory = 20;

  registerRoutes(app: Application, getAuthUserId: (req: any) => string | undefined) {
    app.get('/errors/stream', (req: any, res: Response) => {
      const userId = getAuthUserId(req);
      if (!userId) {
        res.status(401).end('Not authenticated');
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // Add client
      let set = this.clientsByUser.get(userId);
      if (!set) {
        set = new Set<Response>();
        this.clientsByUser.set(userId, set);
      }
      set.add(res);

      // Send recent history
      const history = this.historyByUser.get(userId) || [];
      for (const ev of history) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }

      // Keep-alive ping
      const ping = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          // drop
        }
      }, 25000);

      req.on('close', () => {
        clearInterval(ping);
        const clients = this.clientsByUser.get(userId);
        clients?.delete(res);
        if (clients && clients.size === 0) {
          this.clientsByUser.delete(userId);
        }
      });
    });
  }

  push(userId: string | undefined, source: ErrorSource, message: string, detail?: any) {
    if (!userId) return;
    const ev: ErrorEvent = {
      id: crypto.randomUUID(),
      source,
      message,
      time: Date.now(),
      detail,
    };

    // History
    const hist = this.historyByUser.get(userId) || [];
    hist.push(ev);
    while (hist.length > this.maxHistory) hist.shift();
    this.historyByUser.set(userId, hist);

    // Broadcast
    const clients = this.clientsByUser.get(userId);
    if (clients && clients.size) {
      const line = `data: ${JSON.stringify(ev)}\n\n`;
      for (const res of clients) {
        try {
          res.write(line);
        } catch {
          // ignore write errors
        }
      }
    }
  }
}

export const ErrorFeedback = new ErrorFeedbackHub();
