/**
 * See docs/spec/CLASSIFIER.md and GO-PROMPT.md's "WHAT 24H CANNOT BUY":
 * a real calibration table needs weeks of actual human corrections to mean
 * anything. This ships present-but-advisory, by design, not as a shortfall —
 * a volume/stage-distribution snapshot over classification_finding rows,
 * not an accuracy measurement. There is no outcome-tracking mechanism yet
 * (nothing records "AI suggested X, human decided Y") to compute real
 * accuracy against; building one is future work once there's enough
 * resolved review history to make it meaningful.
 */

export interface CalibrationSnapshot {
  company_id: string;
  total_findings: number;
  stage_distribution: Record<string, number>; // stage_reached -> count
  ai_assisted_count: number; // stage_reached === 4
  ai_assisted_pct: number;
  note: string;
}

export async function computeCalibrationSnapshot(
  db: D1Database, companyId: string,
): Promise<CalibrationSnapshot> {
  const { results } = await db.prepare(
    `SELECT stage_reached, COUNT(*) as n FROM classification_finding WHERE company_id = ? GROUP BY stage_reached`,
  ).bind(companyId).all<{ stage_reached: number; n: number }>();

  const stageDistribution: Record<string, number> = {};
  let total = 0;
  let aiAssisted = 0;
  for (const row of results) {
    stageDistribution[String(row.stage_reached)] = row.n;
    total += row.n;
    if (row.stage_reached === 4) aiAssisted += row.n;
  }

  return {
    company_id: companyId,
    total_findings: total,
    stage_distribution: stageDistribution,
    ai_assisted_count: aiAssisted,
    ai_assisted_pct: total > 0 ? aiAssisted / total : 0,
    note: "Volume/distribution snapshot only, not an accuracy measurement — "
      + "no outcome-tracking mechanism exists yet to compare AI suggestions "
      + "against eventual human decisions. See GO-PROMPT.md.",
  };
}
