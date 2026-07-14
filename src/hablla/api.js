const axios = require("axios");
const {
  RateGate,
  backoffMs,
  isRetryableNetworkError,
  sleep,
  withHttpRetry,
} = require("../lib/http-retry");

const API_BASE_URL = "https://api.hablla.com";

let clientPromise;
let refreshPromise;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function authorizationFor(token) {
  return token.startsWith("ey") ? `Bearer ${token}` : token;
}

function jwtExpiresAt(token) {
  if (!token.startsWith("ey") || token.split(".").length < 2) return 0;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return Number.isFinite(Number(payload.exp)) ? Number(payload.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}

function isRetryable(error) {
  const status = Number(error.response?.status || 0);
  return (
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599) ||
    isRetryableNetworkError(error)
  );
}

function publicError(error, operation) {
  const status = error.response?.status || "network";
  const code = error.code || "unknown";
  return new Error(`Hablla API falhou em ${operation}: status=${status} code=${code}`);
}

async function login() {
  const email = process.env.HABLLA_EMAIL;
  const password = process.env.HABLLA_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Hablla exige HABLLA_TOKEN ou HABLLA_EMAIL + HABLLA_PASSWORD",
    );
  }

  const timeout = positiveInteger(process.env.HABLLA_REQUEST_TIMEOUT_MS, 60000);
  const maxAttempts = positiveInteger(process.env.HABLLA_MAX_ATTEMPTS, 5);

  try {
    const response = await withHttpRetry(
      () =>
        axios.post(
          `${API_BASE_URL}/v1/authentication/login`,
          { email, password },
          { timeout },
        ),
      {
        maxAttempts,
        baseMs: 1500,
        shouldRetry: isRetryable,
        onRetry: ({ nextAttempt, waitMs, status, code }) => {
          console.warn(
            `[Hablla API] Nova tentativa de autenticacao ${nextAttempt}/${maxAttempts} ` +
              `apos ${waitMs}ms (status=${status || "network"}, code=${code || "unknown"}).`,
          );
        },
      },
    );
    const token = response.data?.accessToken;
    if (!token || typeof token !== "string") {
      throw new Error("Hablla nao retornou accessToken");
    }
    return token;
  } catch (error) {
    if (!error.response && !error.code) throw error;
    throw publicError(error, "authentication/login");
  }
}

async function buildClient() {
  let token = process.env.HABLLA_TOKEN || (await login());
  let tokenExpiresAt = jwtExpiresAt(token);
  const timeout = positiveInteger(process.env.HABLLA_REQUEST_TIMEOUT_MS, 60000);
  const maxAttempts = positiveInteger(process.env.HABLLA_MAX_ATTEMPTS, 5);
  const configuredInterval = Number(process.env.HABLLA_MIN_INTERVAL_MS);
  const minIntervalMs =
    Number.isFinite(configuredInterval) && configuredInterval >= 0
      ? configuredInterval
      : 500;
  const rateGate = new RateGate(minIntervalMs);
  const client = axios.create({
    baseURL: API_BASE_URL,
    timeout,
    headers: {
      accept: "application/json",
      Authorization: authorizationFor(token),
    },
  });

  async function refreshAuthorization() {
    if (!refreshPromise) {
      refreshPromise = login()
        .then((newToken) => {
          token = newToken;
          tokenExpiresAt = jwtExpiresAt(token);
          client.defaults.headers.common.Authorization = authorizationFor(token);
          delete client.defaults.headers.Authorization;
          return client.defaults.headers.common.Authorization;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  }

  client.interceptors.request.use(async (config) => {
    if (
      tokenExpiresAt &&
      tokenExpiresAt - Date.now() <= 60000 &&
      process.env.HABLLA_EMAIL &&
      process.env.HABLLA_PASSWORD
    ) {
      await refreshAuthorization();
    }
    config.headers = {
      ...config.headers,
      Authorization: authorizationFor(token),
    };
    await rateGate.wait();
    return config;
  });

  client.interceptors.response.use(undefined, async (error) => {
    const config = error.config || {};
    const status = Number(error.response?.status || 0);

    if (
      status === 401 &&
      !config.__habllaAuthRetried &&
      process.env.HABLLA_EMAIL &&
      process.env.HABLLA_PASSWORD
    ) {
      config.__habllaAuthRetried = true;
      const authorization = await refreshAuthorization();
      config.headers = { ...config.headers, Authorization: authorization };
      return client.request(config);
    }

    const retryAttempt = Number(config.__habllaRetryAttempt || 0);
    const method = String(config.method || "get").toLowerCase();
    const idempotent = ["get", "head", "options"].includes(method);
    if (idempotent && isRetryable(error) && retryAttempt < maxAttempts - 1) {
      config.__habllaRetryAttempt = retryAttempt + 1;
      const waitMs = backoffMs(retryAttempt, {
        baseMs: 1500,
        headers: error.response?.headers,
      });
      console.warn(
        `[Hablla API] Nova tentativa ${retryAttempt + 2}/${maxAttempts} ` +
          `apos ${waitMs}ms (status=${status || "network"}, code=${error.code || "unknown"}).`,
      );
      await sleep(waitMs);
      return client.request(config);
    }

    throw publicError(error, method.toUpperCase());
  });

  return client;
}

function getHabllaClient() {
  if (!clientPromise) {
    clientPromise = buildClient().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

module.exports = getHabllaClient;
module.exports._internals = {
  authorizationFor,
  isRetryable,
  jwtExpiresAt,
  publicError,
};
