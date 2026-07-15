const test = require('node:test');
const assert = require('node:assert/strict');

const { uniqueAttendantRows } = require('../src/hablla/sheets/sync');
const {
  CARD_HEADERS,
  CLIENT_HEADERS,
  assertEmptyAttendantDaysAreSafe,
  booleanOption,
  clientRow,
  collectCardSnapshots,
  columnLetter,
  completedDayRanges,
  formatCustomFieldValue,
  selectedDatasets,
  shouldReplaceCardRow,
} = require('../src/hablla/sheets/sync')._internals;

function row({ date = '13/07/2026', sector = 'sector', user = 'user', connection = 'connection', total = 1 }) {
  const values = Array(17).fill('');
  values[0] = date;
  values[2] = sector;
  values[4] = user;
  values[7] = total;
  values[10] = connection;
  return values;
}

test('atendentes repetidos conservam somente a leitura mais recente', () => {
  const result = uniqueAttendantRows([row({ total: 1 }), row({ total: 2 })]);
  assert.equal(result.length, 1);
  assert.equal(result[0][7], 2);
});

test('linha sem identidade estável só é removida quando é cópia exata', () => {
  const first = row({ user: '', total: 1 });
  const changed = row({ user: '', total: 2 });
  assert.equal(uniqueAttendantRows([first, changed, [...changed]]).length, 2);
});

test('dia vazio de atendentes nunca remove linhas que ja existem', () => {
  assert.doesNotThrow(() =>
    assertEmptyAttendantDaysAreSafe(['12/07/2026'], [['11/07/2026']]),
  );
  assert.throws(
    () => assertEmptyAttendantDaysAreSafe(['12/07/2026'], [['12/07/2026']]),
    /1 dias que ja possuem linhas/,
  );
});

test('janela de cards usa created_at e preserva a coluna Telefone', () => {
  const cutoff = '2026-07-07';
  const oldCreatedRecentlyUpdated = Array(19).fill('');
  oldCreatedRecentlyUpdated[0] = '14/07/2026 10:00:00';
  oldCreatedRecentlyUpdated[1] = '01/06/2026 10:00:00';
  oldCreatedRecentlyUpdated[14] = 'old-card';

  const recentlyCreated = [...oldCreatedRecentlyUpdated];
  recentlyCreated[0] = '01/06/2026 10:00:00';
  recentlyCreated[1] = '14/07/2026 10:00:00';
  recentlyCreated[14] = 'new-card';

  assert.equal(CARD_HEADERS.length, 19);
  assert.equal(CARD_HEADERS[18], 'Telefone');
  assert.equal(
    shouldReplaceCardRow(oldCreatedRecentlyUpdated, new Set(), cutoff),
    false,
  );
  assert.equal(shouldReplaceCardRow(recentlyCreated, new Set(), cutoff), true);
  assert.equal(
    shouldReplaceCardRow(oldCreatedRecentlyUpdated, new Set(['old-card']), cutoff),
    true,
  );
  assert.equal(
    shouldReplaceCardRow(recentlyCreated, new Set(), cutoff, {
      preserveUnfetched: true,
    }),
    false,
  );
});

test('opcoes do backfill sao estritas e a coluna acompanha o schema', () => {
  assert.equal(booleanOption('sim', false, 'FLAG'), true);
  assert.equal(booleanOption('false', true, 'FLAG'), false);
  assert.throws(() => booleanOption('talvez', false, 'FLAG'), /true ou false/);
  assert.deepEqual([...selectedDatasets('cards,clients')], ['cards', 'clients']);
  assert.throws(() => selectedDatasets('cards,unknown'), /cards, attendants e clients/);
  assert.equal(columnLetter(18), 'S');
  assert.equal(columnLetter(77), 'BZ');
  const ranges = completedDayRanges(3);
  assert.equal(ranges.length, 3);
  assert.ok(ranges[0].day < ranges[1].day);
  assert.ok(ranges[1].day < ranges[2].day);
  assert.equal(ranges.every(({ start, end }) => start < end), true);
});

test('coletas repetidas fazem retry e conservam a versao mais recente por ID', async () => {
  let call = 0;
  const waits = [];
  const collect = async () => {
    call += 1;
    if (call === 1) throw new Error('pagina mudou durante a coleta');
    if (call === 2) {
      return [
        { id: 'card-1', updated_at: '2026-07-14T10:00:00.000Z' },
        { id: 'card-2', updated_at: '2026-07-14T11:00:00.000Z' },
      ];
    }
    return [
      { id: 'card-1', updated_at: '2026-07-14T12:00:00.000Z', status: 'novo' },
    ];
  };

  const cards = await collectCardSnapshots({
    hablla: {},
    workspaceId: 'workspace',
    boardId: 'board',
    cutoff: '2026-04-15T03:00:00.000Z',
    exhaustive: true,
    passes: 2,
    attempts: 2,
    collect,
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  assert.equal(call, 3);
  assert.equal(waits.length, 1);
  assert.equal(cards.length, 2);
  assert.equal(cards.find(({ id }) => id === 'card-1').status, 'novo');
});

test('Base Cliente conserva contrato histórico de 17 colunas', () => {
  const person = {
    id: 'client-1',
    description: 'Descrição histórica',
    phones: [{ phone: '+5511999999999', is_whatsapp: true }],
    custom_fields: [
      { custom_field: '6887db7cc2a3a46cebf75ea7', value: false },
      { custom_field: '67e6d5b88d506fc6c09408f9', value: "'+5511888888888" },
    ],
  };
  const result = clientRow(person);

  assert.equal(CLIENT_HEADERS.length, 17);
  assert.equal(result.length, 17);
  assert.equal(result[9], 'Não');
  assert.equal(result[2], '5511999999999');
  assert.equal(result[13], '5511888888888');
  assert.match(result[15], /description: Descrição histórica/);
  assert.equal(formatCustomFieldValue(false), 'Não');
});
