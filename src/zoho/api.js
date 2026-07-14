const axios = require("axios");
const getZohoToken = require("./oauth");
const {
  backoffMs,
  isRetryableNetworkError,
  isRetryableStatus,
  sleep,
} = require("../lib/http-retry");

async function createZohoClient() {
  const accessToken = await getZohoToken();
  const client = axios.create({ timeout: 60000 });
  client.defaults.headers.common.Authorization = `Zoho-oauthtoken ${accessToken}`;

  let refreshPromise;
  client.interceptors.response.use(undefined, async (error) => {
    const config = error.config || {};
    const status = error.response?.status;

    if (status === 401 && !config._zohoAuthRetried) {
      config._zohoAuthRetried = true;
      refreshPromise ||= getZohoToken({ forceRefresh: true }).finally(() => {
        refreshPromise = null;
      });
      const refreshedToken = await refreshPromise;
      const authorization = `Zoho-oauthtoken ${refreshedToken}`;
      client.defaults.headers.common.Authorization = authorization;
      delete client.defaults.headers.Authorization;
      config.headers = { ...config.headers, Authorization: authorization };
      return client.request(config);
    }

    const attempt = Number(config._zohoRetryAttempt || 0);
    const retryable = isRetryableStatus(status) || isRetryableNetworkError(error);
    if (retryable && attempt < 4) {
      config._zohoRetryAttempt = attempt + 1;
      await sleep(backoffMs(attempt, {
        baseMs: 1500,
        headers: error.response?.headers,
      }));
      return client.request(config);
    }

    const safeError = new Error(
      `Zoho API falhou: status=${status || "network"} code=${error.code || "unknown"}`,
    );
    safeError.status = status;
    safeError.providerCode = error.response?.data?.code;
    throw safeError;
  });

  return client;
}

module.exports = createZohoClient;
