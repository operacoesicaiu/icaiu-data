-- Adiciona constraint UNIQUE em external_id nas tabelas raw_ existentes
-- Necessário para o upsert ON CONFLICT funcionar corretamente
-- Execute no SQL Editor do Supabase (Database > SQL Editor)

alter table raw_contact_hablla          add constraint raw_contact_hablla_external_id_key          unique (external_id);
alter table raw_events_hablla           add constraint raw_events_hablla_external_id_key           unique (external_id);
alter table raw_cs_avaliacao_atendimento add constraint raw_cs_avaliacao_atendimento_external_id_key unique (external_id);
alter table raw_contact_telefonia       add constraint raw_contact_telefonia_external_id_key       unique (external_id);
alter table raw_events_faturado         add constraint raw_events_faturado_external_id_key         unique (external_id);
alter table raw_contact_site            add constraint raw_contact_site_external_id_key            unique (external_id);
alter table raw_events_agendamento      add constraint raw_events_agendamento_external_id_key      unique (external_id);
