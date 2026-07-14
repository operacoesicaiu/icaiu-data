const axios = require("axios");
const { withHttpRetry } = require("../lib/http-retry");

const ZOHO_TOKEN_URL = "https://accounts.zoho.com/oauth/v2/token";
let cachedToken;
let cachedExpiresAt = 0;
let tokenPromise;

async function requestZohoToken() {
  const { ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET } = process.env;
  if (!ZOHO_REFRESH_TOKEN || !ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
    throw new Error("Credenciais OAuth do Zoho ausentes");
  }

  let response;
  try {
    response = await withHttpRetry(
      () =>
        axios.post(ZOHO_TOKEN_URL, null, {
          params: {
            refresh_token: ZOHO_REFRESH_TOKEN,
            client_id: ZOHO_CLIENT_ID,
            client_secret: ZOHO_CLIENT_SECRET,
            grant_type: "refresh_token",
          },
          timeout: 60000,
        }),
      { maxAttempts: 5, baseMs: 1500 },
    );
  } catch (error) {
    throw new Error(`Zoho OAuth falhou: status=${error.response?.status || "network"} code=${error.code || "unknown"}`);
  }

  const accessToken = response.data?.access_token;
  if (!accessToken) throw new Error("Zoho OAuth nao retornou access_token");
  const expiresIn = Number(response.data.expires_in || 3600);
  return {
    accessToken,
    expiresAt: Date.now() + Math.max(300, expiresIn) * 1000,
  };
}

async function getZohoTokenDetails({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedToken && cachedExpiresAt - Date.now() > 300000) {
    return { accessToken: cachedToken, expiresAt: cachedExpiresAt };
  }
  if (!tokenPromise) {
    tokenPromise = requestZohoToken()
      .then((token) => {
        cachedToken = token.accessToken;
        cachedExpiresAt = token.expiresAt;
        return token;
      })
      .finally(() => {
        tokenPromise = null;
      });
  }
  return tokenPromise;
}

async function getZohoToken(options) {
  return (await getZohoTokenDetails(options)).accessToken;
}

module.exports = getZohoToken;
module.exports.getZohoTokenDetails = getZohoTokenDetails;
