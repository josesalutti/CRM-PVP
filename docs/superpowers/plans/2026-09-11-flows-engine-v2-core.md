# Motor de Fluxos v2 — Núcleo (Plano A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao motor de fluxos esperas temporizadas, media inbound, condições multi-regra, alterar campo, saltar para fluxo e distribuidor — a base para os Planos B (IA + comprovativo), C (produtos/vendas) e D (UI do editor).

**Architecture:** As decisões de cada bloco vivem em módulos puros testáveis (`collect-input.ts`, `smart-interval.ts`, `condition-rules.ts`, `set-field.ts`, `jump.ts`, `distributor.ts`, `resume.ts`); `engine.ts` mantém o ciclo de avanço e a persistência, com um ramo fino por bloco novo (o código existente não é movido, para não arriscar regressões). Esperas gravam `flow_runs.resume_at`; um serviço `scheduler` no Docker chama `/api/flows/cron` a cada 60 s, que reclama runs vencidos via RPC `claim_due_flow_runs` (`FOR UPDATE SKIP LOCKED`).

**Tech Stack:** Next.js 16 (App Router), TypeScript 6, Supabase (Postgres + RLS), Vitest 4, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-11-flows-engine-v2-design.md`

**Planos seguintes (fora deste):** B — IA multimodal, `ai_prompt`, `verify_receipt`; C — `products`, `sales`, `register_sale` (migração 043); D — UI do editor, páginas, i18n.

## Global Constraints

- Migrações idempotentes (`IF NOT EXISTS`, `DROP ... IF EXISTS` antes de `CREATE POLICY`), numeradas a seguir a `041`.
- Novas asserções de esquema vão DENTRO do único bloco `DO $$` de `supabase/ci/verify-schema.sql`.
- RLS usa `is_account_member(account_id[, role])`; papéis: `owner`, `admin`, `agent`, `viewer`.
- Fuso por defeito: `'Africa/Luanda'`.
- Precisão do scheduler: 60 s; lote de 50 runs por ciclo.
- Profundidade máxima de saltos entre fluxos: 5.
- Nunca guardar texto bruto do cliente nem conteúdo de anexos em `flow_run_events.payload`.
- Comportamento dos blocos existentes (`start`, `send_message`, `send_media`, `send_buttons`, `send_list`, `collect_input` sem opções novas, `condition` legado, `set_tag`, `handoff`, `end`) não muda — os testes atuais têm de continuar verdes.
- Comandos de verificação: `npm test`, `npm run typecheck`, `npm run lint`.
- Estilo do código de `src/lib/flows`: aspas duplas, ponto-e-vírgula, comentários JSDoc explicativos. Rotas em `src/app/api`: aspas simples, sem ponto-e-vírgula.
- Commits: só com autorização do utilizador; mensagens terminam com `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| Ficheiro | Responsabilidade |
|---|---|
| `supabase/migrations/042_flows_engine_v2.sql` | timezone, resume_at/wait_kind, CHECK de node_type, RPCs claim + distribuidor |
| `supabase/ci/verify-schema.sql` | asserções da 042 |
| `src/lib/flows/interpolate.ts` (+test) | `{{vars.a.b}}`, `{{contact.x}}` |
| `src/lib/flows/time.ts` (+test) | aritmética de fuso: hora local, janelas semanais, próxima abertura, entre horas |
| `src/lib/flows/types.ts` | configs novas, `ParsedInbound` media, colunas de temporizador |
| `src/lib/flows/collect-input.ts` (+test) | que respostas completam a espera, o que se guarda, quando expira |
| `src/lib/flows/resume.ts` (+test) | o que fazer quando o scheduler acorda um run |
| `src/lib/flows/smart-interval.ts` (+test) | continuar já ou esperar até quando |
| `src/lib/flows/condition-rules.ts` (+test) | normalização legado → `rules[]` e avaliação pura |
| `src/lib/flows/set-field.ts` (+test) | aritmética de valores de campo |
| `src/lib/flows/jump.ts` (+test) | guardas de salto entre fluxos |
| `src/lib/flows/distributor.ts` (+test) | saídas utilizáveis e fallback |
| `src/components/flows/shared.tsx` | tipos de bloco do editor (sem formulários — Plano D) |
| `src/lib/flows/engine.ts` | entrada, ciclo, `resumeDueRun` |
| `src/lib/flows/validate.ts` | validação dos blocos novos |
| `src/lib/flows/edges.ts` | slots/arestas dos blocos novos |
| `src/app/api/flows/cron/route.ts` | claim + resume + sweep |
| `src/app/api/whatsapp/webhook/route.ts` | entregar media ao motor |
| `docker-compose.yml` | serviço `scheduler` |

---

### Task 1: Migração 042

**Files:**
- Create: `supabase/migrations/042_flows_engine_v2.sql`
- Modify: `supabase/ci/verify-schema.sql` (dentro do bloco `DO $$`, antes de `RAISE NOTICE`)

**Interfaces:**
- Produces: `accounts.timezone text`; `flow_runs.resume_at timestamptz`, `flow_runs.wait_kind text`; RPC `claim_due_flow_runs(p_limit integer) RETURNS SETOF flow_runs`; RPC `pick_distributor_output(p_flow_id uuid, p_node_key text, p_outputs jsonb) RETURNS text`; tabela `flow_distributor_counters`.

- [ ] **Step 1: Escrever a migração**

```sql
-- ============================================================
-- 042 — Flows engine v2 (core).
--
--   1. accounts.timezone — time-of-day conditions and weekly windows
--      are evaluated in the account's local time.
--   2. flow_runs.resume_at / wait_kind — timed waits. The scheduler
--      (/api/flows/cron, every 60 s) claims due runs through
--      claim_due_flow_runs, which uses FOR UPDATE SKIP LOCKED so two
--      overlapping ticks never resume the same run.
--   3. flow_nodes.node_type CHECK widened for the v2 blocks (including
--      ai_prompt / verify_receipt / register_sale, implemented by later
--      plans — widening once avoids three constraint rewrites).
--   4. flow_distributor_counters + pick_distributor_output — weighted
--      round-robin that stays exact under concurrent webhooks.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. accounts.timezone
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Africa/Luanda';

-- 2. flow_runs timed waits
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS resume_at TIMESTAMPTZ;
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS wait_kind TEXT;

ALTER TABLE flow_runs
  DROP CONSTRAINT IF EXISTS flow_runs_wait_kind_check;
ALTER TABLE flow_runs
  ADD CONSTRAINT flow_runs_wait_kind_check
  CHECK (wait_kind IS NULL OR wait_kind IN ('reply', 'interval'));

CREATE INDEX IF NOT EXISTS idx_flow_runs_due
  ON flow_runs(resume_at)
  WHERE status = 'active' AND resume_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_due_flow_runs(p_limit INTEGER)
RETURNS SETOF flow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM flow_runs
    WHERE status = 'active'
      AND resume_at IS NOT NULL
      AND resume_at <= NOW()
    ORDER BY resume_at
    LIMIT GREATEST(p_limit, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE flow_runs r
     SET resume_at = NULL
    FROM due
   WHERE r.id = due.id
  RETURNING r.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_flow_runs(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_due_flow_runs(INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_flow_runs(INTEGER) TO service_role;

-- 3. node_type CHECK
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end',
    'smart_interval',
    'set_field',
    'jump_flow',
    'distributor',
    'ai_prompt',
    'verify_receipt',
    'register_sale'
  ));

-- 4. distributor counters
CREATE TABLE IF NOT EXISTS flow_distributor_counters (
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  output_id TEXT NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (flow_id, node_key, output_id)
);

ALTER TABLE flow_distributor_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flow_distributor_counters_select ON flow_distributor_counters;
CREATE POLICY flow_distributor_counters_select ON flow_distributor_counters FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM flows f
    WHERE f.id = flow_distributor_counters.flow_id
      AND is_account_member(f.account_id)
  ));
-- Writes happen only through pick_distributor_output (service role).

-- p_outputs: [{"id":"a","weight":50}, ...]. Picks the output whose
-- count/weight ratio is lowest (ties → first in array order), then
-- increments it. The advisory lock serialises picks per node so two
-- concurrent contacts can't both read the same counts.
CREATE OR REPLACE FUNCTION public.pick_distributor_output(
  p_flow_id UUID,
  p_node_key TEXT,
  p_outputs JSONB
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_choice TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_flow_id::text || ':' || p_node_key));

  INSERT INTO flow_distributor_counters(flow_id, node_key, output_id)
  SELECT p_flow_id, p_node_key, t.e->>'id'
    FROM jsonb_array_elements(p_outputs) AS t(e)
  ON CONFLICT DO NOTHING;

  SELECT o->>'id' INTO v_choice
    FROM jsonb_array_elements(p_outputs) WITH ORDINALITY AS t(o, ord)
    JOIN flow_distributor_counters c
      ON c.flow_id = p_flow_id AND c.node_key = p_node_key AND c.output_id = o->>'id'
   WHERE (o->>'weight')::numeric > 0
   ORDER BY c.count::numeric / (o->>'weight')::numeric, ord
   LIMIT 1;

  IF v_choice IS NOT NULL THEN
    UPDATE flow_distributor_counters
       SET count = count + 1
     WHERE flow_id = p_flow_id AND node_key = p_node_key AND output_id = v_choice;
  END IF;

  RETURN v_choice;
END;
$$;

REVOKE ALL ON FUNCTION public.pick_distributor_output(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pick_distributor_output(UUID, TEXT, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pick_distributor_output(UUID, TEXT, JSONB) TO service_role;
```

- [ ] **Step 2: Acrescentar asserções ao `verify-schema.sql`** (antes de `RAISE NOTICE 'schema verification passed';`)

```sql
  -- Flows engine v2 (042).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'flow_runs' AND column_name = 'resume_at'
  ) THEN
    RAISE EXCEPTION 'flow_runs.resume_at is missing — migration 042 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'timezone'
  ) THEN
    RAISE EXCEPTION 'accounts.timezone is missing — migration 042 did not apply';
  END IF;
  IF to_regprocedure('public.claim_due_flow_runs(integer)') IS NULL THEN
    RAISE EXCEPTION 'claim_due_flow_runs is missing — migration 042 did not apply';
  END IF;
  IF to_regprocedure('public.pick_distributor_output(uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'pick_distributor_output is missing — migration 042 did not apply';
  END IF;
```

- [ ] **Step 3: Aplicar localmente** (se o Supabase CLI estiver disponível)

Run: `npx supabase db reset --local --no-seed; npx supabase db query --local --file supabase/ci/verify-schema.sql`
Expected: `schema verification passed`. Sem CLI local, a validação fica a cargo do job `Migrations` no PR — registar isso no relatório da tarefa.

- [ ] **Step 4: Commit** (com autorização)

```bash
git add supabase/migrations/042_flows_engine_v2.sql supabase/ci/verify-schema.sql
git commit -m "feat(flows): migration 042 — timed waits, timezone, distributor"
```

---

### Task 2: Interpolação com chaves compostas

**Files:**
- Create: `src/lib/flows/interpolate.ts`
- Test: `src/lib/flows/interpolate.test.ts`
- Modify: `src/lib/flows/engine.ts:544-556` (remover `interpolateVars` local, importar do novo módulo)

**Interfaces:**
- Produces:
  ```ts
  export interface InterpolationContact { name?: string | null; phone?: string | null; email?: string | null; company?: string | null }
  export function interpolate(template: string, vars: Record<string, unknown>, contact?: InterpolationContact | null): string
  export function readVarPath(vars: Record<string, unknown>, path: string): unknown
  export function writeVarPath(vars: Record<string, unknown>, path: string, value: unknown): Record<string, unknown>
  ```

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, expect, it } from "vitest";
import { interpolate, readVarPath, writeVarPath } from "./interpolate";

describe("interpolate", () => {
  it("keeps the v1 flat {{vars.x}} behaviour", () => {
    expect(interpolate("Olá {{vars.name}}", { name: "Ana" })).toBe("Olá Ana");
  });

  it("renders missing vars as empty string", () => {
    expect(interpolate("[{{vars.nope}}]", {})).toBe("[]");
  });

  it("resolves dotted paths into nested objects", () => {
    const vars = { comprovante: { valor: 1500, banco: "BAI" } };
    expect(interpolate("{{vars.comprovante.valor}} via {{vars.comprovante.banco}}", vars)).toBe(
      "1500 via BAI",
    );
  });

  it("falls back to a literal dotted key when no nested object exists", () => {
    expect(interpolate("{{vars.a.b}}", { "a.b": "flat" })).toBe("flat");
  });

  it("renders objects as JSON", () => {
    expect(interpolate("{{vars.o}}", { o: { x: 1 } })).toBe('{"x":1}');
  });

  it("resolves contact placeholders", () => {
    expect(
      interpolate("{{contact.name}} / {{contact.phone}}", {}, { name: "Rui", phone: "+244900" }),
    ).toBe("Rui / +244900");
  });

  it("renders unknown contact fields and null contact as empty", () => {
    expect(interpolate("{{contact.name}}", {}, null)).toBe("");
    expect(interpolate("{{contact.password}}", {}, { name: "x" })).toBe("");
  });
});

describe("readVarPath / writeVarPath", () => {
  it("reads nested and flat keys", () => {
    expect(readVarPath({ a: { b: 2 } }, "a.b")).toBe(2);
    expect(readVarPath({ "a.b": 3 }, "a.b")).toBe(3);
    expect(readVarPath({}, "a.b")).toBeUndefined();
  });

  it("writes nested paths without mutating the input", () => {
    const input = { a: { keep: 1 } };
    const out = writeVarPath(input, "a.b", 2);
    expect(out).toEqual({ a: { keep: 1, b: 2 } });
    expect(input).toEqual({ a: { keep: 1 } });
  });

  it("replaces a non-object intermediate", () => {
    expect(writeVarPath({ a: "str" }, "a.b", 1)).toEqual({ a: { b: 1 } });
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npx vitest run src/lib/flows/interpolate.test.ts`
Expected: FAIL — `Failed to resolve import "./interpolate"`.

- [ ] **Step 3: Implementar**

```ts
/**
 * Template interpolation for flow node text.
 *
 * `{{vars.path}}` reads `flow_runs.vars`; dotted paths walk nested
 * objects (`{{vars.comprovante.valor}}`), falling back to a literal
 * dotted key so v1 flows that stored "a.b" flat keep working.
 * `{{contact.field}}` reads a small allow-list of contact columns.
 * Anything missing renders as "" — same as the automations engine.
 */

export interface InterpolationContact {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
}

const CONTACT_FIELDS = new Set(["name", "phone", "email", "company"]);

export function readVarPath(vars: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(vars, path) && !path.includes(".")) {
    return vars[path];
  }
  let cur: unknown = vars;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) {
      return Object.prototype.hasOwnProperty.call(vars, path) ? vars[path] : undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function writeVarPath(
  vars: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split(".");
  const root: Record<string, unknown> = { ...vars };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const existing = cur[parts[i]];
    const next =
      existing !== null && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cur[parts[i]] = next;
    cur = next;
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

function render(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function interpolate(
  template: string,
  vars: Record<string, unknown>,
  contact?: InterpolationContact | null,
): string {
  if (!template) return "";
  return template.replace(
    /\{\{(vars|contact)\.([a-zA-Z0-9_.]+)\}\}/g,
    (_, scope: string, key: string) => {
      if (scope === "vars") return render(readVarPath(vars, key));
      if (!contact || !CONTACT_FIELDS.has(key)) return "";
      return render(contact[key as keyof InterpolationContact]);
    },
  );
}
```

- [ ] **Step 4: Ligar no engine** — em `src/lib/flows/engine.ts`, apagar a função `interpolateVars` (linhas 544-556) e acrescentar ao bloco de imports:

```ts
import { interpolate } from "./interpolate";
```

Substituir cada `interpolateVars(x, run.vars)` por `interpolate(x, run.vars)` (4 ocorrências: send_message, send_media caption, collect_input prompt, reprompt de collect_input).

- [ ] **Step 5: Correr testes**

Run: `npx vitest run src/lib/flows`
Expected: PASS (novos + existentes).

- [ ] **Step 6: Commit** (com autorização)

```bash
git add src/lib/flows/interpolate.ts src/lib/flows/interpolate.test.ts src/lib/flows/engine.ts
git commit -m "feat(flows): dotted-path and contact interpolation"
```

---

### Task 3: Aritmética de fuso horário

**Files:**
- Create: `src/lib/flows/time.ts`
- Test: `src/lib/flows/time.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
  export const WEEKDAYS: readonly Weekday[];
  export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: Weekday }
  export interface DayWindow { enabled: boolean; start: string; end: string }   // "HH:mm"
  export type WeeklyWindow = Partial<Record<Weekday, DayWindow>>;
  export function isValidTimeZone(tz: string): boolean
  export function localParts(at: Date, timeZone: string): LocalParts
  export function parseHHmm(s: string): number | null            // minutos desde 00:00
  export function isBetweenLocalTimes(at: Date, timeZone: string, start: string, end: string): boolean
  export function isInsideWeeklyWindow(at: Date, timeZone: string, window: WeeklyWindow): boolean
  export function nextWindowOpening(at: Date, timeZone: string, window: WeeklyWindow): Date | null
  export function zonedLocalToUtc(local: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string): Date
  export function addDuration(at: Date, value: number, unit: "minutes" | "hours" | "days"): Date
  ```

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, expect, it } from "vitest";
import {
  addDuration,
  isBetweenLocalTimes,
  isInsideWeeklyWindow,
  isValidTimeZone,
  localParts,
  nextWindowOpening,
  parseHHmm,
  zonedLocalToUtc,
  type WeeklyWindow,
} from "./time";

const LUANDA = "Africa/Luanda"; // UTC+1, no DST
const LISBON = "Europe/Lisbon"; // DST

describe("isValidTimeZone", () => {
  it("accepts IANA zones and rejects junk", () => {
    expect(isValidTimeZone(LUANDA)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("localParts", () => {
  it("shifts UTC into the zone", () => {
    // 2026-09-11 is a Friday
    const p = localParts(new Date("2026-09-11T23:30:00Z"), LUANDA);
    expect(p).toEqual({ year: 2026, month: 9, day: 12, hour: 0, minute: 30, weekday: "saturday" });
  });
});

describe("parseHHmm", () => {
  it("parses valid strings and rejects invalid", () => {
    expect(parseHHmm("08:00")).toBe(480);
    expect(parseHHmm("22:30")).toBe(1350);
    expect(parseHHmm("24:00")).toBeNull();
    expect(parseHHmm("8h")).toBeNull();
  });
});

describe("isBetweenLocalTimes", () => {
  it("handles a same-day range (start inclusive, end exclusive)", () => {
    expect(isBetweenLocalTimes(new Date("2026-09-11T07:00:00Z"), LUANDA, "08:00", "17:00")).toBe(true); // 08:00 local
    expect(isBetweenLocalTimes(new Date("2026-09-11T16:00:00Z"), LUANDA, "08:00", "17:00")).toBe(false); // 17:00 local
  });

  it("handles a range crossing midnight", () => {
    expect(isBetweenLocalTimes(new Date("2026-09-11T22:30:00Z"), LUANDA, "22:00", "08:00")).toBe(true); // 23:30
    expect(isBetweenLocalTimes(new Date("2026-09-11T05:00:00Z"), LUANDA, "22:00", "08:00")).toBe(true); // 06:00
    expect(isBetweenLocalTimes(new Date("2026-09-11T11:00:00Z"), LUANDA, "22:00", "08:00")).toBe(false); // 12:00
  });
});

const EVERY_DAY_8_TO_2230: WeeklyWindow = Object.fromEntries(
  ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [
    d,
    { enabled: true, start: "08:00", end: "22:30" },
  ]),
);

describe("isInsideWeeklyWindow", () => {
  it("is true inside the day's window", () => {
    expect(isInsideWeeklyWindow(new Date("2026-09-11T10:00:00Z"), LUANDA, EVERY_DAY_8_TO_2230)).toBe(true);
  });
  it("is false after closing and on disabled days", () => {
    expect(isInsideWeeklyWindow(new Date("2026-09-11T22:00:00Z"), LUANDA, EVERY_DAY_8_TO_2230)).toBe(false); // 23:00
    expect(
      isInsideWeeklyWindow(new Date("2026-09-11T10:00:00Z"), LUANDA, {
        friday: { enabled: false, start: "08:00", end: "22:30" },
      }),
    ).toBe(false);
  });
});

describe("nextWindowOpening", () => {
  it("returns the same day's opening when before it", () => {
    // 06:00 local Friday → 08:00 local Friday = 07:00Z
    expect(nextWindowOpening(new Date("2026-09-11T05:00:00Z"), LUANDA, EVERY_DAY_8_TO_2230)?.toISOString()).toBe(
      "2026-09-11T07:00:00.000Z",
    );
  });
  it("rolls to the next enabled day after closing", () => {
    // 23:00 local Friday, only Monday enabled → Monday 14 Sep 08:00 local = 07:00Z
    const onlyMonday: WeeklyWindow = { monday: { enabled: true, start: "08:00", end: "22:30" } };
    expect(nextWindowOpening(new Date("2026-09-11T22:00:00Z"), LUANDA, onlyMonday)?.toISOString()).toBe(
      "2026-09-14T07:00:00.000Z",
    );
  });
  it("returns null when no day is enabled", () => {
    expect(nextWindowOpening(new Date(), LUANDA, {})).toBeNull();
  });
});

describe("zonedLocalToUtc", () => {
  it("converts in a fixed-offset zone", () => {
    expect(zonedLocalToUtc({ year: 2026, month: 9, day: 11, hour: 8, minute: 0 }, LUANDA).toISOString()).toBe(
      "2026-09-11T07:00:00.000Z",
    );
  });
  it("respects DST in Lisbon (summer UTC+1, winter UTC+0)", () => {
    expect(zonedLocalToUtc({ year: 2026, month: 7, day: 1, hour: 8, minute: 0 }, LISBON).toISOString()).toBe(
      "2026-07-01T07:00:00.000Z",
    );
    expect(zonedLocalToUtc({ year: 2026, month: 1, day: 15, hour: 8, minute: 0 }, LISBON).toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });
});

describe("addDuration", () => {
  it("adds minutes, hours and days", () => {
    const base = new Date("2026-09-11T00:00:00Z");
    expect(addDuration(base, 30, "minutes").toISOString()).toBe("2026-09-11T00:30:00.000Z");
    expect(addDuration(base, 2, "hours").toISOString()).toBe("2026-09-11T02:00:00.000Z");
    expect(addDuration(base, 1, "days").toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npx vitest run src/lib/flows/time.test.ts`
Expected: FAIL — `Failed to resolve import "./time"`.

- [ ] **Step 3: Implementar**

```ts
/**
 * Timezone arithmetic for flow waits and time-based conditions.
 *
 * Pure and dependency-free: uses Intl.DateTimeFormat for UTC→local and
 * a two-pass offset correction for local→UTC so DST zones resolve
 * correctly. All "HH:mm" windows are start-inclusive, end-exclusive; a
 * window whose end is before its start crosses midnight.
 */

export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/** Index 0 = Sunday, matching Date#getUTCDay. */
export const WEEKDAYS: readonly Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
}

export interface DayWindow {
  enabled: boolean;
  start: string;
  end: string;
}

export type WeeklyWindow = Partial<Record<Weekday, DayWindow>>;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "long",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday").toLowerCase() as Weekday,
  };
}

export function parseHHmm(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesOfDay(p: LocalParts): number {
  return p.hour * 60 + p.minute;
}

function inRange(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function isBetweenLocalTimes(
  at: Date,
  timeZone: string,
  start: string,
  end: string,
): boolean {
  const s = parseHHmm(start);
  const e = parseHHmm(end);
  if (s === null || e === null) return false;
  return inRange(minutesOfDay(localParts(at, timeZone)), s, e);
}

export function isInsideWeeklyWindow(
  at: Date,
  timeZone: string,
  window: WeeklyWindow,
): boolean {
  const p = localParts(at, timeZone);
  const day = window[p.weekday];
  if (!day?.enabled) return false;
  const s = parseHHmm(day.start);
  const e = parseHHmm(day.end);
  if (s === null || e === null || s >= e) return false;
  const m = minutesOfDay(p);
  return m >= s && m < e;
}

export function zonedLocalToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsetAt = (utcMs: number) => {
    const p = localParts(new Date(utcMs), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - utcMs;
  };
  const first = naive - offsetAt(naive);
  const second = naive - offsetAt(first);
  return new Date(second);
}

export function nextWindowOpening(
  at: Date,
  timeZone: string,
  window: WeeklyWindow,
): Date | null {
  const now = localParts(at, timeZone);
  const nowMinute = minutesOfDay(now);
  const baseUtcDay = Date.UTC(now.year, now.month - 1, now.day);
  for (let offset = 0; offset <= 7; offset += 1) {
    const d = new Date(baseUtcDay + offset * 86_400_000);
    const weekday = WEEKDAYS[d.getUTCDay()];
    const day = window[weekday];
    if (!day?.enabled) continue;
    const s = parseHHmm(day.start);
    const e = parseHHmm(day.end);
    if (s === null || e === null || s >= e) continue;
    if (offset === 0 && nowMinute >= s) continue;
    return zonedLocalToUtc(
      {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: Math.floor(s / 60),
        minute: s % 60,
      },
      timeZone,
    );
  }
  return null;
}

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

export function addDuration(
  at: Date,
  value: number,
  unit: "minutes" | "hours" | "days",
): Date {
  return new Date(at.getTime() + value * UNIT_MS[unit]);
}
```

- [ ] **Step 4: Correr testes**

Run: `npx vitest run src/lib/flows/time.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (com autorização)

```bash
git add src/lib/flows/time.ts src/lib/flows/time.test.ts
git commit -m "feat(flows): timezone-aware time helpers"
```

---

### Task 4: Tipos v2 + regras de condição (puro)

**Files:**
- Modify: `src/lib/flows/types.ts` (configs, união `FlowNodeConfig`, `ParsedInbound`, `StepResult`, colunas novas em `FlowRunRow`)
- Create: `src/lib/flows/condition-rules.ts`
- Test: `src/lib/flows/condition-rules.test.ts`

**Interfaces:**
- Consumes: `Weekday`, `WeeklyWindow`, `isBetweenLocalTimes` (Task 3).
- Produces (em `types.ts`):
  ```ts
  export type DurationUnit = "minutes" | "hours" | "days";
  export interface Duration { value: number; unit: DurationUnit }
  export type InputAccept = "text" | "image" | "document";
  // CollectInputNodeConfig ganha: accept?: InputAccept[]; timeout?: Duration; timeout_next?: string;
  export type ConditionRule =
    | { type: "tag"; operator: "present" | "absent"; tag_id: string }
    | { type: "var" | "custom_field" | "contact_field"; key: string;
        operator: "equals" | "not_equals" | "contains" | "present" | "absent" | "gt" | "lt"; value?: string }
    | { type: "time"; operator: "between"; start: string; end: string }
    | { type: "weekday"; operator: "in"; days: Weekday[] };
  export interface ConditionV2Config { match: "all" | "any"; rules: ConditionRule[]; true_next: string; false_next: string }
  // ConditionNodeConfig = legado | ConditionV2Config
  export interface SmartIntervalNodeConfig {
    mode: "duration" | "until" | "weekly_window";
    duration?: Duration; until?: string /* "YYYY-MM-DDTHH:mm" local da conta */;
    weekly_window?: WeeklyWindow; next_node_key: string }
  export interface SetFieldNodeConfig { custom_field_id: string; op: "set" | "increment" | "decrement" | "clear"; value?: string; next_node_key: string }
  export interface JumpFlowNodeConfig { target_flow_id: string }
  export interface DistributorNodeConfig { outputs: Array<{ id: string; label: string; weight: number; next_node_key: string }> }
  export interface InboundMediaRef { type: "image" | "document" | "audio" | "video"; message_id: string; media_url: string; mime_type: string | null; caption: string | null }
  // ParsedInbound ganha: { kind: "media"; media: InboundMediaRef; meta_message_id: string }
  // FlowRunRow ganha: resume_at: string | null; wait_kind: "reply" | "interval" | null;
  ```
- Produces (em `condition-rules.ts`):
  ```ts
  export interface RuleFacts {
    now: Date; timeZone: string;
    vars: Record<string, unknown>;
    tagIds: ReadonlySet<string>;
    customFields: Readonly<Record<string, string | null>>;   // custom_field_id → valor
    contact: Readonly<Record<string, string | null>>;        // name/email/phone/company
  }
  export function normalizeCondition(cfg: Record<string, unknown>): ConditionV2Config
  export function evaluateRule(rule: ConditionRule, facts: RuleFacts): boolean
  export function evaluateCondition(cfg: ConditionV2Config, facts: RuleFacts): boolean
  export function ruleNeeds(cfg: ConditionV2Config): { tags: boolean; customFields: boolean; contact: boolean }
  ```

- [ ] **Step 1: Estender `types.ts`**

Acrescentar depois de `SetTagNodeConfig` (linha 174):

```ts
export type DurationUnit = "minutes" | "hours" | "days";

export interface Duration {
  value: number;
  unit: DurationUnit;
}

export type InputAccept = "text" | "image" | "document";

export type ConditionRule =
  | { type: "tag"; operator: "present" | "absent"; tag_id: string }
  | {
      type: "var" | "custom_field" | "contact_field";
      key: string;
      operator: "equals" | "not_equals" | "contains" | "present" | "absent" | "gt" | "lt";
      value?: string;
    }
  | { type: "time"; operator: "between"; start: string; end: string }
  | { type: "weekday"; operator: "in"; days: Weekday[] };

/**
 * v2 condition shape. Legacy single-predicate configs are normalized
 * into this at read time by `normalizeCondition` — nothing is migrated
 * in the database.
 */
export interface ConditionV2Config {
  match: "all" | "any";
  rules: ConditionRule[];
  true_next: string;
  false_next: string;
}

/**
 * Pauses the run. `duration` resumes after a fixed delay; `until`
 * resumes at an account-local datetime ("YYYY-MM-DDTHH:mm"); and
 * `weekly_window` continues immediately when inside the window,
 * otherwise resumes at the next opening.
 */
export interface SmartIntervalNodeConfig {
  mode: "duration" | "until" | "weekly_window";
  duration?: Duration;
  until?: string;
  weekly_window?: WeeklyWindow;
  next_node_key: string;
}

export interface SetFieldNodeConfig {
  custom_field_id: string;
  op: "set" | "increment" | "decrement" | "clear";
  /** Interpolated. Ignored for `clear`; parsed as a number for increment/decrement. */
  value?: string;
  next_node_key: string;
}

/** Terminal for the current run: starts `target_flow_id` for the same contact. */
export interface JumpFlowNodeConfig {
  target_flow_id: string;
}

export interface DistributorNodeConfig {
  /** Weights are percentages and must sum to 100 (validator). */
  outputs: Array<{ id: string; label: string; weight: number; next_node_key: string }>;
}

export interface InboundMediaRef {
  type: "image" | "document" | "audio" | "video";
  /** Internal `messages.id` of the inbound row. */
  message_id: string;
  /** Durable mirrored URL (migration 039) or the proxy fallback. */
  media_url: string;
  mime_type: string | null;
  caption: string | null;
}
```

Adicionar o import no topo do ficheiro:

```ts
import type { Weekday, WeeklyWindow } from "./time";
```

Alterar `CollectInputNodeConfig` — acrescentar antes de `next_node_key`:

```ts
  /** v2: which reply kinds complete the wait. Default ['text']. */
  accept?: InputAccept[];
  /** v2: when set, the run resumes via `timeout_next` after this long without an accepted reply. */
  timeout?: Duration;
  /** v2: target when the timeout fires. Missing → run ends `timed_out`. */
  timeout_next?: string;
```

Substituir a união (linhas 187-197):

```ts
export type FlowNodeConfig =
  | { node_type: "start"; config: StartNodeConfig }
  | { node_type: "send_message"; config: SendMessageNodeConfig }
  | { node_type: "send_buttons"; config: SendButtonsNodeConfig }
  | { node_type: "send_list"; config: SendListNodeConfig }
  | { node_type: "send_media"; config: SendMediaNodeConfig }
  | { node_type: "collect_input"; config: CollectInputNodeConfig }
  | { node_type: "condition"; config: ConditionNodeConfig | ConditionV2Config }
  | { node_type: "set_tag"; config: SetTagNodeConfig }
  | { node_type: "handoff"; config: HandoffNodeConfig }
  | { node_type: "end"; config: EndNodeConfig }
  | { node_type: "smart_interval"; config: SmartIntervalNodeConfig }
  | { node_type: "set_field"; config: SetFieldNodeConfig }
  | { node_type: "jump_flow"; config: JumpFlowNodeConfig }
  | { node_type: "distributor"; config: DistributorNodeConfig };
```

Em `FlowRunRow`, acrescentar depois de `vars`:

```ts
  /** Set while the run waits on a timer (migration 042). */
  resume_at: string | null;
  wait_kind: "reply" | "interval" | null;
```

Em `ParsedInbound`, acrescentar a variante:

```ts
  | {
      kind: "media";
      media: InboundMediaRef;
      meta_message_id: string;
    };
```

- [ ] **Step 2: Corrigir consumidores de `ParsedInbound`**

Run: `npm run typecheck`
Expected: erros em `entryTriggerTexts` (`engine.ts:129-134`) e no log `reply_received`. Corrigir `entryTriggerTexts`:

```ts
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === "text") return [message.text];
  // A media message only offers its caption — a photo captioned
  // "comprovativo" can start a flow keyed on that word.
  if (message.kind === "media") {
    return message.media.caption?.trim() ? [message.media.caption] : [];
  }
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}
```

E no `logEvent(... "reply_received" ...)` de `handleReplyForActiveRun`, acrescentar ao payload:

```ts
    media_type: message.kind === "media" ? message.media.type : null,
```

Erros que reste em `components/flows` por causa do `NodeType` alargado são resolvidos na Task 11 (edges/validate) — se o `NodeType` do builder for uma união independente, não haverá erros. Re-correr `npm run typecheck` e confirmar 0 erros antes de avançar; se houver erros de exaustividade em `edges.ts`, acrescentar temporariamente os casos novos a devolver `[]`/`null` (a Task 11 substitui-os).

- [ ] **Step 3: Escrever testes de `condition-rules`**

```ts
import { describe, expect, it } from "vitest";
import { evaluateCondition, evaluateRule, normalizeCondition, ruleNeeds, type RuleFacts } from "./condition-rules";

function facts(over: Partial<RuleFacts> = {}): RuleFacts {
  return {
    now: new Date("2026-09-11T10:00:00Z"), // Friday 11:00 Luanda
    timeZone: "Africa/Luanda",
    vars: {},
    tagIds: new Set(),
    customFields: {},
    contact: {},
    ...over,
  };
}

describe("normalizeCondition", () => {
  it("passes v2 configs through", () => {
    const v2 = { match: "any", rules: [], true_next: "t", false_next: "f" };
    expect(normalizeCondition(v2)).toEqual(v2);
  });

  it("converts a legacy var predicate", () => {
    expect(
      normalizeCondition({ subject: "var", subject_key: "x", operator: "equals", value: "1", true_next: "t", false_next: "f" }),
    ).toEqual({
      match: "all",
      rules: [{ type: "var", key: "x", operator: "equals", value: "1" }],
      true_next: "t",
      false_next: "f",
    });
  });

  it("converts a legacy tag predicate", () => {
    expect(
      normalizeCondition({ subject: "tag", subject_key: "tag-1", operator: "present", true_next: "t", false_next: "f" }).rules,
    ).toEqual([{ type: "tag", operator: "present", tag_id: "tag-1" }]);
  });

  it("maps legacy tag equals/contains to present", () => {
    expect(
      normalizeCondition({ subject: "tag", subject_key: "tag-1", operator: "equals", value: "tag-1", true_next: "t", false_next: "f" }).rules,
    ).toEqual([{ type: "tag", operator: "present", tag_id: "tag-1" }]);
  });

  it("converts a legacy contact_field predicate", () => {
    expect(
      normalizeCondition({ subject: "contact_field", subject_key: "email", operator: "absent", true_next: "t", false_next: "f" }).rules,
    ).toEqual([{ type: "contact_field", key: "email", operator: "absent", value: undefined }]);
  });
});

describe("evaluateRule", () => {
  it("tag present/absent", () => {
    const f = facts({ tagIds: new Set(["a"]) });
    expect(evaluateRule({ type: "tag", operator: "present", tag_id: "a" }, f)).toBe(true);
    expect(evaluateRule({ type: "tag", operator: "absent", tag_id: "a" }, f)).toBe(false);
  });

  it("var with dotted path and numeric gt/lt", () => {
    const f = facts({ vars: { comprovante: { valor: 1500 } } });
    expect(evaluateRule({ type: "var", key: "comprovante.valor", operator: "gt", value: "1000" }, f)).toBe(true);
    expect(evaluateRule({ type: "var", key: "comprovante.valor", operator: "lt", value: "1000" }, f)).toBe(false);
  });

  it("gt/lt on non-numeric values is false", () => {
    expect(evaluateRule({ type: "var", key: "x", operator: "gt", value: "1" }, facts({ vars: { x: "abc" } }))).toBe(false);
  });

  it("equals / not_equals / contains are case-insensitive", () => {
    const f = facts({ customFields: { cf1: "Sim" } });
    expect(evaluateRule({ type: "custom_field", key: "cf1", operator: "equals", value: "sim" }, f)).toBe(true);
    expect(evaluateRule({ type: "custom_field", key: "cf1", operator: "not_equals", value: "não" }, f)).toBe(true);
    expect(evaluateRule({ type: "custom_field", key: "cf1", operator: "contains", value: "IM" }, f)).toBe(true);
  });

  it("present/absent treat empty string as absent", () => {
    const f = facts({ contact: { email: "" } });
    expect(evaluateRule({ type: "contact_field", key: "email", operator: "absent" }, f)).toBe(true);
  });

  it("time between crossing midnight", () => {
    const night = facts({ now: new Date("2026-09-11T22:30:00Z") }); // 23:30
    expect(evaluateRule({ type: "time", operator: "between", start: "22:00", end: "08:00" }, night)).toBe(true);
    expect(evaluateRule({ type: "time", operator: "between", start: "22:00", end: "08:00" }, facts())).toBe(false);
  });

  it("weekday in", () => {
    expect(evaluateRule({ type: "weekday", operator: "in", days: ["friday"] }, facts())).toBe(true);
    expect(evaluateRule({ type: "weekday", operator: "in", days: ["monday"] }, facts())).toBe(false);
  });
});

describe("evaluateCondition", () => {
  const T = { type: "weekday", operator: "in", days: ["friday"] } as const;
  const F = { type: "weekday", operator: "in", days: ["monday"] } as const;

  it("all requires every rule", () => {
    expect(evaluateCondition({ match: "all", rules: [T, F], true_next: "", false_next: "" }, facts())).toBe(false);
  });
  it("any requires one rule", () => {
    expect(evaluateCondition({ match: "any", rules: [T, F], true_next: "", false_next: "" }, facts())).toBe(true);
  });
  it("empty rules evaluate false", () => {
    expect(evaluateCondition({ match: "all", rules: [], true_next: "", false_next: "" }, facts())).toBe(false);
  });
});

describe("ruleNeeds", () => {
  it("reports which DB lookups are required", () => {
    expect(
      ruleNeeds({
        match: "all",
        rules: [
          { type: "tag", operator: "present", tag_id: "x" },
          { type: "time", operator: "between", start: "08:00", end: "09:00" },
        ],
        true_next: "",
        false_next: "",
      }),
    ).toEqual({ tags: true, customFields: false, contact: false });
  });
});
```

- [ ] **Step 4: Correr e ver falhar**

Run: `npx vitest run src/lib/flows/condition-rules.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 5: Implementar `condition-rules.ts`**

```ts
/**
 * Pure evaluation of condition-node rules.
 *
 * The engine gathers only the facts a condition needs (see `ruleNeeds`)
 * and hands them here, so every operator is unit-testable without a
 * database. Text comparisons are case-insensitive and trimmed; gt/lt
 * are numeric and false when either side isn't a finite number.
 */

import { readVarPath } from "./interpolate";
import { isBetweenLocalTimes, localParts } from "./time";
import type { ConditionRule, ConditionV2Config } from "./types";

export interface RuleFacts {
  now: Date;
  timeZone: string;
  vars: Record<string, unknown>;
  tagIds: ReadonlySet<string>;
  customFields: Readonly<Record<string, string | null>>;
  contact: Readonly<Record<string, string | null>>;
}

export function normalizeCondition(cfg: Record<string, unknown>): ConditionV2Config {
  if (Array.isArray(cfg.rules)) {
    return {
      match: cfg.match === "any" ? "any" : "all",
      rules: cfg.rules as ConditionRule[],
      true_next: String(cfg.true_next ?? ""),
      false_next: String(cfg.false_next ?? ""),
    };
  }
  const subject = cfg.subject;
  const key = String(cfg.subject_key ?? "");
  const operator = String(cfg.operator ?? "present");
  let rule: ConditionRule;
  if (subject === "tag") {
    rule = { type: "tag", operator: operator === "absent" ? "absent" : "present", tag_id: key };
  } else {
    rule = {
      type: subject === "contact_field" ? "contact_field" : "var",
      key,
      operator: operator as "equals" | "contains" | "present" | "absent",
      value: typeof cfg.value === "string" ? cfg.value : undefined,
    };
  }
  return {
    match: "all",
    rules: [rule],
    true_next: String(cfg.true_next ?? ""),
    false_next: String(cfg.false_next ?? ""),
  };
}

function asText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s;
}

function asNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v.trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function compare(
  operator: Extract<ConditionRule, { key: string }>["operator"],
  subject: string | undefined,
  configured: string | undefined,
): boolean {
  const s = subject?.trim();
  const c = (configured ?? "").trim();
  switch (operator) {
    case "present":
      return s !== undefined && s !== "";
    case "absent":
      return s === undefined || s === "";
    case "equals":
      return s !== undefined && s.toLowerCase() === c.toLowerCase();
    case "not_equals":
      return s === undefined || s.toLowerCase() !== c.toLowerCase();
    case "contains":
      return s !== undefined && s.toLowerCase().includes(c.toLowerCase());
    case "gt":
    case "lt": {
      const a = asNumber(s);
      const b = asNumber(c);
      if (a === null || b === null) return false;
      return operator === "gt" ? a > b : a < b;
    }
  }
}

export function evaluateRule(rule: ConditionRule, facts: RuleFacts): boolean {
  switch (rule.type) {
    case "tag": {
      const has = facts.tagIds.has(rule.tag_id);
      return rule.operator === "present" ? has : !has;
    }
    case "var":
      return compare(rule.operator, asText(readVarPath(facts.vars, rule.key)), rule.value);
    case "custom_field":
      return compare(rule.operator, asText(facts.customFields[rule.key]), rule.value);
    case "contact_field":
      return compare(rule.operator, asText(facts.contact[rule.key]), rule.value);
    case "time":
      return isBetweenLocalTimes(facts.now, facts.timeZone, rule.start, rule.end);
    case "weekday":
      return rule.days.includes(localParts(facts.now, facts.timeZone).weekday);
  }
}

export function evaluateCondition(cfg: ConditionV2Config, facts: RuleFacts): boolean {
  if (!cfg.rules.length) return false;
  return cfg.match === "any"
    ? cfg.rules.some((r) => evaluateRule(r, facts))
    : cfg.rules.every((r) => evaluateRule(r, facts));
}

export function ruleNeeds(cfg: ConditionV2Config): {
  tags: boolean;
  customFields: boolean;
  contact: boolean;
} {
  return {
    tags: cfg.rules.some((r) => r.type === "tag"),
    customFields: cfg.rules.some((r) => r.type === "custom_field"),
    contact: cfg.rules.some((r) => r.type === "contact_field"),
  };
}
```

- [ ] **Step 6: Correr testes e typecheck**

Run: `npx vitest run src/lib/flows; npm run typecheck`
Expected: PASS; 0 erros.

- [ ] **Step 7: Commit** (com autorização)

```bash
git add src/lib/flows/types.ts src/lib/flows/condition-rules.ts src/lib/flows/condition-rules.test.ts src/lib/flows/engine.ts
git commit -m "feat(flows): v2 node types and multi-rule condition evaluation"
```

---

### Task 5: Aguardar resposta v2 (media + timeout) e media no webhook

**Files:**
- Create: `src/lib/flows/collect-input.ts`
- Test: `src/lib/flows/collect-input.test.ts`
- Modify: `src/lib/flows/engine.ts` (`advanceCurrentNodeKey`, ramo `collect_input` de `advanceFromNodeKey`, `handleReplyForActiveRun`)
- Modify: `src/app/api/whatsapp/webhook/route.ts:791-810`

**Interfaces:**
- Consumes: `CollectInputNodeConfig`, `InboundMediaRef`, `ParsedInbound` (Task 4); `addDuration` (Task 3); `writeVarPath` (Task 2).
- Produces:
  ```ts
  // collect-input.ts
  export function acceptedKinds(cfg: CollectInputNodeConfig): Set<InputAccept>
  export function captureFromInbound(cfg: CollectInputNodeConfig, message: ParsedInbound): unknown | null
  export function collectInputResumeAt(cfg: CollectInputNodeConfig, now: Date): Date | null
  // engine.ts (interno, usado pelas Tasks 6-11)
  async function advanceCurrentNodeKey(db, runId, expectedOldKey, newKey,
    timer?: { resumeAt: Date | null; waitKind: "reply" | "interval" | null }): Promise<boolean>
  ```

- [ ] **Step 1: Escrever testes puros**

```ts
import { describe, expect, it } from "vitest";
import { acceptedKinds, captureFromInbound, collectInputResumeAt } from "./collect-input";
import type { CollectInputNodeConfig, ParsedInbound } from "./types";

const base: CollectInputNodeConfig = { prompt_text: "Envie", var_key: "resposta", next_node_key: "n" };

const text = (t: string): ParsedInbound => ({ kind: "text", text: t, meta_message_id: "m1" });
const media = (type: "image" | "document" | "audio"): ParsedInbound => ({
  kind: "media",
  meta_message_id: "m2",
  media: { type, message_id: "msg-1", media_url: "https://x/y.jpg", mime_type: "image/jpeg", caption: "comp" },
});

describe("acceptedKinds", () => {
  it("defaults to text only", () => {
    expect([...acceptedKinds(base)]).toEqual(["text"]);
  });
  it("ignores an empty accept array", () => {
    expect([...acceptedKinds({ ...base, accept: [] })]).toEqual(["text"]);
  });
});

describe("captureFromInbound", () => {
  it("captures trimmed text when text is accepted", () => {
    expect(captureFromInbound(base, text("  olá "))).toBe("olá");
  });
  it("rejects blank text", () => {
    expect(captureFromInbound(base, text("   "))).toBeNull();
  });
  it("rejects media when only text is accepted", () => {
    expect(captureFromInbound(base, media("image"))).toBeNull();
  });
  it("captures an image reference when images are accepted", () => {
    expect(captureFromInbound({ ...base, accept: ["image"] }, media("image"))).toEqual({
      type: "image",
      message_id: "msg-1",
      media_url: "https://x/y.jpg",
      mime_type: "image/jpeg",
      caption: "comp",
    });
  });
  it("rejects text when only media is accepted", () => {
    expect(captureFromInbound({ ...base, accept: ["image", "document"] }, text("ok"))).toBeNull();
  });
  it("never captures audio (not an acceptable kind)", () => {
    expect(captureFromInbound({ ...base, accept: ["image", "document", "text"] }, media("audio"))).toBeNull();
  });
  it("never captures interactive replies", () => {
    expect(
      captureFromInbound(base, { kind: "interactive_reply", reply_id: "a", reply_title: "A", meta_message_id: "m3" }),
    ).toBeNull();
  });
});

describe("collectInputResumeAt", () => {
  const now = new Date("2026-09-11T10:00:00Z");
  it("is null without a timeout", () => {
    expect(collectInputResumeAt(base, now)).toBeNull();
  });
  it("adds the timeout duration", () => {
    expect(collectInputResumeAt({ ...base, timeout: { value: 8, unit: "hours" } }, now)?.toISOString()).toBe(
      "2026-09-11T18:00:00.000Z",
    );
  });
  it("ignores non-positive timeouts", () => {
    expect(collectInputResumeAt({ ...base, timeout: { value: 0, unit: "hours" } }, now)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npx vitest run src/lib/flows/collect-input.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `collect-input.ts`**

```ts
/**
 * Pure rules for the v2 "wait for reply" (collect_input) node: which
 * inbound kinds complete the wait, what gets stored, and when the
 * timeout fires. The engine owns persistence; this owns decisions.
 */

import { addDuration } from "./time";
import type { CollectInputNodeConfig, InputAccept, ParsedInbound } from "./types";

export function acceptedKinds(cfg: CollectInputNodeConfig): Set<InputAccept> {
  return new Set(cfg.accept?.length ? cfg.accept : ["text"]);
}

export function captureFromInbound(
  cfg: CollectInputNodeConfig,
  message: ParsedInbound,
): unknown | null {
  const accepted = acceptedKinds(cfg);
  if (message.kind === "text") {
    const t = message.text.trim();
    return accepted.has("text") && t.length > 0 ? t : null;
  }
  if (message.kind === "media") {
    const type = message.media.type;
    if ((type === "image" || type === "document") && accepted.has(type)) {
      return { ...message.media };
    }
    return null;
  }
  return null;
}

export function collectInputResumeAt(cfg: CollectInputNodeConfig, now: Date): Date | null {
  if (!cfg.timeout || !(cfg.timeout.value > 0)) return null;
  return addDuration(now, cfg.timeout.value, cfg.timeout.unit);
}
```

- [ ] **Step 4: Correr testes puros**

Run: `npx vitest run src/lib/flows/collect-input.test.ts`
Expected: PASS.

- [ ] **Step 5: `advanceCurrentNodeKey` passa a gerir o temporizador**

Substituir a função (`engine.ts:834-861`):

```ts
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
  timer: { resumeAt: Date | null; waitKind: "reply" | "interval" | null } = {
    resumeAt: null,
    waitKind: null,
  },
): Promise<boolean> {
  // Every pointer move also (re)sets the timer columns, so a node that
  // doesn't wait on time can never inherit a stale resume_at from the
  // node before it.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
      resume_at: timer.resumeAt ? timer.resumeAt.toISOString() : null,
      wait_kind: timer.resumeAt ? timer.waitKind : null,
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}
```

- [ ] **Step 6: Ramo `collect_input` grava o timeout**

No ramo `collect_input` de `advanceFromNodeKey`, substituir a chamada `advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key)` por:

```ts
      const resumeAt = collectInputResumeAt(cfg, new Date());
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
        { resumeAt, waitKind: resumeAt ? "reply" : null },
      );
      if (advanced) run.current_node_key = node.node_key;
```

Acrescentar aos imports: `import { captureFromInbound, collectInputResumeAt } from "./collect-input";`

Nota: acrescentar também `run.current_node_key = node.node_key` depois de cada `advanceCurrentNodeKey` bem-sucedido nos ramos `send_buttons` e `send_list` — o `resumeDueRun` (Task 6) e os saltos reutilizam o objeto `run` em memória e precisam do ponteiro atual para a pré-condição otimista.

- [ ] **Step 7: `handleReplyForActiveRun` aceita media**

Substituir o bloco `else if (message.kind === "text" && currentNode.node_type === "collect_input") { ... }` por:

```ts
  } else if (currentNode.node_type === "collect_input") {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = captureFromInbound(cfg, message);
    if (captured !== null && cfg.var_key) {
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      // Clearing resume_at here is what cancels the timeout: the
      // scheduler only claims rows whose resume_at is set.
      const { error: capErr } = await db
        .from("flow_runs")
        .update({ vars: newVars, reprompt_count: 0, resume_at: null, wait_kind: null })
        .eq("id", run.id);
      if (!capErr) {
        run.vars = newVars;
        run.reprompt_count = 0;
        run.resume_at = null;
        run.wait_kind = null;
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_kind: message.kind,
          captured_length: typeof captured === "string" ? captured.length : null,
        });
        matched = cfg.next_node_key;
      }
    }
  }
```

No ramo de reprompt de `collect_input`, nada muda (um tipo não aceite conta como resposta desconhecida e aplica a política de fallback).

- [ ] **Step 8: Webhook entrega media ao motor**

Em `src/app/api/whatsapp/webhook/route.ts`, substituir o objeto `message:` passado a `dispatchInboundToFlows` (linhas 796-808) por:

```ts
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : (contentType === 'image' ||
            contentType === 'document' ||
            contentType === 'audio' ||
            contentType === 'video') &&
          mediaUrl
        ? {
            kind: 'media',
            media: {
              type: contentType,
              message_id: (insertedRows[0] as { id: string }).id,
              media_url: mediaUrl,
              mime_type: mediaType ?? null,
              caption: contentText ?? null,
            },
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
```

- [ ] **Step 9: Teste de integração do motor com media**

Acrescentar a `src/lib/flows/dispatch.test.ts`: no estado `h.state` adicionar `updates: [] as { table: string; patch: Record<string, unknown> }[]`; no `builder`, trocar `update: () => b` por:

```ts
      update: (patch: Record<string, unknown>) => {
        h.state.updates.push({ table, patch });
        return b;
      },
```

e no `beforeEach` existente repor `h.state.updates = []`. Depois acrescentar:

```ts
describe("collect_input v2 — media capture", () => {
  const WAITING_RUN = {
    id: "run-9",
    flow_id: "flow-1",
    account_id: "acct-1",
    user_id: "u-1",
    contact_id: "ct-1",
    conversation_id: "cv-1",
    status: "active",
    current_node_key: "ask",
    vars: {},
    reprompt_count: 0,
    resume_at: "2026-09-11T18:00:00Z",
    wait_kind: "reply",
  };
  const MEDIA_NODES = [
    {
      id: "a",
      flow_id: "flow-1",
      node_key: "ask",
      node_type: "collect_input",
      config: { prompt_text: "Envie o comprovativo", var_key: "comp", accept: ["image"], next_node_key: "done" },
    },
    { id: "b", flow_id: "flow-1", node_key: "done", node_type: "end", config: {} },
  ];

  it("stores the media reference and clears the timer", async () => {
    h.state.activeRuns = [WAITING_RUN];
    h.state.nodes = MEDIA_NODES;
    const res = await dispatch({
      kind: "media",
      meta_message_id: "wamid.media",
      media: { type: "image", message_id: "msg-7", media_url: "https://cdn/x.jpg", mime_type: "image/jpeg", caption: null },
    });
    expect(res.consumed).toBe(true);
    const capture = h.state.updates.find((u) => u.table === "flow_runs" && "vars" in u.patch);
    expect(capture?.patch).toMatchObject({
      vars: { comp: { type: "image", message_id: "msg-7" } },
      resume_at: null,
      wait_kind: null,
    });
  });
});
```

Nota: o mock devolve `count: 0` no `then`, por isso `isDuplicateInbound` dá falso. Se o `beforeEach` existente não repuser `activeRuns`/`nodes`, repô-los no fim deste `describe` com `afterEach(() => { h.state.activeRuns = []; h.state.nodes = []; })`.

- [ ] **Step 10: Correr tudo**

Run: `npx vitest run src/lib/flows; npm run typecheck`
Expected: PASS; 0 erros.

- [ ] **Step 11: Commit** (com autorização)

```bash
git add src/lib/flows/collect-input.ts src/lib/flows/collect-input.test.ts src/lib/flows/engine.ts src/lib/flows/dispatch.test.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "feat(flows): wait-for-reply accepts media and times out"
```

---

### Task 6: Scheduler — retomar runs vencidos

**Files:**
- Create: `src/lib/flows/resume.ts`
- Test: `src/lib/flows/resume.test.ts`
- Modify: `src/lib/flows/engine.ts` (exportar `resumeDueRun`)
- Modify: `src/app/api/flows/cron/route.ts`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `FlowRunRow.resume_at/wait_kind` (Task 4), `advanceCurrentNodeKey` com temporizador (Task 5), RPC `claim_due_flow_runs` (Task 1).
- Produces:
  ```ts
  // resume.ts
  export type ResumeDecision =
    | { kind: "advance"; nodeKey: string; event: "timeout" | "interval_elapsed" }
    | { kind: "end"; status: "timed_out"; reason: "reply_timeout" }
    | { kind: "skip"; reason: string };
  export function decideResume(
    waitKind: "reply" | "interval" | null,
    node: { node_type: string; config: Record<string, unknown> } | null,
  ): ResumeDecision
  // engine.ts
  export async function resumeDueRun(run: FlowRunRow): Promise<"advanced" | "completed" | "handed_off" | "skipped">
  ```
  A Task 7 acrescenta o caso `smart_interval` ao `decideResume` já coberto aqui.

- [ ] **Step 1: Testes de `decideResume`**

```ts
import { describe, expect, it } from "vitest";
import { decideResume } from "./resume";

describe("decideResume", () => {
  it("follows timeout_next for a timed-out reply wait", () => {
    expect(
      decideResume("reply", {
        node_type: "collect_input",
        config: { prompt_text: "x", var_key: "v", next_node_key: "ok", timeout_next: "late" },
      }),
    ).toEqual({ kind: "advance", nodeKey: "late", event: "timeout" });
  });

  it("ends timed_out when no timeout_next is wired", () => {
    expect(
      decideResume("reply", { node_type: "collect_input", config: { next_node_key: "ok" } }),
    ).toEqual({ kind: "end", status: "timed_out", reason: "reply_timeout" });
  });

  it("continues after an elapsed interval", () => {
    expect(
      decideResume("interval", { node_type: "smart_interval", config: { mode: "duration", next_node_key: "go" } }),
    ).toEqual({ kind: "advance", nodeKey: "go", event: "interval_elapsed" });
  });

  it("skips when the run moved to a node that doesn't wait", () => {
    expect(decideResume("reply", { node_type: "send_message", config: {} })).toEqual({
      kind: "skip",
      reason: "node_not_waiting:send_message",
    });
  });

  it("skips when the node is gone or wait kind is missing", () => {
    expect(decideResume("reply", null)).toEqual({ kind: "skip", reason: "node_not_found" });
    expect(
      decideResume(null, { node_type: "collect_input", config: {} }),
    ).toEqual({ kind: "skip", reason: "no_wait_kind" });
  });

  it("skips an interval node with no next target", () => {
    expect(
      decideResume("interval", { node_type: "smart_interval", config: { mode: "duration" } }),
    ).toEqual({ kind: "skip", reason: "interval_missing_next" });
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npx vitest run src/lib/flows/resume.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `resume.ts`**

```ts
/**
 * What to do when the scheduler wakes a run whose resume_at elapsed.
 * Pure: the engine loads the run's current node and applies the result.
 */

export type ResumeDecision =
  | { kind: "advance"; nodeKey: string; event: "timeout" | "interval_elapsed" }
  | { kind: "end"; status: "timed_out"; reason: "reply_timeout" }
  | { kind: "skip"; reason: string };

export function decideResume(
  waitKind: "reply" | "interval" | null,
  node: { node_type: string; config: Record<string, unknown> } | null,
): ResumeDecision {
  if (!node) return { kind: "skip", reason: "node_not_found" };
  if (!waitKind) return { kind: "skip", reason: "no_wait_kind" };

  if (waitKind === "reply" && node.node_type === "collect_input") {
    const target = node.config.timeout_next;
    return typeof target === "string" && target
      ? { kind: "advance", nodeKey: target, event: "timeout" }
      : { kind: "end", status: "timed_out", reason: "reply_timeout" };
  }

  if (waitKind === "interval" && node.node_type === "smart_interval") {
    const target = node.config.next_node_key;
    return typeof target === "string" && target
      ? { kind: "advance", nodeKey: target, event: "interval_elapsed" }
      : { kind: "skip", reason: "interval_missing_next" };
  }

  return { kind: "skip", reason: `node_not_waiting:${node.node_type}` };
}
```

- [ ] **Step 4: Correr testes**

Run: `npx vitest run src/lib/flows/resume.test.ts`
Expected: PASS.

- [ ] **Step 5: `resumeDueRun` no engine**

Acrescentar a `engine.ts` (depois de `startNewRun`), e o import `import { decideResume } from "./resume";`:

```ts
/**
 * Scheduler entry point. `run` comes from claim_due_flow_runs, which
 * already cleared resume_at — so a crash between claim and advance
 * leaves an ordinary active run that the stale sweep eventually closes,
 * never a run that fires twice.
 */
export async function resumeDueRun(
  run: FlowRunRow,
): Promise<"advanced" | "completed" | "handed_off" | "skipped"> {
  const db = supabaseAdmin();
  const nodes = await loadAllNodes(db, run.flow_id);
  const node = run.current_node_key ? (nodes.get(run.current_node_key) ?? null) : null;
  const decision = decideResume(run.wait_kind, node);

  if (decision.kind === "skip") {
    await logEvent(db, run.id, "error", run.current_node_key, {
      reason: `resume_skipped:${decision.reason}`,
    });
    return "skipped";
  }

  if (decision.kind === "end") {
    await logEvent(db, run.id, "timeout", run.current_node_key, { reason: decision.reason });
    await endRun(db, run.id, "timed_out", decision.reason);
    return "completed";
  }

  if (decision.event === "timeout") {
    await logEvent(db, run.id, "timeout", run.current_node_key, {
      reason: "reply_timeout",
      advancing_to: decision.nodeKey,
    });
  }
  run.resume_at = null;
  run.wait_kind = null;
  const outcome = await advanceFromNodeKey(db, run, decision.nodeKey, nodes);
  return outcome.outcome;
}
```

- [ ] **Step 6: Cron route — claim + resume + sweep**

Em `src/app/api/flows/cron/route.ts`, acrescentar ao import: `import { resumeDueRun } from '@/lib/flows/engine'` e `import type { FlowRunRow } from '@/lib/flows/types'`. Logo a seguir a `const now = new Date()`, inserir:

```ts
  // 1. Timed waits (migration 042). Claimed in batches of 50; the RPC's
  //    SKIP LOCKED makes overlapping ticks safe. One run failing must
  //    not stop the rest of the batch.
  let resumed = 0
  let failed = 0
  const { data: due, error: claimError } = await admin.rpc('claim_due_flow_runs', {
    p_limit: 50,
  })
  if (claimError) {
    console.error('[flows-cron] claim_due_flow_runs failed:', claimError.message)
  } else {
    for (const run of (due ?? []) as FlowRunRow[]) {
      try {
        const outcome = await resumeDueRun(run)
        if (outcome === 'skipped') failed += 1
        else resumed += 1
      } catch (err) {
        failed += 1
        console.error(
          '[flows-cron] resume failed for run',
          run.id,
          err instanceof Error ? err.message : err,
        )
      }
    }
  }
```

Na query do sweep, acrescentar `.is('resume_at', null)` a seguir a `.eq('status', 'active')` — um run que espera 2 dias num intervalo não é abandono. Trocar os dois `return NextResponse.json(...)` de sucesso por:

```ts
  if (!runs?.length) return NextResponse.json({ resumed, failed, swept: 0 })
```

e, no fim:

```ts
  return NextResponse.json({ resumed, failed, swept })
```

Atualizar o comentário do topo: "Two jobs per tick: resume runs whose `resume_at` elapsed, then sweep abandoned runs. Expected cadence: every 60 s (docker-compose `scheduler` service)."

- [ ] **Step 7: Serviço `scheduler` no Docker**

Acrescentar a `docker-compose.yml`, dentro de `services:`, depois de `app`:

```yaml
  # Wakes timed flow waits (Aguardar resposta timeout, Intervalo
  # inteligente) and sweeps abandoned runs. Calls the app over the
  # compose network every 60 s; AUTOMATION_CRON_SECRET comes from the
  # same .env.local the app reads.
  scheduler:
    image: curlimages/curl:8.11.1
    env_file:
      - .env.local
    depends_on:
      app:
        condition: service_healthy
    restart: unless-stopped
    entrypoint: ['/bin/sh', '-c']
    command:
      - |
        while true; do
          curl -fsS -m 55 -H "x-cron-secret: $${AUTOMATION_CRON_SECRET}" http://app:3000/api/flows/cron || echo "flows cron tick failed"
          echo
          sleep 60
        done
```

- [ ] **Step 8: Verificar**

Run: `npx vitest run src/lib/flows; npm run typecheck; docker compose config --quiet`
Expected: PASS; 0 erros; compose válido (sem output).

- [ ] **Step 9: Commit** (com autorização)

```bash
git add src/lib/flows/resume.ts src/lib/flows/resume.test.ts src/lib/flows/engine.ts src/app/api/flows/cron/route.ts docker-compose.yml
git commit -m "feat(flows): scheduler resumes timed waits every minute"
```

---

### Task 7: Intervalo inteligente + fuso da conta

**Files:**
- Create: `src/lib/flows/smart-interval.ts`
- Test: `src/lib/flows/smart-interval.test.ts`
- Modify: `src/lib/flows/engine.ts` (`loadAccountTimeZone`, ramo `smart_interval`, `isAutoAdvancing`)

**Interfaces:**
- Consumes: `SmartIntervalNodeConfig` (Task 4); `addDuration`, `nextWindowOpening`, `isInsideWeeklyWindow`, `zonedLocalToUtc`, `isValidTimeZone` (Task 3); `advanceCurrentNodeKey` com temporizador (Task 5); `decideResume` já trata `smart_interval` (Task 6).
- Produces:
  ```ts
  // smart-interval.ts
  export type IntervalPlan = { kind: "continue" } | { kind: "wait"; resumeAt: Date } | { kind: "invalid"; reason: string };
  export function planSmartInterval(cfg: SmartIntervalNodeConfig, now: Date, timeZone: string): IntervalPlan
  // engine.ts (interno; reutilizado pela Task 8)
  async function loadAccountTimeZone(db: AdminClient, accountId: string): Promise<string>
  ```

- [ ] **Step 1: Testes**

```ts
import { describe, expect, it } from "vitest";
import { planSmartInterval } from "./smart-interval";

const TZ = "Africa/Luanda";
const now = new Date("2026-09-11T10:00:00Z"); // Friday 11:00 local

describe("planSmartInterval", () => {
  it("waits for a duration", () => {
    expect(
      planSmartInterval({ mode: "duration", duration: { value: 30, unit: "minutes" }, next_node_key: "n" }, now, TZ),
    ).toEqual({ kind: "wait", resumeAt: new Date("2026-09-11T10:30:00Z") });
  });

  it("rejects a missing or non-positive duration", () => {
    expect(planSmartInterval({ mode: "duration", next_node_key: "n" }, now, TZ)).toEqual({
      kind: "invalid",
      reason: "duration_missing",
    });
    expect(
      planSmartInterval({ mode: "duration", duration: { value: -1, unit: "hours" }, next_node_key: "n" }, now, TZ).kind,
    ).toBe("invalid");
  });

  it("waits until a future local datetime", () => {
    expect(planSmartInterval({ mode: "until", until: "2026-09-12T08:00", next_node_key: "n" }, now, TZ)).toEqual({
      kind: "wait",
      resumeAt: new Date("2026-09-12T07:00:00Z"),
    });
  });

  it("continues when the until datetime already passed", () => {
    expect(planSmartInterval({ mode: "until", until: "2026-09-10T08:00", next_node_key: "n" }, now, TZ)).toEqual({
      kind: "continue",
    });
  });

  it("rejects a malformed until", () => {
    expect(planSmartInterval({ mode: "until", until: "amanhã", next_node_key: "n" }, now, TZ)).toEqual({
      kind: "invalid",
      reason: "until_invalid",
    });
  });

  it("continues immediately inside the weekly window", () => {
    expect(
      planSmartInterval(
        { mode: "weekly_window", weekly_window: { friday: { enabled: true, start: "08:00", end: "22:30" } }, next_node_key: "n" },
        now,
        TZ,
      ),
    ).toEqual({ kind: "continue" });
  });

  it("waits for the next opening outside the window", () => {
    const late = new Date("2026-09-11T22:00:00Z"); // 23:00 local Friday
    expect(
      planSmartInterval(
        {
          mode: "weekly_window",
          weekly_window: {
            friday: { enabled: true, start: "08:00", end: "22:30" },
            saturday: { enabled: true, start: "08:00", end: "22:30" },
          },
          next_node_key: "n",
        },
        late,
        TZ,
      ),
    ).toEqual({ kind: "wait", resumeAt: new Date("2026-09-12T07:00:00Z") });
  });

  it("rejects a window with no enabled day", () => {
    expect(planSmartInterval({ mode: "weekly_window", weekly_window: {}, next_node_key: "n" }, now, TZ)).toEqual({
      kind: "invalid",
      reason: "window_empty",
    });
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npx vitest run src/lib/flows/smart-interval.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
/**
 * Decides whether a smart_interval node continues now or waits, and
 * until when. Pure; the engine persists resume_at.
 */

import { addDuration, isInsideWeeklyWindow, nextWindowOpening, zonedLocalToUtc } from "./time";
import type { SmartIntervalNodeConfig } from "./types";

export type IntervalPlan =
  | { kind: "continue" }
  | { kind: "wait"; resumeAt: Date }
  | { kind: "invalid"; reason: string };

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function planSmartInterval(
  cfg: SmartIntervalNodeConfig,
  now: Date,
  timeZone: string,
): IntervalPlan {
  switch (cfg.mode) {
    case "duration": {
      if (!cfg.duration || !(cfg.duration.value > 0)) {
        return { kind: "invalid", reason: "duration_missing" };
      }
      return { kind: "wait", resumeAt: addDuration(now, cfg.duration.value, cfg.duration.unit) };
    }
    case "until": {
      const m = LOCAL_DATETIME.exec(cfg.until ?? "");
      if (!m) return { kind: "invalid", reason: "until_invalid" };
      const at = zonedLocalToUtc(
        { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] },
        timeZone,
      );
      return at.getTime() <= now.getTime() ? { kind: "continue" } : { kind: "wait", resumeAt: at };
    }
    case "weekly_window": {
      const window = cfg.weekly_window ?? {};
      if (isInsideWeeklyWindow(now, timeZone, window)) return { kind: "continue" };
      const opening = nextWindowOpening(now, timeZone, window);
      return opening ? { kind: "wait", resumeAt: opening } : { kind: "invalid", reason: "window_empty" };
    }
    default:
      return { kind: "invalid", reason: "mode_unknown" };
  }
}
```

- [ ] **Step 4: Correr testes**

Run: `npx vitest run src/lib/flows/smart-interval.test.ts`
Expected: PASS.

- [ ] **Step 5: Ligar no engine**

Imports em `engine.ts`:

```ts
import { planSmartInterval } from "./smart-interval";
import { isValidTimeZone } from "./time";
import type { SmartIntervalNodeConfig } from "./types";
```

Helper (junto dos outros loaders):

```ts
const DEFAULT_TIME_ZONE = "Africa/Luanda";

/** Account-local zone for time rules. Falls back to the default on any
 *  read error or an invalid stored value — a bad timezone must not stop
 *  flows from running. */
async function loadAccountTimeZone(db: AdminClient, accountId: string): Promise<string> {
  const { data, error } = await db
    .from("accounts")
    .select("timezone")
    .eq("id", accountId)
    .maybeSingle();
  const tz = (data as { timezone?: string } | null)?.timezone;
  if (error || !tz || !isValidTimeZone(tz)) return DEFAULT_TIME_ZONE;
  return tz;
}
```

Ramo novo em `advanceFromNodeKey`, antes de `if (node.node_type === "handoff")`:

```ts
    if (node.node_type === "smart_interval") {
      const cfg = node.config as unknown as SmartIntervalNodeConfig;
      const timeZone = await loadAccountTimeZone(db, run.account_id);
      const plan = planSmartInterval(cfg, new Date(), timeZone);
      if (plan.kind === "invalid") {
        await logEvent(db, run.id, "error", node.node_key, { reason: `smart_interval_${plan.reason}` });
        await endRun(db, run.id, "failed", "smart_interval_invalid");
        return { outcome: "completed" };
      }
      if (plan.kind === "continue") {
        currentKey = cfg.next_node_key;
        continue;
      }
      const advanced = await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key, {
        resumeAt: plan.resumeAt,
        waitKind: "interval",
      });
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        run.current_node_key = node.node_key;
        await logEvent(db, run.id, "node_entered", node.node_key, {
          waiting_until: plan.resumeAt.toISOString(),
        });
      }
      return { outcome: "advanced" };
    }
```

- [ ] **Step 6: Mensagens durante um intervalo**

Um cliente que escreve enquanto o run está num `smart_interval` não deve avançar o fluxo. Em `handleReplyForActiveRun`, logo a seguir a obter `currentNode`, inserir:

```ts
  // A run sleeping on a timer ignores inbound — the scheduler wakes it.
  // Not consumed, so automations and AI auto-reply can still answer.
  if (currentNode.node_type === "smart_interval") {
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
```

- [ ] **Step 7: Verificar**

Run: `npx vitest run src/lib/flows; npm run typecheck`
Expected: PASS; 0 erros.

- [ ] **Step 8: Commit** (com autorização)

```bash
git add src/lib/flows/smart-interval.ts src/lib/flows/smart-interval.test.ts src/lib/flows/engine.ts
git commit -m "feat(flows): smart interval node with account timezone"
```

---

### Task 8: Condição v2 no motor

**Files:**
- Modify: `src/lib/flows/engine.ts` (`evaluateConditionNode`, ramo `condition`)
- Test: `src/lib/flows/dispatch.test.ts` (novo `describe`)

**Interfaces:**
- Consumes: `normalizeCondition`, `evaluateCondition`, `ruleNeeds`, `RuleFacts` (Task 4); `loadAccountTimeZone` (Task 7).
- Produces: `evaluateConditionNode(db, run, rawConfig): Promise<{ result: boolean; next: string }>` (interno). `evaluateConditionPredicate` continua exportada sem alterações (testes existentes).

- [ ] **Step 1: Teste de integração (falha primeiro)**

Acrescentar a `dispatch.test.ts`. No mock, fazer `rows()` devolver `h.state.tagRows` para `contact_tags` e `[{ timezone: "Africa/Luanda" }]` para `accounts` (acrescentar `tagRows: [] as unknown[]` ao estado e repor no `beforeEach`):

```ts
    if (table === "contact_tags") return h.state.tagRows;
    if (table === "accounts") return [{ timezone: "Africa/Luanda" }];
```

Nota: `maybeSingle` para `accounts` usa `rows(table)[0]`, o que já funciona com o ramo genérico.

```ts
describe("condition v2", () => {
  afterEach(() => {
    vi.useRealTimers();
    h.state.tagRows = [];
  });

  it("routes true when all rules match (tag present + weekday)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-11T10:00:00Z")); // Friday
    h.state.flows = [KEYWORD_FLOW];
    h.state.tagRows = [{ tag_id: "tag-paid" }];
    h.state.nodes = [
      { id: "1", flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "cond" } },
      {
        id: "2",
        flow_id: "flow-1",
        node_key: "cond",
        node_type: "condition",
        config: {
          match: "all",
          rules: [
            { type: "tag", operator: "present", tag_id: "tag-paid" },
            { type: "weekday", operator: "in", days: ["friday"] },
          ],
          true_next: "yes",
          false_next: "no",
        },
      },
      { id: "3", flow_id: "flow-1", node_key: "yes", node_type: "send_message", config: { text: "SIM", next_node_key: "end" } },
      { id: "4", flow_id: "flow-1", node_key: "no", node_type: "send_message", config: { text: "NAO", next_node_key: "end" } },
      { id: "5", flow_id: "flow-1", node_key: "end", node_type: "end", config: {} },
    ];
    await dispatch({ kind: "text", text: "order status", meta_message_id: "wamid.c1" });
    expect(engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: "SIM" }));
    expect(engineSendText).not.toHaveBeenCalledWith(expect.objectContaining({ text: "NAO" }));
  });
});
```

(Importar `afterEach` do `vitest` no topo do ficheiro se ainda não estiver; `engineSendText.mockClear()` deve estar no `beforeEach` existente — se não estiver, acrescentar.)

Run: `npx vitest run src/lib/flows/dispatch.test.ts`
Expected: FAIL — o `evaluateConditionNode` atual lê `cfg.subject` (indefinido) e cai no ramo `contact_field`, lançando `unsupported contact_field`.

- [ ] **Step 2: Reescrever `evaluateConditionNode`**

Substituir a função (`engine.ts:503-542`) e acrescentar os imports `import { evaluateCondition, normalizeCondition, ruleNeeds } from "./condition-rules";`:

```ts
/**
 * Gather only the facts a condition's rules need, then evaluate purely.
 * Legacy single-predicate configs are normalized first, so v1 flows run
 * through the same path.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  rawConfig: Record<string, unknown>,
): Promise<{ result: boolean; next: string }> {
  const cfg = normalizeCondition(rawConfig);
  const needs = ruleNeeds(cfg);
  const contactId = run.contact_id;

  let tagIds = new Set<string>();
  if (needs.tags && contactId) {
    const { data, error } = await db
      .from("contact_tags")
      .select("tag_id")
      .eq("contact_id", contactId);
    if (error) throw new Error(`contact_tags lookup failed: ${error.message}`);
    tagIds = new Set(((data ?? []) as { tag_id: string }[]).map((r) => r.tag_id));
  }

  let customFields: Record<string, string | null> = {};
  if (needs.customFields && contactId) {
    const { data, error } = await db
      .from("contact_custom_values")
      .select("custom_field_id, value")
      .eq("contact_id", contactId);
    if (error) throw new Error(`custom values lookup failed: ${error.message}`);
    customFields = Object.fromEntries(
      ((data ?? []) as { custom_field_id: string; value: string | null }[]).map((r) => [
        r.custom_field_id,
        r.value,
      ]),
    );
  }

  let contact: Record<string, string | null> = {};
  if (needs.contact && contactId) {
    const { data, error } = await db
      .from("contacts")
      .select("name, email, phone, company")
      .eq("id", contactId)
      .maybeSingle();
    if (error) throw new Error(`contact lookup failed: ${error.message}`);
    contact = (data as Record<string, string | null> | null) ?? {};
  }

  const needsClock = cfg.rules.some((r) => r.type === "time" || r.type === "weekday");
  const timeZone = needsClock ? await loadAccountTimeZone(db, run.account_id) : "UTC";

  const result = evaluateCondition(cfg, {
    now: new Date(),
    timeZone,
    vars: run.vars,
    tagIds,
    customFields,
    contact,
  });
  return { result, next: result ? cfg.true_next : cfg.false_next };
}
```

Nota: o teste legado `unsupported contact_field` deixa de lançar — um `contact_field` desconhecido fica simplesmente ausente (a validação na Task 12 impede chaves fora de `name|email|phone|company`). Se algum teste existente depender do throw, atualizá-lo para esperar o ramo `false`/`absent`.

- [ ] **Step 3: Ramo `condition` usa o resultado**

Substituir o ramo `condition` em `advanceFromNodeKey`:

```ts
    if (node.node_type === "condition") {
      let evaluation: { result: boolean; next: string };
      try {
        evaluation = await evaluateConditionNode(db, run, node.config);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey = evaluation.next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: evaluation.result ? "true" : "false",
        advancing_to: currentKey,
      });
      continue;
    }
```

Remover o import agora não usado de `ConditionNodeConfig` em `engine.ts` se o lint o acusar.

- [ ] **Step 4: Verificar**

Run: `npx vitest run src/lib/flows; npm run typecheck; npm run lint`
Expected: PASS; 0 erros.

- [ ] **Step 5: Commit** (com autorização)

```bash
git add src/lib/flows/engine.ts src/lib/flows/dispatch.test.ts
git commit -m "feat(flows): engine evaluates multi-rule conditions"
```

---

### Task 9: Alterar campo personalizado

**Files:**
- Create: `src/lib/flows/set-field.ts`
- Test: `src/lib/flows/set-field.test.ts`
- Modify: `src/lib/flows/engine.ts` (ramo `set_field`)

**Interfaces:**
- Consumes: `SetFieldNodeConfig` (Task 4), `interpolate` (Task 2).
- Produces:
  ```ts
  export type FieldWrite = { kind: "upsert"; value: string } | { kind: "delete" };
  export function computeFieldWrite(
    op: SetFieldNodeConfig["op"], current: string | null, input: string,
  ): { write: FieldWrite; warning: string | null }
  ```

- [ ] **Step 1: Testes**

```ts
import { describe, expect, it } from "vitest";
import { computeFieldWrite } from "./set-field";

describe("computeFieldWrite", () => {
  it("set writes the interpolated input", () => {
    expect(computeFieldWrite("set", "old", "novo")).toEqual({ write: { kind: "upsert", value: "novo" }, warning: null });
  });

  it("clear deletes the value", () => {
    expect(computeFieldWrite("clear", "x", "")).toEqual({ write: { kind: "delete" }, warning: null });
  });

  it("increment adds numbers, accepting comma decimals", () => {
    expect(computeFieldWrite("increment", "1500,50", "499.5")).toEqual({
      write: { kind: "upsert", value: "2000" },
      warning: null,
    });
  });

  it("decrement subtracts", () => {
    expect(computeFieldWrite("decrement", "10", "3")).toEqual({ write: { kind: "upsert", value: "7" }, warning: null });
  });

  it("treats a non-numeric current value as 0 and warns", () => {
    expect(computeFieldWrite("increment", "abc", "2")).toEqual({
      write: { kind: "upsert", value: "2" },
      warning: "current_not_numeric",
    });
    expect(computeFieldWrite("increment", null, "2").warning).toBeNull();
  });

  it("warns and leaves the value when the input isn't numeric", () => {
    expect(computeFieldWrite("increment", "5", "dois")).toEqual({
      write: { kind: "upsert", value: "5" },
      warning: "input_not_numeric",
    });
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npx vitest run src/lib/flows/set-field.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
/**
 * Value arithmetic for the set_field node. Custom field values are
 * stored as text, so numbers are parsed leniently ("1.500,50" is not
 * supported — only a single decimal separator, dot or comma).
 */

import type { SetFieldNodeConfig } from "./types";

export type FieldWrite = { kind: "upsert"; value: string } | { kind: "delete" };

function parseNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw.trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function formatNumber(n: number): string {
  // Round away float noise (0.1 + 0.2) without forcing decimals.
  return String(Math.round(n * 1e6) / 1e6);
}

export function computeFieldWrite(
  op: SetFieldNodeConfig["op"],
  current: string | null,
  input: string,
): { write: FieldWrite; warning: string | null } {
  if (op === "clear") return { write: { kind: "delete" }, warning: null };
  if (op === "set") return { write: { kind: "upsert", value: input }, warning: null };

  const delta = parseNumber(input);
  const base = parseNumber(current);
  const currentBlank = current === null || current.trim() === "";
  if (delta === null) {
    return { write: { kind: "upsert", value: current ?? "0" }, warning: "input_not_numeric" };
  }
  const start = base ?? 0;
  const next = op === "increment" ? start + delta : start - delta;
  return {
    write: { kind: "upsert", value: formatNumber(next) },
    warning: base === null && !currentBlank ? "current_not_numeric" : null,
  };
}
```

- [ ] **Step 4: Correr testes**

Run: `npx vitest run src/lib/flows/set-field.test.ts`
Expected: PASS.

- [ ] **Step 5: Ramo no engine**

Imports: `import { computeFieldWrite } from "./set-field";` e `SetFieldNodeConfig` no import de tipos. Ramo antes de `handoff`:

```ts
    if (node.node_type === "set_field") {
      const cfg = node.config as unknown as SetFieldNodeConfig;
      try {
        if (!run.contact_id) throw new Error("run has no contact");
        // Tenancy: the field must belong to the run's account — node
        // configs are user-authored JSON and must not reach other tenants.
        const { data: field, error: fieldErr } = await db
          .from("custom_fields")
          .select("id")
          .eq("id", cfg.custom_field_id)
          .eq("account_id", run.account_id)
          .maybeSingle();
        if (fieldErr) throw new Error(fieldErr.message);
        if (!field) throw new Error("custom field not found in account");

        const { data: existing } = await db
          .from("contact_custom_values")
          .select("value")
          .eq("contact_id", run.contact_id)
          .eq("custom_field_id", cfg.custom_field_id)
          .maybeSingle();
        const current = (existing as { value: string | null } | null)?.value ?? null;
        const { write, warning } = computeFieldWrite(
          cfg.op,
          current,
          interpolate(cfg.value ?? "", run.vars),
        );
        if (write.kind === "delete") {
          await db
            .from("contact_custom_values")
            .delete()
            .eq("contact_id", run.contact_id)
            .eq("custom_field_id", cfg.custom_field_id);
        } else {
          const { error: upErr } = await db
            .from("contact_custom_values")
            .upsert(
              { contact_id: run.contact_id, custom_field_id: cfg.custom_field_id, value: write.value },
              { onConflict: "contact_id,custom_field_id" },
            );
          if (upErr) throw new Error(upErr.message);
        }
        if (warning) {
          await logEvent(db, run.id, "error", node.node_key, { reason: `set_field_${warning}` });
        }
      } catch (err) {
        // Non-fatal, like set_tag: a field write must not strand the customer.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_field_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
```

- [ ] **Step 6: Verificar**

Run: `npx vitest run src/lib/flows; npm run typecheck`
Expected: PASS; 0 erros.

- [ ] **Step 7: Commit** (com autorização)

```bash
git add src/lib/flows/set-field.ts src/lib/flows/set-field.test.ts src/lib/flows/engine.ts
git commit -m "feat(flows): set custom field node"
```

---

### Task 10: Saltar para outro fluxo

**Files:**
- Create: `src/lib/flows/jump.ts`
- Test: `src/lib/flows/jump.test.ts`
- Modify: `src/lib/flows/engine.ts` (`startJumpRun`, ramo `jump_flow`)
- Test: `src/lib/flows/dispatch.test.ts` (novo `describe`)

**Interfaces:**
- Consumes: `JumpFlowNodeConfig` (Task 4), `endRun`, `loadFlow`, `loadAllNodes`, `advanceFromNodeKey` (engine atual).
- Produces:
  ```ts
  // jump.ts
  export const MAX_JUMP_DEPTH = 5;
  export const JUMP_DEPTH_VAR = "__jump_depth";
  export function nextJumpDepth(vars: Record<string, unknown>): number
  export function canJump(args: { currentFlowId: string; target: { id: string; status: string; account_id: string; entry_node_id: string | null } | null; accountId: string; depth: number }): { ok: true } | { ok: false; reason: "jump_depth_exceeded" | "jump_target_unavailable" | "jump_to_self" }
  ```

- [ ] **Step 1: Testes puros**

```ts
import { describe, expect, it } from "vitest";
import { canJump, MAX_JUMP_DEPTH, nextJumpDepth } from "./jump";

const target = { id: "f2", status: "active", account_id: "acct-1", entry_node_id: "start" };

describe("nextJumpDepth", () => {
  it("starts at 1 and increments", () => {
    expect(nextJumpDepth({})).toBe(1);
    expect(nextJumpDepth({ __jump_depth: 2 })).toBe(3);
    expect(nextJumpDepth({ __jump_depth: "junk" })).toBe(1);
  });
});

describe("canJump", () => {
  const base = { currentFlowId: "f1", target, accountId: "acct-1", depth: 1 };

  it("allows an active target in the same account", () => {
    expect(canJump(base)).toEqual({ ok: true });
  });
  it("blocks past the depth limit", () => {
    expect(canJump({ ...base, depth: MAX_JUMP_DEPTH + 1 })).toEqual({ ok: false, reason: "jump_depth_exceeded" });
    expect(canJump({ ...base, depth: MAX_JUMP_DEPTH })).toEqual({ ok: true });
  });
  it("blocks missing, inactive, foreign or entry-less targets", () => {
    expect(canJump({ ...base, target: null })).toEqual({ ok: false, reason: "jump_target_unavailable" });
    expect(canJump({ ...base, target: { ...target, status: "draft" } }).ok).toBe(false);
    expect(canJump({ ...base, target: { ...target, account_id: "other" } }).ok).toBe(false);
    expect(canJump({ ...base, target: { ...target, entry_node_id: null } }).ok).toBe(false);
  });
  it("blocks jumping to the same flow", () => {
    expect(canJump({ ...base, target: { ...target, id: "f1" } })).toEqual({ ok: false, reason: "jump_to_self" });
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npx vitest run src/lib/flows/jump.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `jump.ts`**

```ts
/**
 * Guards for the jump_flow node. A jump ends the current run and starts
 * the target flow for the same contact, carrying vars. The depth counter
 * lives in vars so a chain A→B→A→B… stops at MAX_JUMP_DEPTH instead of
 * looping forever.
 */

export const MAX_JUMP_DEPTH = 5;
export const JUMP_DEPTH_VAR = "__jump_depth";

export function nextJumpDepth(vars: Record<string, unknown>): number {
  const raw = vars[JUMP_DEPTH_VAR];
  const current = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  return current + 1;
}

export function canJump(args: {
  currentFlowId: string;
  target: { id: string; status: string; account_id: string; entry_node_id: string | null } | null;
  accountId: string;
  depth: number;
}):
  | { ok: true }
  | { ok: false; reason: "jump_depth_exceeded" | "jump_target_unavailable" | "jump_to_self" } {
  if (args.depth > MAX_JUMP_DEPTH) return { ok: false, reason: "jump_depth_exceeded" };
  const t = args.target;
  if (!t || t.status !== "active" || t.account_id !== args.accountId || !t.entry_node_id) {
    return { ok: false, reason: "jump_target_unavailable" };
  }
  if (t.id === args.currentFlowId) return { ok: false, reason: "jump_to_self" };
  return { ok: true };
}
```

- [ ] **Step 4: Correr testes puros**

Run: `npx vitest run src/lib/flows/jump.test.ts`
Expected: PASS.

- [ ] **Step 5: Engine — `startJumpRun` e ramo `jump_flow`**

Imports: `import { canJump, JUMP_DEPTH_VAR, nextJumpDepth } from "./jump";` e `JumpFlowNodeConfig` no import de tipos.

Helper (depois de `startNewRun`):

```ts
/**
 * Start `flow` for the contact of a run that just ended via jump_flow.
 * The previous run is already ended, so the one-active-run-per-contact
 * index accepts the INSERT.
 */
async function startJumpRun(
  db: AdminClient,
  from: FlowRunRow,
  flow: FlowRow,
  vars: Record<string, unknown>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  const { data: inserted, error } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      account_id: flow.account_id,
      user_id: flow.user_id,
      contact_id: from.contact_id,
      conversation_id: from.conversation_id,
      status: "active",
      current_node_key: flow.entry_node_id,
      vars,
    })
    .select("*")
    .maybeSingle();
  if (error || !inserted) {
    console.error("[flows] startJumpRun insert error:", error?.message);
    return { outcome: "completed" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: "jump",
    from_run_id: from.id,
  });
  const { error: incErr } = await db.rpc("increment_flow_execution_count", { p_flow_id: flow.id });
  if (incErr) console.error("[flows] execution_count rpc error:", incErr.message);
  const nodes = await loadAllNodes(db, flow.id);
  return advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
}
```

Ramo em `advanceFromNodeKey`, antes de `handoff`:

```ts
    if (node.node_type === "jump_flow") {
      const cfg = node.config as unknown as JumpFlowNodeConfig;
      const depth = nextJumpDepth(run.vars);
      const target = cfg.target_flow_id ? await loadFlow(db, cfg.target_flow_id) : null;
      const verdict = canJump({
        currentFlowId: run.flow_id,
        target,
        accountId: run.account_id,
        depth,
      });
      if (!verdict.ok) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: verdict.reason,
          target_flow_id: cfg.target_flow_id ?? null,
        });
        await endRun(db, run.id, "failed", verdict.reason);
        return { outcome: "completed" };
      }
      await logEvent(db, run.id, "completed", node.node_key, {
        reason: "jump",
        target_flow_id: target!.id,
      });
      await endRun(db, run.id, "completed", "jump");
      return startJumpRun(db, run, target!, { ...run.vars, [JUMP_DEPTH_VAR]: depth });
    }
```

- [ ] **Step 6: Teste de integração**

Acrescentar a `dispatch.test.ts` (o mock de `flows` devolve `h.state.flows`; `maybeSingle` para `flows` usa o primeiro — por isso o teste coloca o fluxo destino em primeiro lugar só depois do início, via `mockTarget`). Acrescentar ao estado `flowById: {} as Record<string, unknown>`; no builder, guardar o último `eq("id", v)` e usá-lo em `maybeSingle` para `flows`:

```ts
      eq: (col: string, v: unknown) => {
        if (col === "id") lastId = v as string;
        return b;
      },
```

(com `let lastId: string | null = null;` no início de `builder`) e, em `maybeSingle`:

```ts
        data:
          table === "flow_runs"
            ? h.state.insertedRun
            : table === "flows" && lastId && h.state.flowById[lastId]
              ? h.state.flowById[lastId]
              : (rows(table)[0] ?? null),
```

```ts
describe("jump_flow", () => {
  it("ends the current run and starts the target flow with depth 1", async () => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.flowById = {
      "flow-2": { ...KEYWORD_FLOW, id: "flow-2", trigger_type: "manual", entry_node_id: "start" },
    };
    h.state.nodes = [
      { id: "1", flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "jump" } },
      { id: "2", flow_id: "flow-1", node_key: "jump", node_type: "jump_flow", config: { target_flow_id: "flow-2" } },
    ];
    await dispatch({ kind: "text", text: "order status", meta_message_id: "wamid.j1" });
    const runs = startedRuns();
    expect(runs).toHaveLength(2);
    expect(runs[1].row).toMatchObject({ flow_id: "flow-2", vars: { __jump_depth: 1 } });
  });

  it("fails the run when the target is inactive", async () => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.flowById = { "flow-2": { ...KEYWORD_FLOW, id: "flow-2", status: "draft" } };
    h.state.nodes = [
      { id: "1", flow_id: "flow-1", node_key: "start", node_type: "start", config: { next_node_key: "jump" } },
      { id: "2", flow_id: "flow-1", node_key: "jump", node_type: "jump_flow", config: { target_flow_id: "flow-2" } },
    ];
    await dispatch({ kind: "text", text: "order status", meta_message_id: "wamid.j2" });
    expect(startedRuns()).toHaveLength(1);
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({ table: "flow_runs", patch: expect.objectContaining({ end_reason: "jump_target_unavailable" }) }),
    );
  });
});
```

Repor `h.state.flowById = {}` no `beforeEach`.

- [ ] **Step 7: Verificar**

Run: `npx vitest run src/lib/flows; npm run typecheck`
Expected: PASS; 0 erros.

- [ ] **Step 8: Commit** (com autorização)

```bash
git add src/lib/flows/jump.ts src/lib/flows/jump.test.ts src/lib/flows/engine.ts src/lib/flows/dispatch.test.ts
git commit -m "feat(flows): jump to another flow with depth guard"
```

---

### Task 11: Distribuidor

**Files:**
- Create: `src/lib/flows/distributor.ts`
- Test: `src/lib/flows/distributor.test.ts`
- Modify: `src/lib/flows/engine.ts` (ramo `distributor`)

**Interfaces:**
- Consumes: `DistributorNodeConfig` (Task 4); RPC `pick_distributor_output` (Task 1).
- Produces:
  ```ts
  export function usableOutputs(cfg: DistributorNodeConfig): DistributorNodeConfig["outputs"]
  export function resolveDistributorTarget(cfg: DistributorNodeConfig, pickedId: string | null): { nodeKey: string; outputId: string; fallback: boolean } | null
  ```

- [ ] **Step 1: Testes**

```ts
import { describe, expect, it } from "vitest";
import { resolveDistributorTarget, usableOutputs } from "./distributor";

const cfg = {
  outputs: [
    { id: "a", label: "A", weight: 50, next_node_key: "to_a" },
    { id: "b", label: "B", weight: 50, next_node_key: "to_b" },
    { id: "c", label: "C", weight: 0, next_node_key: "to_c" },
    { id: "d", label: "D", weight: 10, next_node_key: "" },
  ],
};

describe("usableOutputs", () => {
  it("keeps only positive weights with a target", () => {
    expect(usableOutputs(cfg).map((o) => o.id)).toEqual(["a", "b"]);
  });
});

describe("resolveDistributorTarget", () => {
  it("uses the picked output", () => {
    expect(resolveDistributorTarget(cfg, "b")).toEqual({ nodeKey: "to_b", outputId: "b", fallback: false });
  });
  it("falls back to the first usable output when the pick is null or unusable", () => {
    expect(resolveDistributorTarget(cfg, null)).toEqual({ nodeKey: "to_a", outputId: "a", fallback: true });
    expect(resolveDistributorTarget(cfg, "c")).toEqual({ nodeKey: "to_a", outputId: "a", fallback: true });
  });
  it("returns null when nothing is usable", () => {
    expect(resolveDistributorTarget({ outputs: [] }, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npx vitest run src/lib/flows/distributor.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```ts
/**
 * Output resolution for the distributor node. The weighted pick itself
 * happens in SQL (pick_distributor_output) so it stays exact under
 * concurrent webhooks; this module filters unusable outputs and chooses
 * a deterministic fallback if the RPC fails.
 */

import type { DistributorNodeConfig } from "./types";

export function usableOutputs(cfg: DistributorNodeConfig): DistributorNodeConfig["outputs"] {
  return (cfg.outputs ?? []).filter((o) => o.id && o.weight > 0 && o.next_node_key);
}

export function resolveDistributorTarget(
  cfg: DistributorNodeConfig,
  pickedId: string | null,
): { nodeKey: string; outputId: string; fallback: boolean } | null {
  const usable = usableOutputs(cfg);
  if (!usable.length) return null;
  const picked = pickedId ? usable.find((o) => o.id === pickedId) : undefined;
  const chosen = picked ?? usable[0];
  return { nodeKey: chosen.next_node_key, outputId: chosen.id, fallback: !picked };
}
```

- [ ] **Step 4: Correr testes**

Run: `npx vitest run src/lib/flows/distributor.test.ts`
Expected: PASS.

- [ ] **Step 5: Ramo no engine**

Imports: `import { resolveDistributorTarget, usableOutputs } from "./distributor";` e `DistributorNodeConfig`. Ramo antes de `handoff`:

```ts
    if (node.node_type === "distributor") {
      const cfg = node.config as unknown as DistributorNodeConfig;
      const outputs = usableOutputs(cfg).map((o) => ({ id: o.id, weight: o.weight }));
      let pickedId: string | null = null;
      if (outputs.length) {
        const { data, error } = await db.rpc("pick_distributor_output", {
          p_flow_id: run.flow_id,
          p_node_key: node.node_key,
          p_outputs: outputs,
        });
        if (error) {
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "distributor_pick_failed",
            detail: error.message,
          });
        } else {
          pickedId = typeof data === "string" ? data : null;
        }
      }
      const target = resolveDistributorTarget(cfg, pickedId);
      if (!target) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "distributor_no_outputs" });
        await endRun(db, run.id, "failed", "distributor_no_outputs");
        return { outcome: "completed" };
      }
      await logEvent(db, run.id, "node_entered", node.node_key, {
        distributor_output: target.outputId,
        fallback: target.fallback,
      });
      currentKey = target.nodeKey;
      continue;
    }
```

Nota: o mock de `rpc` em `dispatch.test.ts` devolve `{ error: null }` sem `data`, o que exercita o caminho de fallback — suficiente para não partir testes existentes.

- [ ] **Step 6: Verificar**

Run: `npx vitest run src/lib/flows; npm run typecheck`
Expected: PASS; 0 erros.

- [ ] **Step 7: Commit** (com autorização)

```bash
git add src/lib/flows/distributor.ts src/lib/flows/distributor.test.ts src/lib/flows/engine.ts
git commit -m "feat(flows): weighted distributor node"
```

---

### Task 12: Validação e arestas dos blocos novos

**Files:**
- Modify: `src/components/flows/shared.tsx` (`NodeType`, `NODE_META`, `NODE_HUE`, filtro do menu)
- Modify: `src/lib/flows/edges.ts`
- Modify: `src/lib/flows/validate.ts`
- Test: `src/lib/flows/edges.test.ts`, `src/lib/flows/validate.test.ts`

**Interfaces:**
- Consumes: configs da Task 4; `normalizeCondition` (Task 4); `parseHHmm`, `isValidTimeZone` não são necessários aqui.
- Produces:
  - Handles de canvas: `next` (smart_interval, set_field), `timeout` (collect_input com `timeout`), `out:<output_id>` (distributor); `jump_flow` sem saídas.
  - `export const ENGINE_ONLY_NODE_TYPES: ReadonlySet<NodeType>` em `shared.tsx` — tipos que o motor executa mas que ainda não têm formulário (o Plano D esvazia este set).
  - `validateFlowForActivation(flow, nodes, opts?: { activeFlowIds?: ReadonlySet<string>; flowId?: string })` — `opts` usado para validar `jump_flow`.

- [ ] **Step 1: Tipos do editor**

Em `shared.tsx`, acrescentar ao import de `lucide-react`: `CornerUpRight, PencilLine, Shuffle, Timer`. Alargar `NodeType`:

```ts
export type NodeType =
  | 'start'
  | 'send_message'
  | 'send_buttons'
  | 'send_list'
  | 'send_media'
  | 'collect_input'
  | 'condition'
  | 'set_tag'
  | 'handoff'
  | 'end'
  | 'smart_interval'
  | 'set_field'
  | 'jump_flow'
  | 'distributor';

/**
 * Node types the engine runs but the builder can't configure yet (their
 * forms ship in plan D). Hidden from the add-step menu so nobody can drop
 * an unconfigurable block; flows that already contain them still render.
 */
export const ENGINE_ONLY_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'smart_interval',
  'set_field',
  'jump_flow',
  'distributor',
]);
```

Entradas em `NODE_META`:

```ts
  smart_interval: {
    label: 'Smart interval',
    icon: Timer,
    color: 'text-cyan-400',
    blurb: 'Pause for a duration, until a time, or until business hours',
    category: 'logic',
  },
  set_field: {
    label: 'Set field',
    icon: PencilLine,
    color: 'text-lime-400',
    blurb: 'Set, add to, or clear a contact custom field',
    category: 'logic',
  },
  jump_flow: {
    label: 'Jump to flow',
    icon: CornerUpRight,
    color: 'text-orange-400',
    blurb: 'End this flow and start another one',
    category: 'flow',
  },
  distributor: {
    label: 'Distributor',
    icon: Shuffle,
    color: 'text-fuchsia-400',
    blurb: 'Split contacts across paths by percentage',
    category: 'flow',
  },
```

Entradas em `NODE_HUE`:

```ts
  smart_interval: { l: 0.68, c: 0.11, h: 200 }, // cyan — waiting
  set_field: { l: 0.7, c: 0.15, h: 130 }, // lime — data write
  jump_flow: { l: 0.68, c: 0.16, h: 45 }, // orange — leaves the flow
  distributor: { l: 0.64, c: 0.17, h: 320 }, // fuchsia — split
```

Na função de agrupamento (linha ~183), trocar o filtro por:

```ts
    types: types.filter(
      (t) => NODE_META[t].category === id && !ENGINE_ONLY_NODE_TYPES.has(t)
    ),
```

Run: `npm run typecheck`
Expected: erros de exaustividade só em `edges.ts` (resolvidos no passo 3) e em qualquer `Record<NodeType, …>` adicional — acrescentar as 4 chaves a cada um que o compilador indicar, com os mesmos rótulos de `NODE_META`.

- [ ] **Step 2: Testes de arestas (falham primeiro)**

Acrescentar a `edges.test.ts`:

```ts
describe("v2 node edges", () => {
  const nodes = [
    { node_key: "wait", node_type: "collect_input", config: { prompt_text: "p", var_key: "v", next_node_key: "ok", timeout: { value: 1, unit: "hours" }, timeout_next: "late" } },
    { node_key: "pause", node_type: "smart_interval", config: { mode: "duration", next_node_key: "field" } },
    { node_key: "field", node_type: "set_field", config: { custom_field_id: "cf", op: "set", next_node_key: "split" } },
    { node_key: "split", node_type: "distributor", config: { outputs: [{ id: "a", label: "A", weight: 50, next_node_key: "ok" }, { id: "b", label: "B", weight: 50, next_node_key: "late" }] } },
    { node_key: "ok", node_type: "jump_flow", config: { target_flow_id: "f2" } },
    { node_key: "late", node_type: "end", config: {} },
  ] as BuilderNode[];

  it("derives next, timeout and distributor edges", () => {
    const handles = deriveCanvasEdges(nodes).map((e) => `${e.source}:${e.sourceHandle}->${e.target}`);
    expect(handles).toEqual([
      "wait:next->ok",
      "wait:timeout->late",
      "pause:next->field",
      "field:next->split",
      "split:out:a->ok",
      "split:out:b->late",
    ]);
  });

  it("lists slots per node", () => {
    expect(outgoingSlots(nodes[0]).map((s) => s.id)).toEqual(["next", "timeout"]);
    expect(outgoingSlots(nodes[3]).map((s) => s.id)).toEqual(["out:a", "out:b"]);
    expect(outgoingSlots(nodes[4])).toEqual([]);
  });

  it("collect_input without timeout exposes only next", () => {
    expect(outgoingSlots({ node_key: "x", node_type: "collect_input", config: {} }).map((s) => s.id)).toEqual(["next"]);
  });

  it("connects and unlinks the new handles", () => {
    expect(applyEdgeConnection(nodes[0], "timeout", "z")).toEqual({ timeout_next: "z" });
    expect(applyEdgeConnection(nodes[3], "out:b", "z")).toEqual({
      outputs: [
        { id: "a", label: "A", weight: 50, next_node_key: "ok" },
        { id: "b", label: "B", weight: 50, next_node_key: "z" },
      ],
    });
    expect(applyEdgeConnection(nodes[4], "next", "z")).toBeNull();
    const unlinked = unlinkNodeReferences(nodes, "late");
    expect(unlinked[0].config).toMatchObject({ timeout_next: "" });
    expect((unlinked[3].config as { outputs: { next_node_key: string }[] }).outputs[1].next_node_key).toBe("");
  });
});
```

(Garantir que `deriveCanvasEdges`, `outgoingSlots`, `applyEdgeConnection`, `unlinkNodeReferences` e o tipo `BuilderNode` estão importados no topo do ficheiro de teste.)

Run: `npx vitest run src/lib/flows/edges.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar em `edges.ts`**

Em `deriveCanvasEdges`, acrescentar `case "smart_interval": case "set_field":` ao grupo de `next`. Depois do `break` desse grupo, acrescentar o `timeout` de `collect_input` — substituir o `case "collect_input":` no grupo por um caso próprio:

```ts
      case "collect_input": {
        const c = cfg as { next_node_key?: string; timeout?: unknown; timeout_next?: string };
        if (c.next_node_key && knownKeys.has(c.next_node_key)) {
          edges.push({
            id: `${node.node_key}--next--${c.next_node_key}`,
            source: node.node_key,
            target: c.next_node_key,
            sourceHandle: "next",
          });
        }
        if (c.timeout && c.timeout_next && knownKeys.has(c.timeout_next)) {
          edges.push({
            id: `${node.node_key}--timeout--${c.timeout_next}`,
            source: node.node_key,
            target: c.timeout_next,
            sourceHandle: "timeout",
            label: "timeout",
          });
        }
        break;
      }

      case "distributor": {
        for (const o of distributorOutputs(cfg)) {
          if (!o.next_node_key || !knownKeys.has(o.next_node_key)) continue;
          edges.push({
            id: `${node.node_key}--out:${o.id}--${o.next_node_key}`,
            source: node.node_key,
            target: o.next_node_key,
            sourceHandle: `out:${o.id}`,
            label: `${o.label || o.id} (${o.weight}%)`,
          });
        }
        break;
      }

      case "jump_flow":
```

(o `case "jump_flow":` fica a cair em `handoff`/`end`, sem arestas). Helper no fim do ficheiro:

```ts
function distributorOutputs(
  cfg: Record<string, unknown>,
): Array<{ id: string; label: string; weight: number; next_node_key: string }> {
  const raw = Array.isArray((cfg as { outputs?: unknown }).outputs)
    ? ((cfg as { outputs: Array<Record<string, unknown>> }).outputs)
    : [];
  return raw
    .filter((o) => typeof o.id === "string" && o.id)
    .map((o) => ({
      id: o.id as string,
      label: typeof o.label === "string" ? o.label : "",
      weight: typeof o.weight === "number" ? o.weight : 0,
      next_node_key: typeof o.next_node_key === "string" ? o.next_node_key : "",
    }));
}
```

`outgoingSlots`:

```ts
    case "start":
    case "send_message":
    case "send_media":
    case "set_tag":
    case "smart_interval":
    case "set_field":
      return [{ id: "next", label: "Next" }];

    case "collect_input":
      return (cfg as { timeout?: unknown }).timeout
        ? [
            { id: "next", label: "Next" },
            { id: "timeout", label: "Timeout" },
          ]
        : [{ id: "next", label: "Next" }];

    case "distributor":
      return distributorOutputs(cfg).map((o) => ({
        id: `out:${o.id}`,
        label: `${o.label || o.id} (${o.weight}%)`,
      }));

    case "jump_flow":
      return [];
```

`applyEdgeConnection`:

```ts
    case "start":
    case "send_message":
    case "send_media":
    case "set_tag":
    case "smart_interval":
    case "set_field":
      if (sourceHandle === "next") return { next_node_key: targetKey };
      return null;

    case "collect_input":
      if (sourceHandle === "next") return { next_node_key: targetKey };
      if (sourceHandle === "timeout") return { timeout_next: targetKey };
      return null;

    case "distributor": {
      if (!sourceHandle.startsWith("out:")) return null;
      const outputId = sourceHandle.slice("out:".length);
      const outputs = Array.isArray((node.config as { outputs?: unknown }).outputs)
        ? ((node.config as { outputs: Array<Record<string, unknown>> }).outputs)
        : [];
      if (!outputs.some((o) => o.id === outputId)) return null;
      return {
        outputs: outputs.map((o) => (o.id === outputId ? { ...o, next_node_key: targetKey } : o)),
      };
    }

    case "jump_flow":
      return null;
```

`patchedConfigWithoutKey`:

```ts
    case "start":
    case "send_message":
    case "send_media":
    case "set_tag":
    case "smart_interval":
    case "set_field": {
      const next = (cfg as { next_node_key?: string }).next_node_key;
      if (next !== deletedKey) return null;
      return { ...cfg, next_node_key: "" };
    }

    case "collect_input": {
      const c = cfg as { next_node_key?: string; timeout_next?: string };
      const nextMatch = c.next_node_key === deletedKey;
      const timeoutMatch = c.timeout_next === deletedKey;
      if (!nextMatch && !timeoutMatch) return null;
      return {
        ...cfg,
        ...(nextMatch ? { next_node_key: "" } : {}),
        ...(timeoutMatch ? { timeout_next: "" } : {}),
      };
    }

    case "distributor": {
      const outputs = Array.isArray((cfg as { outputs?: unknown }).outputs)
        ? ((cfg as { outputs: Array<Record<string, unknown>> }).outputs)
        : [];
      if (!outputs.some((o) => o.next_node_key === deletedKey)) return null;
      return {
        ...cfg,
        outputs: outputs.map((o) => (o.next_node_key === deletedKey ? { ...o, next_node_key: "" } : o)),
      };
    }

    case "jump_flow":
      return null;
```

Remover `"collect_input"` dos grupos antigos onde passou a ter caso próprio. Atualizar o comentário do topo com os handles `timeout` e `out:<id>`.

Run: `npx vitest run src/lib/flows/edges.test.ts; npm run typecheck`
Expected: PASS; 0 erros.

- [ ] **Step 4: Testes de validação (falham primeiro)**

Acrescentar a `validate.test.ts`:

```ts
describe("v2 node validation", () => {
  const flow = { name: "F", trigger_type: "manual" as const, trigger_config: {}, entry_node_id: "start" };
  const end = { node_key: "end", node_type: "end", config: {} };
  const errorsFor = (node: { node_key: string; node_type: string; config: Record<string, unknown> }, opts?: Parameters<typeof validateFlowForActivation>[2]) =>
    validateFlowForActivation(
      flow,
      [{ node_key: "start", node_type: "start", config: { next_node_key: node.node_key } }, node, end],
      opts,
    ).filter((i) => i.severity === "error" && i.node_key === node.node_key);

  it("smart_interval requires a valid mode config", () => {
    expect(errorsFor({ node_key: "p", node_type: "smart_interval", config: { mode: "duration", next_node_key: "end" } }).map((i) => i.field)).toContain("duration");
    expect(errorsFor({ node_key: "p", node_type: "smart_interval", config: { mode: "until", until: "x", next_node_key: "end" } }).map((i) => i.field)).toContain("until");
    expect(errorsFor({ node_key: "p", node_type: "smart_interval", config: { mode: "weekly_window", weekly_window: {}, next_node_key: "end" } }).map((i) => i.field)).toContain("weekly_window");
    expect(errorsFor({ node_key: "p", node_type: "smart_interval", config: { mode: "duration", duration: { value: 5, unit: "minutes" }, next_node_key: "end" } })).toEqual([]);
  });

  it("set_field requires a field, a known op and a numeric-looking value for math", () => {
    expect(errorsFor({ node_key: "s", node_type: "set_field", config: { op: "set", next_node_key: "end" } }).map((i) => i.field)).toContain("custom_field_id");
    expect(errorsFor({ node_key: "s", node_type: "set_field", config: { custom_field_id: "cf", op: "multiply", next_node_key: "end" } }).map((i) => i.field)).toContain("op");
    expect(errorsFor({ node_key: "s", node_type: "set_field", config: { custom_field_id: "cf", op: "clear", next_node_key: "end" } })).toEqual([]);
  });

  it("distributor weights must sum to 100 with every output wired", () => {
    const bad = { node_key: "d", node_type: "distributor", config: { outputs: [{ id: "a", label: "A", weight: 60, next_node_key: "end" }, { id: "b", label: "B", weight: 30, next_node_key: "" }] } };
    const fields = errorsFor(bad).map((i) => i.field);
    expect(fields).toContain("outputs");
    expect(fields).toContain("outputs.1.next_node_key");
    const good = { node_key: "d", node_type: "distributor", config: { outputs: [{ id: "a", label: "A", weight: 50, next_node_key: "end" }, { id: "b", label: "B", weight: 50, next_node_key: "end" }] } };
    expect(errorsFor(good)).toEqual([]);
  });

  it("jump_flow needs an active target other than itself", () => {
    const node = { node_key: "j", node_type: "jump_flow", config: { target_flow_id: "f2" } };
    expect(errorsFor(node, { flowId: "f1", activeFlowIds: new Set(["f1"]) }).map((i) => i.field)).toContain("target_flow_id");
    expect(errorsFor({ ...node, config: { target_flow_id: "f1" } }, { flowId: "f1", activeFlowIds: new Set(["f1"]) }).map((i) => i.field)).toContain("target_flow_id");
    expect(errorsFor(node, { flowId: "f1", activeFlowIds: new Set(["f2"]) })).toEqual([]);
    // Without opts (client-side draft check) only presence is enforced.
    expect(errorsFor(node)).toEqual([]);
  });

  it("collect_input timeout needs a positive value and a timeout target", () => {
    const node = { node_key: "c", node_type: "collect_input", config: { prompt_text: "p", var_key: "v", next_node_key: "end", timeout: { value: 0, unit: "hours" } } };
    const fields = errorsFor(node).map((i) => i.field);
    expect(fields).toContain("timeout");
    expect(fields).toContain("timeout_next");
  });

  it("collect_input rejects unknown accept kinds", () => {
    const node = { node_key: "c", node_type: "collect_input", config: { prompt_text: "p", var_key: "v", next_node_key: "end", accept: ["video"] } };
    expect(errorsFor(node).map((i) => i.field)).toContain("accept");
  });

  it("condition v2 validates each rule", () => {
    const node = {
      node_key: "k",
      node_type: "condition",
      config: {
        match: "all",
        rules: [
          { type: "time", operator: "between", start: "25:00", end: "08:00" },
          { type: "contact_field", key: "password", operator: "equals", value: "x" },
          { type: "weekday", operator: "in", days: [] },
        ],
        true_next: "end",
        false_next: "end",
      },
    };
    expect(errorsFor(node).map((i) => i.field)).toEqual(["rules.0", "rules.1", "rules.2"]);
  });

  it("condition v2 with no rules is an error; legacy configs still validate as before", () => {
    expect(errorsFor({ node_key: "k", node_type: "condition", config: { match: "all", rules: [], true_next: "end", false_next: "end" } }).map((i) => i.field)).toContain("rules");
    expect(errorsFor({ node_key: "k", node_type: "condition", config: { subject: "var", subject_key: "x", operator: "present", true_next: "end", false_next: "end" } })).toEqual([]);
  });
});
```

Run: `npx vitest run src/lib/flows/validate.test.ts`
Expected: FAIL.

- [ ] **Step 5: Implementar em `validate.ts`**

Imports: `import { parseHHmm } from "./time";`. Assinatura:

```ts
export interface ValidateOptions {
  /** This flow's id — a jump to itself is rejected. */
  flowId?: string;
  /** Ids of active flows in the account. When omitted, jump targets are only checked for presence. */
  activeFlowIds?: ReadonlySet<string>;
}

export function validateFlowForActivation(
  flow: FlowInput,
  nodes: NodeInput[],
  opts: ValidateOptions = {},
): ValidationIssue[] {
```

e passar `opts` a `validateNode(n, keys, opts)`.

Helper partilhado (depois de `validateTrigger`):

```ts
function requireTarget(
  issues: ValidationIssue[],
  node: NodeInput,
  field: string,
  target: unknown,
  knownKeys: Set<string>,
  label: string,
): void {
  if (typeof target !== "string" || !target) {
    issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message: `${label} must point to a next node.` });
  } else if (!knownKeys.has(target)) {
    issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message: `${label} points to non-existent node "${target}".` });
  }
}

function nodeError(node: NodeInput, field: string, message: string): ValidationIssue {
  return { severity: "error", scope: "node", node_key: node.node_key, field, message };
}

const DURATION_UNITS = ["minutes", "hours", "days"];
const CONTACT_FIELD_KEYS = ["name", "email", "phone", "company"];
const WEEKDAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function isValidDuration(d: unknown): boolean {
  const v = d as { value?: unknown; unit?: unknown } | undefined;
  return !!v && typeof v.value === "number" && v.value > 0 && DURATION_UNITS.includes(String(v.unit));
}
```

No `case "collect_input"`, antes do `break`:

```ts
      const v2 = node.config as { accept?: unknown; timeout?: unknown; timeout_next?: unknown };
      if (v2.accept !== undefined) {
        const ok = Array.isArray(v2.accept) && v2.accept.every((k) => ["text", "image", "document"].includes(String(k)));
        if (!ok) issues.push(nodeError(node, "accept", "Accepted reply types must be text, image or document."));
      }
      if (v2.timeout !== undefined) {
        if (!isValidDuration(v2.timeout)) issues.push(nodeError(node, "timeout", "Timeout needs a positive value and a unit."));
        requireTarget(issues, node, "timeout_next", v2.timeout_next, knownKeys, "Timeout");
      }
```

Substituir o início do `case "condition"` para bifurcar v2 vs legado:

```ts
    case "condition": {
      if (Array.isArray((node.config as { rules?: unknown }).rules)) {
        issues.push(...validateConditionV2(node, knownKeys));
        break;
      }
      // ...código legado existente, sem alterações...
```

Função nova:

```ts
function validateConditionV2(node: NodeInput, knownKeys: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cfg = node.config as { match?: unknown; rules: Array<Record<string, unknown>>; true_next?: unknown; false_next?: unknown };
  if (cfg.match !== "all" && cfg.match !== "any") issues.push(nodeError(node, "match", "Choose whether all or any rule must match."));
  if (!cfg.rules.length) issues.push(nodeError(node, "rules", "Add at least one rule."));
  cfg.rules.forEach((r, i) => {
    const field = `rules.${i}`;
    const textOps = ["equals", "not_equals", "contains", "present", "absent", "gt", "lt"];
    let ok = true;
    switch (r.type) {
      case "tag":
        ok = typeof r.tag_id === "string" && !!r.tag_id && (r.operator === "present" || r.operator === "absent");
        break;
      case "var":
      case "custom_field":
        ok = typeof r.key === "string" && !!r.key && textOps.includes(String(r.operator));
        break;
      case "contact_field":
        ok = CONTACT_FIELD_KEYS.includes(String(r.key)) && textOps.includes(String(r.operator));
        break;
      case "time":
        ok = parseHHmm(String(r.start)) !== null && parseHHmm(String(r.end)) !== null && r.start !== r.end;
        break;
      case "weekday":
        ok = Array.isArray(r.days) && r.days.length > 0 && r.days.every((d) => WEEKDAY_KEYS.includes(String(d)));
        break;
      default:
        ok = false;
    }
    if (!ok) issues.push(nodeError(node, field, `Rule ${i + 1} is incomplete or invalid.`));
  });
  requireTarget(issues, node, "true_next", cfg.true_next, knownKeys, 'Condition "true" branch');
  requireTarget(issues, node, "false_next", cfg.false_next, knownKeys, 'Condition "false" branch');
  return issues;
}
```

Casos novos em `validateNode`, antes de `case "handoff":`:

```ts
    case "smart_interval": {
      const cfg = node.config as { mode?: unknown; duration?: unknown; until?: unknown; weekly_window?: Record<string, { enabled?: boolean; start?: string; end?: string }>; next_node_key?: unknown };
      if (cfg.mode === "duration") {
        if (!isValidDuration(cfg.duration)) issues.push(nodeError(node, "duration", "Interval needs a positive duration."));
      } else if (cfg.mode === "until") {
        if (typeof cfg.until !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cfg.until)) {
          issues.push(nodeError(node, "until", "Pick a date and time to resume at."));
        }
      } else if (cfg.mode === "weekly_window") {
        const days = Object.values(cfg.weekly_window ?? {}).filter((d) => d?.enabled);
        const valid = days.length > 0 && days.every((d) => {
          const s = parseHHmm(String(d.start));
          const e = parseHHmm(String(d.end));
          return s !== null && e !== null && s < e;
        });
        if (!valid) issues.push(nodeError(node, "weekly_window", "Enable at least one day with a start before its end."));
      } else {
        issues.push(nodeError(node, "mode", "Choose how the interval waits."));
      }
      requireTarget(issues, node, "next_node_key", cfg.next_node_key, knownKeys, "Smart interval");
      break;
    }

    case "set_field": {
      const cfg = node.config as { custom_field_id?: unknown; op?: unknown; next_node_key?: unknown };
      if (typeof cfg.custom_field_id !== "string" || !cfg.custom_field_id) {
        issues.push(nodeError(node, "custom_field_id", "Pick the custom field to change."));
      }
      if (!["set", "increment", "decrement", "clear"].includes(String(cfg.op))) {
        issues.push(nodeError(node, "op", "Choose set, increment, decrement or clear."));
      }
      requireTarget(issues, node, "next_node_key", cfg.next_node_key, knownKeys, "Set field");
      break;
    }

    case "jump_flow": {
      const target = (node.config as { target_flow_id?: unknown }).target_flow_id;
      if (typeof target !== "string" || !target) {
        issues.push(nodeError(node, "target_flow_id", "Pick the flow to jump to."));
      } else if (opts.flowId && target === opts.flowId) {
        issues.push(nodeError(node, "target_flow_id", "A flow can't jump to itself."));
      } else if (opts.activeFlowIds && !opts.activeFlowIds.has(target)) {
        issues.push(nodeError(node, "target_flow_id", "The target flow must be active."));
      }
      break;
    }

    case "distributor": {
      const outputs = Array.isArray((node.config as { outputs?: unknown }).outputs)
        ? ((node.config as { outputs: Array<{ id?: unknown; weight?: unknown; next_node_key?: unknown }> }).outputs)
        : [];
      const total = outputs.reduce((sum, o) => sum + (typeof o.weight === "number" ? o.weight : 0), 0);
      if (outputs.length < 2 || total !== 100) {
        issues.push(nodeError(node, "outputs", "Add at least two paths whose percentages add up to 100."));
      }
      const ids = new Set<string>();
      outputs.forEach((o, i) => {
        if (typeof o.id !== "string" || !o.id || ids.has(o.id)) {
          issues.push(nodeError(node, `outputs.${i}.id`, `Path ${i + 1} needs a unique id.`));
        } else {
          ids.add(o.id);
        }
        requireTarget(issues, node, `outputs.${i}.next_node_key`, o.next_node_key, knownKeys, `Path ${i + 1}`);
      });
      break;
    }
```

Mudar a assinatura para `function validateNode(node: NodeInput, knownKeys: Set<string>, opts: ValidateOptions): ValidationIssue[]`.

`outgoingEdges` (reachability):

```ts
    case "start":
    case "send_message":
    case "send_media":
    case "set_tag":
    case "smart_interval":
    case "set_field": {
      const cfg = node.config as { next_node_key?: string };
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    case "collect_input": {
      const cfg = node.config as { next_node_key?: string; timeout_next?: string };
      return [cfg.next_node_key, cfg.timeout_next].filter((k): k is string => !!k);
    }
    case "distributor": {
      const cfg = node.config as { outputs?: Array<{ next_node_key?: string }> };
      return (cfg.outputs ?? []).map((o) => o.next_node_key).filter((k): k is string => !!k);
    }
```

(`jump_flow` cai no `default` → `[]`.)

- [ ] **Step 6: Passar `opts` na ativação do servidor**

Run: `npx vitest run src/lib/flows/validate.test.ts` → Expected: PASS.

Encontrar o chamador do servidor:

Run: `npx rg -n "validateFlowForActivation\(" src/app`

No route handler encontrado (ativação de fluxo em `src/app/api/flows/[id]/...`), antes da chamada, carregar os fluxos ativos da conta e passar `opts`:

```ts
  const { data: activeFlows } = await supabase
    .from('flows')
    .select('id')
    .eq('account_id', flowRow.account_id)
    .eq('status', 'active')
  const issues = validateFlowForActivation(flowInput, nodeInputs, {
    flowId: flowRow.id,
    activeFlowIds: new Set((activeFlows ?? []).map((f) => f.id as string)),
  })
```

(adaptar os nomes `supabase`, `flowRow`, `flowInput`, `nodeInputs` às variáveis já existentes nesse handler; a chamada do cliente fica sem `opts`).

- [ ] **Step 7: Verificação completa**

Run: `npm test; npm run typecheck; npm run lint`
Expected: todos os testes PASS; 0 erros de tipos e lint.

- [ ] **Step 8: Commit** (com autorização)

```bash
git add src/components/flows/shared.tsx src/lib/flows/edges.ts src/lib/flows/edges.test.ts src/lib/flows/validate.ts src/lib/flows/validate.test.ts src/app/api/flows
git commit -m "feat(flows): validate and wire v2 nodes on the canvas"
```

---

## Verificação final do Plano A

- [ ] `npm test` — todos verdes (incluindo `src/i18n/messages.test.ts`, que não muda neste plano).
- [ ] `npm run typecheck` e `npm run lint` limpos.
- [ ] Migração 042 aplicada num Supabase local (`npx supabase db reset --local --no-seed`) e `verify-schema.sql` a passar — ou, sem CLI, confirmada pelo job `Migrations` no PR.
- [ ] `docker compose up --build` → `docker compose logs scheduler` mostra `{"resumed":0,"failed":0,"swept":0}` a cada ~60 s.
- [ ] Teste manual: fluxo `start → collect_input (accept: image, timeout 2 min, timeout_next → send_message "Ainda aguardamos") → end`; enviar keyword e não responder → mensagem de timeout chega em 2-3 min; repetir enviando uma imagem → run avança e `flow_runs.vars` contém a referência do anexo.
