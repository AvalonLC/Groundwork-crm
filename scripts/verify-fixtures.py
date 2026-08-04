"""Verify every golden number in the Groundwork Finance OS spec.
Any assertion failure here is a spec bug that would have been baked into tasks.json.
"""
import json, datetime
from decimal import Decimal as D

def burden(wage, paid, pto, shop, idle, tax, comp, ben_mo, truck, equip, tools):
    h_bill = paid - (pto + shop + idle)
    assert h_bill > 0
    wage_cost = wage * paid
    payroll = wage_cost * (1 + tax) + wage_cost * comp + ben_mo * 12
    support = truck + equip + tools
    total = payroll + support
    return {
        "billable_hours": h_bill,
        "utilization": round(h_bill / paid, 6),
        "wage_cost": round(wage_cost, 2),
        "payroll_pool": round(payroll, 2),
        "support_pool": round(support, 2),
        "total_annual_cost": round(total, 2),
        "burdened_rate": round(total / h_bill, 4),
        "burden_multiplier": round((total / h_bill) / wage, 5),
    }

BASE = dict(wage=24.00, paid=2080, pto=96, shop=168, idle=194,
            tax=0.0865, comp=0.0700, ben_mo=260,
            truck=4200, tools=834)

print("=" * 68)
print("FIXTURE A - labor rate WITH equipment (equipment_engine_active = FALSE)")
print("=" * 68)
a = burden(equip=2400, **BASE)
for k, v in a.items():
    print(f"  {k:24s} {v}")
assert a["billable_hours"] == 1622, a["billable_hours"]
assert abs(round(a["burdened_rate"], 2) - 42.10) < 0.005, a["burdened_rate"]
assert abs(round(a["burden_multiplier"], 3) - 1.754) < 0.001, a["burden_multiplier"]
print("  -> displays as $42.10 at 1.754x  [MATCHES SPEC]")

print()
print("=" * 68)
print("FIXTURE B - labor rate WITHOUT equipment (equipment_engine_active = TRUE)")
print("=" * 68)
b = burden(equip=0, **BASE)
for k, v in b.items():
    print(f"  {k:24s} {v}")
print()
print(f"  CORRECT equipment-removed rate : ${round(b['burdened_rate'],2)}  "
      f"at {round(b['burden_multiplier'],3)}x")
print(f"  Value used in earlier render   : $39.49  at 1.645x")
print(f"  ERROR MAGNITUDE                : ${round(b['burdened_rate']-39.49, 2)}/hr too low")
annual_err = (b["burdened_rate"] - 39.49) * 1622 * 13
print(f"  Understated cost, 13 field staff: ${annual_err:,.0f}/yr")
assert abs(round(b["burdened_rate"], 2) - 40.62) < 0.005, b["burdened_rate"]

print()
print("  WHY 39.49 WAS WRONG:")
print(f"    equip per BILLABLE hour = 2400/1622 = ${2400/1622:.4f}  (not $2.61)")
print(f"    42.0972 - 1.4796        = ${42.0972-2400/1622:.4f}  = correct")
print( "    42.10   - 2.61          = $39.49    = wrong on BOTH counts")

print()
print("=" * 68)
print("FIXTURE C - equipment rate engine")
print("=" * 68)
def equip_rate(price, salv, life, H, fin, ins, stor, gal, fp, rep, wear):
    dep = (price - salv) / life
    interest = ((price + salv) / 2) * fin
    own_annual = dep + interest + ins + stor
    own_hr = own_annual / H
    fuel = gal * fp
    lube = fuel * 0.12
    op_hr = fuel + lube + rep / H + wear / H
    return {"ownership_annual": round(own_annual, 2),
            "ownership_rate": round(own_hr, 4),
            "operating_rate": round(op_hr, 4),
            "total_rate": round(own_hr + op_hr, 4)}

c = equip_rate(62000, 14000, 7, 720, 0.075, 1180, 600, 2.4, 4.05, 4900, 3300)
for k, v in c.items():
    print(f"  {k:24s} {v}")
assert abs(round(c["ownership_rate"], 2) - 15.95) < 0.005
assert abs(round(c["operating_rate"], 2) - 22.28) < 0.005
assert abs(round(c["total_rate"], 2) - 38.23) < 0.005
print("  -> $15.95 ownership + $22.28 operating = $38.23  [MATCHES SPEC]")

print()
print("=" * 68)
print("FIXTURE D - overhead allocation by division")
print("=" * 68)
DIV = {"maintenance": (8110, 196400, 38.40, 0.40),
       "hardscape":   (9732, 268900, 45.60, 0.34),
       "snow":        (1622,  71300, 47.20, 0.38),
       "drainage":    (1622,  41800, 44.10, 0.33)}
tot_h = sum(v[0] for v in DIV.values())
tot_oh = sum(v[1] for v in DIV.values())
assert tot_h == 21086, tot_h
assert tot_oh == 578400, tot_oh
print(f"  total sellable hours {tot_h}   total overhead ${tot_oh:,}")
print(f"  blended overhead/hr  ${tot_oh/tot_h:.4f} -> ${round(tot_oh/tot_h,2)}")
assert abs(round(tot_oh / tot_h, 2) - 27.43) < 0.005
expect = {"maintenance": (24.22, 62.62, 104.37), "hardscape": (27.63, 73.23, 110.95),
          "snow": (43.96, 91.16, 147.03), "drainage": (25.77, 69.87, 104.28)}
divisions = {}
for name, (h, oh, lab, tgt) in DIV.items():
    oh_hr = oh / h
    absorbed = lab + round(oh_hr, 2)
    req = absorbed / (1 - tgt)
    e = expect[name]
    print(f"  {name:12s} oh/hr ${round(oh_hr,2):>6}  absorbed ${round(absorbed,2):>6}"
          f"  required ${round(req,2):>7}")
    assert abs(round(oh_hr, 2) - e[0]) < 0.005, (name, oh_hr, e[0])
    assert abs(round(absorbed, 2) - e[1]) < 0.005, (name, absorbed, e[1])
    assert abs(round(req, 2) - e[2]) < 0.01, (name, req, e[2])
    divisions[name] = {"sellable_hours": h, "allocated_overhead": oh,
                       "weighted_labor_rate": lab, "overhead_rate": round(oh_hr, 4),
                       "absorbed_cost": round(absorbed, 2),
                       "target_margin": tgt, "required_bill_rate": round(req, 2)}
print("  -> all four division rate pairs  [MATCH SPEC]")

print()
print("=" * 68)
print("FIXTURE E - recovery projection / Black Friday")
print("=" * 68)
target, recovered, hrs_wk, blended = 591000, 381900, 380, 27.43
remaining = target - recovered
weekly = hrs_wk * blended
weeks = remaining / weekly
asof = datetime.date(2026, 8, 3)
bf = asof + datetime.timedelta(days=round(weeks * 7))
print(f"  restated target      ${target:,}")
print(f"  recovered to date    ${recovered:,}  ({recovered/target*100:.1f}%)")
print(f"  weekly recovery      ${weekly:,.2f}")
print(f"  weeks remaining      {weeks:.2f}")
print(f"  projected Black Friday  {bf.strftime('%A, %B %d, %Y')}")
assert abs(recovered / target * 100 - 64.6) < 0.05
assert bf == datetime.date(2026, 12, 21), bf
print("  -> Dec 21 2026 at 64.6%  [MATCHES SPEC]")

golden = {
    "generated": "2026-08-03",
    "note": "Verified fixtures. burden_labor_with_equipment is used ONLY when "
            "equipment_engine_active=false. Wave 2 ships the equipment engine, "
            "so the ACTIVE labor fixture is burden_labor_no_equipment.",
    "burden_labor_with_equipment": {"input": dict(BASE, equip=2400), "expect": a},
    "burden_labor_no_equipment":   {"input": dict(BASE, equip=0),    "expect": b},
    "equipment_rate": {"input": {"purchase_price": 62000, "salvage": 14000,
        "life_years": 7, "annual_machine_hours": 720, "finance_rate": 0.075,
        "insurance_annual": 1180, "storage_annual": 600, "fuel_gal_per_hr": 2.4,
        "fuel_price": 4.05, "repairs_annual": 4900, "wear_annual": 3300,
        "lube_pct_of_fuel": 0.12}, "expect": c},
    "overhead_allocation": {"total_overhead": tot_oh, "total_sellable_hours": tot_h,
        "blended_overhead_rate": round(tot_oh / tot_h, 4), "divisions": divisions},
    "recovery": {"as_of": "2026-08-03", "restated_target": target,
        "recovered_to_date": recovered, "hours_per_week": hrs_wk,
        "blended_overhead_rate": blended, "weekly_recovery": round(weekly, 2),
        "pct_recovered": round(recovered / target, 6),
        "projected_black_friday": "2026-12-21", "confidence_days": 13},
    "tolerance": {"rate": 0.01, "pct": 0.001},
}
with open("/home/user/golden.json", "w") as f:
    json.dump(golden, f, indent=2)

print()
print("=" * 68)
print("ALL ASSERTIONS PASSED - golden.json written")
print("=" * 68)
