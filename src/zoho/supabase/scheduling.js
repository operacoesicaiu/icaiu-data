const runZohoSchedulingSync = require('./scheduling-sync');
const formatPublicError = require('../../lib/public-error');
const { atTime, startOfMonth, today: saoPauloToday } = require('../../lib/sao-paulo-date');

function schedulingDateRange(now = new Date()) {
  const today = saoPauloToday(now);
  return {
    startDate: atTime(startOfMonth(today, -1)),
    endDate: atTime(today, 23, 59, 59, 999),
  };
}

async function run(now = new Date()) {
  try {
    const { startDate, endDate } = schedulingDateRange(now);
    await runZohoSchedulingSync({ startDate, endDate, label: 'mês atual + mês anterior' });
  } catch (e) {
    console.error('[events_agendamento] Erro:', formatPublicError(e));
    process.exit(1);
  }
}

module.exports = run;
module.exports.schedulingDateRange = schedulingDateRange;
if (require.main === module) run();
