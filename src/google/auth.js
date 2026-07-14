const crypto = require("crypto");
const axios = require("axios");
const { backoffMs, isRetryableNetworkError, isRetryableStatus, sleep } = require("../lib/http-retry");

const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizePrivateKey(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n");
}

let cachedToken;
let cachedExpiresAt = 0;
let tokenPromise;

async function requestGoogleAccessToken() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  if (!clientEmail || !privateKey)
    throw new Error("Credenciais Google ausentes");

  const now = Math.floor(Date.now() / 1000);
  const tokenToSign = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_URI,
      exp: now + 3600,
      iat: now,
    }),
  )}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(tokenToSign)
    .sign(privateKey, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${tokenToSign}.${signature}`,
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await axios.post(GOOGLE_TOKEN_URI, body.toString(), {
        timeout: 60000,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (!response.data?.access_token) throw new Error("Resposta sem access_token");
      const expiresIn = Number(response.data.expires_in || 3600);
      return { accessToken: response.data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    } catch (error) {
      const retryable = isRetryableStatus(error.response?.status) || isRetryableNetworkError(error);
      if (!retryable || attempt === 4) {
        throw new Error(`Google OAuth falhou: status=${error.response?.status || "network"}`);
      }
      await sleep(backoffMs(attempt, { headers: error.response?.headers }));
    }
  }
  throw new Error("Google OAuth falhou apos retries");
}

async function getGoogleAccessTokenDetails({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedToken && cachedExpiresAt - Date.now() > 300000) {
    return { accessToken: cachedToken, expiresAt: cachedExpiresAt };
  }
  if (!tokenPromise) {
    tokenPromise = requestGoogleAccessToken()
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

async function getGoogleAccessToken(options) {
  return (await getGoogleAccessTokenDetails(options)).accessToken;
}

module.exports = { getGoogleAccessToken, getGoogleAccessTokenDetails, normalizePrivateKey };
