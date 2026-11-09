import type { LogLevel } from '@nestjs/common';

export interface Environment {
  readonly host: string;
  readonly port: number;
  readonly logLevels: LogLevel[];
  readonly trustedProxyHops: 0 | 1;
}

const levels: Record<string, LogLevel[]> = {
  debug: ['error', 'warn', 'log', 'debug'],
  info: ['error', 'warn', 'log'],
  warn: ['error', 'warn'],
  error: ['error'],
};

export function readEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Environment {
  const host = env.HOST ?? '127.0.0.1';
  const portText = env.PORT ?? '3000';
  const level = env.LOG_LEVEL ?? 'info';
  const proxyHops = env.TRUST_PROXY_HOPS ?? '0';

  if (host.length === 0 || host.trim() !== host || /\s/.test(host)) {
    throw new Error('HOST must be a non-empty hostname or IP address');
  }
  if (!/^\d+$/.test(portText)) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  const logLevels = Object.hasOwn(levels, level) ? levels[level] : undefined;
  if (!logLevels) {
    throw new Error('LOG_LEVEL must be debug, info, warn, or error');
  }
  if (proxyHops !== '0' && proxyHops !== '1')
    throw new Error('TRUST_PROXY_HOPS must be 0 or 1');
  return {
    host,
    port,
    logLevels: [...logLevels],
    trustedProxyHops: proxyHops === '1' ? 1 : 0,
  };
}
