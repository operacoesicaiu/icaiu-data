const runZohoSchedulingSync = require('./zoho-scheduling-sync');

async function run() {
  try {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 6);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);

    await runZohoSchedulingSync({ startDate, endDate, label: 'últimos 7 dias' });
  } catch (e) {
    console.error('[events_agendamento] Erro:', e.response?.data || e.message);
    process.exit(1);
  }
}

module.exports = run;
