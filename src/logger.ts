/**
 * AnoFox Terminal & Privacy Logger
 * Provides configurable severity levels, anonymized URL logging to the terminal/console,
 * and an isolated, strictly ephemeral internal in-memory log buffer that does NOT go to console.
 */

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'OFF';

export const SEVERITY_LEVELS: Record<LogSeverity, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  OFF: 4
};

// Sensitive query parameter keys that must be redacted in anonymized logs
const SENSITIVE_PARAM_KEYS = new Set([
  'email',
  'mail',
  'user',
  'username',
  'login',
  'password',
  'pass',
  'pwd',
  'token',
  'access_token',
  'auth_token',
  'id_token',
  'secret',
  'key',
  'api_key',
  'apikey',
  'code',
  'state',
  'ticket',
  'session',
  'session_id',
  'jwt',
  'q',
  'query',
  'search',
  'p',
  'phone',
  'tel',
  'address',
  'ssn'
]);

/**
 * Anonymizes sensitive query parameter values from a URL string for safe terminal logging.
 */
export function anonymizeUrlForLog(inputUrl: string): string {
  try {
    const url = new URL(inputUrl);
    for (const [key, value] of url.searchParams.entries()) {
      const lower = key.toLowerCase();
      if (SENSITIVE_PARAM_KEYS.has(lower) || lower.includes('token') || lower.includes('secret') || lower.includes('pass')) {
        url.searchParams.set(key, '[REDACTED]');
      } else if (value.length > 40) {
        // Redact excessively long opaque parameter values (likely IDs/hashes)
        url.searchParams.set(key, `${value.slice(0, 6)}...[LEN:${value.length}]`);
      }
    }
    return url.toString();
  } catch {
    return '[Invalid URL]';
  }
}

export interface InternalLogEntry {
  id: number;
  timestamp: number;
  timeFormatted: string;
  level: LogSeverity;
  category: string;
  message: string;
  details?: string;
}

export interface LoggerConfig {
  terminalLogging: boolean;
  severity: LogSeverity;
  internalLogging?: boolean;
}

export class TerminalLogger {
  private terminalLogging: boolean = true;
  private severity: LogSeverity = 'INFO';
  private internalLogging: boolean = false;
  private internalLogs: InternalLogEntry[] = [];
  private nextLogId: number = 1;
  private readonly maxInternalLogs: number = 200;

  constructor(config?: Partial<LoggerConfig>) {
    if (config) {
      if (typeof config.terminalLogging === 'boolean') {
        this.terminalLogging = config.terminalLogging;
      }
      if (config.severity && config.severity in SEVERITY_LEVELS) {
        this.severity = config.severity;
      }
      if (typeof config.internalLogging === 'boolean') {
        this.internalLogging = config.internalLogging;
      }
    }
  }

  public setConfig(config: Partial<LoggerConfig>): void {
    if (typeof config.terminalLogging === 'boolean') {
      this.terminalLogging = config.terminalLogging;
    }
    if (config.severity && config.severity in SEVERITY_LEVELS) {
      this.severity = config.severity;
    }
    if (typeof config.internalLogging === 'boolean') {
      this.setInternalLogging(config.internalLogging);
    }
  }

  public getConfig(): LoggerConfig {
    return {
      terminalLogging: this.terminalLogging,
      severity: this.severity,
      internalLogging: this.internalLogging
    };
  }

  public setInternalLogging(enabled: boolean): void {
    if (this.internalLogging && !enabled) {
      this.clearInternalLogs();
    }
    this.internalLogging = enabled;
  }

  public isInternalLoggingEnabled(): boolean {
    return this.internalLogging;
  }

  public getInternalLogs(): InternalLogEntry[] {
    return [...this.internalLogs];
  }

  public clearInternalLogs(): void {
    this.internalLogs = [];
  }

  private isLevelEnabled(level: LogSeverity): boolean {
    if (this.severity === 'OFF' || level === 'OFF') return false;
    return SEVERITY_LEVELS[level] >= SEVERITY_LEVELS[this.severity];
  }

  /**
   * Records an entry into the internal log buffer ONLY.
   * Does NOT output to browser console.
   */
  public logInternal(level: LogSeverity, category: string, message: string, details?: string): void {
    if (!this.internalLogging || !this.isLevelEnabled(level)) {
      return;
    }

    const now = new Date();
    const timeFormatted = now.toTimeString().split(' ')[0] || '';

    const entry: InternalLogEntry = {
      id: this.nextLogId++,
      timestamp: Date.now(),
      timeFormatted,
      level,
      category,
      message,
      details
    };

    this.internalLogs.unshift(entry);
    if (this.internalLogs.length > this.maxInternalLogs) {
      this.internalLogs.length = this.maxInternalLogs;
    }
  }

  public debug(message: string, ...args: unknown[]): void {
    if (this.terminalLogging && this.isLevelEnabled('DEBUG')) {
      console.debug(`[AnoFox][DEBUG] ${message}`, ...args);
    }
    if (this.internalLogging && this.isLevelEnabled('DEBUG')) {
      this.logInternal('DEBUG', 'SYSTEM', message, args.length > 0 ? JSON.stringify(args) : undefined);
    }
  }

  public info(message: string, ...args: unknown[]): void {
    if (this.terminalLogging && this.isLevelEnabled('INFO')) {
      console.info(`[AnoFox][INFO] ${message}`, ...args);
    }
    if (this.internalLogging && this.isLevelEnabled('INFO')) {
      this.logInternal('INFO', 'SYSTEM', message, args.length > 0 ? JSON.stringify(args) : undefined);
    }
  }

  public warn(message: string, ...args: unknown[]): void {
    if (this.terminalLogging && this.isLevelEnabled('WARN')) {
      console.warn(`[AnoFox][WARN] ${message}`, ...args);
    }
    if (this.internalLogging && this.isLevelEnabled('WARN')) {
      this.logInternal('WARN', 'SYSTEM', message, args.length > 0 ? JSON.stringify(args) : undefined);
    }
  }

  public error(message: string, ...args: unknown[]): void {
    if (this.terminalLogging && this.isLevelEnabled('ERROR')) {
      console.error(`[AnoFox][ERROR] ${message}`, ...args);
    }
    if (this.internalLogging && this.isLevelEnabled('ERROR')) {
      this.logInternal('ERROR', 'SYSTEM', message, args.length > 0 ? JSON.stringify(args) : undefined);
    }
  }

  /**
   * Logs a URL cleaning event at INFO level with anonymized details.
   */
  public logUrlCleaned(originalUrl: string, cleanedUrl: string, removedParams: string[]): void {
    const origHost = (() => {
      try { return new URL(originalUrl).hostname; } catch { return 'URL'; }
    })();

    if (this.terminalLogging && this.isLevelEnabled('INFO')) {
      try {
        const orig = new URL(originalUrl);
        const anonymizedBefore = anonymizeUrlForLog(originalUrl);
        const anonymizedAfter = anonymizeUrlForLog(cleanedUrl);

        const logLines = [
          `\n╔══════════════════════════════════════════════════════════════════`,
          `║ [AnoFox][INFO] URL Tracking Cleaner: Parameter entfernt`,
          `╟──────────────────────────────────────────────────────────────────`,
          `║ Host:       ${orig.hostname}`,
          `║ Pfad:       ${orig.pathname}`,
          `║ Parameter:  [${removedParams.join(', ')}]`,
          `║ Vorher:     ${anonymizedBefore}`,
          `║ Nachher:    ${anonymizedAfter}`,
          `╚══════════════════════════════════════════════════════════════════`
        ];

        console.info(logLines.join('\n'));
      } catch {
        console.info(`[AnoFox][INFO] URL bereinigt: Parameter [${removedParams.join(', ')}] entfernt.`);
      }
    }

    if (this.internalLogging && this.isLevelEnabled('INFO')) {
      this.logInternal(
        'INFO',
        'URL_CLEANER',
        `Tracking-Parameter entfernt auf ${origHost}`,
        `Entfernt (${removedParams.length}): ${removedParams.join(', ')}`
      );
    }
  }
}

export const logger = new TerminalLogger();
export { TerminalLogger as AnoFoxLogger };
