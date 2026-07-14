const assert = require("node:assert/strict");
const test = require("node:test");

const GoogleSheets = require("../src/google/sheets");
const {
  RateGate,
  backoffMs,
  isRetryableNetworkError,
  isRetryableStatus,
} = require("../src/lib/http-retry");

function responseError(status, { headers = {}, data } = {}) {
  const error = new Error(`HTTP ${status}`);
  error.response = { status, headers, data };
  return error;
}

function networkError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function withoutRealDelays(action) {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, _delay, ...args) => {
    callback(...args);
    return 0;
  };
  try {
    return await action();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

function createSheets(overrides = {}) {
  return new GoogleSheets({
    spreadsheetId: "spreadsheet-for-tests",
    accessToken: "initial-token",
    tokenExpiresAt: Date.now() + 3_600_000,
    refreshAccessToken: async () => "refreshed-token",
    ...overrides,
  });
}

test("http-retry classifica apenas falhas transitórias conhecidas", () => {
  for (const status of [408, 429, 500, 502, 503, 504])
    assert.equal(isRetryableStatus(status), true, `status ${status}`);

  for (const status of [400, 401, 403, 404, 425])
    assert.equal(isRetryableStatus(status), false, `status ${status}`);

  for (const code of ["ECONNRESET", "EAI_AGAIN", "ERR_NETWORK", "ETIMEDOUT"])
    assert.equal(isRetryableNetworkError({ code }), true, code);

  assert.equal(isRetryableNetworkError({ code: "ERR_BAD_REQUEST" }), false);
  assert.equal(isRetryableNetworkError(), false);
});

test("backoff respeita teto exponencial e Retry-After", () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(backoffMs(3, { baseMs: 100, maxMs: 500 }), 500);
    assert.equal(
      backoffMs(0, { baseMs: 100, maxMs: 500, headers: { "retry-after": "2" } }),
      2_000,
    );
    assert.equal(
      backoffMs(0, {
        baseMs: 100,
        maxMs: 500,
        maxRetryAfterMs: 700,
        headers: { "retry-after": "2" },
      }),
      700,
    );
  } finally {
    Math.random = originalRandom;
  }
});

test("RateGate espaça chamadas consecutivas", async () => {
  const originalNow = Date.now;
  const waits = [];
  Date.now = () => 1_000;
  try {
    const gate = new RateGate(275);
    await gate.wait();
    await withoutRealDelays(async () => {
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (callback, delay) => {
        waits.push(delay);
        callback();
        return 0;
      };
      try {
        await gate.wait();
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    });
    assert.deepEqual(waits, [275]);
  } finally {
    Date.now = originalNow;
  }
});

test("Google Sheets atualiza o token uma vez após 401 e repete a leitura", async () => {
  let requestCount = 0;
  let refreshCount = 0;
  const sentAuthorizations = [];
  const sheets = createSheets({
    refreshAccessToken: async () => {
      refreshCount++;
      return { accessToken: "token-after-401", expiresAt: Date.now() + 3_600_000 };
    },
  });
  sheets.http.defaults.adapter = async (config) => {
    requestCount++;
    sentAuthorizations.push(config.headers.get("Authorization"));
    if (requestCount === 1) {
      const error = responseError(401);
      error.config = config;
      throw error;
    }
    return {
      config,
      data: { values: [["ok"]] },
      headers: {},
      status: 200,
      statusText: "OK",
    };
  };

  const response = await sheets.request({ method: "get", url: "/values/Teste!A:A" });

  assert.deepEqual(response.data.values, [["ok"]]);
  assert.equal(requestCount, 2);
  assert.equal(refreshCount, 1);
  assert.deepEqual(sentAuthorizations, ["Bearer initial-token", "Bearer token-after-401"]);
});

test("refresh preventivo é compartilhado entre operações concorrentes", async () => {
  let refreshCount = 0;
  const sheets = createSheets({
    tokenExpiresAt: Date.now() + 60_000,
    refreshAccessToken: async () => {
      refreshCount++;
      await Promise.resolve();
      return { accessToken: "shared-token", expiresAt: Date.now() + 3_600_000 };
    },
  });

  await Promise.all([
    sheets.ensureFreshToken(),
    sheets.ensureFreshToken(),
    sheets.ensureFreshToken(),
  ]);

  assert.equal(refreshCount, 1);
  assert.ok(sheets.tokenExpiresAt - Date.now() > 3_500_000);
});

test("Google Sheets repete 429 e erro de rede antes de retornar sucesso", async () => {
  let requestCount = 0;
  const sheets = createSheets();
  sheets.http.request = async () => {
    requestCount++;
    if (requestCount === 1) throw responseError(429, { headers: { "retry-after": "0" } });
    if (requestCount === 2) throw networkError("ECONNRESET");
    return { data: { ok: true } };
  };

  const response = await withoutRealDelays(() =>
    sheets.request({ method: "get", url: "/values/Teste!A:A" }, { maxAttempts: 3 }),
  );

  assert.deepEqual(response.data, { ok: true });
  assert.equal(requestCount, 3);
});

test("appendValues não repete escrita quando a resposta é ambígua", async () => {
  let requestCount = 0;
  const sheets = createSheets();
  sheets.http.request = async () => {
    requestCount++;
    throw networkError("ECONNRESET");
  };

  await assert.rejects(
    () => sheets.appendValues("Teste!A:B", [["a", "b"]]),
    /status=network code=ECONNRESET/,
  );
  assert.equal(requestCount, 1);
});

test("replaceRows usa seletoras para excluir blocos de baixo para cima", async () => {
  const sheets = createSheets();
  const header = ["Data", "Nome", "Valor", "Empresa"];
  let requestedRanges;
  let update;
  let rows = [
    ["2026-07-01", "Um", 1, "A"],
    ["2026-07-02", "Dois", 2, "B"],
    ["2026-07-03", "Tres", 3, "C"],
    ["2026-07-04", "Quatro", 4, "D"],
  ];

  sheets.getValuesBatch = async (ranges, options = {}) => {
    if (options.valueRenderOption === "FORMULA") {
      return [[header, ...rows.map((row) => [...row])]];
    }
    if (options.valueRenderOption === "UNFORMATTED_VALUE") {
      return ranges.map((range) => {
        const match = range.match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);
        assert.ok(match);
        return rows
          .slice(Number(match[1]) - 2, Number(match[2]) - 1)
          .map((row) => [...row]);
      });
    }
    requestedRanges = ranges;
    return [
      [header],
      [[header[0]], ...rows.map((row) => [row[0]])],
      [[header[3]], ...rows.map((row) => [row[3]])],
    ];
  };
  sheets.getSheetPropertiesByTitle = async () => ({
    "Base Dados": {
      sheetId: 321,
      gridProperties: { rowCount: 1_000, columnCount: header.length },
    },
  });
  sheets.batchUpdate = async (requests, options) => {
    update = { requests, options };
    rows = [rows[1], rows[3], ["2026-07-05", "Novo", 10, "E"]];
    return { ok: true };
  };

  const seenRows = [];
  const result = await sheets.replaceRows({
    sheetTitle: "Base Dados",
    columnRange: "A:D",
    header,
    newRows: [["2026-07-05", "Novo", 10, "E"]],
    matchColumnIndexes: [0, 3],
    shouldReplace: (row) => {
      seenRows.push(row);
      return row[0] === "2026-07-01" || row[0] === "2026-07-03" || row[0] === "2026-07-05";
    },
  });

  assert.deepEqual(requestedRanges, [
    "'Base Dados'!A1:D1",
    "'Base Dados'!A:A",
    "'Base Dados'!D:D",
  ]);
  assert.equal(seenRows.length, 8);
  assert.equal(seenRows[0][0], "2026-07-01");
  assert.equal(seenRows[0][1], undefined);
  assert.equal(seenRows[0][3], "A");
  assert.deepEqual(update.options, { idempotent: false });

  const deletions = update.requests
    .filter((request) => request.deleteDimension)
    .map((request) => request.deleteDimension.range);
  assert.deepEqual(deletions, [
    { sheetId: 321, dimension: "ROWS", startIndex: 3, endIndex: 4 },
    { sheetId: 321, dimension: "ROWS", startIndex: 1, endIndex: 2 },
  ]);
  assert.equal(update.requests.some((request) => request.insertDimension), false);
  assert.equal(update.requests.some((request) => request.appendCells), false);
  assert.equal(
    update.requests.find(
      (request) => request.updateCells?.range?.startRowIndex === 3,
    ).updateCells.range.endRowIndex,
    4,
  );
  assert.deepEqual(result, { previous: 4, removed: 2, inserted: 1, final: 3 });
});

test("caracteres de formula permanecem texto literal sem apostrofo", () => {
  for (const value of ["=SUM(A1:A2)", "+5511999999999", "-texto", "@usuario"]) {
    assert.deepEqual(GoogleSheets.literalCell(value), {
      userEnteredValue: { stringValue: value },
    });
  }
});
