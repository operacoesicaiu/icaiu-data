const axios = require("axios");
const { RateGate, withHttpRetry } = require("../lib/http-retry");
const { createIdPageTracker } = require("../lib/page-progress");

const requestGate = new RateGate(process.env.SIGE_MIN_INTERVAL_MS || 500);

function getSigeHeaders() {
  const { SIGE_TOKEN, SIGE_USER, SIGE_APP } = process.env;
  if (!SIGE_TOKEN || !SIGE_USER || !SIGE_APP) {
    throw new Error("Credenciais SIGE ausentes");
  }
  return {
    "Authorization-Token": SIGE_TOKEN,
    User: SIGE_USER,
    App: SIGE_APP,
    "Content-Type": "application/json",
  };
}

async function listSigeOrdersForDay(date) {
  const rows = [];
  const pageSize = 100;
  const maxRecords = Number(process.env.SIGE_MAX_RECORDS_PER_DAY || 50000);
  if (!Number.isInteger(maxRecords) || maxRecords < pageSize) {
    throw new Error("SIGE_MAX_RECORDS_PER_DAY precisa ser inteiro >= 100");
  }
  const pageTracker = createIdPageTracker({
    source: "SIGE pedidos",
    idOf: (record) => record?.Codigo,
  });

  for (let skip = 0; ; skip += pageSize) {
    if (skip > maxRecords) throw new Error("SIGE excedeu o limite seguro de paginacao");
    await requestGate.wait();
    const response = await withHttpRetry(
      () =>
        axios.get("https://api.sigecloud.com.br/request/Pedidos/Pesquisar", {
          headers: getSigeHeaders(),
          timeout: 60000,
          params: {
            status: "Pedido Faturado",
            dataInicial: date,
            dataFinal: date,
            filtrarPor: 3,
            pageSize,
            skip,
          },
        }),
      { maxAttempts: 5, baseMs: 1500 },
    );
    if (Number(response?.status) !== 200 || !Array.isArray(response.data)) {
      throw new Error("SIGE retornou lista de pedidos invalida");
    }
    pageTracker.observe(response.data);
    rows.push(...response.data);
    if (response.data.length < pageSize) return rows;
  }
}

module.exports = { listSigeOrdersForDay };
