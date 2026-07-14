const test = require('node:test');
const assert = require('node:assert/strict');

const { validateFaturamentoHeader } = require('../src/sige/sheets/sync');

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
