-- Migrations das tabelas raw_ do projeto icaiu-data
-- Execute no SQL Editor do Supabase (Database > SQL Editor)

-- 1. Adiciona constraint UNIQUE em external_id (necessário para upsert ON CONFLICT)
--    Já executado. Mantido aqui apenas para referência histórica.
-- alter table raw_contact_hablla           add constraint raw_contact_hablla_external_id_key           unique (external_id);
-- alter table raw_events_hablla            add constraint raw_events_hablla_external_id_key            unique (external_id);
-- alter table raw_cs_avaliacao_atendimento add constraint raw_cs_avaliacao_atendimento_external_id_key unique (external_id);
-- alter table raw_contact_telefonia        add constraint raw_contact_telefonia_external_id_key        unique (external_id);
-- alter table raw_events_faturado          add constraint raw_events_faturado_external_id_key          unique (external_id);
-- alter table raw_contact_site             add constraint raw_contact_site_external_id_key             unique (external_id);
-- alter table raw_events_agendamento       add constraint raw_events_agendamento_external_id_key       unique (external_id);

-- 2. Concede permissão de leitura e escrita ao service_role
--    Necessário quando tabelas são criadas via SQL Editor (o grant não é aplicado automaticamente).
grant all on raw_contact_hablla          to service_role;
grant all on raw_events_hablla           to service_role;
grant all on raw_cs_avaliacao_atendimento to service_role;
grant all on raw_contact_telefonia       to service_role;
grant all on raw_events_faturado         to service_role;
grant all on raw_contact_site            to service_role;
grant all on raw_events_agendamento      to service_role;
