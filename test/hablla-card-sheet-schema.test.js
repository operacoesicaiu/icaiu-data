const assert = require("node:assert/strict");
const test = require("node:test");

const GoogleSheets = require("../src/google/sheets");
const {
  CARD_CUSTOM_FIELD_IDS,
  CARD_HEADERS,
  CUSTOM_FIELD_DISPLAY_NAMES,
  LEGACY_EXTRA_HEADER_ALIASES,
  MAX_CELL_CHARACTERS,
  TECHNICAL_CARD_HEADERS,
  buildBaseCardRow,
  buildCardSheet,
  buildCardSheetRow,
  discoverCardSheetHeaders,
  normalizePhoneValue,
  sheetValue,
  validateCardSheetHeader,
} = require("../src/hablla/card-sheet-schema");

const FIXED_FIELD_IDS = [
  "field-one",
  "field-two",
  "field-three",
  "field-reason",
  "field-phone",
];

function cardFixture(overrides = {}) {
  return {
    updated_at: "2026-04-01T10:20:30-03:00",
    created_at: "2026-03-31T09:10:11-03:00",
    workspace: "workspace-test",
    board: "board-test",
    list: "list-test",
    name: "Card de teste",
    description: "Descricao de teste",
    source: "source-test",
    status: "open",
    user: { id: "user-test", name: "Pessoa Teste", role: "agent" },
    finished_at: "2026-04-01T11:21:31-03:00",
    id: "card-test",
    tags: [{ name: "tag-a", color: "blue" }, { name: "tag-b" }],
    custom_fields: [
      { custom_field: FIXED_FIELD_IDS[0], value: "valor-um" },
      { custom_field: FIXED_FIELD_IDS[1], value: "valor-dois" },
      { custom_field: FIXED_FIELD_IDS[2], value: "valor-tres" },
      { custom_field: FIXED_FIELD_IDS[3], value: "motivo-teste" },
      { custom_field: FIXED_FIELD_IDS[4], value: "telefone-teste" },
    ],
    ...overrides,
  };
}

test("as 19 colunas base usam nomes visuais e a linha reproduz o contrato atual", () => {
  assert.equal(Object.isFrozen(CARD_HEADERS), true);
  assert.deepEqual(CARD_HEADERS, [
    "Atualizado",
    "Criado",
    "workspace",
    "Quadro",
    "Lista",
    "Device",
    "Aparelho",
    "Serviço",
    "Nome",
    "Descrição",
    "Origem do Card",
    "Status",
    "Usuário",
    "Finalizado",
    "ID",
    "Atendente",
    "Motivo de Contato",
    "Tags",
    "Telefone",
  ]);
  assert.equal(Object.isFrozen(TECHNICAL_CARD_HEADERS), true);
  assert.deepEqual(TECHNICAL_CARD_HEADERS.slice(0, 5), [
    "updated_at",
    "created_at",
    "workspace",
    "board",
    "list",
  ]);
  assert.throws(() => CARD_HEADERS.push("outra"), TypeError);

  const row = buildBaseCardRow(cardFixture(), { customFieldIds: FIXED_FIELD_IDS });
  assert.equal(row.length, 19);
  assert.deepEqual(row, [
    GoogleSheets.dateTimeCell("01/04/2026 10:20:30"),
    GoogleSheets.dateTimeCell("31/03/2026 09:10:11"),
    "workspace-test",
    "board-test",
    "list-test",
    "valor-um",
    "valor-dois",
    "valor-tres",
    "Card de teste",
    "Descricao de teste",
    "source-test",
    "open",
    "user-test",
    GoogleSheets.dateTimeCell("01/04/2026 11:21:31"),
    "card-test",
    "Pessoa Teste",
    "motivo-teste",
    "tag-a, tag-b",
    "telefone-teste",
  ]);
});

test("cabecalho tecnico e migrado para o visual sem mudar posicoes", () => {
  const knownId = "67ca3b1b2a2005b0e7c0b67f";
  const oldHeader = [
    ...TECHNICAL_CARD_HEADERS,
    "card.metadata",
    `custom_field.${knownId}`,
    "custom_field.desconhecido",
  ];

  assert.deepEqual(validateCardSheetHeader(oldHeader), [
    ...CARD_HEADERS,
    "card.metadata",
    "utm_medium",
    "custom_field.desconhecido",
  ]);
  assert.deepEqual(
    validateCardSheetHeader([
      ...CARD_HEADERS,
      "card.metadata",
      "utm_medium",
      "custom_field.desconhecido",
    ]),
    [
      ...CARD_HEADERS,
      "card.metadata",
      "utm_medium",
      "custom_field.desconhecido",
    ],
  );
});

test("cabecalho visual legado de telefone continua ligado ao campo do card", () => {
  assert.equal(LEGACY_EXTRA_HEADER_ALIASES["Telefone (Campo)"], "card.phone");
  const existingHeader = [...CARD_HEADERS, "Telefone (Campo)"];
  const card = cardFixture({ phone: "+5511999999999" });

  const { header, rows } = buildCardSheet([card], existingHeader, {
    customFieldIds: FIXED_FIELD_IDS,
  });

  assert.deepEqual(header.slice(0, existingHeader.length), existingHeader);
  assert.equal(rows[0][header.indexOf("Telefone (Campo)")], "+5511999999999");
  assert.equal(header.includes("card.phone"), false);
});

test("descobertas sao ordenadas e preservam para sempre a ordem existente", () => {
  const firstHeader = discoverCardSheetHeaders([
    cardFixture({
      zeta: "z",
      alpha: "a",
      custom_fields: [
        { custom_field: "field-zeta", value: "z" },
        { custom_field: "field-alpha", value: "a" },
      ],
    }),
  ]);
  assert.deepEqual(firstHeader.slice(19), [
    "card.alpha",
    "card.custom_fields",
    "card.tags",
    "card.user",
    "card.zeta",
    "custom_field.field-alpha",
    "custom_field.field-zeta",
  ]);

  const existing = [
    ...CARD_HEADERS,
    "card.zeta",
    "custom_field.field-old",
    "card.alpha",
  ];
  const nextHeader = discoverCardSheetHeaders(
    [
      {
        id: "card-next",
        beta: true,
        custom_fields: [{ custom_field: "field-new", value: 1 }],
      },
    ],
    existing,
  );
  assert.deepEqual(nextHeader, [
    ...existing,
    "card.beta",
    "card.custom_fields",
    "custom_field.field-new",
  ]);
  assert.deepEqual(discoverCardSheetHeaders([], nextHeader), nextHeader);
});

test("IDs conhecidos recebem nomes visuais e desconhecidos permanecem tecnicos", () => {
  assert.equal(Object.keys(CUSTOM_FIELD_DISPLAY_NAMES).length, 22);
  const knownFields = Object.entries(CUSTOM_FIELD_DISPLAY_NAMES).map(
    ([custom_field, display], index) => ({
      custom_field,
      value: `valor-${index}`,
      display,
    }),
  );
  const card = cardFixture({
    custom_fields: [
      ...knownFields,
      { custom_field: "id-sem-mapeamento", value: "desconhecido" },
    ],
  });
  const { header, rows } = buildCardSheet([card], TECHNICAL_CARD_HEADERS, {
    customFieldIds: FIXED_FIELD_IDS,
  });

  for (const { custom_field, value, display } of knownFields) {
    assert.equal(header.includes(`custom_field.${custom_field}`), false);
    assert.equal(rows[0][header.indexOf(display)], value);
  }
  assert.equal(
    rows[0][header.indexOf("custom_field.id-sem-mapeamento")],
    "desconhecido",
  );
});

test("toda linha acompanha a largura descoberta e campos ausentes ficam vazios", () => {
  const cards = [
    cardFixture({ extra_alpha: "presente" }),
    cardFixture({ id: "card-sem-extra", extra_beta: "outro" }),
  ];
  const { header, rows } = buildCardSheet(cards, CARD_HEADERS, {
    customFieldIds: FIXED_FIELD_IDS,
  });

  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.length === header.length), true);
  assert.equal(rows[0][header.indexOf("card.extra_alpha")], "presente");
  assert.equal(rows[0][header.indexOf("card.extra_beta")], "");
  assert.equal(rows[1][header.indexOf("card.extra_alpha")], "");
  assert.equal(rows[1][header.indexOf("card.extra_beta")], "outro");
});

test("valores dinamicos preservam literais, numeros, booleanos, JSON e datas", () => {
  const card = cardFixture({
    active: false,
    count: 7,
    empty_value: null,
    formula_text: "=SUM(A1:A2)",
    invalid_at: "nao-e-iso",
    metadata: { z: 3, a: { y: 2, x: 1 } },
    numeric_keys: { 2: "dois", 10: "dez" },
    observed_at: "2026-04-02T12:34:56-03:00",
    sequence: [{ z: 2, a: 1 }, true],
  });
  const header = discoverCardSheetHeaders([card]);
  const row = buildCardSheetRow(card, header, { customFieldIds: FIXED_FIELD_IDS });
  const at = (name) => row[header.indexOf(name)];

  assert.equal(at("card.active"), false);
  assert.equal(at("card.count"), 7);
  assert.equal(at("card.empty_value"), "");
  assert.equal(at("card.formula_text"), "=SUM(A1:A2)");
  assert.deepEqual(GoogleSheets.literalCell(at("card.formula_text")), {
    userEnteredValue: { stringValue: "=SUM(A1:A2)" },
  });
  assert.equal(at("card.invalid_at"), "nao-e-iso");
  assert.equal(at("card.metadata"), '{"a":{"x":1,"y":2},"z":3}');
  assert.equal(at("card.numeric_keys"), '{"10":"dez","2":"dois"}');
  assert.equal(at("card.sequence"), '[{"a":1,"z":2},true]');
  assert.equal(String(at("card.observed_at")), "02/04/2026 12:34:56");
  assert.equal(
    GoogleSheets.literalCell(at("card.observed_at")).userEnteredValue.numberValue > 0,
    true,
  );
});

test("remove apostrofo de escape e mais inicial apenas de telefone", () => {
  assert.equal(sheetValue("'texto", "card.name"), "texto");
  assert.equal(sheetValue("+campanha", "card.name"), "+campanha");
  assert.equal(normalizePhoneValue("'+5511999999999"), "5511999999999");

  const phoneId = CARD_CUSTOM_FIELD_IDS[4];
  const card = cardFixture({
    name: "'Card sem escape",
    custom_fields: [{ custom_field: phoneId, value: "+5511999999999" }],
  });
  const header = discoverCardSheetHeaders([card]);
  const row = buildCardSheetRow(card, header);
  assert.equal(row[8], "Card sem escape");
  assert.equal(row[18], "5511999999999");
  assert.equal(row[header.indexOf(`custom_field.${phoneId}`)], "5511999999999");
});

test("cada custom field ganha coluna e IDs repetidos viram JSON estavel sem perda", () => {
  const fields = [
    { custom_field: "field-duplicate", value: "zeta" },
    { custom_field: "field-number", value: 42 },
    { custom_field: "field-duplicate", value: { z: 2, a: 1 } },
    { custom_field: "field-duplicate", value: "alpha" },
  ];
  const first = cardFixture({ custom_fields: fields });
  const second = cardFixture({ id: "card-reversed", custom_fields: [...fields].reverse() });
  const header = discoverCardSheetHeaders([first, second]);
  const firstRow = buildCardSheetRow(first, header, { customFieldIds: FIXED_FIELD_IDS });
  const secondRow = buildCardSheetRow(second, header, { customFieldIds: FIXED_FIELD_IDS });
  const duplicateIndex = header.indexOf("custom_field.field-duplicate");
  const numberIndex = header.indexOf("custom_field.field-number");

  assert.notEqual(duplicateIndex, -1);
  assert.notEqual(numberIndex, -1);
  assert.equal(firstRow[numberIndex], 42);
  assert.equal(firstRow[duplicateIndex], '["alpha","zeta",{"a":1,"z":2}]');
  assert.equal(secondRow[duplicateIndex], firstRow[duplicateIndex]);
});

test("valores acima de 50 mil caracteres falham antes da escrita", () => {
  assert.equal(sheetValue("x".repeat(MAX_CELL_CHARACTERS), "card.note").length, 50_000);
  assert.throws(
    () => sheetValue("x".repeat(MAX_CELL_CHARACTERS + 1), "card.note"),
    /excede 50000 caracteres/,
  );
  assert.throws(
    () => sheetValue({ payload: "x".repeat(MAX_CELL_CHARACTERS) }, "card.raw"),
    /excede 50000 caracteres/,
  );
  assert.throws(
    () =>
      buildCardSheetRow(
        cardFixture({ name: "x".repeat(MAX_CELL_CHARACTERS + 1) }),
        CARD_HEADERS,
        { customFieldIds: FIXED_FIELD_IDS },
      ),
    /excede 50000 caracteres/,
  );
});

test("cabecalho alterado, extra desconhecido ou duplicado e rejeitado", () => {
  const changedBase = [...CARD_HEADERS];
  changedBase[0] = "created_at";
  assert.throws(() => validateCardSheetHeader(changedBase), /Coluna base.*alterada/);
  assert.throws(
    () => validateCardSheetHeader([...CARD_HEADERS, "campo-solto"]),
    /nao reconhecido/,
  );
  assert.throws(
    () => validateCardSheetHeader([...CARD_HEADERS, "card.updated_at"]),
    /nao reconhecido/,
  );
  assert.throws(
    () => validateCardSheetHeader([...CARD_HEADERS, "card.extra", "card.extra"]),
    /duplicado/,
  );
  assert.throws(
    () => validateCardSheetHeader([...CARD_HEADERS, "custom_field."]),
    /nao reconhecido/,
  );
  assert.throws(
    () =>
      validateCardSheetHeader([
        ...CARD_HEADERS,
        "custom_field.67ca3b1b2a2005b0e7c0b67f",
        "utm_medium",
      ]),
    /duplicado/,
  );
});
