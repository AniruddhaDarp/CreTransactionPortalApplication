/**
 * @cre/platform — shared runtime helpers used by every service Lambda:
 *   - `logger`  structured JSON logging with a `correlationId`
 *   - `ddb`     memoized DynamoDB DocumentClient
 *   - `bus`     EventBridge publisher (wraps `detail` in the @cre/events envelope)
 *   - `http`    API Gateway v2 handler adapter (routing, JWT claims, validation)
 */
export * from './logger.js';
export * from './ddb.js';
export * from './bus.js';
export * from './http.js';
