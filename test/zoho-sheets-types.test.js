const assert = require("node:assert/strict");
const test = require("node:test");

const GoogleSheets = require("../src/google/sheets");
const scheduling = require("../src/zoho/sheets/scheduling");
const leads = require("../src/zoho/sheets/leads");

test("Zoho Scheduling aplica apenas os tipos históricos nas colunas previstas", () => {
  const row = Array.from({ length: 34 }, (_, index) => `campo-${index}`);
  row[0] = "5511999999999";
  row[3] = "001234";
  row[4] = "14-Jul-2026 07:47:13";
  row[5] = "14-Jul-2026 08:15:00";
  row[12] = "14-Jul-2026 09:30:45";
  row[16] = "46217001234";
  row[17] = "14/Jul/2026";
  row[18] = "09:30:45";
  row[19] = "14/Jul/2026";
  row[20] = "07:47:13";
  row[21] = 1;
  row[22] = 0;
  row[33] = "Jul/2026";

  const typed = scheduling.applySchedulingTypes(row);

  assert.equal(typed[0], 5511999999999);
  assert.deepEqual(GoogleSheets.literalCell(typed[3]), {
    userEnteredValue: { stringValue: "001234" },
  });
  assert.deepEqual(GoogleSheets.literalCell(typed[16]), {
    userEnteredValue: { stringValue: "46217001234" },
  });
  assert.deepEqual(GoogleSheets.literalCell(typed[4]), {
    userEnteredValue: { numberValue: Number(typed[4]) },
    userEnteredFormat: {
      numberFormat: { type: "DATE_TIME", pattern: "dd-mm-yyyy hh:mm" },
    },
  });
  assert.deepEqual(GoogleSheets.literalCell(typed[12]), {
    userEnteredValue: { numberValue: Number(typed[12]) },
    userEnteredFormat: {
      numberFormat: {
        type: "DATE_TIME",
        pattern: "dd/MM/yyyy HH:mm:ss",
      },
    },
  });
  for (const index of [17, 19]) {
    assert.equal(
      GoogleSheets.literalCell(typed[index]).userEnteredFormat.numberFormat.type,
      "DATE",
    );
  }
  for (const index of [18, 20]) {
    assert.deepEqual(
      GoogleSheets.literalCell(typed[index]).userEnteredFormat.numberFormat,
      { type: "TIME", pattern: "HH:mm:ss" },
    );
  }
  assert.deepEqual(
    GoogleSheets.literalCell(typed[33]).userEnteredFormat.numberFormat,
    { type: "DATE", pattern: "mm/yyyy" },
  );
  assert.equal(String(typed[17]), "14/07/2026");
  assert.equal(typed[2], "campo-2");
  assert.equal(typed[21], 1);
  assert.equal(typed[22], 0);
});

test("Zoho Leads preserva primitivos e converte somente CPF, CEP, R e W", () => {
  assert.equal(leads.extractValue(42), 42);
  assert.equal(leads.extractValue(false), false);
  assert.equal(leads.extractValue({ display_value: 7 }), 7);
  assert.equal(leads.extractValue({ display_value: false }), false);

  const row = Array.from({ length: 29 }, (_, index) => `campo-${index}`);
  row[1] = "01234567890";
  row[2] = "1234";
  row[5] = "01310930";
  row[17] = "14-Jul-2026 07:47:13";
  row[22] = "14-Jul-2026 09:30:45";
  row[23] = 17;
  row[24] = true;

  const typed = leads.applyLeadTypes(row);

  assert.equal(typed[1], 1234567890);
  assert.equal(typed[5], 1310930);
  assert.equal(typed[2], "1234");
  assert.equal(typed[23], 17);
  assert.equal(typed[24], true);
  assert.deepEqual(
    GoogleSheets.literalCell(typed[17]).userEnteredFormat.numberFormat,
    { type: "DATE_TIME", pattern: "dd-mm-yyyy hh:mm:ss" },
  );
  assert.deepEqual(
    GoogleSheets.literalCell(typed[22]).userEnteredFormat.numberFormat,
    { type: "DATE_TIME", pattern: "dd/MM/yyyy HH:mm:ss" },
  );
  for (const index of [17, 22]) {
    assert.ok(String(typed[index]).startsWith("14/07/2026"));
  }
});
