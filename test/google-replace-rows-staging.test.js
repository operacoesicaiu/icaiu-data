const assert = require("node:assert/strict");
const test = require("node:test");

const GoogleSheets = require("../src/google/sheets");

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function columnIndex(letters) {
  let result = 0;
  for (const character of letters) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

function cloneCell(cell = {}) {
  return {
    value: cell.value ?? "",
    numberFormat: cell.numberFormat
      ? { ...cell.numberFormat }
      : undefined,
  };
}

function primitiveCell(value) {
  return { value: value ?? "" };
}

function cellValues(row, width) {
  return Array.from(
    { length: width },
    (_, index) => row[index]?.value ?? "",
  );
}

function cellDataValue(cellData) {
  const value = cellData?.userEnteredValue;
  if (!value) return "";
  if (Object.hasOwn(value, "numberValue")) return value.numberValue;
  if (Object.hasOwn(value, "boolValue")) return value.boolValue;
  if (Object.hasOwn(value, "formulaValue")) return value.formulaValue;
  return value.stringValue;
}

function trimValues(values) {
  const result = values.map((row) => {
    let length = row.length;
    while (length > 0 && !hasValue(row[length - 1])) length--;
    return row.slice(0, length);
  });
  while (result.length > 0 && result.at(-1).length === 0) result.pop();
  return result;
}

function createHarness({
  header,
  initialHeader = header,
  rows,
  gridRowCount = 20,
  gridColumnCount = header.length,
  mutateBeforeSecondOriginalRead,
  throwAfterPromotion = false,
  throwBeforePromotion = false,
  externalFormula,
  extraSheetDimensions,
}) {
  const client = new GoogleSheets({
    spreadsheetId: "staging-test",
    accessToken: "test-token",
  });
  const sheets = new Map();
  const original = {
    sheetId: 7,
    title: "Base",
    hidden: false,
    rowCount: gridRowCount,
    columnCount: gridColumnCount,
    cells: [
      initialHeader.slice(0, gridColumnCount).map(primitiveCell),
      ...rows.map((row) =>
        row.slice(0, gridColumnCount).map(primitiveCell),
      ),
    ],
  };
  sheets.set(original.sheetId, original);
  const dependent = externalFormula
    ? {
        sheetId: 9,
        title: "Resumo",
        hidden: false,
        rowCount: 10,
        columnCount: 2,
        cells: [[primitiveCell(externalFormula)]],
      }
    : null;
  if (dependent) sheets.set(dependent.sheetId, dependent);
  if (extraSheetDimensions) {
    sheets.set(11, {
      sheetId: 11,
      title: "Arquivo",
      hidden: false,
      rowCount: extraSheetDimensions.rowCount,
      columnCount: extraSheetDimensions.columnCount,
      cells: [],
    });
  }
  const batchCalls = [];
  let originalFormulaReads = 0;
  let promotionThrowsRemaining = throwAfterPromotion ? 1 : 0;
  let promotionPreThrowsRemaining = throwBeforePromotion ? 1 : 0;

  function byTitle(title) {
    return [...sheets.values()].find((sheet) => sheet.title === title);
  }

  function ensureCell(sheet, rowIndex, columnIndex) {
    while (sheet.cells.length <= rowIndex) sheet.cells.push([]);
    while (sheet.cells[rowIndex].length <= columnIndex) {
      sheet.cells[rowIndex].push(primitiveCell(""));
    }
    return sheet.cells[rowIndex][columnIndex];
  }

  function parseRange(range) {
    const match = String(range).match(
      /^'((?:''|[^'])+)'!([A-Z]+)(\d*)?:([A-Z]+)(\d*)?$/,
    );
    assert.ok(match, `intervalo inesperado: ${range}`);
    const title = match[1].replace(/''/g, "'");
    const startColumn = columnIndex(match[2]);
    const endColumn = columnIndex(match[4]) + 1;
    const startRow = match[3] ? Number(match[3]) - 1 : 0;
    const endRow = match[5] ? Number(match[5]) : null;
    return { title, startColumn, endColumn, startRow, endRow };
  }

  function valuesForRange(range) {
    const parsed = parseRange(range);
    const sheet = byTitle(parsed.title);
    assert.ok(sheet, `aba inesperada: ${parsed.title}`);
    const endRow = Math.min(
      parsed.endRow ?? sheet.rowCount,
      sheet.rowCount,
    );
    const values = [];
    for (let rowIndex = parsed.startRow; rowIndex < endRow; rowIndex++) {
      const row = [];
      for (
        let column = parsed.startColumn;
        column < parsed.endColumn;
        column++
      ) {
        row.push(sheet.cells[rowIndex]?.[column]?.value ?? "");
      }
      values.push(row);
    }
    return trimValues(values);
  }

  client.getValuesBatch = async (ranges, options = {}) => {
    if (options.valueRenderOption === "FORMULA") {
      const title = parseRange(ranges[0]).title;
      if (title === original.title) {
        originalFormulaReads++;
        if (originalFormulaReads === 2) {
          mutateBeforeSecondOriginalRead?.(original);
        }
      }
    }
    return ranges.map(valuesForRange);
  };

  client.getSheetPropertiesByTitle = async () =>
    Object.fromEntries(
      [...sheets.values()].map((sheet) => [
        sheet.title,
        {
          sheetId: sheet.sheetId,
          title: sheet.title,
          hidden: sheet.hidden,
          gridProperties: {
            rowCount: sheet.rowCount,
            columnCount: sheet.columnCount,
          },
        },
      ]),
    );

  function applyUpdateCells(sheet, update) {
    const { range, rows: updateRows = [], fields = "" } = update;
    for (let rowOffset = 0; rowOffset < updateRows.length; rowOffset++) {
      const rowIndex = range.startRowIndex + rowOffset;
      const values = updateRows[rowOffset].values || [];
      for (let columnOffset = 0; columnOffset < values.length; columnOffset++) {
        const columnIndexValue = range.startColumnIndex + columnOffset;
        const target = ensureCell(sheet, rowIndex, columnIndexValue);
        const source = values[columnOffset];
        if (fields.includes("userEnteredValue")) {
          target.value = cellDataValue(source);
        }
        if (fields.includes("userEnteredFormat.numberFormat")) {
          target.numberFormat = source.userEnteredFormat?.numberFormat
            ? { ...source.userEnteredFormat.numberFormat }
            : undefined;
        }
      }
    }
  }

  function applyCopyPaste(request) {
    const sourceSheet = sheets.get(request.source.sheetId);
    const destinationSheet = sheets.get(request.destination.sheetId);
    assert.ok(sourceSheet);
    assert.ok(destinationSheet);
    const height = request.source.endRowIndex - request.source.startRowIndex;
    const width =
      request.source.endColumnIndex - request.source.startColumnIndex;
    const copied = Array.from({ length: height }, (_, rowOffset) =>
      Array.from({ length: width }, (_, columnOffset) =>
        cloneCell(
          sourceSheet.cells[request.source.startRowIndex + rowOffset]?.[
            request.source.startColumnIndex + columnOffset
          ],
        ),
      ),
    );
    for (let rowOffset = 0; rowOffset < height; rowOffset++) {
      for (let columnOffset = 0; columnOffset < width; columnOffset++) {
        const rowIndex = request.destination.startRowIndex + rowOffset;
        const columnIndexValue =
          request.destination.startColumnIndex + columnOffset;
        ensureCell(destinationSheet, rowIndex, columnIndexValue);
        destinationSheet.cells[rowIndex][columnIndexValue] = cloneCell(
          copied[rowOffset][columnOffset],
        );
      }
    }
  }

  function adjustBaseRowReferences(startIndex, endIndex, delta) {
    const firstAffectedRow = startIndex + 1;
    const lastDeletedRow = endIndex;
    for (const sheet of sheets.values()) {
      for (const row of sheet.cells) {
        for (const cell of row) {
          if (typeof cell?.value !== "string") continue;
          cell.value = cell.value.replace(
            /Base!([A-Z]+)(\d+)/g,
            (reference, column, rowText) => {
              const rowNumber = Number(rowText);
              if (delta > 0 && rowNumber >= firstAffectedRow) {
                return `Base!${column}${rowNumber + delta}`;
              }
              if (
                delta < 0 &&
                rowNumber >= firstAffectedRow &&
                rowNumber <= lastDeletedRow
              ) {
                return "#REF!";
              }
              if (delta < 0 && rowNumber > lastDeletedRow) {
                return `Base!${column}${rowNumber + delta}`;
              }
              return reference;
            },
          );
        }
      }
    }
  }

  client.batchUpdate = async (requests, options) => {
    batchCalls.push({ requests, options });
    const isPromotion = requests.some(
      (request) =>
        request.updateSheetProperties?.properties?.sheetId ===
        original.sheetId,
    );
    if (isPromotion && promotionPreThrowsRemaining > 0) {
      promotionPreThrowsRemaining--;
      throw new Error("promocao nao aplicada");
    }
    for (const request of requests) {
      if (request.addSheet) {
        const properties = request.addSheet.properties;
        sheets.set(properties.sheetId, {
          sheetId: properties.sheetId,
          title: properties.title,
          hidden: properties.hidden,
          rowCount: properties.gridProperties.rowCount,
          columnCount: properties.gridProperties.columnCount,
          cells: [],
        });
      } else if (request.copyPaste) {
        applyCopyPaste(request.copyPaste);
      } else if (request.deleteDimension) {
        const range = request.deleteDimension.range;
        const sheet = sheets.get(range.sheetId);
        if (sheet.sheetId === original.sheetId) {
          adjustBaseRowReferences(
            range.startIndex,
            range.endIndex,
            range.startIndex - range.endIndex,
          );
        }
        sheet.cells.splice(range.startIndex, range.endIndex - range.startIndex);
        sheet.rowCount -= range.endIndex - range.startIndex;
      } else if (request.insertDimension) {
        const range = request.insertDimension.range;
        const sheet = sheets.get(range.sheetId);
        const count = range.endIndex - range.startIndex;
        if (sheet.sheetId === original.sheetId) {
          adjustBaseRowReferences(range.startIndex, range.startIndex, count);
        }
        sheet.cells.splice(
          range.startIndex,
          0,
          ...Array.from({ length: count }, () => []),
        );
        sheet.rowCount += count;
      } else if (request.updateSheetProperties) {
        const properties = request.updateSheetProperties.properties;
        const sheet = sheets.get(properties.sheetId);
        if (properties.gridProperties.rowCount !== undefined) {
          sheet.rowCount = properties.gridProperties.rowCount;
          sheet.cells.length = Math.min(sheet.cells.length, sheet.rowCount);
        }
        if (properties.gridProperties.columnCount !== undefined) {
          sheet.columnCount = properties.gridProperties.columnCount;
          for (const row of sheet.cells) {
            row.length = Math.min(row.length, sheet.columnCount);
          }
        }
      } else if (request.updateCells) {
        const sheet = sheets.get(request.updateCells.range.sheetId);
        applyUpdateCells(sheet, request.updateCells);
      } else if (request.deleteSheet) {
        sheets.delete(request.deleteSheet.sheetId);
      }
    }
    if (isPromotion && promotionThrowsRemaining > 0) {
      promotionThrowsRemaining--;
      throw new Error("resposta de promocao perdida");
    }
    return { ok: true };
  };

  client.numberFormatsMatch = async (title, blocks) => {
    const sheet = byTitle(title);
    if (!sheet) return false;
    return blocks.every((block) => {
      for (
        let rowIndex = block.startRowIndex;
        rowIndex < block.endRowIndex;
        rowIndex++
      ) {
        const actual =
          sheet.cells[rowIndex]?.[block.columnIndex]?.numberFormat;
        if (
          actual?.type !== block.numberFormat.type ||
          actual?.pattern !== block.numberFormat.pattern
        ) {
          return false;
        }
      }
      return true;
    });
  };

  return {
    batchCalls,
    client,
    dependent,
    original,
    sheets,
    stagingSheets: () =>
      [...sheets.values()].filter((sheet) =>
        sheet.title.startsWith("_data_staging_"),
      ),
  };
}

test("replaceRowsViaStaging preserva linhas, promove e expande colunas", async () => {
  const header = ["Chave", "Data", "Valor", "Nova coluna"];
  const harness = createHarness({
    header,
    gridColumnCount: 3,
    rows: [
      ["MANTER-1", "01/07/2026", "primeiro"],
      ["ALVO", "14/07/2026", "antigo"],
      ["MANTER-2", "02/07/2026", "ultimo"],
    ],
  });
  const typedDate = GoogleSheets.dateCell("14/07/2026");
  const typedDateSerial =
    GoogleSheets.literalCell(typedDate).userEnteredValue.numberValue;

  const result = await harness.client.replaceRowsViaStaging({
    sheetTitle: "Base",
    columnRange: "A:D",
    header,
    newRows: [["NOVO", typedDate, "atual", "expandido"]],
    matchColumnIndexes: [0],
    shouldReplace: (row) => row[0] === "ALVO" || row[0] === "NOVO",
  });

  assert.deepEqual(result, {
    previous: 3,
    removed: 1,
    inserted: 1,
    final: 3,
  });
  assert.equal(harness.original.columnCount, 4);
  assert.equal(harness.original.rowCount, 4);
  assert.deepEqual(
    harness.original.cells.slice(0, 4).map((row) =>
      cellValues(row, 4),
    ),
    [
      header,
      ["MANTER-1", "01/07/2026", "primeiro", ""],
      ["MANTER-2", "02/07/2026", "ultimo", ""],
      ["NOVO", typedDateSerial, "atual", "expandido"],
    ],
  );
  assert.deepEqual(harness.original.cells[3][1].numberFormat, {
    type: "DATE",
    pattern: "dd/mm/yyyy",
  });
  assert.equal(harness.stagingSheets().length, 0);
  const promotion = harness.batchCalls.find((call) =>
    call.requests.some(
      (request) =>
        request.copyPaste?.destination?.sheetId === harness.original.sheetId,
    ),
  );
  assert.ok(promotion);
  assert.equal(
    promotion.requests.find((request) => request.updateSheetProperties)
      .updateSheetProperties.properties.gridProperties.rowCount,
    4,
  );
});

test("replaceRowsViaStaging preserva e realinha colunas fora de columnRange", async () => {
  const header = ["Chave", "Valor"];
  const harness = createHarness({
    header,
    initialHeader: [...header, "Auxiliar"],
    gridColumnCount: 3,
    rows: [
      ["ALVO", "antigo", "auxiliar antigo"],
      ["MANTER", "preservar", "auxiliar preservado"],
    ],
  });

  await harness.client.replaceRowsViaStaging({
    sheetTitle: "Base",
    columnRange: "A:B",
    header,
    newRows: [["NOVO", "atual"]],
    matchColumnIndexes: [0],
    shouldReplace: (row) => row[0] === "ALVO" || row[0] === "NOVO",
  });

  assert.equal(harness.original.columnCount, 3);
  assert.deepEqual(
    harness.original.cells.slice(0, 3).map((row) =>
      cellValues(row, 3),
    ),
    [
      ["Chave", "Valor", "Auxiliar"],
      ["MANTER", "preservar", "auxiliar preservado"],
      ["NOVO", "atual", ""],
    ],
  );
  const promotion = harness.batchCalls.find((call) =>
    call.requests.some(
      (request) =>
        request.copyPaste?.destination?.sheetId === harness.original.sheetId,
    ),
  );
  const structuralDelete = promotion.requests.find(
    (request) => request.deleteDimension,
  );
  assert.deepEqual(structuralDelete.deleteDimension.range, {
    sheetId: harness.original.sheetId,
    dimension: "ROWS",
    startIndex: 1,
    endIndex: 2,
  });
  assert.equal(
    promotion.requests.find((request) => request.copyPaste).copyPaste.source
      .endColumnIndex,
    2,
  );
});

test("replaceRowsViaStaging usa exclusao estrutural e ajusta formula externa", async () => {
  const header = ["Chave", "Valor", "Auxiliar"];
  const harness = createHarness({
    header,
    rows: [
      ["MANTER-1", "primeiro", "a"],
      ["ALVO", "antigo", "b"],
      ["MANTER-2", "ultimo", "c"],
    ],
    externalFormula: "=Base!C4",
  });

  await harness.client.replaceRowsViaStaging({
    sheetTitle: "Base",
    columnRange: "A:C",
    header,
    newRows: [["NOVO", "atual", "d"]],
    matchColumnIndexes: [0],
    shouldReplace: (row) => row[0] === "ALVO" || row[0] === "NOVO",
  });

  assert.equal(harness.dependent.cells[0][0].value, "=Base!C3");
  assert.deepEqual(
    harness.original.cells.slice(0, 4).map((row) =>
      row.slice(0, 3).map((cell) => cell?.value ?? ""),
    ),
    [
      header,
      ["MANTER-1", "primeiro", "a"],
      ["MANTER-2", "ultimo", "c"],
      ["NOVO", "atual", "d"],
    ],
  );
});

test("replaceRowsViaStaging insere cabecalho antes das exclusoes estruturais", async () => {
  const header = ["Chave", "Valor"];
  const harness = createHarness({
    header,
    initialHeader: ["ALVO", "antigo"],
    rows: [["MANTER", "preservar"]],
    gridRowCount: 2,
  });

  const result = await harness.client.replaceRowsViaStaging({
    sheetTitle: "Base",
    columnRange: "A:B",
    header,
    newRows: [["NOVO", "atual"]],
    matchColumnIndexes: [0],
    shouldReplace: (row) => row[0] === "ALVO" || row[0] === "NOVO",
  });

  assert.deepEqual(result, {
    previous: 2,
    removed: 1,
    inserted: 1,
    final: 2,
  });
  assert.deepEqual(
    harness.original.cells.slice(0, 3).map((row) => cellValues(row, 2)),
    [header, ["MANTER", "preservar"], ["NOVO", "atual"]],
  );
  const promotion = harness.batchCalls.find((call) =>
    call.requests.some(
      (request) =>
        request.updateSheetProperties?.properties?.sheetId ===
        harness.original.sheetId,
    ),
  );
  assert.ok(promotion.requests[0].insertDimension);
  assert.deepEqual(promotion.requests[1].deleteDimension.range, {
    sheetId: harness.original.sheetId,
    dimension: "ROWS",
    startIndex: 1,
    endIndex: 2,
  });
});

test("replaceRowsViaStaging falha antes da staging ao exceder 10 milhoes de celulas", async () => {
  const header = ["Chave"];
  const harness = createHarness({
    header,
    rows: [["ALVO"]],
    gridRowCount: 2,
    extraSheetDimensions: {
      rowCount: 9_999_998,
      columnCount: 1,
    },
  });

  await assert.rejects(
    () =>
      harness.client.replaceRowsViaStaging({
        sheetTitle: "Base",
        columnRange: "A:A",
        header,
        newRows: [["NOVO"]],
        matchColumnIndexes: [0],
        shouldReplace: (row) => row[0] === "ALVO" || row[0] === "NOVO",
      }),
    /limite de 10000000 celulas/,
  );
  assert.equal(harness.stagingSheets().length, 0);
  assert.equal(harness.batchCalls.length, 0);
});

test("replaceRowsViaStaging escreve newRows em chunks absolutos idempotentes", async () => {
  const previousChunkSize = process.env.GOOGLE_SHEETS_STAGING_CHUNK_ROWS;
  const previousChunkInterval =
    process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS;
  process.env.GOOGLE_SHEETS_STAGING_CHUNK_ROWS = "2";
  process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS = "0";
  try {
    const header = ["Chave", "Data"];
    const harness = createHarness({
      header,
      rows: [["ALVO", "14/07/2026"]],
      gridRowCount: 2,
    });
    const date = GoogleSheets.dateCell("14/07/2026");
    const newRows = Array.from(
      { length: 5 },
      (_, index) => [`NOVO-${index}`, date],
    );

    await harness.client.replaceRowsViaStaging({
      sheetTitle: "Base",
      columnRange: "A:B",
      header,
      newRows,
      matchColumnIndexes: [0],
      shouldReplace: (row) =>
        row[0] === "ALVO" || String(row[0] || "").startsWith("NOVO-"),
    });

    const chunkCalls = harness.batchCalls.filter(
      (call) =>
        call.options?.idempotent === true &&
        call.requests.length === 1 &&
        call.requests[0].updateCells,
    );
    assert.equal(chunkCalls.length, 3);
    assert.deepEqual(
      chunkCalls.map((call) => {
        const range = call.requests[0].updateCells.range;
        return [range.startRowIndex, range.endRowIndex];
      }),
      [
        [0, 2],
        [2, 4],
        [4, 5],
      ],
    );
    assert.ok(
      chunkCalls.every(
        (call) =>
          call.requests[0].updateCells.fields ===
          "userEnteredValue,userEnteredFormat.numberFormat",
      ),
    );
  } finally {
    if (previousChunkSize === undefined) {
      delete process.env.GOOGLE_SHEETS_STAGING_CHUNK_ROWS;
    } else {
      process.env.GOOGLE_SHEETS_STAGING_CHUNK_ROWS = previousChunkSize;
    }
    if (previousChunkInterval === undefined) {
      delete process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS;
    } else {
      process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS =
        previousChunkInterval;
    }
  }
});

test("replaceRowsViaStaging limita chunks pelo tamanho serializado", async () => {
  const previousChunkRows = process.env.GOOGLE_SHEETS_STAGING_CHUNK_ROWS;
  const previousChunkBytes = process.env.GOOGLE_SHEETS_STAGING_CHUNK_BYTES;
  const previousChunkInterval =
    process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS;
  process.env.GOOGLE_SHEETS_STAGING_CHUNK_ROWS = "500";
  process.env.GOOGLE_SHEETS_STAGING_CHUNK_BYTES = "300";
  process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS = "0";
  try {
    const header = ["Chave", "Valor"];
    const harness = createHarness({
      header,
      rows: [["ALVO", "antigo"]],
      gridRowCount: 2,
    });
    const newRows = Array.from({ length: 4 }, (_, index) => [
      `NOVO-${index}`,
      "x".repeat(180),
    ]);

    await harness.client.replaceRowsViaStaging({
      sheetTitle: "Base",
      columnRange: "A:B",
      header,
      newRows,
      matchColumnIndexes: [0],
      shouldReplace: (row) =>
        row[0] === "ALVO" || String(row[0] || "").startsWith("NOVO-"),
    });

    const chunkCalls = harness.batchCalls.filter(
      (call) =>
        call.options?.idempotent === true &&
        call.requests.length === 1 &&
        call.requests[0].updateCells,
    );
    assert.equal(chunkCalls.length, 4);
    assert.deepEqual(
      chunkCalls.map((call) => {
        const range = call.requests[0].updateCells.range;
        return [range.startRowIndex, range.endRowIndex];
      }),
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
      ],
    );
  } finally {
    if (previousChunkRows === undefined) {
      delete process.env.GOOGLE_SHEETS_STAGING_CHUNK_ROWS;
    } else {
      process.env.GOOGLE_SHEETS_STAGING_CHUNK_ROWS = previousChunkRows;
    }
    if (previousChunkBytes === undefined) {
      delete process.env.GOOGLE_SHEETS_STAGING_CHUNK_BYTES;
    } else {
      process.env.GOOGLE_SHEETS_STAGING_CHUNK_BYTES = previousChunkBytes;
    }
    if (previousChunkInterval === undefined) {
      delete process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS;
    } else {
      process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS =
        previousChunkInterval;
    }
  }
});

test("replaceRowsViaStaging rejeita uma linha maior que o chunk seguro", async () => {
  const previousChunkBytes = process.env.GOOGLE_SHEETS_STAGING_CHUNK_BYTES;
  const previousChunkInterval =
    process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS;
  process.env.GOOGLE_SHEETS_STAGING_CHUNK_BYTES = "150";
  process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS = "0";
  try {
    const harness = createHarness({
      header: ["Chave", "Valor"],
      rows: [["ALVO", "antigo"]],
      gridRowCount: 2,
    });

    await assert.rejects(
      () =>
        harness.client.replaceRowsViaStaging({
          sheetTitle: "Base",
          columnRange: "A:B",
          header: ["Chave", "Valor"],
          newRows: [["NOVO", "x".repeat(200)]],
          matchColumnIndexes: [0],
          shouldReplace: (row) =>
            row[0] === "ALVO" || row[0] === "NOVO",
        }),
      /linha excede o tamanho seguro/,
    );
    assert.equal(harness.original.cells[1][0].value, "ALVO");
    assert.equal(harness.stagingSheets().length, 0);
  } finally {
    if (previousChunkBytes === undefined) {
      delete process.env.GOOGLE_SHEETS_STAGING_CHUNK_BYTES;
    } else {
      process.env.GOOGLE_SHEETS_STAGING_CHUNK_BYTES = previousChunkBytes;
    }
    if (previousChunkInterval === undefined) {
      delete process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS;
    } else {
      process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS =
        previousChunkInterval;
    }
  }
});

test("replaceRowsViaStaging rejeita promocao atomica grande antes da staging", async () => {
  const previousMaxBytes = process.env.GOOGLE_SHEETS_PROMOTION_MAX_BYTES;
  process.env.GOOGLE_SHEETS_PROMOTION_MAX_BYTES = "600";
  try {
    const rows = Array.from({ length: 40 }, (_, index) => [
      index % 2 === 0 ? `ALVO-${index}` : `MANTER-${index}`,
    ]);
    const harness = createHarness({
      header: ["Chave"],
      rows,
      gridRowCount: rows.length + 1,
    });

    await assert.rejects(
      () =>
        harness.client.replaceRowsViaStaging({
          sheetTitle: "Base",
          columnRange: "A:A",
          header: ["Chave"],
          newRows: [["NOVO"]],
          matchColumnIndexes: [0],
          shouldReplace: (row) =>
            String(row[0] || "").startsWith("ALVO-") ||
            row[0] === "NOVO",
        }),
      /Promocao atomica excederia/,
    );
    assert.equal(harness.batchCalls.length, 0);
    assert.equal(harness.stagingSheets().length, 0);
  } finally {
    if (previousMaxBytes === undefined) {
      delete process.env.GOOGLE_SHEETS_PROMOTION_MAX_BYTES;
    } else {
      process.env.GOOGLE_SHEETS_PROMOTION_MAX_BYTES = previousMaxBytes;
    }
  }
});

test("replaceRowsViaStaging aborta promocao quando o original muda", async () => {
  const header = ["Chave", "Valor"];
  const harness = createHarness({
    header,
    rows: [
      ["ALVO", "antigo"],
      ["MANTER", "preservar"],
    ],
    mutateBeforeSecondOriginalRead: (original) => {
      original.cells[2][1].value = "mudanca concorrente";
    },
  });

  await assert.rejects(
    () =>
      harness.client.replaceRowsViaStaging({
        sheetTitle: "Base",
        columnRange: "A:B",
        header,
        newRows: [["NOVO", "atual"]],
        matchColumnIndexes: [0],
        shouldReplace: (row) =>
          row[0] === "ALVO" || row[0] === "NOVO",
      }),
    /Estado da planilha mudou antes da promocao/,
  );
  assert.equal(harness.original.cells[1][0].value, "ALVO");
  assert.equal(harness.original.cells[2][1].value, "mudanca concorrente");
  assert.equal(harness.stagingSheets().length, 0);
  assert.equal(
    harness.batchCalls.some((call) =>
      call.requests.some(
        (request) =>
          request.copyPaste?.destination?.sheetId ===
          harness.original.sheetId,
      ),
    ),
    false,
  );
});

test("replaceRowsViaStaging confirma promocao com resposta ambigua", async () => {
  const header = ["Chave", "Valor"];
  const harness = createHarness({
    header,
    rows: [["ALVO", "antigo"]],
    gridRowCount: 2,
    throwAfterPromotion: true,
  });

  const result = await harness.client.replaceRowsViaStaging({
    sheetTitle: "Base",
    columnRange: "A:B",
    header,
    newRows: [["NOVO", "atual"]],
    matchColumnIndexes: [0],
    shouldReplace: (row) => row[0] === "ALVO" || row[0] === "NOVO",
  });

  assert.deepEqual(result, {
    previous: 1,
    removed: 1,
    inserted: 1,
    final: 1,
  });
  assert.deepEqual(
    harness.original.cells.slice(0, 2).map((row) =>
      row.slice(0, 2).map((cell) => cell?.value ?? ""),
    ),
    [header, ["NOVO", "atual"]],
  );
  assert.equal(harness.stagingSheets().length, 0);
  assert.equal(
    harness.batchCalls.filter((call) =>
      call.requests.some(
        (request) =>
          request.copyPaste?.destination?.sheetId ===
          harness.original.sheetId,
      ),
    ).length,
    1,
  );
});

test("replaceRowsViaStaging limpa staging quando a promocao nao foi aplicada", async () => {
  const header = ["Chave", "Valor"];
  const harness = createHarness({
    header,
    rows: [["ALVO", "antigo"]],
    gridRowCount: 2,
    throwBeforePromotion: true,
  });

  await assert.rejects(
    () =>
      harness.client.replaceRowsViaStaging({
        sheetTitle: "Base",
        columnRange: "A:B",
        header,
        newRows: [["NOVO", "atual"]],
        matchColumnIndexes: [0],
        shouldReplace: (row) => row[0] === "ALVO" || row[0] === "NOVO",
      }),
    /promocao nao aplicada/,
  );
  assert.deepEqual(
    harness.original.cells.slice(0, 2).map((row) => cellValues(row, 2)),
    [header, ["ALVO", "antigo"]],
  );
  assert.equal(harness.stagingSheets().length, 0);
});

test("replaceRowsViaStaging mantem staging quando erro ambiguo parece antigo e final", async () => {
  const header = ["Chave", "Valor"];
  const harness = createHarness({
    header,
    rows: [["ALVO", "antigo"]],
    gridRowCount: 2,
    throwBeforePromotion: true,
  });

  await assert.rejects(
    () =>
      harness.client.replaceRowsViaStaging({
        sheetTitle: "Base",
        columnRange: "A:B",
        header,
        newRows: [["ALVO", "antigo"]],
        matchColumnIndexes: [0],
        shouldReplace: (row) => row[0] === "ALVO",
      }),
    /Resultado ambiguo da promocao/,
  );
  assert.deepEqual(
    harness.original.cells.slice(0, 2).map((row) => cellValues(row, 2)),
    [header, ["ALVO", "antigo"]],
  );
  assert.equal(harness.stagingSheets().length, 1);
});
