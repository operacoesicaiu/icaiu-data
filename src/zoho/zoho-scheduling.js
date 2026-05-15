const runZohoSchedulingSync = require('./zoho-scheduling-sync');
const formatPublicError = require('../lib/public-error');

async function run() {
  try {
    const today = new Date();
    const startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1, 0, 0, 0, 0);
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
    await runZohoSchedulingSync({ startDate, endDate, label: 'mês atual + mês anterior' });
  } catch (e) {
    console.error('[events_agendamento] Erro:', formatPublicError(e));
    process.exit(1);
  }
}

module.exports = run;