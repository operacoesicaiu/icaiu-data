const assert = require("node:assert/strict");
const test = require("node:test");

const GoogleSheets = require("../src/google/sheets");

function createHarness({ initialRows, beforeSelectorRead, onWrite }) {
  const sheets = new GoogleSheets({
    spreadsheetId: "integrity-test",
    accessToken: "test-token",
  });
  const header = ["Data", "Valor"];
  const state = { rows: initialRows.map((row) => [...row]) };
  let selectorReads = 0;
  let writeCalls = 0;

  sheets.getSheetIdByTitle = async () => ({ "Base Dados": 7 });
  sheets.getValuesBatch = async (ranges, options = {}) => {
    if (options.valueRenderOption === "UNFORMATTED_VALUE") {
      return ranges.map((range) => {
        const match = range.match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);
        assert.ok(match);
        return state.rows
          .slice(Number(match[1]) - 2, Number(match[2]) - 1)
          .map((row) => [...row]);
      });
    }
    selectorReads++;
    if (beforeSelectorRead) {
      await beforeSelectorRead({ count: selectorReads, state });
    }
    return [
      [header],
      [[header[0]], ...state.rows.map((row) => [row[0] ?? ""])],
    ];
  };
  sheets.batchUpdate = async () => {
    writeCalls++;
    return onWrite?.(state);
  };

  const replace = (newRows = [["14/07/2026", "NOVO"]]) =>
    sheets.replaceRows({
      sheetTitle: "Base Dados",
      columnRange: "A:B",
      header,
      newRows,
      matchColumnIndexes: [0],
      shouldReplace: (row) => row[0] === "14/07/2026",
    });
  return {
    replace,
    get writeCalls() {
      return writeCalls;
    },
  };
}

test("replaceRows rejeita HTTP 403 quando apenas a seletora coincide", async () => {
  const harness = createHarness({
    initialRows: [["14/07/2026", "VELHO"]],
    onWrite: () => {
      throw new Error("HTTP 403");
    },
  });

  await assert.rejects(harness.replace, /HTTP 403/);
  assert.equal(harness.writeCalls, 1);
});

test("replaceRows confirma resposta ambigua quando a linha completa foi aplicada", async () => {
  const newRow = ["14/07/2026", "NOVO"];
  const harness = createHarness({
    initialRows: [["14/07/2026", "VELHO"]],
    onWrite: (state) => {
      state.rows = [newRow];
      const error = new Error("resposta perdida");
      error.code = "ECONNRESET";
      throw error;
    },
  });

  assert.deepEqual(await harness.replace([newRow]), {
    previous: 1,
    removed: 1,
    inserted: 1,
    final: 1,
  });
});

test("replaceRows aborta quando a precondicao seletora muda", async () => {
  const harness = createHarness({
    initialRows: [
      ["14/07/2026", "VELHO"],
      ["NAO-ALVO", "PRESERVAR"],
    ],
    beforeSelectorRead: ({ count, state }) => {
      if (count === 2) state.rows[1][0] = "MUDOU";
    },
  });

  await assert.rejects(harness.replace, /Estado da planilha mudou antes da escrita/);
  assert.equal(harness.writeCalls, 0);
});

test("replaceRows detecta exclusao inesperada de linha nao alvo", async () => {
  const newRow = ["14/07/2026", "NOVO"];
  const harness = createHarness({
    initialRows: [
      ["14/07/2026", "VELHO"],
      ["NAO-ALVO", "PRESERVAR"],
    ],
    onWrite: (state) => {
      state.rows = [newRow];
      return { ok: true };
    },
  });

  await assert.rejects(
    () => harness.replace([newRow]),
    /Validacao completa apos escrita falhou/,
  );
});
