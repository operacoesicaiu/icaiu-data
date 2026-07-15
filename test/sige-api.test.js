const assert = require("node:assert/strict");
const test = require("node:test");
const axios = require("axios");

test("SIGE pagina com skip ate receber uma pagina incompleta", async () => {
  const originalGet = axios.get;
  const originalEnv = {
    SIGE_TOKEN: process.env.SIGE_TOKEN,
    SIGE_USER: process.env.SIGE_USER,
    SIGE_APP: process.env.SIGE_APP,
    SIGE_MIN_INTERVAL_MS: process.env.SIGE_MIN_INTERVAL_MS,
  };
  Object.assign(process.env, {
    SIGE_TOKEN: "token-for-test",
    SIGE_USER: "user-for-test",
    SIGE_APP: "app-for-test",
    SIGE_MIN_INTERVAL_MS: "0",
  });
  const modulePath = require.resolve("../src/sige/api");
  delete require.cache[modulePath];

  const skips = [];
  axios.get = async (_url, config) => {
    skips.push(config.params.skip);
    const size = config.params.skip === 0 ? 100 : 1;
    return {
      status: 200,
      data: Array.from(
        { length: size },
        (_, index) => ({ Codigo: config.params.skip + index }),
      ),
    };
  };

  try {
    const { listSigeOrdersForDay } = require("../src/sige/api");
    const rows = await listSigeOrdersForDay("2026-07-13");
    assert.equal(rows.length, 101);
    assert.deepEqual(skips, [0, 100]);
  } finally {
    axios.get = originalGet;
    delete require.cache[modulePath];
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("SIGE rejeita HTTP 200 sem lista explicita", async () => {
  const originalGet = axios.get;
  const originalEnv = {
    SIGE_TOKEN: process.env.SIGE_TOKEN,
    SIGE_USER: process.env.SIGE_USER,
    SIGE_APP: process.env.SIGE_APP,
    SIGE_MIN_INTERVAL_MS: process.env.SIGE_MIN_INTERVAL_MS,
  };
  Object.assign(process.env, {
    SIGE_TOKEN: "token-for-test",
    SIGE_USER: "user-for-test",
    SIGE_APP: "app-for-test",
    SIGE_MIN_INTERVAL_MS: "0",
  });
  const modulePath = require.resolve("../src/sige/api");
  delete require.cache[modulePath];
  axios.get = async () => ({ status: 200, data: {} });

  try {
    const { listSigeOrdersForDay } = require("../src/sige/api");
    await assert.rejects(
      () => listSigeOrdersForDay("2026-07-13"),
      /lista de pedidos invalida/,
    );
  } finally {
    axios.get = originalGet;
    delete require.cache[modulePath];
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("SIGE consulta pessoa por CPF/CNPJ e retorna somente o primeiro resultado", async () => {
  const originalGet = axios.get;
  const originalEnv = {
    SIGE_TOKEN: process.env.SIGE_TOKEN,
    SIGE_USER: process.env.SIGE_USER,
    SIGE_APP: process.env.SIGE_APP,
    SIGE_MIN_INTERVAL_MS: process.env.SIGE_MIN_INTERVAL_MS,
  };
  Object.assign(process.env, {
    SIGE_TOKEN: "token-for-test",
    SIGE_USER: "user-for-test",
    SIGE_APP: "app-for-test",
    SIGE_MIN_INTERVAL_MS: "0",
  });
  const modulePath = require.resolve("../src/sige/api");
  delete require.cache[modulePath];
  const calls = [];
  axios.get = async (url, config) => {
    calls.push({ url, cpfcnpj: config.params.cpfcnpj });
    return { status: 200, data: [{ Celular: "+5511999999999" }, { Celular: "outro" }] };
  };

  try {
    const { getSigePersonByCpfCnpj } = require("../src/sige/api");
    assert.deepEqual(
      await getSigePersonByCpfCnpj("123.456.789-00"),
      { Celular: "+5511999999999" },
    );
    assert.deepEqual(calls, [{
      url: "https://api.sigecloud.com.br/request/Pessoas/Pesquisar",
      cpfcnpj: "12345678900",
    }]);
    assert.equal(await getSigePersonByCpfCnpj(""), null);
  } finally {
    axios.get = originalGet;
    delete require.cache[modulePath];
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
