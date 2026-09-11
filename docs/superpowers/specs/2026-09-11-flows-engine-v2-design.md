# Motor de Fluxos v2 + Verificação de Comprovativo + Vendas — Design

**Data:** 2026-09-11
**Estado:** Aprovado (brainstorming)
**Referência funcional:** blocos do Leona usados na conta "Grupo PVP" (fluxo `[CM GERAL - VERIFICADOR ENTREGAVEL]`).
Não há acesso ao código do Leona — as funcionalidades são reimplementadas a partir do comportamento dos blocos.

## 1. Objetivo

Permitir recriar no wacrm os fluxos de venda de produtos digitais que hoje correm no Leona:
pedir comprovativo → verificar com IA → registar venda → lembretes com esperas → saltar para downsell,
respeitando horário de funcionamento e distribuição de contactos.

### Dentro do âmbito
1. Aguardar resposta v2 (texto/imagem/documento + timeout com saída própria)
2. Intervalo inteligente (duração, até data/hora, janela semanal)
3. Condição v2 (múltiplas regras E/OU; etiqueta, variável, campo personalizado, campo do contacto, hora, dia da semana)
4. Verificar comprovativo (bloco dedicado)
5. Bloco de IA genérico
6. Alterar campo personalizado
7. Saltar para outro fluxo
8. Distribuidor (pesos em %)
9. Registar venda + catálogo de Produtos + Histórico de Vendas
10. Fuso horário por conta

### Fora do âmbito (sub-projetos futuros)
PIX, cobranças/pagamentos, mover card de pipeline em fluxo, notificação à equipa por WhatsApp,
estado do chat em fluxo, departamentos, HTTP, Pixel/CAPI, template Meta em fluxo, carrossel.

## 2. Modelo de dados — migração `042_flows_engine_v2.sql`

### `accounts`
- `timezone text NOT NULL DEFAULT 'Africa/Luanda'` — validado na app contra `Intl.supportedValuesOf('timeZone')`.

### `flow_runs`
- `resume_at timestamptz NULL` — quando o scheduler deve acordar o run.
- `wait_kind text NULL CHECK (wait_kind IN ('reply','interval'))`.
- Índice parcial: `(resume_at) WHERE status = 'active' AND resume_at IS NOT NULL`.
- RPC `claim_due_flow_runs(p_limit int)` (SECURITY DEFINER, apenas service role):
  seleciona runs ativos com `resume_at <= now()` via `FOR UPDATE SKIP LOCKED`, limpa `resume_at`
  e devolve `id, wait_kind, current_node_key` — dois ciclos nunca reclamam o mesmo run.

### `flow_nodes.node_type` CHECK
Acrescenta: `smart_interval`, `verify_receipt`, `ai_prompt`, `set_field`, `jump_flow`, `distributor`, `register_sale`.
`collect_input` e `condition` evoluem in-place (retrocompatíveis — ver §3).

### `products`
| coluna | tipo |
|---|---|
| id | uuid pk |
| account_id | uuid fk accounts, NOT NULL |
| name | text NOT NULL |
| currency | text NOT NULL (ISO-4217, validado por `src/lib/currency.ts`) |
| default_price | numeric(18,2) NULL |
| is_active | boolean NOT NULL DEFAULT true |
| created_at / updated_at | timestamptz |

Único `(account_id, lower(name))`.

### `sales`
| coluna | tipo |
|---|---|
| id | uuid pk |
| account_id | uuid NOT NULL |
| contact_id | uuid NULL fk contacts ON DELETE SET NULL |
| product_id | uuid NULL fk products ON DELETE SET NULL |
| amount | numeric(18,2) NOT NULL CHECK (amount >= 0) |
| currency | text NOT NULL |
| customer_name | text NULL |
| source | text NOT NULL CHECK (source IN ('flow','manual')) |
| flow_run_id | uuid NULL fk flow_runs ON DELETE SET NULL |
| receipt | jsonb NULL — dados extraídos + `message_id` do anexo |
| receipt_fingerprint | text NULL — hash normalizado para deteção de duplicados |
| created_by | uuid NULL |
| created_at | timestamptz |

Índice `(account_id, receipt_fingerprint) WHERE receipt_fingerprint IS NOT NULL`; índice `(account_id, created_at desc)`.

### `flow_distributor_counters`
`(flow_id, node_key, output_id)` pk, `count bigint`. RPC `pick_distributor_output(flow_id, node_key, outputs jsonb)`
escolhe e incrementa atomicamente a saída com menor `count/peso`.

### RLS
`products`, `sales`, `flow_distributor_counters` seguem o padrão de membros de conta das migrações 017–020
(membros leem; admin/owner escrevem produtos; qualquer membro regista venda manual; apagar venda só admin/owner).

## 3. Motor

### 3.1 Reestruturação
Decisão tomada no plano: o código existente de `engine.ts` não é movido (evita regressões). Cada bloco novo tem
a sua lógica num módulo puro e testável, e `engine.ts` fica só com um ramo fino que carrega dados e persiste:
- `engine.ts` — entrada (`dispatchInboundToFlows`, `resumeDueRun`), ciclo de avanço, persistência.
- `collect-input.ts`, `smart-interval.ts`, `condition-rules.ts`, `set-field.ts`, `jump.ts`, `distributor.ts`, `resume.ts` — decisões puras por bloco.
- `interpolate.ts` — `{{vars.a.b}}`, `{{contact.name}}`, `{{contact.phone}}`.
- `time.ts` — funções puras sobre fuso horário (janela semanal, "entre 22:00 e 08:00", próxima abertura).

Comportamento dos blocos existentes mantém-se byte-a-byte (os testes atuais continuam verdes).

### 3.2 Entrada de mensagens
`ParsedInbound` ganha `kind: 'media'` com `media_type ('image'|'document'|'audio'|'video')`, `message_id` interno,
`media_url` (URL durável espelhado pela migração 039, ou o proxy como fallback), `mime_type`, `caption`. O webhook passa a entregar media ao motor.
Mensagens media que chegam a um nó que não as aceita seguem a política de fallback atual.

### 3.3 Scheduler
- Serviço `scheduler` no `docker-compose.yml` (imagem `curlimages/curl`), loop de 60 s a chamar
  `GET /api/flows/cron` com `x-cron-secret: $AUTOMATION_CRON_SECRET`.
- O endpoint: (1) `claim_due_flow_runs(50)` → `resumeDueRun` para cada; (2) sweep de abandonados existente,
  agora a ignorar runs com `resume_at` definido.
- `resumeDueRun`: `wait_kind='reply'` → segue `timeout_next` (ou termina `timed_out`); `'interval'` → segue `next_node_key`.

### 3.4 Blocos

**Aguardar resposta v2 (`collect_input`)** — config nova opcional:
`accept: ('text'|'image'|'document')[]` (default `['text']`), `timeout?: {value, unit: 'minutes'|'hours'|'days'}`, `timeout_next?`.
Com `timeout`: grava `resume_at`, `wait_kind='reply'`. Resposta aceite limpa `resume_at`.
Media captada guarda em `vars[var_key]` `{ type, message_id, storage_path, mime_type, caption }`.

**Intervalo inteligente (`smart_interval`)**
`mode: 'duration' | 'until' | 'weekly_window'`; `duration {value, unit}`; `until` ISO local da conta;
`weekly_window { [dia]: {enabled, start 'HH:mm', end 'HH:mm'} }`; `next_node_key`.
Dentro da janela → segue imediatamente; `until` no passado → segue imediatamente.

**Condição v2 (`condition`)**
`match: 'all'|'any'`, `rules[]`, `true_next`, `false_next`. Tipos de regra:
- `tag` (`present|absent`, `tag_id`)
- `var` / `custom_field` / `contact_field` (`equals|not_equals|contains|present|absent|gt|lt`, `key`, `value`)
- `time` (`between`, `start`, `end` — atravessa meia-noite)
- `weekday` (`in`, `days[]`)
Config legada `{subject, subject_key, operator, value}` é normalizada para `rules:[…]`, `match:'all'` na leitura.

**Verificar comprovativo (`verify_receipt`)**
Config: `source_var`, `min_amount?`, `currency?`, `recipient_names?[]`, `recipient_ibans?[]`, `max_age_days?`,
`reject_duplicates` (default true), `field_mapping?` (campo personalizado por chave extraída),
`valid_next`, `invalid_next`, `error_next`.
Passos:
1. Resolve o anexo em `vars[source_var]`; descarrega do storage (limite 10 MB; imagem ou PDF). Texto também é aceite.
2. Chama o fornecedor da conta com prompt fixo (`src/lib/flows/receipt/prompt.ts`) e exige JSON:
   `{is_receipt, amount, currency, bank, date, payer_name, payer_doc, recipient_name, recipient_account, reference}`.
3. Parse tolerante (`receipt/parse.ts`): extrai o primeiro objeto JSON, normaliza valor ("1.500,00 Kz" → 1500.00).
4. Regras determinísticas (`receipt/rules.ts`, puro): não-comprovativo, abaixo do mínimo, moeda diferente,
   destinatário não corresponde, demasiado antigo, duplicado (fingerprint = hash de `reference` ou `amount|date|payer_name` normalizados, procurado em `sales`).
5. Grava `vars.comprovante = {…dados, valid, reason}` e aplica `field_mapping`.
6. Saída: `valid_next` | `invalid_next` (com `vars.comprovante.reason`) | `error_next` (sem config de IA, falha do fornecedor, ficheiro ilegível/grande demais).

**Bloco de IA (`ai_prompt`)**
Config: `system_prompt`, `user_message` (com variáveis), `image_var?`, `output: 'text'|'json'`,
`save_to_var`, `json_mapping?: {json_key → var_key}`, `success_next`, `error_next`.

**IA — alterações partilhadas**
- `ChatMessage.content` passa a `string | ContentPart[]` (`{type:'text'}` / `{type:'image', mimeType, base64}` / `{type:'document', mimeType:'application/pdf', base64}`); adaptadores OpenAI e Anthropic serializam para os formatos nativos; `mergeConsecutive` trata partes.
- Nova `generateRaw()` (sem sentinel de handoff) usada pelos blocos.
- Blocos usam `loadAiConfig(db, accountId, { requireActive: false })` — funcionam com a chave configurada mesmo com resposta automática desligada.
- Uso registado em `ai_usage_log` com `source` `flow_ai` / `flow_receipt`.

**Alterar campo (`set_field`)**
`custom_field_id`, `op: 'set'|'increment'|'decrement'|'clear'`, `value` (interpolado), `next_node_key`.
increment/decrement sobre valor não numérico → trata como 0 e regista aviso. Falha é não-fatal.

**Saltar para fluxo (`jump_flow`)**
`target_flow_id`, sem saídas. Termina o run atual (`completed`, `end_reason='jump'`), cria run no destino para o mesmo
contacto/conversa copiando `vars` e `vars.__jump_depth + 1`. Profundidade > 5 → `failed` `jump_depth_exceeded`.
Destino inativo/inexistente → `failed` `jump_target_unavailable`.

**Distribuidor (`distributor`)**
`outputs[]: {id, label, weight, next_node_key}` (soma dos pesos = 100). Usa `pick_distributor_output`.

**Registar venda (`register_sale`)**
`product_id`, `amount` (interpolado, default `default_price`), `currency?` (default do produto),
`customer_name?` (interpolado), `attach_receipt_var?` (default `comprovante`), `next_node_key`.
Insere em `sales` com `receipt` + `receipt_fingerprint`. Valor inválido/negativo ou erro de escrita → evento `error`, segue (não-fatal).

## 4. Interface

**Editor de fluxos** (`src/components/flows/`)
- Menu "adicionar bloco" por categorias: Mensagens · Lógica · CRM · IA · Vendas.
- Handles múltiplos no canvas por bloco (verdadeiro/falso; respondeu/sem resposta; válido/inválido/erro; sucesso/erro; N saídas do distribuidor); `edges.ts` e `layout.ts` estendidos.
- `forms/node-config-form.tsx` passa a despachar para `forms/<tipo>-form.tsx`.
- Componente `VariablePicker` (`{x}`) nos campos de texto.
- `validate.ts`: saídas obrigatórias ligadas, pesos = 100, produto definido, fluxo destino ativo e ≠ atual, timeout válido, `source_var` definido.

**Páginas**
- `/products` — lista + criar/editar/desativar.
- `/sales` — tabela (filtros data/produto/origem), totais por moeda sem conversão, detalhe com imagem do comprovativo e dados extraídos, registo manual, apagar com confirmação (admin/owner).
- Sidebar: entradas Produtos e Vendas.
- Definições: campo Fuso horário; nota nas Definições de IA sobre uso nos fluxos.
- Inbox → `contact-sidebar.tsx`: secção "Vendas" do contacto.

**i18n:** todas as strings em `messages/pt.json`, `en.json`, `ko.json`; `src/i18n/messages.test.ts` garante paridade.

## 5. Erros e observabilidade

- Todo o erro de bloco gera `flow_run_events` `error` com `reason` estável; nunca guarda o texto bruto do cliente nem base64 do anexo.
- Falhas não-fatais (set_field, register_sale, set_tag) registam e avançam; falhas de envio e de avaliação terminam o run `failed` (comportamento atual).
- `verify_receipt` / `ai_prompt` nunca rebentam o run: erros vão para a saída `error`.
- Scheduler: erro num run não impede os restantes do lote; endpoint devolve `{ resumed, failed, swept }`.
- Chaves de IA nunca aparecem em eventos, logs ou respostas.

## 6. Testes (Vitest, TDD)

- **Puros:** `time.ts` (janelas, meia-noite, DST-free Luanda e fuso com DST), normalização de condição legada, avaliação de regras, `interpolate.ts`, `receipt/parse.ts`, `receipt/rules.ts` (cada motivo de rejeição + duplicado), escolha do distribuidor, validação de novos blocos.
- **Motor com mocks** (padrão de `engine.test.ts` / `dispatch.test.ts`): suspender com timeout → `resumeDueRun` segue `timeout_next`; resposta antes do timeout limpa `resume_at`; media aceite/recusada; jump com limite de profundidade; register_sale não-fatal.
- **IA:** serialização de `ContentPart` para OpenAI e Anthropic; erro do fornecedor → saída `error`.
- **Regressão:** todos os testes existentes de flows, automations, ai e i18n continuam verdes; `tsc --noEmit` e lint limpos.
- **Migração:** aplicada localmente; RLS verificada para membro vs admin.

## 7. Ordem de construção (para o plano)

1. Migração 042 + tipos
2. Reestruturação do motor em `nodes/` sem mudança de comportamento
3. Media inbound + Aguardar resposta v2 + scheduler
4. Intervalo inteligente + fuso horário
5. Condição v2
6. Alterar campo, Saltar para fluxo, Distribuidor
7. IA multimodal + Bloco de IA
8. Verificar comprovativo
9. Produtos + Vendas + Registar venda
10. UI do editor para todos os blocos + páginas + i18n
