import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, mapPgError } from '../errors.js';
import { logger } from '../lib/logger.js';

export function notFound(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, 'NOT_FOUND', 'Nie znaleziono zasobu'));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Popraw zaznaczone pola',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  // Błędne JSON-y z express.json()
  if (typeof err === 'object' && err !== null && 'type' in err) {
    const t = (err as { type: string }).type;
    if (t === 'entity.parse.failed') {
      res.status(400).json({ error: 'INVALID_JSON', message: 'Niepoprawny format danych' });
      return;
    }
    if (t === 'entity.too.large') {
      res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Zbyt duże żądanie' });
      return;
    }
  }

  const appErr = err instanceof AppError ? err : mapPgError(err);
  if (appErr) {
    if (appErr.status >= 500) logger.error({ err, path: req.path }, appErr.code);
    if (appErr.code === 'BUSY') res.setHeader('Retry-After', 2);
    res.status(appErr.status).json({ error: appErr.code, message: appErr.message, details: appErr.details });
    return;
  }

  // Nieznany błąd — szczegóły tylko w logach, nigdy w odpowiedzi
  logger.error({ err, path: req.path }, 'Nieobsłużony błąd');
  res.status(500).json({ error: 'INTERNAL', message: 'Wystąpił nieoczekiwany błąd' });
}
