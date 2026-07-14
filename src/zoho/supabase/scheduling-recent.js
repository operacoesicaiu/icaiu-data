const runZohoSchedulingSync = require('./scheduling-sync');
const formatPublicError = require('../../lib/public-error');
const { addDays, atTime, today: saoPauloToday } = require('../../lib/sao-paulo-date');

function recentSchedulingDateRange(now = new Date()) {
  const today = saoPauloToday(now);
  return {
    startDate: atTime(addDays(today, -6)),
    endDate: atTime(today, 23, 59, 59, 999),
  };
}

async function run(now = new Date()) {
  try {
    const { startDate, endDate } = recentSchedulingDateRange(now);
    await runZohoSchedulingSync({ startDate, endDate, label: 'últimos 7 dias' });
  } catch (e) {
    console.error('[events_agendamento] Erro:', formatPublicError(e));
    process.exit(1);
  }
}

module.exports = run;
module.exports.recentSchedulingDateRange = recentSchedulingDateRange;
if (require.main === module) run();
