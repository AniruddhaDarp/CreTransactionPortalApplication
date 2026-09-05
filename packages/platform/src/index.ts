/**
 * @cre/platform — shared runtime helpers used by every service Lambda.
 *
 * Skeleton for Module 1. Real implementations arrive with the first service
 * that needs them (Module 3 onward):
 *   - `ddb`    — DynamoDB DocumentClient + single-table key helpers
 *   - `bus`    — EventBridge publisher (wraps detail in the @cre/events envelope)
 *   - `http`   — API Gateway handler adapter: zod validation, error -> response,
 *                correlation-id extraction, structured access logs
 *   - `log`    — structured JSON logger (below)
 */

export interface LogFields {
  correlationId?: string;
  [key: string]: unknown;
}

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, message: string, fields: LogFields): void {
  const line = JSON.stringify({ level, message, ...fields, ts: new Date().toISOString() });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields: LogFields = {}) => emit('info', message, fields),
  warn: (message: string, fields: LogFields = {}) => emit('warn', message, fields),
  error: (message: string, fields: LogFields = {}) => emit('error', message, fields),
};
