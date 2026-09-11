// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

import type { CurrencyTotal } from '@/lib/currency'

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  /**
   * Open-deal value split by ISO-4217 currency, account default
   * first. Never collapse this to one number: the app does no FX
   * conversion, so a cross-currency sum would be meaningless.
   */
  openDealsTotals: CurrencyTotal[]
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  /** ISO-4217 currency the slices and totalValue are denominated in. */
  currency: string
  /** Sum of the slices — all in `currency`, never mixed. */
  totalValue: number
  /**
   * Open-deal subtotals in every OTHER currency, which the ring
   * deliberately excludes (proportional slices only mean something
   * within one currency). Surfaced so the chart can say so instead of
   * silently under-reporting.
   */
  otherCurrencies: CurrencyTotal[]
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}
