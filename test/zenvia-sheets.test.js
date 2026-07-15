const assert = require("node:assert/strict");
const test = require("node:test");

const GoogleSheets = require("../src/google/sheets");
const runIntegration = require("../src/zenvia/sheets/sync");

const NOW = new Date("2026-07-15T15:00:00Z");

test("Zenvia usa dias concluidos e permite backfill explicito prioritario", () => {
  const standard = runIntegration.resolveZenviaWindow({}, NOW);
  assert.equal(standard.days, 1);
  assert.equal(standard.startDay, "2026-07-14");
  assert.equal(standard.endDay, "2026-07-14");
  assert.equal(standard.apiStartDay, "2026-07-13");
  assert.equal(standard.apiEndDay, "2026-07-15");

  const july = runIntegration.resolveZenviaWindow({
    ZENVIA_SHEETS_DAYS: "2",
    ZENVIA_SHEETS_START_DATE: "2026-07-01",
    ZENVIA_SHEETS_END_DATE: "2026-07-14",
  }, NOW);
  assert.equal(july.explicit, true);
  assert.equal(july.days, 14);
  assert.equal(july.startDay, "2026-07-01");
  assert.equal(july.endDay, "2026-07-14");
  assert.equal(july.apiStartDay, "2026-06-30");
  assert.equal(july.apiEndDay, "2026-07-15");
});

test("Zenvia reconhece os formatos historicos somente dentro da janela", () => {
  assert.equal(
    runIntegration.isDayInWindow(
      "2026-07-01 07:47:13",
      "2026-07-01",
      "2026-07-14",
    ),
    true,
  );
  assert.equal(
    runIntegration.isDayInWindow(
      "14/07/2026 23:59:59",
      "2026-07-01",
      "2026-07-14",
    ),
    true,
  );
  assert.equal(
    runIntegration.isDayInWindow(
      "15/07/2026 00:00:00",
      "2026-07-01",
      "2026-07-14",
    ),
    false,
  );
  assert.equal(
    runIntegration.isDayInWindow(
      "2026-07-15T01:30:00Z",
      "2026-07-14",
      "2026-07-14",
    ),
    true,
  );
  assert.equal(
    runIntegration.isDayInWindow(
      "2026-07-15T03:00:00Z",
      "2026-07-14",
      "2026-07-14",
    ),
    false,
  );
});

test("Zenvia rejeita hoje e protege uma janela existente contra resposta vazia", () => {
  assert.throws(
    () => runIntegration.resolveZenviaWindow({
      ZENVIA_SHEETS_START_DATE: "2026-07-01",
      ZENVIA_SHEETS_END_DATE: "2026-07-15",
    }, NOW),
    /anterior a hoje/,
  );

  const options = {
    incomingCount: 0,
    existingValues: [["14/07/2026 07:47:00"]],
    startDay: "2026-07-01",
    endDay: "2026-07-14",
    allowEmpty: false,
  };
  assert.throws(
    () => runIntegration.assertNonEmptyWindowReplacement(options),
    /substituicao cancelada/,
  );
  assert.doesNotThrow(() =>
    runIntegration.assertNonEmptyWindowReplacement({
      ...options,
      allowEmpty: true,
    }),
  );
});

test("Zenvia converte horários válidos para o tipo histórico DATE_TIME", () => {
  const cell = runIntegration.toSheetDateTime(
    "2026-07-14T10:47:13-03:00",
  );

  assert.equal(String(cell), "14/07/2026 10:47:13");
  assert.deepEqual(GoogleSheets.literalCell(cell), {
    userEnteredValue: { numberValue: Number(cell) },
    userEnteredFormat: {
      numberFormat: {
        type: "DATE_TIME",
        pattern: "dd/mm/yyyy hh:mm:ss",
      },
    },
  });
});

test("Zenvia mantém vazios e valores de data inválidos como texto", () => {
  assert.equal(runIntegration.toSheetDateTime(""), "");
  assert.equal(runIntegration.toSheetDateTime("null"), "");
  assert.equal(runIntegration.toSheetDateTime("data-invalida"), "data-invalida");
});

test("Zenvia preserva telefones, duracao e espera como numeros historicos", () => {
  assert.equal(runIntegration.numericSheetValue("5511999999999", ""), 5511999999999);
  assert.equal(runIntegration.numericSheetValue("12.5"), 12.5);
  assert.equal(runIntegration.numericSheetValue("", 0), 0);
  assert.equal(runIntegration.numericSheetValue("indisponivel"), "indisponivel");
  assert.throws(
    () => runIntegration.numericSheetValue("9999999999999999"),
    /precisao segura/,
  );
});

test("Zenvia preserva duracao HH:mm:ss como celula TIME historica", () => {
  const duration = runIntegration.durationSheetValue("00:01:22");

  assert.deepEqual(GoogleSheets.literalCell(duration), {
    userEnteredValue: { numberValue: Number(duration) },
    userEnteredFormat: {
      numberFormat: { type: "TIME", pattern: "hh:mm:ss" },
    },
  });
  assert.deepEqual(
    GoogleSheets.literalCell(runIntegration.durationSheetValue("")),
    {
      userEnteredValue: { numberValue: 0 },
      userEnteredFormat: {
        numberFormat: { type: "TIME", pattern: "hh:mm:ss" },
      },
    },
  );
  assert.deepEqual(
    GoogleSheets.literalCell(runIntegration.durationSheetValue("0")),
    {
      userEnteredValue: { numberValue: 0 },
      userEnteredFormat: {
        numberFormat: { type: "TIME", pattern: "hh:mm:ss" },
      },
    },
  );
  assert.equal(runIntegration.durationSheetValue("0.25"), 0.25);
  assert.throws(
    () => runIntegration.durationSheetValue("indisponivel"),
    /formato inesperado/,
  );
});
