import * as os from 'os';
import * as fs from 'fs';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { RoomManager } from '../room/room.manager';

export interface TelegramSendOptions {
  chatId?: string;
  botToken?: string;
  parseMode?: 'HTML' | 'Markdown';
  disableNotification?: boolean;
  dedupeKey?: string;
  cooldownMs?: number;
  forceInTest?: boolean;
}

export interface TelegramSendResult {
  ok: boolean;
  status?: number;
  messageId?: number;
  description?: string;
  skippedReason?: string;
}

export interface ServiceCheckStatus {
  name: string;
  healthy: boolean;
  latencyMs: number;
  details: string;
}

export interface ServerHealthReport {
  timestampIso: string;
  timestampLocal: string;
  hostname: string;
  uptimeSeconds: number;
  cpuCores: number;
  loadAvg1m: number;
  loadAvg5m: number;
  loadAvg15m: number;
  cpuUsagePercent: number;
  ramTotalMb: number;
  ramUsedMb: number;
  ramUsagePercent: number;
  diskTotalGb: number;
  diskUsedGb: number;
  diskUsagePercent: number;
  processRssMb: number;
  processHeapUsedMb: number;
  activeSessionsCount: number;
  overallHealthy: boolean;
  services: ServiceCheckStatus[];
}

export type TelegramTransportFn = (
  url: string,
  payload: Record<string, any>
) => Promise<{ ok: boolean; status: number; data: any }>;

/**
 * Escapes HTML special characters for safe Telegram HTML parse_mode.
 */
export function escapeTelegramHtml(input: string): string {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Common Non-Blocking Telegram Alert & Daily 11:00 PM Server Health Monitoring Service.
 */
export class TelegramMonitorService {
  private static dedupeCache = new Map<string, number>();
  private static serviceStateMap = new Map<string, { healthy: boolean; downSince?: number }>();
  private static watchdogTimer: NodeJS.Timeout | null = null;
  private static dailyReportTimer: NodeJS.Timeout | null = null;
  private static lastDailyReportDate = '';
  private static customTransport: TelegramTransportFn | null = null;
  private static processHooksRegistered = false;

  public static DEFAULT_COOLDOWN_MS = 60_000; // 60s deduplication window for identical error signatures
  public static WATCHDOG_INTERVAL_MS = 60_000; // Check services every 60s
  public static DAILY_CHECK_INTERVAL_MS = 30_000; // Check 11:00 PM schedule every 30s

  /**
   * Allows unit/integration tests to inject a mock HTTP transport.
   */
  public static setTransport(transport: TelegramTransportFn | null): void {
    this.customTransport = transport;
  }

  public static clearDedupeCache(): void {
    this.dedupeCache.clear();
    this.serviceStateMap.clear();
    this.lastDailyReportDate = '';
  }

  private static isAutomatedTestRun(): boolean {
    if (process.env.NODE_ENV === 'test') return true;
    const allArgs = [...process.execArgv, ...process.argv];
    return allArgs.some((arg) => arg === '--test' || arg.includes('node:test'));
  }

  /**
   * Common function to send a message to the configured Telegram group.
   * Safe: never throws; catches network/API errors and falls back to plain text if HTML parsing fails.
   */
  public static async sendTelegramMessage(
    message: string,
    options: TelegramSendOptions = {}
  ): Promise<TelegramSendResult> {
    try {
      const botToken = (options.botToken || env.TELEGRAM_BOT_TOKEN || '').trim();
      const chatId = (options.chatId || env.TELEGRAM_ERROR_CHAT_ID || '')
        .replace(/^["']|["']$/g, '')
        .trim();

      if (!botToken || !chatId) {
        return { ok: false, skippedReason: 'MISSING_TELEGRAM_CONFIG' };
      }

      // Suppress live external network calls during automated test suites unless forceInTest or customTransport is used
      if (this.isAutomatedTestRun() && !options.forceInTest && !this.customTransport) {
        return { ok: true, skippedReason: 'TEST_MODE_SUPPRESSED' };
      }

      // Deduplication / rate-limit check so repeated errors never flood Telegram
      if (options.dedupeKey) {
        const now = Date.now();
        const cooldown = options.cooldownMs ?? this.DEFAULT_COOLDOWN_MS;
        const lastSent = this.dedupeCache.get(options.dedupeKey) || 0;
        if (now - lastSent < cooldown) {
          return { ok: true, skippedReason: 'DEDUPLICATED_COOLDOWN' };
        }
        this.dedupeCache.set(options.dedupeKey, now);
      }

      const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const truncatedText =
        message.length > 4000 ? `${message.slice(0, 3980)}\n...[truncated]` : message;

      const payload: Record<string, any> = {
        chat_id: chatId,
        text: truncatedText,
        disable_web_page_preview: true,
      };
      if (options.parseMode) {
        payload.parse_mode = options.parseMode;
      }
      if (options.disableNotification) {
        payload.disable_notification = true;
      }

      const executeRequest = async (bodyPayload: Record<string, any>) => {
        if (this.customTransport) {
          return await this.customTransport(apiUrl, bodyPayload);
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        try {
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyPayload),
            signal: controller.signal,
          });
          const data: any = await res.json().catch(() => ({}));
          return { ok: res.ok && Boolean(data?.ok), status: res.status, data };
        } finally {
          clearTimeout(timeoutId);
        }
      };

      let response = await executeRequest(payload);

      // If Telegram rejected HTML formatting, retry immediately as plain text so the alert is never lost
      if (!response.ok && options.parseMode) {
        const plainPayload = { ...payload };
        delete plainPayload.parse_mode;
        response = await executeRequest(plainPayload);
      }

      return {
        ok: response.ok,
        status: response.status,
        messageId: response.data?.result?.message_id,
        description: response.data?.description,
      };
    } catch (err: any) {
      console.error('[TelegramMonitorService] Failed to send Telegram message:', err?.message || err);
      return {
        ok: false,
        description: err?.message || 'Telegram request failed',
      };
    }
  }

  /**
   * Fire-and-forget asynchronous wrapper around `sendTelegramMessage`.
   * Dispatches on the next event loop tick (`setImmediate`) so it NEVER blocks any request or socket handler.
   */
  public static notifyTelegramAsync(message: string, options: TelegramSendOptions = {}): void {
    setImmediate(() => {
      void this.sendTelegramMessage(message, options).catch(() => {});
    });
  }

  /**
   * Asynchronously formats and sends an error alert to the Telegram group without blocking the caller.
   */
  public static notifyErrorAsync(params: {
    source: string;
    error: unknown;
    context?: Record<string, any>;
    dedupeKey?: string;
    cooldownMs?: number;
    forceInTest?: boolean;
  }): void {
    setImmediate(() => {
      try {
        const errObj = params.error as any;
        const errMsg =
          errObj instanceof Error
            ? errObj.message
            : typeof errObj === 'string'
            ? errObj
            : JSON.stringify(errObj || 'Unknown error');
        const errName = errObj instanceof Error ? errObj.name : 'Error';
        const stackLines =
          typeof errObj?.stack === 'string'
            ? errObj.stack
                .split('\n')
                .slice(0, 4)
                .join('\n')
            : '';

        const dedupeKey =
          params.dedupeKey || `err:${params.source}:${errName}:${errMsg.slice(0, 120)}`;

        const contextLines = params.context
          ? Object.entries(params.context)
              .filter(([, v]) => v !== undefined && v !== null && v !== '')
              .map(
                ([k, v]) =>
                  `• <b>${escapeTelegramHtml(k)}:</b> <code>${escapeTelegramHtml(String(v))}</code>`
              )
              .join('\n')
          : '';

        const formattedTime = new Date().toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'medium',
          timeStyle: 'medium',
        });

        const htmlMessage = [
          `🚨 <b>[BROADCAST ERROR ALERT]</b>`,
          `• <b>Component:</b> <code>${escapeTelegramHtml(params.source)}</code>`,
          `• <b>Host:</b> <code>${escapeTelegramHtml(os.hostname())}</code>`,
          `• <b>Time (IST):</b> <code>${escapeTelegramHtml(formattedTime)}</code>`,
          `• <b>Error:</b> <code>${escapeTelegramHtml(`${errName}: ${errMsg}`)}</code>`,
          contextLines ? contextLines : null,
          stackLines
            ? `\n<b>Stack Snippet:</b>\n<pre>${escapeTelegramHtml(stackLines.slice(0, 700))}</pre>`
            : null,
        ]
          .filter(Boolean)
          .join('\n');

        void this.sendTelegramMessage(htmlMessage, {
          parseMode: 'HTML',
          dedupeKey,
          cooldownMs: params.cooldownMs ?? this.DEFAULT_COOLDOWN_MS,
          forceInTest: params.forceInTest,
        }).catch(() => {});
      } catch {
        // Never allow error reporter to throw
      }
    });
  }

  /**
   * Probes an HTTP endpoint with a fast timeout to verify service liveness.
   */
  private static async probeHttpService(
    name: string,
    url: string,
    timeoutMs = 3000
  ): Promise<ServiceCheckStatus> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      // Any HTTP response < 500 proves the server is listening and responding
      const healthy = res.status < 500;
      return {
        name,
        healthy,
        latencyMs,
        details: `HTTP ${res.status} (${latencyMs}ms)`,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return {
        name,
        healthy: false,
        latencyMs,
        details: err?.message || 'Connection refused / timeout',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Collects comprehensive Server OS + Broadcast Service health metrics.
   */
  public static async collectServerHealthMetrics(): Promise<ServerHealthReport> {
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const usedMemBytes = Math.max(0, totalMemBytes - freeMemBytes);
    const ramTotalMb = Math.round(totalMemBytes / (1024 * 1024));
    const ramUsedMb = Math.round(usedMemBytes / (1024 * 1024));
    const ramUsagePercent =
      totalMemBytes > 0 ? Math.round((usedMemBytes / totalMemBytes) * 1000) / 10 : 0;

    const cpus = os.cpus() || [];
    const cpuCores = Math.max(1, cpus.length);
    const [load1, load5, load15] = os.loadavg();
    const cpuUsagePercent = Math.min(100, Math.round((load1 / cpuCores) * 1000) / 10);

    let diskTotalGb = 0;
    let diskUsedGb = 0;
    let diskUsagePercent = 0;
    try {
      if (typeof fs.promises.statfs === 'function') {
        const stat = await fs.promises.statfs(env.STORAGE_CACHE_DIR || '/');
        const totalDiskBytes = Number(stat.blocks) * Number(stat.bsize);
        const availDiskBytes = Number(stat.bavail) * Number(stat.bsize);
        const usedDiskBytes = Math.max(0, totalDiskBytes - availDiskBytes);
        diskTotalGb = Math.round((totalDiskBytes / (1024 * 1024 * 1024)) * 10) / 10;
        diskUsedGb = Math.round((usedDiskBytes / (1024 * 1024 * 1024)) * 10) / 10;
        diskUsagePercent =
          totalDiskBytes > 0 ? Math.round((usedDiskBytes / totalDiskBytes) * 1000) / 10 : 0;
      }
    } catch {
      // Fallback if statfs unavailable
    }

    const memUsage = process.memoryUsage();
    const processRssMb = Math.round((memUsage.rss / (1024 * 1024)) * 10) / 10;
    const processHeapUsedMb = Math.round((memUsage.heapUsed / (1024 * 1024)) * 10) / 10;

    // 1. Check Redis
    const services: ServiceCheckStatus[] = [];
    let activeSessionsCount = 0;
    const redisStart = Date.now();
    try {
      const pong = await redis.ping();
      const redisLatency = Date.now() - redisStart;
      services.push({
        name: 'Redis (State & PubSub)',
        healthy: pong === 'PONG',
        latencyMs: redisLatency,
        details: `${pong} (${redisLatency}ms)`,
      });
      const activeSessions = await RoomManager.getActiveSessions().catch(() => []);
      activeSessionsCount = activeSessions.length;
    } catch (err: any) {
      services.push({
        name: 'Redis (State & PubSub)',
        healthy: false,
        latencyMs: Date.now() - redisStart,
        details: err?.message || 'Redis unreachable',
      });
    }

    // 2. Broadcast Engine Self-Check
    services.push({
      name: 'Broadcast Engine (Fastify + Socket.IO)',
      healthy: true,
      latencyMs: 1,
      details: `ONLINE (Port ${env.PORT}, Heap ${processHeapUsedMb}MB)`,
    });

    // 3. Check LiveKit SFU Server
    const livekitCheck = await this.probeHttpService(
      'LiveKit SFU (Audio Stage)',
      env.LIVEKIT_URL || 'http://127.0.0.1:7880'
    );
    services.push(livekitCheck);

    // 4. Check Frontend Next.js Server
    const frontendCheck = await this.probeHttpService(
      'Broadcast Frontend (Next.js)',
      env.FRONTEND_HEALTH_URL || 'http://127.0.0.1:3000'
    );
    services.push(frontendCheck);

    // 5. Check Laravel API if configured in laravel_api mode
    if (env.DATA_SOURCE_MODE === 'laravel_api' && env.LARAVEL_API_BASE_URL) {
      const laravelCheck = await this.probeHttpService(
        'Laravel LMS API',
        env.LARAVEL_API_BASE_URL
      );
      services.push(laravelCheck);
    }

    const overallHealthy = services.every((s) => s.healthy);
    const now = new Date();

    return {
      timestampIso: now.toISOString(),
      timestampLocal: now.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'medium',
      }),
      hostname: os.hostname(),
      uptimeSeconds: Math.floor(os.uptime()),
      cpuCores,
      loadAvg1m: Math.round(load1 * 100) / 100,
      loadAvg5m: Math.round(load5 * 100) / 100,
      loadAvg15m: Math.round(load15 * 100) / 100,
      cpuUsagePercent,
      ramTotalMb,
      ramUsedMb,
      ramUsagePercent,
      diskTotalGb,
      diskUsedGb,
      diskUsagePercent,
      processRssMb,
      processHeapUsedMb,
      activeSessionsCount,
      overallHealthy,
      services,
    };
  }

  /**
   * Formats a `ServerHealthReport` into a clean, readable Telegram HTML message.
   */
  public static formatHealthReportMessage(
    report: ServerHealthReport,
    title = '📊 DAILY 11:00 PM SERVER HEALTH REPORT'
  ): string {
    const hours = Math.floor(report.uptimeSeconds / 3600);
    const mins = Math.floor((report.uptimeSeconds % 3600) / 60);

    const serviceLines = report.services
      .map((s) => {
        const icon = s.healthy ? '✅' : '🔴';
        return `${icon} <b>${escapeTelegramHtml(s.name)}:</b> <code>${escapeTelegramHtml(
          s.details
        )}</code>`;
      })
      .join('\n');

    const statusBadge = report.overallHealthy ? '🟢 ALL SERVICES HEALTHY' : '🔴 DEGRADED / ATTENTION REQUIRED';

    return [
      `<b>${escapeTelegramHtml(title)}</b>`,
      `Status: <b>${statusBadge}</b>`,
      ``,
      `🖥 <b>Server & Host Metrics</b>`,
      `• <b>Host:</b> <code>${escapeTelegramHtml(report.hostname)}</code>`,
      `• <b>Time (IST):</b> <code>${escapeTelegramHtml(report.timestampLocal)}</code>`,
      `• <b>OS Uptime:</b> <code>${hours}h ${mins}m</code>`,
      `• <b>CPU Load:</b> <code>${report.cpuUsagePercent}% (load: ${report.loadAvg1m}, ${report.loadAvg5m}, ${report.loadAvg15m} / ${report.cpuCores} cores)</code>`,
      `• <b>RAM Usage:</b> <code>${report.ramUsedMb} MB / ${report.ramTotalMb} MB (${report.ramUsagePercent}%)</code>`,
      `• <b>Disk Usage:</b> <code>${report.diskUsedGb} GB / ${report.diskTotalGb} GB (${report.diskUsagePercent}%)</code>`,
      `• <b>Engine Memory:</b> <code>RSS ${report.processRssMb} MB | Heap ${report.processHeapUsedMb} MB</code>`,
      `• <b>Active Live Classes:</b> <code>${report.activeSessionsCount}</code>`,
      ``,
      `🔌 <b>Service Health Checks</b>`,
      serviceLines,
    ].join('\n');
  }

  /**
   * Collects health metrics and sends the formatted Server Health Report to Telegram.
   */
  public static async sendServerHealthReport(options?: {
    title?: string;
    forceInTest?: boolean;
  }): Promise<{ report: ServerHealthReport; telegramResult: TelegramSendResult }> {
    const report = await this.collectServerHealthMetrics();
    const html = this.formatHealthReportMessage(
      report,
      options?.title || '📊 DAILY 11:00 PM SERVER HEALTH REPORT'
    );
    const telegramResult = await this.sendTelegramMessage(html, {
      parseMode: 'HTML',
      forceInTest: options?.forceInTest,
    });
    return { report, telegramResult };
  }

  /**
   * Checks all services and sends an immediate Telegram alert if any service goes DOWN or RECOVERS.
   */
  public static async checkServicesAndAlert(options?: {
    forceInTest?: boolean;
  }): Promise<ServerHealthReport> {
    const report = await this.collectServerHealthMetrics();

    for (const svc of report.services) {
      const prev = this.serviceStateMap.get(svc.name);

      if (!svc.healthy) {
        // Service is DOWN
        if (!prev || prev.healthy) {
          this.serviceStateMap.set(svc.name, { healthy: false, downSince: Date.now() });
          const alertHtml = [
            `🚨 <b>[SERVICE DOWN ALERT]</b>`,
            `• <b>Service:</b> <code>${escapeTelegramHtml(svc.name)}</code>`,
            `• <b>Status:</b> 🔴 <b>DOWN / NOT RESPONDING</b>`,
            `• <b>Details:</b> <code>${escapeTelegramHtml(svc.details)}</code>`,
            `• <b>Host:</b> <code>${escapeTelegramHtml(report.hostname)}</code>`,
            `• <b>Time (IST):</b> <code>${escapeTelegramHtml(report.timestampLocal)}</code>`,
            `• <b>CPU / RAM:</b> <code>CPU ${report.cpuUsagePercent}% | RAM ${report.ramUsagePercent}%</code>`,
          ].join('\n');

          this.notifyTelegramAsync(alertHtml, {
            parseMode: 'HTML',
            dedupeKey: `service_down:${svc.name}`,
            cooldownMs: 5 * 60_000, // Re-alert at most every 5 minutes while down
            forceInTest: options?.forceInTest,
          });
        }
      } else {
        // Service is UP
        if (prev && !prev.healthy) {
          const downDurationSec = prev.downSince
            ? Math.max(1, Math.round((Date.now() - prev.downSince) / 1000))
            : 0;
          this.serviceStateMap.set(svc.name, { healthy: true });
          const recoveryHtml = [
            `✅ <b>[SERVICE RECOVERED]</b>`,
            `• <b>Service:</b> <code>${escapeTelegramHtml(svc.name)}</code>`,
            `• <b>Status:</b> 🟢 <b>ONLINE</b>`,
            `• <b>Details:</b> <code>${escapeTelegramHtml(svc.details)}</code>`,
            `• <b>Downtime:</b> <code>${downDurationSec}s</code>`,
            `• <b>Host:</b> <code>${escapeTelegramHtml(report.hostname)}</code>`,
            `• <b>Time (IST):</b> <code>${escapeTelegramHtml(report.timestampLocal)}</code>`,
          ].join('\n');

          this.notifyTelegramAsync(recoveryHtml, {
            parseMode: 'HTML',
            dedupeKey: `service_up:${svc.name}`,
            cooldownMs: 10_000,
            forceInTest: options?.forceInTest,
          });
        } else if (!prev) {
          this.serviceStateMap.set(svc.name, { healthy: true });
        }
      }
    }

    return report;
  }

  /**
   * Checks whether current local time (Asia/Kolkata / server time) is 11:00 PM (23:00)
   * and triggers the daily health report exactly once per calendar day.
   */
  public static async evaluateDailyReportSchedule(nowDate = new Date()): Promise<boolean> {
    const targetTime = (env.TELEGRAM_DAILY_REPORT_TIME || '23:00').trim();
    const [targetHourStr, targetMinStr] = targetTime.split(':');
    const targetHour = parseInt(targetHourStr || '23', 10);
    const targetMinute = parseInt(targetMinStr || '0', 10);

    // Format current time in Asia/Kolkata (IST) so 11:00 PM is always accurate
    const istParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(nowDate);

    const partMap: Record<string, string> = {};
    for (const part of istParts) {
      partMap[part.type] = part.value;
    }

    const dateKey = `${partMap.year}-${partMap.month}-${partMap.day}`;
    const currentHour = parseInt(partMap.hour || '0', 10) % 24;
    const currentMinute = parseInt(partMap.minute || '0', 10);

    if (currentHour !== targetHour || currentMinute !== targetMinute) {
      return false;
    }

    if (this.lastDailyReportDate === dateKey) {
      return false;
    }

    // Acquire distributed Redis lock for this date so multiple processes don't send duplicate 11:00 PM reports
    try {
      const redisLockKey = `monitor:daily_health_report:${dateKey}`;
      const locked = await redis.set(redisLockKey, '1', 'EX', 7200, 'NX');
      if (!locked) {
        this.lastDailyReportDate = dateKey;
        return false;
      }
    } catch {
      // If Redis is down at 11:00 PM, still proceed using in-memory guard
    }

    this.lastDailyReportDate = dateKey;
    void this.sendServerHealthReport({
      title: '📊 DAILY 11:00 PM SERVER HEALTH REPORT',
    }).catch(() => {});

    return true;
  }

  /**
   * Starts background service watchdog (every 60s), daily 11:00 PM scheduler,
   * and process-level uncaughtException / unhandledRejection listeners.
   */
  public static init(): void {
    if (!this.processHooksRegistered) {
      this.processHooksRegistered = true;

      process.on('uncaughtException', (err) => {
        console.error('[Process:uncaughtException]', err);
        this.notifyErrorAsync({
          source: 'Node.js Process (uncaughtException)',
          error: err,
        });
      });

      process.on('unhandledRejection', (reason) => {
        console.error('[Process:unhandledRejection]', reason);
        this.notifyErrorAsync({
          source: 'Node.js Process (unhandledRejection)',
          error: reason,
        });
      });
    }

    if (!this.watchdogTimer) {
      // Run initial service check after 5s so server finishes binding port 4000 first
      setTimeout(() => {
        if (this.watchdogTimer) {
          void this.checkServicesAndAlert().catch(() => {});
        }
      }, 5000).unref();

      this.watchdogTimer = setInterval(() => {
        void this.checkServicesAndAlert().catch(() => {});
      }, this.WATCHDOG_INTERVAL_MS);
      this.watchdogTimer.unref();
    }

    if (!this.dailyReportTimer) {
      this.dailyReportTimer = setInterval(() => {
        void this.evaluateDailyReportSchedule().catch(() => {});
      }, this.DAILY_CHECK_INTERVAL_MS);
      this.dailyReportTimer.unref();
    }

    console.log(
      `[TelegramMonitorService] Initialized (Chat: ${env.TELEGRAM_ERROR_CHAT_ID}, Daily Report: ${env.TELEGRAM_DAILY_REPORT_TIME} IST).`
    );
  }

  /**
   * Stops background timers cleanly during server shutdown or test teardown.
   */
  public static close(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.dailyReportTimer) {
      clearInterval(this.dailyReportTimer);
      this.dailyReportTimer = null;
    }
  }
}

/**
 * Common reusable function to send a Telegram message (async Promise).
 */
export async function sendTelegramMessage(
  message: string,
  options: TelegramSendOptions = {}
): Promise<TelegramSendResult> {
  return TelegramMonitorService.sendTelegramMessage(message, options);
}

/**
 * Common reusable non-blocking function to send a Telegram message in the background (`setImmediate`).
 * Never blocks HTTP requests, Socket.IO events, or workers.
 */
export function sendTelegramMessageAsync(
  message: string,
  options: TelegramSendOptions = {}
): void {
  TelegramMonitorService.notifyTelegramAsync(message, options);
}

/**
 * Common reusable non-blocking function to report an application or service error to Telegram in the background.
 */
export function notifyTelegramErrorAsync(params: {
  source: string;
  error: unknown;
  context?: Record<string, any>;
  dedupeKey?: string;
  cooldownMs?: number;
  forceInTest?: boolean;
}): void {
  TelegramMonitorService.notifyErrorAsync(params);
}

