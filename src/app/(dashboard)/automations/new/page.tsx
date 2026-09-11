"use client"

import { Suspense, useMemo } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"

import {
  AutomationBuilder,
  type BuilderInitial,
  type BuilderStep,
} from "@/components/automations/automation-builder"
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "@/lib/automations/templates"
import type { AutomationStepType, AutomationTriggerType } from "@/types"

// `useSearchParams` requires a Suspense boundary or the production build
// bails to CSR and errors out. Thin wrapper supplies it; the inner
// component reads the `?template=` query string.
export default function NewAutomationPage() {
  return (
    <Suspense fallback={null}>
      <NewAutomationPageInner />
    </Suspense>
  )
}

function NewAutomationPageInner() {
  const params = useSearchParams()
  const t = useTranslations("Automations.list")
  const template = params.get("template") as TemplateSlug | null

  const initial: BuilderInitial = useMemo(() => {
    if (template && AUTOMATION_TEMPLATES[template]) {
      const def = AUTOMATION_TEMPLATES[template]
      // The seed's structure (step types, branches, wait amounts) is
      // locale-independent and stays in the lib; the copy the user will
      // read and send — name, description, message bodies, keywords —
      // comes from the catalogue so a template opens in their language.
      let messageSeen = 0
      const steps = expandFromSeeds(
        def.steps.map((seed, idx) => ({
          index: idx,
          step_type: seed.step_type,
          step_config: localizeStepConfig(
            seed.step_type,
            seed.step_config as Record<string, unknown>,
            () => t(`templates.${template}.step${++messageSeen}`),
          ),
          branch: seed.branch ?? null,
          parent_index: seed.parent_index ?? null,
        })),
      )
      return {
        name: t(`templates.${template}.name`),
        description: t(`templates.${template}.description`),
        trigger_type: def.trigger_type,
        trigger_config: localizeTriggerConfig(
          def.trigger_config as Record<string, unknown>,
          template,
          t,
        ),
        is_active: false,
        steps,
      }
    }
    return {
      name: "",
      description: "",
      trigger_type: "new_message_received" as AutomationTriggerType,
      trigger_config: {},
      is_active: false,
      steps: [],
    }
  }, [template, t])

  return <AutomationBuilder initial={initial} />
}

/** Swap a send_message seed's English body for the catalogue's. */
function localizeStepConfig(
  stepType: AutomationStepType,
  config: Record<string, unknown>,
  nextText: () => string,
): Record<string, unknown> {
  if (stepType !== "send_message") return config
  return { ...config, text: nextText() }
}

/** Swap keyword-trigger seeds for the catalogue's comma-separated list. */
function localizeTriggerConfig(
  config: Record<string, unknown>,
  slug: TemplateSlug,
  t: ReturnType<typeof useTranslations>,
): Record<string, unknown> {
  if (!Array.isArray(config.keywords)) return config
  const keywords = t(`templates.${slug}.keywords`)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
  return { ...config, keywords }
}

interface SeedRow {
  index: number
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branch: "yes" | "no" | null
  parent_index: number | null
}

function uid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

/** Template seeds are flat with parent_index references. Expand into the
 *  builder's nested tree, preserving order within each scope. */
function expandFromSeeds(rows: SeedRow[]): BuilderStep[] {
  const nodes: BuilderStep[] = rows.map((r) => ({
    cid: uid(),
    step_type: r.step_type,
    step_config: r.step_config,
    branches:
      r.step_type === "condition" ? { yes: [], no: [] } : undefined,
  }))
  const roots: BuilderStep[] = []
  rows.forEach((r, i) => {
    if (r.parent_index == null) {
      roots.push(nodes[i])
      return
    }
    const parent = nodes[r.parent_index]
    if (!parent.branches) parent.branches = { yes: [], no: [] }
    parent.branches[r.branch ?? "yes"].push(nodes[i])
  })
  return roots
}
