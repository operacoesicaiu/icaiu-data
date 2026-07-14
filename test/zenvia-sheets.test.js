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
