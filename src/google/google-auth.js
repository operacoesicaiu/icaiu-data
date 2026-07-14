const crypto = require("crypto");
const axios = require("axios");

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

async function getGoogleAccessToken() {
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

  try {
    const response = await axios.post(GOOGLE_TOKEN_URI, body.toString(), {
      timeout: 60000,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!response.data?.access_token)
      throw new Error("Resposta sem access_token");
    return response.data.access_token;
  } catch (error) {
    throw new Error(
      `Google OAuth falhou: status=${error.response?.status || "network"}`,
    );
  }
}

module.exports = { getGoogleAccessToken, normalizePrivateKey };
