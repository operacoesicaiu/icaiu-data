const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractAttendants,
  extractCards,
  extractClients,
} = require("../src/hablla/response-contracts");
const {
  retryableSupabaseError,
  upsertRows,
} = require("../src/lib/supabase-upsert");

function fakeSupabase(results) {
  const calls = [];
  let index = 0;
  return {
    calls,
    from(table) {
      return {
        async upsert(rows, options) {
          calls.push({ options, rows, table });
          const result = results[Math.min(index, results.length - 1)];
          index++;
          if (result instanceof Error) throw result;
          return result;
        },
      };
    },
  };
}

test("contratos Hablla aceitam somente listas explicitas observadas", () => {
  const cards = [{ id: "card-1" }];
  const attendants = [{ id: "attendant-1" }];
  const clients = [{ id: "client-1" }];

  assert.equal(extractCards({ results: cards }), cards);
  assert.equal(extractAttendants({ results: attendants }), attendants);
  assert.equal(extractClients({ results: clients }), clients);
  assert.equal(extractClients({ data: clients }), clients);
  assert.equal(extractClients({ list: clients }), clients);
  assert.equal(extractClients(clients), clients);
  assert.deepEqual(extractCards({ results: [] }), []);
});

test("resposta Hablla 200 malformada nunca vira lista vazia", () => {
  for (const payload of [undefined, null, {}, { results: null }, { results: {} }]) {
    assert.throws(() => extractCards(payload), /Hablla retornou/);
    assert.throws(() => extractAttendants(payload), /Hablla retornou/);
  }

  for (const payload of [
    undefined,
    null,
    {},
    { data: null },
    { list: {} },
    { results: null, data: [{ id: "nao-deve-ser-aceito" }] },
  ]) {
    assert.throws(() => extractClients(payload), /Hablla retornou/);
  }
  assert.throws(
    () => extractCards({ results: [null] }),
    /item invalido/,
  );
  assert.throws(
    () => extractClients({ data: ["client-invalido"] }),
    /item invalido/,
  );
});

test("contrato malformado interrompe o fluxo antes de qualquer escrita", async () => {
  let replaces = 0;
  let upserts = 0;
  const processResponse = async (payload) => {
    const rows = extractCards(payload);
    replaces++;
    upserts += rows.length;
  };

  await assert.rejects(processResponse({ meta: { status: 200 } }));
  assert.equal(replaces, 0);
  assert.equal(upserts, 0);
});

test("upsert Hablla repete 429 com a mesma chave idempotente", async () => {
  const rows = [
    { external_id: "card-1", payload: { private: "nao-logar" } },
  ];
  const client = fakeSupabase([{ error: { status: 429 } }, { error: null }]);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await upsertRows({
      table: "raw_events_hablla",
      rows,
      client,
      maxAttempts: 2,
      baseMs: 1,
      maxMs: 1,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[0].rows, rows);
  assert.deepEqual(client.calls[1].rows, rows);
  assert.equal(client.calls[0].options.onConflict, "external_id");
});

test("retry Supabase e limitado e nao registra payload", async () => {
  const secretMarker = "payload-ultrassecreto";
  const client = fakeSupabase([
    { error: { status: 503, message: secretMarker } },
    { error: { status: 503, message: secretMarker } },
    { error: { status: 503, message: secretMarker } },
  ]);
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => logs.push(parts.join(" "));
  try {
    await assert.rejects(
      upsertRows({
        table: "raw_contact_hablla",
        rows: [{ external_id: "client-1", payload: secretMarker }],
        client,
        maxAttempts: 3,
        baseMs: 1,
        maxMs: 1,
      }),
      (error) => {
        assert.equal(error.message.includes(secretMarker), false);
        return true;
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(client.calls.length, 3);
  assert.equal(logs.length, 2);
  assert.equal(logs.join(" ").includes(secretMarker), false);
});

test("upsert nao repete erro permanente", async () => {
  const row = { external_id: "attendant-1", payload: {} };
  const permanent = fakeSupabase([{ error: { status: 400 } }]);
  await assert.rejects(
    upsertRows({
      table: "raw_cs_avaliacao_atendimento",
      rows: [row],
      client: permanent,
      maxAttempts: 4,
      baseMs: 1,
      maxMs: 1,
    }),
  );
  assert.equal(permanent.calls.length, 1);

});

test("classificacao Supabase cobre rede, 408, 429 e todos os 5xx", () => {
  assert.equal(retryableSupabaseError({ code: "ECONNRESET" }), true);
  assert.equal(retryableSupabaseError({ status: 408 }), true);
  assert.equal(retryableSupabaseError({ status: 429 }), true);
  assert.equal(retryableSupabaseError({ status: 599 }), true);
  assert.equal(retryableSupabaseError({ status: 400 }), false);
});
