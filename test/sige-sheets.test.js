const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertNonEmptyWindowReplacement,
  cleanupGlobalDocumentDuplicates,
  dedupeDocumentRowsKeepLast,
  digitsToNumber,
  documentDeleteRequests,
  duplicateDocumentIndexes,
  formatarDataBR,
  formatarMesBR,
  resolveSigeWindow,
  validateFaturamentoHeader,
} = require('../src/sige/sheets/sync');

const NOW = new Date('2026-07-15T15:00:00Z');

test('SIGE formata dia e mes no calendario de Sao Paulo', () => {
  assert.equal(formatarDataBR('2026-08-01T01:30:00Z'), '31/07/2026');
  assert.equal(formatarMesBR('2026-08-01T01:30:00Z'), '07/2026');
  assert.equal(formatarDataBR('2026-08-01T01:30:00'), '01/08/2026');
  assert.equal(formatarMesBR('2026-08-01'), '08/2026');
});

test('SIGE usa cinco dias concluidos por padrao e aceita janela explicita prioritaria', () => {
  const standard = resolveSigeWindow({}, NOW);
  assert.equal(standard.explicit, false);
  assert.equal(standard.days, 5);
  assert.equal(standard.startDate.toISOString().slice(0, 10), '2026-07-10');
  assert.equal(standard.endDate.toISOString().slice(0, 10), '2026-07-14');

  const explicit = resolveSigeWindow({
    SIGE_SHEETS_DAYS: '1',
    SIGE_SHEETS_START_DATE: '2026-07-01',
    SIGE_SHEETS_END_DATE: '2026-07-14',
  }, NOW);
  assert.equal(explicit.explicit, true);
  assert.equal(explicit.days, 14);
  assert.equal(explicit.startDate.toISOString().slice(0, 10), '2026-07-01');
  assert.equal(explicit.endDate.toISOString().slice(0, 10), '2026-07-14');
});

test('SIGE rejeita janela incompleta, invertida ou que alcance hoje', () => {
  assert.throws(
    () => resolveSigeWindow({ SIGE_SHEETS_START_DATE: '2026-07-01' }, NOW),
    /devem ser informadas juntas/,
  );
  assert.throws(
    () => resolveSigeWindow({
      SIGE_SHEETS_START_DATE: '2026-07-14',
      SIGE_SHEETS_END_DATE: '2026-07-01',
    }, NOW),
    /invertida/,
  );
  assert.throws(
    () => resolveSigeWindow({
      SIGE_SHEETS_START_DATE: '2026-07-01',
      SIGE_SHEETS_END_DATE: '2026-07-15',
    }, NOW),
    /anterior a hoje/,
  );
});

test('SIGE protege janela existente contra resposta vazia salvo override explicito', () => {
  const options = {
    incomingCount: 0,
    existingValues: [['01/07/2026'], ['30/06/2026']],
    startDate: new Date('2026-07-01T00:00:00Z'),
    endDate: new Date('2026-07-14T00:00:00Z'),
    allowEmpty: false,
  };
  assert.throws(
    () => assertNonEmptyWindowReplacement(options),
    /substituicao cancelada/,
  );
  assert.doesNotThrow(() =>
    assertNonEmptyWindowReplacement({ ...options, allowEmpty: true }),
  );
  assert.doesNotThrow(() =>
    assertNonEmptyWindowReplacement({
      ...options,
      existingValues: [['30/06/2026']],
    }),
  );
});

test('identificadores numericos SIGE preservam o tipo historico sem apostrofo', () => {
  assert.equal(digitsToNumber('01234567890'), 1234567890);
  assert.equal(digitsToNumber('12.345.678/0001-90'), '12.345.678/0001-90');
  assert.throws(
    () => digitsToNumber('9999999999999999'),
    /precisao segura/,
  );
});

const header = [
  'Contato',
  'Código',
  'Status Venda',
  'Data',
  'Nome Cliente',
  'Telefone Cliente',
  'E-mail Cliente',
  'Valor Venda',
  'Local Técnico',
  'Nº Documento',
  'CPF/CNPJ Cliente',
  'Dia agendado novos serviços',
  'Colaborador',
  'Valor de venda do novo serviço',
  'Dia agendado retirada',
  'Responsável pela venda Retirada',
  'Valor de venda da retirada',
  'Mês',
];

test('aceita o contrato real de 18 colunas da aba Faturamento', () => {
  assert.doesNotThrow(() => validateFaturamentoHeader(header));
});

test('rejeita planilha errada mesmo que tenha 18 colunas', () => {
  const invalid = [...header];
  [invalid[3], invalid[10]] = [invalid[10], invalid[3]];
  assert.throws(() => validateFaturamentoHeader(invalid), /Ordem das colunas/);
});

test('rejeita reordenação em qualquer uma das 18 colunas', () => {
  const invalid = [...header];
  [invalid[5], invalid[6]] = [invalid[6], invalid[5]];
  assert.throws(() => validateFaturamentoHeader(invalid), /Ordem das colunas/);
});

function faturamentoRow(document, marker, values = {}) {
  const row = Array(18).fill('');
  row[9] = document;
  row[17] = marker;
  for (const [columnIndex, value] of Object.entries(values)) {
    row[Number(columnIndex)] = value;
  }
  return row;
}

function apiRow(row) {
  const result = [...row];
  while (result.at(-1) === '') result.pop();
  return result;
}

function applyDeleteRequests(state, requests) {
  for (const request of requests) {
    const range = request.deleteDimension.range;
    const dataStart = range.startIndex - 1;
    state.splice(dataStart, range.endIndex - range.startIndex);
  }
}

function createCleanupHarness(initialState, { beforeRead, onBatchUpdate } = {}) {
  const state = initialState.map((row) => [...row]);
  const batches = [];
  let reads = 0;

  const sheets = {
    async getValuesBatch(ranges, options) {
      assert.deepEqual(ranges, ['Faturamento!A2:R']);
      assert.deepEqual(options, {
        valueRenderOption: 'FORMULA',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });
      reads++;
      if (beforeRead) await beforeRead({ reads, state });
      return [state.map(apiRow)];
    },
    async getSheetIdByTitle() {
      return { Faturamento: 73 };
    },
    async batchUpdate(requests, options) {
      assert.deepEqual(options, { idempotent: false });
      batches.push(requests);
      if (onBatchUpdate) {
        return onBatchUpdate({ requests, state });
      }
      applyDeleteRequests(state, requests);
      return { ok: true };
    },
  };

  return { batches, sheets, state };
}

test('deduplica a coleta mantendo a ultima ocorrencia e a ordem historica', () => {
  const firstA = faturamentoRow('Pedido A', 'A-antigo');
  const onlyB = faturamentoRow('Pedido B', 'B');
  const lastA = faturamentoRow('Pedido A', 'A-recente');

  assert.deepEqual(
    dedupeDocumentRowsKeepLast([firstA, onlyB, lastA]),
    [onlyB, lastA],
  );
});

test('calcula duplicados pela coluna J mantendo a ultima ocorrencia nao vazia', () => {
  assert.deepEqual(
    duplicateDocumentIndexes([
      'Pedido A',
      'Pedido B',
      'Pedido A',
      '',
      'Pedido B',
      'Pedido A',
    ]),
    [0, 1, 2],
  );
});

test('gera somente exclusoes agrupadas e ordenadas de baixo para cima', () => {
  assert.deepEqual(documentDeleteRequests(73, [0, 1, 4]), [
    {
      deleteDimension: {
        range: {
          sheetId: 73,
          dimension: 'ROWS',
          startIndex: 5,
          endIndex: 6,
        },
      },
    },
    {
      deleteDimension: {
        range: {
          sheetId: 73,
          dimension: 'ROWS',
          startIndex: 1,
          endIndex: 3,
        },
      },
    },
  ]);
});

test('limpeza global exclui somente anteriores e preserva fisicamente as ultimas linhas', async () => {
  const harness = createCleanupHarness([
    faturamentoRow('Pedido A', 'A-antigo', { 0: 'contato antigo', 3: 45600 }),
    faturamentoRow('', 'sem-documento-1'),
    faturamentoRow('Pedido X', 'X'),
    faturamentoRow('Pedido A', 'A-novo', {
      0: 'contato novo',
      3: '=DATE(2026,7,14)',
      16: 125.5,
    }),
    faturamentoRow('Pedido B', 'B-antigo'),
    faturamentoRow('', 'sem-documento-2'),
    faturamentoRow('Pedido B', 'B-novo'),
  ]);

  const retainedA = harness.state[3];
  const retainedB = harness.state[6];
  const result = await cleanupGlobalDocumentDuplicates(harness.sheets);

  assert.deepEqual(result, {
    previous: 7,
    removed: 2,
    final: 5,
    recoveredAmbiguousWrite: false,
  });
  assert.equal(harness.batches.length, 1);
  assert.ok(
    harness.batches[0].every(
      (request) => Object.keys(request).length === 1 && request.deleteDimension,
    ),
  );
  assert.equal(harness.state.includes(retainedA), true);
  assert.equal(harness.state.includes(retainedB), true);
  assert.deepEqual(
    harness.state.map((row) => row[17]),
    ['sem-documento-1', 'X', 'A-novo', 'sem-documento-2', 'B-novo'],
  );
  assert.deepEqual(
    retainedA,
    faturamentoRow('Pedido A', 'A-novo', {
      0: 'contato novo',
      3: '=DATE(2026,7,14)',
      16: 125.5,
    }),
  );
});

test('rejeita excluir a ultima duplicata quando J coincide mas a linha completa difere', async () => {
  const previous = faturamentoRow('Pedido A', '', {
    0: 'conteudo anterior',
    3: '=DATE(2026,7,13)',
  });
  const latest = faturamentoRow('Pedido A', '', {
    0: 'conteudo mais recente',
    3: '=DATE(2026,7,14)',
  });
  assert.equal(apiRow(previous).length, 10);
  assert.equal(apiRow(latest).length, 10);

  const harness = createCleanupHarness([previous, latest], {
    onBatchUpdate: ({ state }) => {
      // Simula a ocorrencia errada sendo removida: a coluna J final ainda seria igual.
      state.splice(1, 1);
      return { ok: true };
    },
  });

  await assert.rejects(
    () => cleanupGlobalDocumentDuplicates(harness.sheets),
    /Validacao da deduplicacao global/,
  );
  assert.deepEqual(harness.state, [previous]);
});

test('aborta antes da escrita se qualquer celula mudar entre as leituras', async () => {
  const harness = createCleanupHarness(
    [
      faturamentoRow('Pedido A', 'antigo', { 0: 'valor inicial' }),
      faturamentoRow('Pedido A', 'novo', { 0: 'valor mantido' }),
    ],
    {
      beforeRead: ({ reads, state }) => {
        if (reads === 2) state[0][0] = 'alteracao concorrente';
      },
    },
  );

  await assert.rejects(
    () => cleanupGlobalDocumentDuplicates(harness.sheets),
    /mudou antes da deduplicacao global/,
  );
  assert.equal(harness.batches.length, 0);
});

test('rejeita alteracao concorrente na linha preservada durante a pos-validacao', async () => {
  const harness = createCleanupHarness(
    [
      faturamentoRow('Pedido A', 'antigo'),
      faturamentoRow('Pedido A', 'novo', { 0: 'valor esperado' }),
    ],
    {
      onBatchUpdate: ({ requests, state }) => {
        applyDeleteRequests(state, requests);
        state[0][0] = 'alteracao concorrente';
        return { ok: true };
      },
    },
  );

  await assert.rejects(
    () => cleanupGlobalDocumentDuplicates(harness.sheets),
    /Validacao da deduplicacao global/,
  );
});

test('aceita resposta ambigua somente se a pos-validacao confirmar as exclusoes', async () => {
  const harness = createCleanupHarness(
    [
      faturamentoRow('Pedido A', 'antigo'),
      faturamentoRow('Pedido X', 'preservar'),
      faturamentoRow('Pedido A', 'novo-anexado'),
    ],
    {
      onBatchUpdate: ({ requests, state }) => {
        applyDeleteRequests(state, requests);
        throw new Error('resposta perdida');
      },
    },
  );

  const result = await cleanupGlobalDocumentDuplicates(harness.sheets);
  assert.equal(result.recoveredAmbiguousWrite, true);
  assert.deepEqual(
    harness.state.map((row) => row[17]),
    ['preservar', 'novo-anexado'],
  );
});

test('propaga a falha ambigua quando a exclusao nao foi aplicada', async () => {
  const error = new Error('timeout sem escrita');
  const harness = createCleanupHarness(
    [
      faturamentoRow('Pedido A', 'antigo'),
      faturamentoRow('Pedido A', 'novo'),
    ],
    {
      onBatchUpdate: () => {
        throw error;
      },
    },
  );

  await assert.rejects(
    () => cleanupGlobalDocumentDuplicates(harness.sheets),
    (received) => received === error,
  );
});

test('falha se a API responder sucesso mas o estado final nao coincidir', async () => {
  const harness = createCleanupHarness(
    [
      faturamentoRow('Pedido A', 'antigo'),
      faturamentoRow('Pedido A', 'novo'),
    ],
    { onBatchUpdate: () => ({ ok: true }) },
  );

  await assert.rejects(
    () => cleanupGlobalDocumentDuplicates(harness.sheets),
    /Validacao da deduplicacao global/,
  );
});
