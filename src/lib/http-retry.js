const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EPIPE",
  "ERR_NETWORK",
  "ETIMEDOUT",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(headers = {}) {
  const value = headers.get?.("retry-after") ?? headers["retry-after"] ?? headers["Retry-After"];
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function backoffMs(attempt, { baseMs = 1000, maxMs = 60000, maxRetryAfterMs = 900000, headers } = {}) {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.max(250, exponential * 0.3));
  const requested = Math.min(maxRetryAfterMs, retryAfterMs(headers));
  return Math.max(requested, Math.min(maxMs, exponential + jitter));
}

function isRetryableStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableNetworkError(error) {
  return RETRYABLE_NETWORK_CODES.has(error?.code);
}

function isRetryableHttpError(error) {
  return isRetryableStatus(error?.response?.status) || isRetryableNetworkError(error);
}

async function withHttpRetry(operation, {
  maxAttempts = 5,
  baseMs = 1000,
  maxMs = 60000,
  shouldRetry = isRetryableHttpError,
  onRetry,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts precisa ser inteiro >= 1");
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === maxAttempts - 1 || !shouldRetry(error)) throw error;
      const waitMs = backoffMs(attempt, {
        baseMs,
        maxMs,
        headers: error?.response?.headers,
      });
      if (onRetry) {
        await onRetry({
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          maxAttempts,
          waitMs,
          status: error?.response?.status,
          code: error?.code,
        });
      }
      await sleep(waitMs);
    }
  }
  throw new Error("Operacao HTTP falhou apos retries");
}

class Semaphore {
  constructor(limit = 1) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }

  async use(operation) {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class RateGate {
  constructor(minIntervalMs = 0) {
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.nextAt = 0;
  }

  async wait() {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.minIntervalMs;
    if (waitMs) await sleep(waitMs);
  }
}

module.exports = {
  RateGate,
  Semaphore,
  backoffMs,
  isRetryableHttpError,
  isRetryableNetworkError,
  isRetryableStatus,
  retryAfterMs,
  sleep,
  withHttpRetry,
};
