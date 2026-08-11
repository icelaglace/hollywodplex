/*
 * error-handler.js — central error formatting middleware for express.
 */

function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  const message = err.message || 'an unexpected error occurred';

  if (status === 500) {
    console.error('[error]', err);
  }

  res.status(status).json({
    error: status === 502 ? 'server_unreachable' : 'request_failed',
    message,
  });
}

export default errorHandler;
