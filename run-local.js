/**
 * Runner local para testar as integrações
 * Uso: node run-local.js [nome-do-script]
 *
 * Exemplos:
 *   node run-local.js                     → roda todos
 *   node run-local.js telefonia           → só telefonia
 *   node run-local.js hablla-attendants   → só hablla attendants
 *   node run-local.js hablla-card-person-link-diagnostic
 *   node run-local.js hablla-cards
 *   node run-local.js hablla-clients
 *   node run-local.js zoho-leads-recent
 *   node run-local.js zoho-scheduling-recent
 *   node run-local.js site
 *   node run-local.js agendamento
 *   node run-local.js faturado
 */

require('dotenv').config();

const scripts = {
  telefonia:        require('./src/zenvia/zenvia-calls'),
  'hablla-attendants': require('./src/hablla/hablla-attendants'),
  'hablla-card-person-link-diagnostic': require('./src/hablla/hablla-card-person-link-diagnostic'),
  'hablla-cards':   require('./src/hablla/hablla-cards'),
  'hablla-clients': require('./src/hablla/hablla-clients'),
  'zoho-leads-recent': require('./src/zoho/zoho-leads-recent'),
  'zoho-scheduling-recent': require('./src/zoho/zoho-scheduling-recent'),
  site:             require('./src/zoho/zoho-leads'),
  agendamento:      require('./src/zoho/zoho-scheduling'),
  faturado:         require('./src/sige/sige-faturamento')
};

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    for (const [name, fn] of Object.entries(scripts)) {
      console.log(`\n========== ${name} ==========`);
      await fn();
    }
  } else {
    for (const arg of args) {
      const fn = scripts[arg];
      if (!fn) {
        console.error(`Script desconhecido: "${arg}". Opções: ${Object.keys(scripts).join(', ')}`);
        process.exit(1);
      }
      console.log(`\n========== ${arg} ==========`);
      await fn();
    }
  }

  console.log('\nTodos os scripts finalizados.');
}

main().catch(err => {
  console.error('Erro no runner:', err);
  process.exit(1);
});
