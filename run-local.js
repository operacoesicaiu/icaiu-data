/**
 * Runner local para testar as integrações
 * Uso: node run-local.js [nome-do-script]
 *
 * Exemplos:
 *   node run-local.js                     → roda todos os coletores Supabase
 *   node run-local.js zenvia-calls        → roda um coletor específico
 *   node run-local.js hablla-cards
 *   node run-local.js zoho-leads-recent
 *   node run-local.js zoho-scheduling-recent
 *   node run-local.js sige-faturamento
 */

require('dotenv').config();
const formatPublicError = require('./src/lib/public-error');

const scripts = {
  'zenvia-calls': require('./src/zenvia/supabase/calls'),
  'hablla-attendants': require('./src/hablla/supabase/attendants'),
  'hablla-cards': require('./src/hablla/supabase/cards'),
  'hablla-clients': require('./src/hablla/supabase/clients'),
  'zoho-leads-recent': require('./src/zoho/supabase/leads-recent'),
  'zoho-scheduling-recent': require('./src/zoho/supabase/scheduling-recent'),
  'zoho-leads': require('./src/zoho/supabase/leads'),
  'zoho-scheduling': require('./src/zoho/supabase/scheduling'),
  'sige-faturamento': require('./src/sige/supabase/faturamento')
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
  console.error('Erro no runner:', formatPublicError(err));
  process.exit(1);
});
