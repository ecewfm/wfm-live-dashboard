export interface KpiSnapshot {
  id: string
  account_id: string
  sla: string | null
  total_calls: string | null
  outbound: string | null
  inbound: string | null
  answered: string | null
  unanswered: string | null
  time_to_answer: string | null
  longest_waiting: string | null
  available_users: string | null
  calls_waiting: string | null
  calls_in_table: string | null
  total_users: string | null
  updated_at: string
}

export interface AgentState {
  id: string
  account_id: string
  agent_name: string
  status: string | null
  duration: string | null
  updated_at: string
}

export interface UserStatusCounts {
  id: string
  account_id: string
  available: number
  ringing: number
  in_call: number
  after_call_work: number
  not_available: number
  do_not_disturb: number
  on_a_break: number
  out_for_lunch: number
  back_office: number
  in_training: number
  offline: number
  updated_at: string
}

export interface ActiveCall {
  id: string
  account_id: string
  direction: string | null
  agent: string | null
  phone_line: string | null
  customer: string | null
  status: string | null
  started_at: string | null
  updated_at: string
}

export interface AccountData {
  kpi: KpiSnapshot | null
  agents: AgentState[]
  status: UserStatusCounts | null
  calls: ActiveCall[]
  syncing: boolean
}

export interface KpiThresholds {
  warn: number
  crit: number
  targ: number
  direction: 'asc' | 'desc'
}

export interface Thresholds {
  sla:  KpiThresholds
  wait: KpiThresholds
  aht:  KpiThresholds
  abn:  KpiThresholds
}
