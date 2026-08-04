# Burdened-hour acceptance tests

| ID | Scenario | Expected |
|----|----------|----------|
| BH-01 | Golden fixture, equipment engine OFF | 42.1002 / 1.754x / 1622 hrs |
| BH-02 | Zero support pools | 37.52 |
| BH-03 | Non-billable > paid hours | billable floors at 1, not publishable |
| BH-04 | idle=800 | utilization < 55%, suspect, requires review |
| BH-05 | Multiplier > 2.5 | config_warning true |
| BH-06 | Resolution cascade employee->crew->role->tenant | confidence downgrades |
| BH-07 | Entry dated before rate change | resolves to OLDER profile |
| BH-08 | 10 OT hrs at 1.5x | support pools NOT re-applied |
| BH-09 | Crew weighted average, 3 members | hours-weighted mean within $0.01 |
| BH-10 | require_rate_approval = true | proposed profile invisible downstream |
| BH-11 | Recalibration | new row inserted, prior effective_to set, history unchanged |
| BH-12 | Seasonal tenant | utilization on trailing 12 months, not quarter |
| BH-13 | **Equipment double-count** | **40.62 / 1.693x, delta = 2400/1622, never 39.49** |
| BH-14 | Fixture/engine agreement | golden.json matches computeBurden output |
