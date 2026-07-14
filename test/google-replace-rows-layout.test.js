const assert = require("node:assert/strict");
const test = require("node:test");

const GoogleSheets = require("../src/google/sheets");

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function trimTrailingEmptyRows(rows) {
  let length = rows.length;
  while (length > 0 && !rows[length - 1].some(hasValue)) length--;
  return rows.slice(0, length);
}

function columnIndex(letters) {
  let result = 0;
  for (const character of letters) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

function cellValue(cell) {
  const value = cell?.userEnteredValue;
  if (!value) return "";
  if (Object.hasOwn(value, "numberValue")) return value.numberValue;
  if (Object.hasOwn(value, "boolValue")) return value.boolValue;
  return value.stringValue;
}

function createLayoutHarness({ header, initialRows, gridRowCount, afterDelete }) {
  const sheets = new GoogleSheets({
    spreadsheetId: "layout-test",
    accessToken: "test-token",
  });
  const state = {
    header: [...header],
    rows: initialRows.map((row) => [...row]),
    gridRowCount,
  };
  const batchCalls = [];

  sheets.getSheetPropertiesByTitle = async () => ({
    Base: {
      sheetId: 41,
      gridProperties: {
        rowCount: state.gridRowCount,
        columnCount: header.length,
      },
    },
  });
  sheets.getValuesBatch = async (ranges, options = {}) => {
    if (options.valueRenderOption === "FORMULA") {
      return [[
        [...state.header],
        ...trimTrailingEmptyRows(state.rows).map((row) => [...row]),
      ]];
    }
    if (options.valueRenderOption === "UNFORMATTED_VALUE") {
      return ranges.map((range) => {
        const match = range.match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);
        assert.ok(match, `intervalo completo inesperado: ${range}`);
        return state.rows
          .slice(Number(match[1]) - 2, Number(match[2]) - 1)
          .map((row) => [...row]);
      });
    }

    return ranges.map((range, rangeIndex) => {
      if (rangeIndex === 0) return [[...state.header]];
      const match = range.match(/!([A-Z]+):\1$/);
      assert.ok(match, `seletora inesperada: ${range}`);
      const index = columnIndex(match[1]);
      let lastBodyIndex = state.rows.length - 1;
      while (
        lastBodyIndex >= 0 &&
        !hasValue(state.rows[lastBodyIndex]?.[index])
      ) {
        lastBodyIndex--;
      }
      return [
        [state.header[index]],
        ...state.rows
          .slice(0, lastBodyIndex + 1)
          .map((row) => [row[index] ?? ""]),
      ];
    });
  };
  sheets.batchUpdate = async (requests, options) => {
    batchCalls.push({ requests, options });
    for (const request of requests) {
      if (request.deleteDimension) {
        const { startIndex, endIndex } = request.deleteDimension.range;
        state.rows.splice(startIndex - 1, endIndex - startIndex);
        state.gridRowCount -= endIndex - startIndex;
        afterDelete?.(state);
      } else if (request.appendDimension) {
        state.gridRowCount += request.appendDimension.length;
      } else if (request.updateCells) {
        const { range, rows } = request.updateCells;
        if (range.startRowIndex === 0) {
          state.header = rows[0].values.map(cellValue);
          continue;
        }
        const bodyStart = range.startRowIndex - 1;
        rows.forEach((row, offset) => {
          while (state.rows.length <= bodyStart + offset) state.rows.push([]);
          state.rows[bodyStart + offset] = row.values.map(cellValue);
        });
      }
    }
    state.rows = trimTrailingEmptyRows(state.rows);
    return { ok: true };
  };
  sheets.numberFormatsMatch = async (_sheetTitle, blocks) => {
    const repeatCells = batchCalls[0].requests
      .filter((request) => request.repeatCell)
      .map((request) => request.repeatCell.range);
    return blocks.every((block) =>
      repeatCells.some(
        (range) =>
          range.startRowIndex === block.startRowIndex &&
          range.endRowIndex === block.endRowIndex &&
          range.startColumnIndex === block.columnIndex,
      ),
    );
  };

  return { batchCalls, sheets, state };
}

test("replaceRows compacta no fim logico mesmo com grade pre-alocada e seletora vazia", async () => {
  const header = ["Chave", "Data", "Valor", "Observacao"];
  const typedDate = GoogleSheets.dateCell("14/07/2026");
  const newRow = ["NOVO", typedDate, "novo"];
  const harness = createLayoutHarness({
    header,
    gridRowCount: 50_000,
    initialRows: [
      ["MANTER", "", "primeiro"],
      [],
      ["ALVO", "", "antigo"],
      ["", "", "", "conteudo fora da seletora"],
    ],
  });

  const result = await harness.sheets.replaceRows({
    sheetTitle: "Base",
    columnRange: "A:D",
    header,
    newRows: [newRow],
    matchColumnIndexes: [0],
    shouldReplace: (row) => row[0] === "ALVO" || row[0] === "NOVO",
  });

  assert.deepEqual(result, { previous: 4, removed: 1, inserted: 1, final: 4 });
  assert.equal(harness.batchCalls.length, 1);
  assert.deepEqual(harness.batchCalls[0].options, { idempotent: false });
  const requests = harness.batchCalls[0].requests;
  assert.equal(requests.some((request) => request.appendCells), false);
  assert.equal(requests.some((request) => request.appendDimension), false);
  assert.deepEqual(
    requests.find(
      (request) => request.updateCells?.range?.startRowIndex === 4,
    ).updateCells.range,
    {
      sheetId: 41,
      startRowIndex: 4,
      endRowIndex: 5,
      startColumnIndex: 0,
      endColumnIndex: 4,
    },
  );
  assert.equal(
    requests.find((request) => request.repeatCell).repeatCell.range.startRowIndex,
    4,
  );
  assert.equal(harness.state.rows[2][3], "conteudo fora da seletora");
  assert.equal(harness.state.rows[3][0], "NOVO");
  assert.equal(harness.state.rows[3].length, 4);
});

test("replaceRows amplia somente o deficit de linhas antes do updateCells", async () => {
  const header = ["Chave", "Valor"];
  const harness = createLayoutHarness({
    header,
    gridRowCount: 2,
    initialRows: [["ALVO", "antigo"]],
  });
  const newRows = [["NOVO-1"], ["NOVO-2"], ["NOVO-3"]];

  await harness.sheets.replaceRows({
    sheetTitle: "Base",
    columnRange: "A:B",
    header,
    newRows,
    matchColumnIndexes: [0],
    shouldReplace: (row) =>
      row[0] === "ALVO" || String(row[0] ?? "").startsWith("NOVO-"),
  });

  const requests = harness.batchCalls[0].requests;
  const appendIndex = requests.findIndex((request) => request.appendDimension);
  const writeIndex = requests.findIndex(
    (request) => request.updateCells?.range?.startRowIndex === 1,
  );
  assert.equal(requests[appendIndex].appendDimension.length, 3);
  assert.ok(appendIndex < writeIndex);
  assert.deepEqual(requests[writeIndex].updateCells.range, {
    sheetId: 41,
    startRowIndex: 1,
    endRowIndex: 4,
    startColumnIndex: 0,
    endColumnIndex: 2,
  });
  assert.equal(harness.state.gridRowCount, 4);
  assert.deepEqual(
    harness.state.rows,
    [["NOVO-1", ""], ["NOVO-2", ""], ["NOVO-3", ""]],
  );
});

test("milhares de datas contiguas geram um unico bloco de formato", async () => {
  const header = ["Chave", "Data"];
  const date = GoogleSheets.dateCell("14/07/2026");
  const newRows = Array.from(
    { length: 2_000 },
    (_, index) => [`NOVO-${index}`, date],
  );
  const harness = createLayoutHarness({
    header,
    gridRowCount: 2,
    initialRows: [["ALVO", ""]],
  });

  await harness.sheets.replaceRows({
    sheetTitle: "Base",
    columnRange: "A:B",
    header,
    newRows,
    matchColumnIndexes: [0],
    shouldReplace: (row) =>
      row[0] === "ALVO" || String(row[0] ?? "").startsWith("NOVO-"),
  });

  assert.equal(harness.batchCalls.length, 1);
  const repeatCells = harness.batchCalls[0].requests.filter(
    (request) => request.repeatCell,
  );
  assert.equal(repeatCells.length, 1);
  assert.deepEqual(repeatCells[0].repeatCell.range, {
    sheetId: 41,
    startRowIndex: 1,
    endRowIndex: 2_001,
    startColumnIndex: 1,
    endColumnIndex: 2,
  });
});

test("validacao aceita referencia de formula ajustada pela exclusao", async () => {
  const header = ["Chave", "Formula", "Valor"];
  const harness = createLayoutHarness({
    header,
    gridRowCount: 100,
    initialRows: [
      ["ALVO", "", "antigo"],
      ["MANTER", "=C3", "preservado"],
    ],
    afterDelete: (state) => {
      state.rows[0][1] = "=C2";
    },
  });

  const result = await harness.sheets.replaceRows({
    sheetTitle: "Base",
    columnRange: "A:C",
    header,
    newRows: [["NOVO", "", "novo"]],
    matchColumnIndexes: [0],
    shouldReplace: (row) => row[0] === "ALVO" || row[0] === "NOVO",
  });

  assert.deepEqual(result, { previous: 2, removed: 1, inserted: 1, final: 2 });
  assert.equal(harness.state.rows[0][1], "=C2");
  assert.equal(harness.state.rows[0][2], "preservado");
});
