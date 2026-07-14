const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';

const { isoDay, today } = require('../src/lib/sao-paulo-date');
const {
  formatZohoDay,
  leadsDateRange,
} = require('../src/zoho/supabase/leads-sync')._internals;
const scheduling = require('../src/zoho/supabase/scheduling');
const schedulingRecent = require('../src/zoho/supabase/scheduling-recent');
const { formatZohoDateTime } = require('../src/zoho/supabase/scheduling-sync');
const sige = require('../src/sige/supabase/faturamento');
const zenvia = require('../src/zenvia/supabase/calls');

test('dia de negocio de Sao Paulo nao avanca entre 01:xx e 02:xx UTC', () => {
  assert.equal(isoDay(today(new Date('2026-07-14T01:30:00.000Z'))), '2026-07-13');
  assert.equal(isoDay(today(new Date('2026-07-14T02:59:59.999Z'))), '2026-07-13');
  assert.equal(isoDay(today(new Date('2026-07-14T03:00:00.000Z'))), '2026-07-14');
});

test('Zoho Leads usa a janela BRT e preserva o formato do Creator', () => {
  const { startDate, endDate } = leadsDateRange(
    7,
    new Date('2026-07-14T01:30:00.000Z'),
  );
  assert.equal(isoDay(startDate), '2026-07-07');
  assert.equal(isoDay(endDate), '2026-07-13');
  assert.equal(formatZohoDay(startDate), '07-Jul-2026');
  assert.equal(formatZohoDay(endDate), '13-Jul-2026');
});

test('Zoho Scheduling usa limites de calendario BRT sem depender do TZ do runner', () => {
  const now = new Date('2026-07-14T01:30:00.000Z');
  const full = scheduling.schedulingDateRange(now);
  const recent = schedulingRecent.recentSchedulingDateRange(now);

  assert.equal(formatZohoDateTime(full.startDate), '01-Jun-2026 00:00:00');
  assert.equal(formatZohoDateTime(full.endDate), '13-Jul-2026 23:59:59');
  assert.equal(formatZohoDateTime(recent.startDate), '07-Jul-2026 00:00:00');
  assert.equal(formatZohoDateTime(recent.endDate), '13-Jul-2026 23:59:59');
});

test('Zenvia e SIGE Supabase usam o mesmo calendario BRT', () => {
  const now = new Date('2026-07-14T02:15:00.000Z');
  assert.deepEqual(zenvia.zenviaDateRange(now), {
    start: '2026-07-09',
    end: '2026-07-13',
  });
  const range = sige.sigeDateRange(now);
  assert.equal(isoDay(range.startDate), '2026-07-09');
  assert.equal(isoDay(range.endDate), '2026-07-13');
});
