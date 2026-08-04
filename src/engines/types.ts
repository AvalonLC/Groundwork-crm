export interface BurdenInput {
  wage: number; paid: number; pto: number; shop: number; idle: number;
  tax: number; comp: number; ben_mo: number;
  truck: number; equip: number; tools: number;
  equipment_engine_active: boolean;
}
export interface BurdenResult {
  billable_hours: number; utilization: number;
  payroll_pool: number; support_pool: number; total_annual_cost: number;
  burdened_rate: number; burden_multiplier: number;
  support_equipment_annual_used: number;
  config_error: boolean; config_warning: boolean;
  suspect: boolean; requires_review: boolean; publishable: boolean;
}
