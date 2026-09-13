"use client";

/**
 * Validation panel — surfaces every error and warning from
 * `validateFlowForActivation`. Lives once at the bottom of the
 * editor shell so it's visible in both views (canvas + list).
 *
 * Node-scoped issues are clickable: tapping one calls
 * `requestFlash(node_key)` on the editor context. List view's
 * useEffect on `flashKey` expands + scrolls + flashes the row;
 * canvas view's useEffect pans the viewport + flashes the card.
 * Both views read the same flashKey so the panel doesn't need
 * per-view plumbing.
 *
 * Trigger-scoped issues are NOT clickable from canvas — trigger
 * config is a list-only panel (it's a flat form, not a graph
 * concept). User can switch to List to address them.
 */

import { CircleAlert, CircleCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { ValidationIssue } from "@/lib/flows/validate";
import { useFlowEditor } from "./flow-editor-state";

function formatValidationMessage(message: string, locale: string): string {
  if (locale !== "pt") return message;

  if (message === "Keyword triggers need at least one keyword.") {
    return "Gatilhos por palavra-chave precisam de pelo menos uma palavra-chave.";
  }
  if (message === "Flow name is required.") {
    return "O nome do fluxo é obrigatório.";
  }
  if (message === "Pick an entry node before activating.") {
    return "Escolha um bloco inicial antes de ativar o fluxo.";
  }
  if (message === "A flow needs at least one node before activation.") {
    return "O fluxo precisa de pelo menos um bloco antes da ativação.";
  }
  if (message === "Start node must point to a next node.") {
    return "O bloco inicial deve apontar para um próximo bloco.";
  }
  if (message === "Send-message node needs a text body.") {
    return "O bloco de mensagem precisa de um texto.";
  }
  if (message === "Send-message node must point to a next node.") {
    return "O bloco de mensagem deve apontar para um próximo bloco.";
  }
  if (message === "Send-buttons node needs a text body.") {
    return "O bloco de botões precisa de um texto.";
  }
  if (message === "Send-buttons needs at least one button.") {
    return "O bloco de botões precisa de pelo menos um botão.";
  }
  if (message === "Send-media node needs a file (upload one before activating).") {
    return "O bloco de mídia precisa de um ficheiro (carregue um antes de ativar).";
  }

  // Dynamic regex replacements
  const buttonNextMatch = message.match(/^Button (\d+) needs a next node\.$/);
  if (buttonNextMatch) {
    return `O Botão ${buttonNextMatch[1]} precisa estar conectado a um próximo bloco.`;
  }

  const buttonTitleMatch = message.match(/^Button (\d+) needs a title\.$/);
  if (buttonTitleMatch) {
    return `O Botão ${buttonTitleMatch[1]} precisa de um título.`;
  }

  const buttonReplyIdMatch = message.match(/^Button (\d+) needs a reply id\.$/);
  if (buttonReplyIdMatch) {
    return `O Botão ${buttonReplyIdMatch[1]} precisa de um ID de resposta.`;
  }

  const unreachableMatch = message.match(/^Node "([^"]+)" is unreachable from the entry node\.$/);
  if (unreachableMatch) {
    return `O bloco "${unreachableMatch[1]}" não é alcançado a partir do bloco inicial.`;
  }

  return message;
}

export function ValidationPanel() {
  const { issues, requestFlash } = useFlowEditor();
  const t = useTranslations("Flows.validation");
  const locale = useLocale();

  if (issues.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-600/50 bg-background p-3 text-sm font-medium text-emerald-300">
        <CircleCheck className="h-4 w-4 shrink-0" />
        {t("noIssues")}
      </div>
    );
  }
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return (
    <div
      className={cn(
        "rounded-lg border bg-background p-3",
        errors.length > 0 ? "border-red-500/40" : "border-amber-500/40",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {errors.length > 0 ? (
          <CircleAlert className="h-4 w-4 text-red-400" />
        ) : (
          <CircleAlert className="h-4 w-4 text-amber-400" />
        )}
        {t("summary", { errorCount: errors.length, warningCount: warnings.length })}
      </div>
      <div className="flex flex-col gap-1">
        {issues.map((i, ix) => (
          <IssueLine key={ix} issue={i} onJump={requestFlash} t={t} locale={locale} />
        ))}
      </div>
    </div>
  );
}

/**
 * Exported so the per-node card (list view) and the trigger panel
 * can render the same "icon + node key chip + message" formatting
 * for their own per-row issue lists without re-implementing the
 * tone / icon / accessibility logic.
 */
export function IssueLine({
  issue,
  onJump,
  t,
  locale = "en",
}: {
  issue: ValidationIssue;
  onJump?: (key: string) => void;
  t?: ReturnType<typeof useTranslations>;
  locale?: string;
}) {
  const tone =
    issue.severity === "error" ? "text-red-300" : "text-amber-300";
  const iconTone =
    issue.severity === "error" ? "text-red-400" : "text-amber-400";
  const displayMessage = formatValidationMessage(issue.message, locale);
  const body = (
    <>
      <CircleAlert className={cn("mt-0.5 h-3 w-3 shrink-0", iconTone)} />
      <span className="min-w-0 flex-1">
        {issue.node_key && (
          <code className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
            {issue.node_key}
          </code>
        )}
        {displayMessage}
      </span>
    </>
  );

  // Only node-scoped issues can jump; trigger-scoped issues have no
  // destination (the trigger panel is list-only and already at the
  // top of that view).
  if (issue.node_key && onJump) {
    return (
      <button
        type="button"
        onClick={() => onJump(issue.node_key!)}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted/60",
          tone,
        )}
        aria-label={t ? t("jumpToNode", { key: issue.node_key! }) : `Jump to node ${issue.node_key}`}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md px-2 py-1 text-xs",
        tone,
      )}
    >
      {body}
    </div>
  );
}
