const assert = require("node:assert/strict");
const test = require("node:test");

const GoogleSheets = require("../src/google/sheets");
const runIntegration = require("../src/zenvia/sheets/sync");

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
