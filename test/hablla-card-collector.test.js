const test = require("node:test");
const assert = require("node:assert/strict");

const collectHabllaCards = require("../src/hablla/card-collector");

const CUTOFF = "2026-07-07T00:00:00.000Z";

function card(id, updatedAt, createdAt = updatedAt) {
  return { id, created_at: createdAt, updated_at: updatedAt };
}

function fakeHablla(pages) {
  const calls = [];
  return {
    calls,
    async get(path, options) {
      calls.push({ options, path });
      const page = options.params.page;
      if (page > pages.length) {
        throw new Error(`Teste solicitou pagina inesperada: ${page}`);
      }
      return { data: { results: pages[page - 1] } };
    },
  };
}

function collect(hablla, overrides = {}) {
  return collectHabllaCards({
    hablla,
    workspaceId: "workspace-test",
    boardId: "board-test",
    cutoff: CUTOFF,
    pageSize: 2,
    maxPages: 10,
    ...overrides,
  });
}

test("uma pagina sem created_at recente nao encerra a busca", async () => {
  const hablla = fakeHablla([
    [
      card("old-1", "2026-07-10T12:00:00.000Z", "2026-06-01T12:00:00.000Z"),
      card("old-2", "2026-07-09T12:00:00.000Z", "2026-06-02T12:00:00.000Z"),
    ],
    [
      card("recent-1", "2026-07-08T12:00:00.000Z"),
      card("recent-2", "2026-07-07T12:00:00.000Z"),
    ],
    [],
  ]);

  const cards = await collect(hablla);

  assert.deepEqual(cards.map(({ id }) => id), ["recent-1", "recent-2"]);
  assert.equal(hablla.calls.length, 3);
  for (const { options, path } of hablla.calls) {
    assert.equal(path, "/v3/workspaces/workspace-test/cards");
    assert.equal(options.params.order, "updated_at");
    assert.equal(options.params.direction, "desc");
    assert.equal(options.params.updated_after, CUTOFF);
  }
});

test("duas paginas consecutivas sem created_at recente encerram a busca", async () => {
  const hablla = fakeHablla([
    [
      card("recent-1", "2026-07-10T12:00:00.000Z"),
      card("recent-2", "2026-07-09T12:00:00.000Z"),
    ],
    [
      card("old-1", "2026-07-08T12:00:00.000Z", "2026-06-01T12:00:00.000Z"),
      card("old-2", "2026-07-08T11:00:00.000Z", "2026-06-02T12:00:00.000Z"),
    ],
    [
      card("old-3", "2026-07-08T10:00:00.000Z", "2026-06-03T12:00:00.000Z"),
      card("old-4", "2026-07-08T09:00:00.000Z", "2026-06-04T12:00:00.000Z"),
    ],
    [
      card("nao-deve-ser-lido-1", "2026-07-08T08:00:00.000Z"),
      card("nao-deve-ser-lido-2", "2026-07-08T07:00:00.000Z"),
    ],
  ]);

  const cards = await collect(hablla);

  assert.deepEqual(cards.map(({ id }) => id), ["recent-1", "recent-2"]);
  assert.equal(hablla.calls.length, 3);
});

test("pagina com created_at recente zera o contador consecutivo", async () => {
  const hablla = fakeHablla([
    [
      card("old-1", "2026-07-12T12:00:00.000Z", "2026-06-01T12:00:00.000Z"),
      card("old-2", "2026-07-12T11:00:00.000Z", "2026-06-02T12:00:00.000Z"),
    ],
    [
      card("recent-1", "2026-07-12T10:00:00.000Z"),
      card("recent-2", "2026-07-12T09:00:00.000Z"),
    ],
    [
      card("old-3", "2026-07-12T08:00:00.000Z", "2026-06-03T12:00:00.000Z"),
      card("old-4", "2026-07-12T07:00:00.000Z", "2026-06-04T12:00:00.000Z"),
    ],
    [
      card("recent-3", "2026-07-12T06:00:00.000Z"),
      card("recent-4", "2026-07-12T05:00:00.000Z"),
    ],
    [
      card("old-5", "2026-07-12T04:00:00.000Z", "2026-06-05T12:00:00.000Z"),
      card("old-6", "2026-07-12T03:00:00.000Z", "2026-06-06T12:00:00.000Z"),
    ],
    [
      card("old-7", "2026-07-12T02:00:00.000Z", "2026-06-07T12:00:00.000Z"),
      card("old-8", "2026-07-12T01:00:00.000Z", "2026-06-08T12:00:00.000Z"),
    ],
  ]);

  const cards = await collect(hablla);

  assert.equal(hablla.calls.length, 6);
  assert.deepEqual(cards.map(({ id }) => id), [
    "recent-1",
    "recent-2",
    "recent-3",
    "recent-4",
  ]);
});

test("updated_at pagina a API, mas somente created_at define a janela", async () => {
  const hablla = fakeHablla([
    [
      card(
        "old-card-updated-now",
        "2026-07-10T12:00:00.000Z",
        "2026-06-01T12:00:00.000Z",
      ),
      card(
        "new-card",
        "2026-07-09T12:00:00.000Z",
        "2026-07-08T12:00:00.000Z",
      ),
    ],
    [card("old-1", "2026-07-08T12:00:00.000Z", "2026-06-02T12:00:00.000Z")],
  ]);

  const cards = await collect(hablla);

  assert.deepEqual(cards.map(({ id }) => id), ["new-card"]);
  assert.equal(hablla.calls.length, 2);
});

test("cards exigem id, created_at e updated_at coerentes", async () => {
  await assert.rejects(
    collect(fakeHablla([[card("", "2026-07-10T00:00:00.000Z")]])),
    /sem id valido/,
  );
  await assert.rejects(
    collect(fakeHablla([[card("card-1", "data-invalida", CUTOFF)]])),
    /updated_at invalido/,
  );
  await assert.rejects(
    collect(fakeHablla([[{ id: "card-1", updated_at: "2026-07-10T00:00:00.000Z" }]])),
    /sem created_at/,
  );
  await assert.rejects(
    collect(fakeHablla([[
      card(
        "card-1",
        "2026-07-09T00:00:00.000Z",
        "2026-07-10T00:00:00.000Z",
      ),
    ]])),
    /created_at posterior a updated_at/,
  );
});

test("fingerprint impede loop de pagina repetida", async () => {
  const repeated = [
    card("card-1", "2026-07-10T00:00:00.000Z"),
    card("card-2", "2026-07-09T00:00:00.000Z"),
  ];
  const hablla = fakeHablla([repeated, repeated]);

  await assert.rejects(collect(hablla), /repetiu uma pagina/);
  assert.equal(hablla.calls.length, 2);
});

test("fallback desordenado respeita o teto de paginas", async () => {
  const hablla = fakeHablla([
    [
      card("recent-1", "2026-07-09T00:00:00.000Z"),
      card("recent-2", "2026-07-10T00:00:00.000Z"),
    ],
    [
      card("old-1", "2026-07-06T00:00:00.000Z"),
      card("old-2", "2026-07-05T00:00:00.000Z"),
    ],
  ]);

  await assert.rejects(
    collect(hablla, { maxPages: 2 }),
    /limite seguro de 2 paginas/,
  );
  assert.equal(hablla.calls.length, 2);
});

test("limite padrao permanece em 2000 paginas", () => {
  assert.equal(collectHabllaCards.DEFAULT_MAX_PAGES, 2000);
  assert.equal(collectHabllaCards.DEFAULT_PAGES_WITHOUT_RECENT_CREATED, 2);
});
