export interface LogFields {
  correlationId?: string;
  [key: string]: unknown;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, fields: LogFields): void {
  const line = JSON.stringify({ level, message, ts: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every line. */
  child(fields: LogFields): Logger;
}

export function createLogger(base: LogFields = {}): Logger {
  const at =
    (level: Level) =>
    (message: string, fields: LogFields = {}) =>
      emit(level, message, { ...base, ...fields });
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

/** Process-wide logger with no bound fields. */
export const log = createLogger();
