const assert = require("node:assert/strict");
const test = require("node:test");

const {
  attendantExternalId,
  buildAttendantRows,
  reconcileAttendantRows,
} = require("../src/hablla/attendant-rows");

function fakeSupabase(initialIds, failures = {}) {
  const state = new Set(initialIds);
  const events = [];

  return {
    events,
    state,
    from(table) {
      assert.equal(table, "raw_cs_avaliacao_atendimento");
      const query = {
        prefix: "",
        select(column) {
          assert.equal(column, "external_id");
          return this;
        },
        like(column, pattern) {
          assert.equal(column, "external_id");
          this.prefix = pattern.replace(/%$/, "");
          return this;
        },
        order(column) {
          assert.equal(column, "external_id");
          return this;
        },
        async range(from, to) {
          events.push("read");
          if (failures.read) {
            return {
              data: null,
              error: { code: "PGRST503", status: 503 },
              status: 503,
            };
          }
          const ids = [...state]
            .filter((id) => id.startsWith(this.prefix))
            .sort()
            .slice(from, to + 1);
          return {
            data: ids.map((external_id) => ({ external_id })),
            error: null,
            status: 200,
          };
        },
        delete() {
          return this;
        },
        async in(column, ids) {
          assert.equal(column, "external_id");
          events.push("delete");
          if (failures.delete) {
            return {
              data: null,
              error: { code: "PGRST500", status: 500 },
              status: 500,
            };
          }
          ids.forEach((id) => state.delete(id));
          return { data: null, error: null, status: 204 };
        },
      };
      return query;
    },
  };
}

function upsertInto(client, { fail = false } = {}) {
  return async ({ table, rows, onConflict }) => {
    assert.equal(table, "raw_cs_avaliacao_atendimento");
    assert.equal(onConflict, "external_id");
    client.events.push("upsert");
    if (fail) throw new Error("upsert failed");
    rows.forEach((row) => client.state.add(row.external_id));
  };
}

test("identidade composta preserva setor, usuario e conexao sem expor valores", () => {
  const first = {
    user: { id: "user-secret", email: "person@example.test" },
    sector: { id: "sector-secret" },
    connection: { id: "connection-a" },
    total_services: 1,
  };
  const updated = { ...first, total_services: 2 };
  const otherConnection = {
    ...first,
    connection: { id: "connection-b" },
  };

  const rows = buildAttendantRows("2026-07-13", [
    first,
    updated,
    otherConnection,
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].payload, updated);
  for (const row of rows) {
    assert.match(
      row.external_id,
      /^attendant-2026-07-13-v2-[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(
      row.external_id,
      /user-secret|sector-secret|connection|person@example/,
    );
  }
});

test("fallback canonico e deterministico conserva somente payloads identicos", () => {
  const first = {
    total_services: 3,
    sector: { name: "Setor sensivel" },
    connection: { id: "connection-secret" },
  };
  const reordered = {
    connection: { id: "connection-secret" },
    sector: { name: "Setor sensivel" },
    total_services: 3,
  };
  const changed = { ...first, total_services: 4 };

  assert.equal(
    attendantExternalId("2026-07-13", first),
    attendantExternalId("2026-07-13", reordered),
  );
  assert.notEqual(
    attendantExternalId("2026-07-13", first),
    attendantExternalId("2026-07-13", changed),
  );
  assert.equal(buildAttendantRows("2026-07-13", [first, reordered]).length, 1);
  assert.doesNotMatch(attendantExternalId("2026-07-13", first), /Setor|secret/);
});

test("reconciliacao faz upsert antes e remove apenas legado ou atual obsoleto", async () => {
  const day = "2026-07-13";
  const rows = buildAttendantRows(day, [
    {
      user: { id: "u1" },
      sector: { id: "s1" },
      connection: { id: "c1" },
    },
  ]);
  const currentId = rows[0].external_id;
  const legacyId = `attendant-${day}-u1`;
  const staleV2 = `attendant-${day}-v2-${"f".repeat(64)}`;
  const unrelated = "attendant-2026-07-12-old";
  const client = fakeSupabase([legacyId, staleV2, currentId, unrelated]);

  const result = await reconcileAttendantRows({
    client,
    rowsByDay: new Map([[day, rows]]),
    upsertRows: upsertInto(client),
    options: { maxAttempts: 1 },
  });

  assert.deepEqual(result, { deleted: 2, upserted: 1 });
  assert.deepEqual(client.events, ["read", "upsert", "delete"]);
  assert.equal(client.state.has(currentId), true);
  assert.equal(client.state.has(legacyId), false);
  assert.equal(client.state.has(staleV2), false);
  assert.equal(client.state.has(unrelated), true);
});

test("falha de leitura impede qualquer escrita", async () => {
  const day = "2026-07-13";
  const rows = buildAttendantRows(day, [
    { user: { id: "u" }, sector: { id: "s" }, connection: { id: "c" } },
  ]);
  const client = fakeSupabase([], { read: true });

  await assert.rejects(
    reconcileAttendantRows({
      client,
      rowsByDay: new Map([[day, rows]]),
      upsertRows: upsertInto(client),
      options: { maxAttempts: 1 },
    }),
  );
  assert.deepEqual(client.events, ["read"]);
});

test("falha de upsert impede a exclusao de IDs legados", async () => {
  const day = "2026-07-13";
  const legacyId = `attendant-${day}-legacy`;
  const rows = buildAttendantRows(day, [
    { user: { id: "u" }, sector: { id: "s" }, connection: { id: "c" } },
  ]);
  const client = fakeSupabase([legacyId]);

  await assert.rejects(
    reconcileAttendantRows({
      client,
      rowsByDay: new Map([[day, rows]]),
      upsertRows: upsertInto(client, { fail: true }),
      options: { maxAttempts: 1 },
    }),
    /upsert failed/,
  );
  assert.deepEqual(client.events, ["read", "upsert"]);
  assert.equal(client.state.has(legacyId), true);
});

test("falha de delete falha a reconciliacao e preserva registros atuais", async () => {
  const day = "2026-07-13";
  const legacyId = `attendant-${day}-legacy`;
  const rows = buildAttendantRows(day, [
    { user: { id: "u" }, sector: { id: "s" }, connection: { id: "c" } },
  ]);
  const client = fakeSupabase([legacyId], { delete: true });

  await assert.rejects(
    reconcileAttendantRows({
      client,
      rowsByDay: new Map([[day, rows]]),
      upsertRows: upsertInto(client),
      options: { maxAttempts: 1 },
    }),
  );
  assert.deepEqual(client.events, ["read", "upsert", "delete"]);
  assert.equal(client.state.has(rows[0].external_id), true);
  assert.equal(client.state.has(legacyId), true);
});
