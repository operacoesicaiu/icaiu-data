const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");

test("Zoho renova o token uma vez apos 401 e envia o novo header", async () => {
  const originalPost = axios.post;
  const originalEnv = {
    ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN,
    ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET,
  };
  process.env.ZOHO_REFRESH_TOKEN = "refresh-for-test";
  process.env.ZOHO_CLIENT_ID = "client-for-test";
  process.env.ZOHO_CLIENT_SECRET = "secret-for-test";

  const oauthPath = require.resolve("../src/zoho/oauth");
  const clientPath = require.resolve("../src/zoho/api");
  delete require.cache[oauthPath];
  delete require.cache[clientPath];

  let tokenRequests = 0;
  axios.post = async () => ({
    data: { access_token: `zoho-token-${++tokenRequests}`, expires_in: 3600 },
  });

  try {
    const createZohoClient = require("../src/zoho/api");
    const client = await createZohoClient();
    const sentHeaders = [];
    let apiRequests = 0;
    client.defaults.adapter = async (config) => {
      sentHeaders.push(config.headers.get("Authorization"));
      apiRequests++;
      if (apiRequests === 1) {
        const error = new Error("unauthorized");
        error.config = config;
        error.response = { status: 401, data: {}, headers: {} };
        throw error;
      }
      return {
        config,
        data: { ok: true },
        headers: {},
        status: 200,
        statusText: "OK",
      };
    };

    const response = await client.get("https://creator.zoho.com/test");
    assert.deepEqual(response.data, { ok: true });
    assert.equal(tokenRequests, 2);
    assert.deepEqual(sentHeaders, [
      "Zoho-oauthtoken zoho-token-1",
      "Zoho-oauthtoken zoho-token-2",
    ]);
  } finally {
    axios.post = originalPost;
    delete require.cache[oauthPath];
    delete require.cache[clientPath];
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
