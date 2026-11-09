import type { NextFunction, Request, Response } from 'express';
import { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes, type RateLimiterAbstract } from 'rate-limiter-flexible';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { logger } from '../lib/logger.js';

const redis = config.REDIS_URL
  ? new Redis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  : null;
if (!redis) logger.warn('Brak REDIS_URL — rate limiting w pamięci procesu (tylko do developmentu)');

function limiter(keyPrefix: string, points: number, duration: number): RateLimiterAbstract {
  if (redis) {
    return new RateLimiterRedis({
      storeClient: redis,
      keyPrefix,
      points,
      duration,
      // Gdy Redis padnie, nie wyłączamy ochrony — przechodzimy na limit w pamięci
      insuranceLimiter: new RateLimiterMemory({ keyPrefix, points, duration }),
    });
  }
  return new RateLimiterMemory({ keyPrefix, points, duration });
}

export const limiters = {
  publicRead: limiter('rl:read:ip', config.READ_LIMIT_PER_IP_PER_MIN, 60),
  bookingByIp: limiter('rl:book:ip', config.BOOKING_LIMIT_PER_IP, config.BOOKING_LIMIT_PER_IP_WINDOW_SEC),
  bookingByPhone: limiter('rl:book:phone', config.BOOKING_LIMIT_PER_PHONE, config.BOOKING_LIMIT_PER_PHONE_WINDOW_SEC),
  loginByIp: limiter('rl:login:ip', config.LOGIN_LIMIT_PER_IP, 15 * 60),
};

/** Zużywa punkt; po przekroczeniu rzuca 429 z Retry-After. */
export async function consume(l: RateLimiterAbstract, key: string, res: Response): Promise<void> {
  try {
    await l.consume(key);
  } catch (e) {
    if (e instanceof RateLimiterRes) {
      res.setHeader('Retry-After', Math.ceil(e.msBeforeNext / 1000));
      throw new AppError(429, 'TOO_MANY_REQUESTS', 'Zbyt wiele prób. Spróbuj ponownie później.');
    }
    throw e;
  }
}

export const rateLimitByIp = (l: RateLimiterAbstract) =>
  async (req: Request, res: Response, next: NextFunction) => {
    await consume(l, req.ip ?? 'unknown', res);
    next();
  };
