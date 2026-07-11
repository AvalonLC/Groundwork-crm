window.AVALON_DATA = {
  "company": {
    "name": "Avalon Landscape Construction",
    "website": "avalon-lc.com",
    "tagline": "Consultative. Profitable. Operationally clean. Easy to trust."
  },

  "fy2026": {
    "asOfDate": "5/21/2026",
    "budgetVersion": "v2.2 — June 2026 Operating Playbook",
    "annual": {
      "budgetedRevenue": 1245000,
      "actualRevenue": 533148.94,
      "remaining": 711851.06,
      "monthsLeft": 7,
      "avgNeededPerMonth": 101693.01,
      "totalIncome": 1281140.95,
      "cogs": 776854,
      "grossProfit": 504286.95,
      "grossMarginPct": 0.39,
      "totalExpenses": 394791.87,
      "netOperatingIncome": 109495.08,
      "netIncome": 111782.66,
      "loans": 89059.20,
      "loanMonthly": 7421.60,
      "trueNetIncome": 22723.46
    },
    "monthlyBudget": [
      { "month": "Jan", "budgeted": 48000,  "actual": 21100.64,  "variance": -26899.36 },
      { "month": "Feb", "budgeted": 176000, "actual": 187832.54, "variance": 11832.54  },
      { "month": "Mar", "budgeted": 109000, "actual": 104275.22, "variance": -4724.78  },
      { "month": "Apr", "budgeted": 103000, "actual": 113504.53, "variance": 10504.53  },
      { "month": "May", "budgeted": 113000, "actual": 106436.01, "variance": -6563.99  },
      { "month": "Jun", "budgeted": 108000, "actual": null,      "variance": null },
      { "month": "Jul", "budgeted": 123000, "actual": null,      "variance": null },
      { "month": "Aug", "budgeted": 103000, "actual": null,      "variance": null },
      { "month": "Sep", "budgeted": 103000, "actual": null,      "variance": null },
      { "month": "Oct", "budgeted": 93000,  "actual": null,      "variance": null },
      { "month": "Nov", "budgeted": 88000,  "actual": null,      "variance": null },
      { "month": "Dec", "budgeted": 78000,  "actual": null,      "variance": null }
    ],
    "divisionMonthlyActuals": {
      "landscape": {
        "Jan": { "revenue": 0       },
        "Feb": { "revenue": 13833   },
        "Mar": { "revenue": 25275   },
        "Apr": { "revenue": 55505   },
        "May": { "revenue": 58436   }
      },
      "maintenance": {
        "Jan": { "revenue": 0       },
        "Feb": { "revenue": 48000   },
        "Mar": { "revenue": 48000   },
        "Apr": { "revenue": 58000   },
        "May": { "revenue": 48000   }
      },
      "snow": {
        "Jan": { "revenue": 21100.64 },
        "Feb": { "revenue": 126000   },
        "Mar": { "revenue": 31000    },
        "Apr": { "revenue": 0        },
        "May": { "revenue": 0        }
      }
    },
    "divisions": {
      "landscape": {
        "name": "Landscape",
        "icon": "🌿",
        "target": 525000,
        "actual": 153049,
        "remaining": 371951,
        "pctOfCompany": 0.422,
        "operatingIncome": 220609.22,
        "cogs": 178237,
        "grossProfit": 304390.78,
        "grossMarginPct": 0.42,
        "grossMarginFloor": 0.50,
        "netOperatingIncome": 42372.22,
        "jobsTarget": 75,
        "meanTicket": 6500,
        "medianTicket": 4000,
        "closeRate": "20–25%",
        "arDays": 30,
        "depositRule": "≥ 40% at signing",
        "leadResponseSLA": "≤ 24 hours",
        "funnelTarget": "130–150 opportunities/year (160–190 total contacts)",
        "laborPctMax": 0.25,
        "materialsPctMax": 0.40,
        "serviceCatalog": {
          "residential": ["Design/Build", "Hardscape (patios, walkways, walls)", "Planting (trees/shrubs/perennials/annuals)", "Sod", "Lighting", "Drainage", "Carpentry/Decks"],
          "commercial": ["Site Work", "Bed Renovation", "Tree/Shrub Replacement", "Common-Area Plantings"]
        },
        "serviceLines": [
          { "name": "Hardscaping (patios, walkways, walls)", "segment": "Res/Comm", "gmMin": 0.52, "gmMax": 0.55, "avgTicketMin": 15000, "avgTicketMax": 45000, "pricingRule": "Material × 2.2 minimum" },
          { "name": "Softscaping / Planting",               "segment": "Res/Comm", "gmMin": 0.50, "gmMax": 0.55, "avgTicketMin": 5000,  "avgTicketMax": 20000, "pricingRule": "Wholesale × 2.2" },
          { "name": "Drainage & Grading",                   "segment": "Res/Comm", "gmMin": 0.58, "gmMax": 0.60, "avgTicketMin": 8000,  "avgTicketMax": 25000, "pricingRule": "Labor-heavy, premium margin" },
          { "name": "Carpentry & Decks",                    "segment": "Res",      "gmMin": 0.48, "gmMax": 0.52, "avgTicketMin": 12000, "avgTicketMax": 35000, "pricingRule": "Material × 2.0 + labor markup" },
          { "name": "Masonry & Wet-Cast Walls",             "segment": "Res/Comm", "gmMin": 0.50, "gmMax": 0.54, "avgTicketMin": 10000, "avgTicketMax": 30000, "pricingRule": "Material × 2.2" },
          { "name": "Lighting Design & Install",            "segment": "Res",      "gmMin": 0.50, "gmMax": 0.55, "avgTicketMin": 4000,  "avgTicketMax": 12000, "pricingRule": "Material × 2.2" },
          { "name": "Sod Install",                          "segment": "Res/Comm", "gmMin": 0.45, "gmMax": 0.50, "avgTicketMin": 3000,  "avgTicketMax": 15000, "pricingRule": "Material × 2.0" },
          { "name": "Site Work",                            "segment": "Comm",     "gmMin": 0.45, "gmMax": 0.50, "avgTicketMin": 10000, "avgTicketMax": 50000, "pricingRule": "Per scope" }
        ]
      },
      "maintenance": {
        "name": "Maintenance",
        "icon": "✂️",
        "target": 543000,
        "actual": 202000,
        "remaining": 341000,
        "ytdActual": 202000,
        "pctOfCompany": 0.436,
        "contractedBase": 378614,
        "contractedCommercial": 314737,
        "contractedCommercialAccounts": 16,
        "contractedResidential": 63877,
        "contractedResidentialAccounts": 17,
        "growthTarget": 165000,
        "operatingIncome": 156363.03,
        "cogs": 194458,
        "grossProfit": 387250.97,
        "grossMarginPct": 0.29,
        "grossMarginFloor": 0.32,
        "closeRate": "50–60%",
        "arDays": 30,
        "depositRule": "CC on file before first service",
        "leadResponseSLA": "≤ 24 hours",
        "monthlyRevenuePace": 45250,
        "funnelTarget": "10–15 leads/month, 50–60% close rate",
        "laborPctMax": 0.40,
        "materialsPctRange": "18–22% of route revenue",
        "equipmentFuelPct": "6–8% of route revenue",
        "enhancementsMonthlyFloor": 8000,
        "serviceCatalog": {
          "residential": ["Lawn Mowing (every 10–14 days, Apr–Oct, max 24 mowings)", "Turf Program (7-step)", "Spring/Fall Clean-Ups", "Edge & Mulch (1× Mar–Apr)", "Professional Pruning (2× May–Sep)", "Grounds Care Visits (every 14 days Apr–Dec)", "Leaf Removal (3× Nov–Dec)", "Aeration & Overseeding (1× Sep–Oct)", "Annual Flowers (2× Spring+Fall)", "Mosquito Control", "Seasonal Color"],
          "commercial": ["All residential services", "Annual Contract Management", "Property Walks", "Enhancements", "Reporting"]
        },
        "growthPipeline": [
          { "bucket": "Commercial Contract Add-On Enhancements", "segment": "Comm", "target": 20000 },
          { "bucket": "Residential Contract Add-On Enhancements (mulch, color)", "segment": "Res",  "target": 15000 },
          { "bucket": "New Annual Commercial Maintenance Agreements", "segment": "Comm", "target": 45000 },
          { "bucket": "New Annual Residential Maintenance Agreements", "segment": "Res",  "target": 35000 },
          { "bucket": "Residential Misc. Variable 1× Maintenance", "segment": "Res",  "target": 50000 }
        ]
      },
      "snow": {
        "name": "Snow & Ice",
        "icon": "❄️",
        "target": 177000,
        "actual": 178100.64,
        "remaining": -1100.64,
        "status": "ABOVE PLAN",
        "pctOfCompany": 0.142,
        "operatingIncome": 127314.70,
        "cogs": 22096.87,
        "grossProfit": 85212.25,
        "grossMarginPct": 0.60,
        "grossMarginFloor": 0.50,
        "closeRate": "30–40%",
        "arDays": 15,
        "depositRule": "Signed agreement + plow ID assigned",
        "leadResponseSLA": "≤ 12 hours in season",
        "emphasis": "Commercial-First — Zero-Tolerance Operations",
        "stormResponse": "≤ 4 hours of trigger",
        "preStormComm": "100% of accounts notified ≤ 12 hrs pre-event",
        "equipmentROI": "> 2.5× season ROI per unit",
        "saltCostPct": "15–20% of event revenue",
        "serviceCatalog": {
          "residential": ["Driveway/Walk push (per-push or seasonal cap)", "Ice melt"],
          "commercial": ["Lot clearing (per-push with trigger depth)", "Walks/Entry shoveling (per-event)", "Salting/Pre-Treatment (per application)", "Storm Standby/On-Call (retainer + per-event)", "Liquid brining"]
        }
      }
    },
    "decisionRule": "If work is performed ONCE → Landscape. If it RECURS on a schedule → Maintenance. If triggered by a weather event → Snow & Ice.",
    "leadSources": {
      "landscape":    { "websiteInbound": "High", "pastClient": "High", "referrals": "High", "propertyMgr": "Medium", "builderGC": "Medium", "paid": "Medium", "fieldSignage": "Low" },
      "maintenance":  { "websiteInbound": "High", "pastClient": "Medium", "referrals": "High", "propertyMgr": "Very High", "builderGC": "Low",    "paid": "Medium", "fieldSignage": "Medium" },
      "snow":         { "websiteInbound": "High (seasonal)", "pastClient": "Medium", "referrals": "Medium", "propertyMgr": "Very High", "builderGC": "Low", "paid": "Low", "fieldSignage": "Low" }
    }
  },

  "hubspotPipeline": {
    "description": "All deals — Landscape, Maintenance Growth, and Snow — track through this 7-stage HubSpot pipeline. A stage cannot be advanced until required field gates are populated. No exceptions.",
    "hygieneRules": [
      "No deal sits in any single stage > 14 days without an activity note.",
      "Stage skipping is disabled — every gate is mandatory.",
      "Weekly pipeline review (Owner + Ryan) audits Stage 3–6 field completeness.",
      "Stage 7 firing triggers the Sales-to-Production Handoff workflow (3-phase handoff)."
    ],
    "stages": [
      {
        "num": 1, "name": "Lead Intake / Rapport", "winProb": 0.10,
        "gates": ["Source", "Contact Phone", "Contact Email"],
        "landscape": "Website form, referral, past-client outreach",
        "maintenance": "Website forms (Res + Comm), commercial outreach",
        "snow": "Website, referrals, property mgrs, HOA bids"
      },
      {
        "num": 2, "name": "Mutual Agreement Set", "winProb": 0.20,
        "gates": ["Driveway T.A.P.P.O. Confirmed (Checkbox)"],
        "landscape": "Driveway T.A.P.P.O. on-site",
        "maintenance": "Route fit + property walk T.A.P.P.O.",
        "snow": "Site map + lot sqft confirmation"
      },
      {
        "num": 3, "name": "Discovery / CBR Uncovered", "winProb": 0.40,
        "gates": ["Core Buying Reason (CBR) Narrative (Text Field)"],
        "landscape": "Emotional driver (legacy, entertaining, drainage stress)",
        "maintenance": "Pain point (curb appeal, tenant retention, HOA complaints)",
        "snow": "Liability + access tolerance (slip-and-fall risk)"
      },
      {
        "num": 4, "name": "Budget & Investment Qualified", "winProb": 0.60,
        "gates": ["Target Investment Tolerance (Currency Range)"],
        "landscape": "Budget Bracketing script aligned to scope",
        "maintenance": "Route-based pricing aligned to scope",
        "snow": "Per-push or seasonal cap modeled"
      },
      {
        "num": 5, "name": "Decision Process Qualified", "winProb": 0.80,
        "gates": ["All Decision Makers Identified (Boolean)", "Spouse Present (Boolean)"],
        "landscape": "All decision makers + spouse present confirmed",
        "maintenance": "Facilities lead + insurance/risk approval",
        "snow": "Owner + property manager + AP contact"
      },
      {
        "num": 6, "name": "Presentation & SOW Pitch", "winProb": 0.90,
        "gates": ["Draft Proposal Uploaded (File)", "Draft SOW Uploaded (File)"],
        "landscape": "Design plan + SOW uploaded",
        "maintenance": "Service schedule + annual agreement uploaded",
        "snow": "Service map + storm trigger SOW uploaded"
      },
      {
        "num": 7, "name": "Deal Closed / Won", "winProb": 1.00,
        "gates": ["Signed Contract Uploaded", "Signed SOW Uploaded", "Handoff Packet Completed (Checkbox)"],
        "landscape": "Signed SOW + 40% deposit + Handoff Packet",
        "maintenance": "Signed agreement + CC on file + Handoff Packet",
        "snow": "Signed agreement + CC on file + plow ID assigned"
      }
    ]
  },

  "repData": {
    "ryan": {
      "name": "Ryan",
      "role": "Client Relations & Enhancement Sales Associate",
      "totalEmployeeCost": 56586.80,
      "quotas": {
        "landscapeJobs": 75,
        "landscapeRevenue": 525000,
        "maintenanceGrowth": 165000,
        "meanLandscapeTicket": 6500,
        "medianLandscapeTicket": 4000
      },
      "weeklyActivityCadence": [
        { "activity": "Proactive Sales Calls",    "target": 5, "description": "Outreach to past clients from 2023, 2024, 2025" },
        { "activity": "Referral Asks",             "target": 2, "description": "Asking satisfied active clients for direct warm introductions" },
        { "activity": "Past Client Touches",       "target": 1, "description": "Warranty follow-ups, spring/fall landscape walkthrough invites" },
        { "activity": "On-Site Visits",            "target": 2, "description": "Completed property walks; re-confirming Mutual Agreements live" },
        { "activity": "Proactive Upsell Proposals","target": 1, "description": "Generated detail on pruning, mulch, or drainage upgrades" }
      ],
      "kpiFloors": [
        { "kpi": "Landscape GM per job",           "floor": "≥ 50%",    "cadence": "Per deal" },
        { "kpi": "Maintenance Quote-to-Close",     "floor": "50–60%",   "cadence": "Rolling 90-day" },
        { "kpi": "HubSpot Stage Hygiene",          "floor": "0 stale deals > 14 days", "cadence": "Weekly" },
        { "kpi": "Driveway T.A.P.P.O. Confirmed",  "floor": "100% of qualified opps", "cadence": "Per deal" },
        { "kpi": "CBR Narrative Populated",        "floor": "100% of opps in Stage 3+", "cadence": "Per deal" }
      ]
    },
    "tyler": {
      "name": "Tyler",
      "role": "Owner / CEO",
      "totalEmployeeCost": 75850,
      "leadershipScorecard": [
        { "metric": "Total Employee Cost",    "target": "$75,850 annual",        "cadence": "Annual" },
        { "metric": "Landscape Deals Closed", "target": "≥ 1 deal/month minimum", "cadence": "Monthly" },
        { "metric": "Cash Reserves",          "target": "≥ $30,000",            "cadence": "Monthly" },
        { "metric": "Margin Protection",      "target": "Avg ≥ 45% across jobs",  "cadence": "Ongoing" }
      ]
    }
  },

  "pricingDiscipline": {
    "grossMarginFloors": [
      { "division": "Landscape",    "floor": "≥ 50%", "current": "42% operating budget basis" },
      { "division": "Maintenance",  "floor": "≥ 32%", "current": "29% — requires tighter recovery" },
      { "division": "Snow & Ice",   "floor": "≥ 50%", "current": "60% — above floor" }
    ],
    "activityCostRecovery": [
      { "category": "Direct Labor",          "landscape": "20–25%", "maintenance": "35–40%", "snow": "15–20%" },
      { "category": "Materials/Consumables", "landscape": "30–40%", "maintenance": "18–22%", "snow": "15–20% (salt/brine)" },
      { "category": "Equipment + Fuel",      "landscape": "4–6%",   "maintenance": "6–8%",   "snow": "8–12%" },
      { "category": "Subcontractors",        "landscape": "0–8%",   "maintenance": "0–2%",   "snow": "0–5%" },
      { "category": "Overhead Recovery",     "landscape": "15–18%", "maintenance": "15–18%", "snow": "15–18%" }
    ],
    "laborRecoveryRules": [
      "Maintenance labor is recovered against route revenue, not single-stop revenue. A route missing 40% labor for two consecutive weeks is re-engineered.",
      "Landscape labor must hit ≤ 25% of project revenue. Overruns trigger a Sales/Ops post-mortem within 10 days of job close.",
      "Snow equipment must clear a 2.5× season ROI per unit — below that, unit is sold or repurposed.",
      "Overhead allocation is uniform at 15–18% across all three divisions."
    ]
  },

  "reviewCadence": [
    { "cadence": "Daily",     "meeting": "Morning Huddle",     "attendees": "Crews + Ops",                    "output": "Day plan, safety brief" },
    { "cadence": "Weekly",    "meeting": "Sales Pipeline Review", "attendees": "Sales + Owner",              "output": "Stage movement, slip risk" },
    { "cadence": "Weekly",    "meeting": "Production Review",  "attendees": "Ops + Crew Leaders",            "output": "Job status, punch list" },
    { "cadence": "Monthly",   "meeting": "Division P&L",       "attendees": "Owner + Controller + Division Heads", "output": "Variance vs. budget" },
    { "cadence": "Monthly",   "meeting": "Rep 1:1",            "attendees": "Owner + Rep",                   "output": "Activity, quota, coaching" },
    { "cadence": "Quarterly", "meeting": "Executive Review",   "attendees": "Owner + Leadership",            "output": "Strategy, hiring, capex" },
    { "cadence": "Annual",    "meeting": "Budget Reset",       "attendees": "All leadership",                "output": "Next-year plan + targets" }
  ],


  "serviceLines": [
    "Landscape – Hardscape/Patio/Walls",
    "Landscape – Softscape/Planting",
    "Landscape – Drainage & Grading",
    "Landscape – Carpentry/Decks",
    "Landscape – Lighting Design",
    "Landscape – Sod Install",
    "Landscape – Design/Build",
    "Landscape – Site Work (Comm)",
    "Maintenance – Recurring Contract",
    "Maintenance – One-Time Service",
    "Maintenance – Enhancement/Upsell",
    "Snow & Ice – Residential Push",
    "Snow & Ice – Commercial Lot/Walks",
    "Snow & Ice – Salting/Pre-Treatment",
    "Snow & Ice – Storm Standby",
    "Other"
  ],
  "projectCategories": [
    { "id": "landscape_hardscape",  "label": "Hardscape / Patio / Walls",  "division": "landscape",    "icon": "🪨" },
    { "id": "landscape_softscape",  "label": "Softscape / Planting",        "division": "landscape",    "icon": "🌿" },
    { "id": "landscape_drainage",   "label": "Drainage & Grading",          "division": "landscape",    "icon": "💧" },
    { "id": "landscape_carpentry",  "label": "Carpentry / Decks",           "division": "landscape",    "icon": "🪵" },
    { "id": "landscape_lighting",   "label": "Lighting Design & Install",   "division": "landscape",    "icon": "💡" },
    { "id": "landscape_sod",        "label": "Sod Install",                 "division": "landscape",    "icon": "🟩" },
    { "id": "landscape_designbuild","label": "Design / Build",              "division": "landscape",    "icon": "📐" },
    { "id": "landscape_sitework",   "label": "Commercial Site Work",        "division": "landscape",    "icon": "🏗️" },
    { "id": "maintenance_recurring","label": "Maintenance – Recurring",     "division": "maintenance",  "icon": "🔁" },
    { "id": "maintenance_onetime",  "label": "Maintenance – One-Time",      "division": "maintenance",  "icon": "✂️" },
    { "id": "maintenance_enhance",  "label": "Enhancement / Upsell",        "division": "maintenance",  "icon": "⬆️" },
    { "id": "snow_residential",     "label": "Snow – Residential Push",     "division": "snow",         "icon": "❄️" },
    { "id": "snow_commercial",      "label": "Snow – Commercial Lot/Walks", "division": "snow",         "icon": "🚜" },
    { "id": "snow_salting",         "label": "Snow – Salting/Pre-Treat",    "division": "snow",         "icon": "🧂" },
    { "id": "snow_standby",         "label": "Snow – Storm Standby",        "division": "snow",         "icon": "📟" }
  ],
  "clientTypes": [
    { "id": "residential", "label": "Residential", "icon": "🏡" },
    { "id": "commercial", "label": "Commercial", "icon": "🏢" }
  ],
  "leadSources": [
    "Website",
    "Referral",
    "Existing Client",
    "Google",
    "Social Media",
    "Yard Sign",
    "Door Hanger",
    "Cold Call",
    "Neighborhood Canvass",
    "Job-Site Canvass",
    "Networking",
    "Past Client",
    "Other"
  ],
  "statuses": [
    "Lead Intake / Rapport",
    "Mutual Agreement Set",
    "Discovery / CBR Uncovered",
    "Budget & Investment Qualified",
    "Decision Process Qualified",
    "Presentation & SOW Pitch",
    "Deal Closed / Won",
    "On Hold",
    "Closed Lost"
  ],
  "statusesLegacy": [
    "New Lead", "Discovery Scheduled", "Site Walk Scheduled",
    "Scope Development", "Estimating", "Proposal Sent",
    "Follow-Up", "Verbal Yes", "Sold / Activation", "On Hold", "Closed Lost"
  ],
  "salesProcess": {
    "title": "The 6-Step Avalon Sales Process",
    "subtitle": "Every engagement follows these exact, non-negotiable milestones. Skipping a step creates process friction and burns estimating hours.",
    "stat": "+25% company-wide sales increase when a consistent process is followed. (Dave Kurlan, Objective Management Group)",
    "steps": [
      {
        "num": "01",
        "title": "Rapport",
        "tagline": "Establish trust within 7 seconds.",
        "description": "Enter the prospect's world. Real rapport is not small talk — it is active listening, matching communication style, and entering their reality to understand operational and lifestyle pains. The client decides in 7 seconds if they trust you.",
        "socialRapport": ["Small talk about weather, sports, or traffic.", "Surface-level chatter that delays professional depth.", "Fails to establish expertise or build lasting credibility.", "Client views you as a typical transactional contractor."],
        "realRapport": ["Active listening and displaying mutual respect.", "Match and mirror communication styles.", "Entering their reality to understand operational/lifestyle pains.", "Establish yourself as a trusted advisor, not a dynamic vendor."],
        "communicationStyles": [
          { "type": "Visual", "description": "Think in pictures — value aesthetics, renderings, physical samples.", "triggers": "\"see,\" \"looks,\" \"appear,\" \"show me,\" \"reveal,\" \"imagine,\" \"crystal clear\"" },
          { "type": "Auditory", "description": "Focus on sound, flow, spoken details. Respond highly to clear verbal reviews.", "triggers": "\"hear,\" \"sounds good,\" \"listen,\" \"tune in,\" \"it resonates\"" },
          { "type": "Kinesthetic", "description": "Focus on texture, comfort, physical sensation — want to touch materials.", "triggers": "\"feel,\" \"touch,\" \"grasp,\" \"concrete,\" \"solid,\" \"tap into\"" },
          { "type": "Auditory Digital", "description": "Value data, systems, logic, specifications, contracts, and structured steps.", "triggers": "\"process,\" \"understand,\" \"think,\" \"decide,\" \"system,\" \"analyze\"" }
        ],
        "nlpTips": ["Fast Talker? Speed up your delivery. Slow/Deliberate Talker? Slow down and insert pauses.", "Kinesthetic Client? Hand them a heavy paving stone or masonry sample early.", "Auditory Digital? Present the project roadmap step-by-step before opening the 3D drawings."]
      },
      {
        "num": "02",
        "title": "Mutual Agreements (T.A.P.P.O.)",
        "tagline": "Set the roadmap. Commitments build massive trust.",
        "description": "Mutual Agreements are commitments that provide comfort, clarity, and progression throughout the sales funnel. T.A.P.P.O. is the framework — set it at every meeting.",
        "tappo": [
          { "letter": "T", "word": "Time", "description": "State exactly how much time is committed for the meeting." },
          { "letter": "A", "word": "Agenda", "description": "Identify what the prospect wants to cover and what you need to cover." },
          { "letter": "P", "word": "People", "description": "Clarify who will be present. Never present to one spouse only." },
          { "letter": "P", "word": "Process", "description": "Explain what will occur during the meeting step by step." },
          { "letter": "O", "word": "Outcome", "description": "Mutually define what the next step will be at the end." }
        ],
        "nonNegotiables": [
          "No budget qualification = No site plan or breakdown shared.",
          "Unidentified decision-makers = No final proposal review.",
          "Mutual Agreement broken = Stop work immediately and debrief."
        ]
      },
      {
        "num": "03",
        "title": "Discovery (CBRs + 3+ Rule)",
        "tagline": "Uncover Core Buying Reasons using the 3+ Funneling Rule.",
        "description": "CBRs (Core Buying Reasons) are the deep emotional drivers behind the purchase. Ask 3+ layered funnel questions before accepting any surface-level answer. Surface-level answers burn estimating hours on unqualified work.",
        "cbrQuestions": [
          "What prompted you to reach out today specifically?",
          "What is not working today with the current condition?",
          "What would make this project feel like a complete win 6 months after it's done?",
          "What has stopped you from addressing this before now?",
          "Who else needs to be part of this decision?",
          "Have you thought about the level of investment you are comfortable with?"
        ],
        "questioningTactics": [
          { "num": "01", "title": "The 3+ Funneling Rule", "description": "Never accept the first answer. Ask at least 3 deeper follow-up questions to reach the real Core Buying Reason. Surface answers like 'I just want it to look nice' hide emotional drivers like 'my daughter's wedding is in 4 months'." },
          { "num": "02", "title": "Pain to Pleasure Shift", "description": "Once pain and consequences are thoroughly established, transition toward a collaborative, forward-looking solution. 'Based on what we've walked through today, where would you like me to focus my design recommendations?'" },
          { "num": "03", "title": "Implication & Consequence", "description": "Uncover the cost of inaction. 'What happens next spring if we don't fix this retaining wall or the standing water?'" },
          { "num": "04", "title": "Nurturing & Validating Statements", "description": "Validate ideas to build trust. 'I appreciate your candor in sharing that with me. It sounds like a highly frustrating situation...' This makes them comfortable sharing deep emotional or financial constraints." },
          { "num": "05", "title": "Struggling Statements", "description": "Play vulnerable to make the prospect help you. 'Help me out here, I'm a bit confused... earlier you mentioned X, but now we're looking at Y?' Removes vendor tension and keeps you from sounding salesy." },
          { "num": "06", "title": "Effective Listening Discipline", "description": "We think at 3,000 words/min but listen at 150. 75% of the time we are distracted. Silence is power — pause 3 seconds after they finish. Nod and validate. Clarify definitions. Use verbatim feedback loops: 'Just to ensure I fully understand, when you say low-maintenance, you mean zero weeding or resealing, correct?'" }
        ]
      },
      {
        "num": "04",
        "title": "Budget",
        "tagline": "Align money tolerance with emotional Core Buying Reasons.",
        "description": "Your money tolerance governs how you sell. Reframe 'Cost' to 'Investment' — link their hard dollars back to emotional Core Buying Reasons. Never apologize for premium pricing. Never allow 1:1 comparison to generic hourly contractors.",
        "reframingRules": [
          "Link the $120,000 price tag directly back to hosting their daughter's wedding or securing structural integrity.",
          "Establish money limits during initial walk: 'What is your comfortable investment tolerance for this backyard transition?'",
          "Never apologize for the high pricing of premium materials.",
          "Never allow the client to compare your custom-engineered masonry proposal 1:1 with generic hourly contractors.",
          "No budget qualification = No site plan or breakdown shared."
        ],
        "talkTrack": "I know budget is a sensitive topic, so I'll be direct. We typically see projects like this ranging from [range]. I'm not asking you to commit to a number — I just want to make sure I'm building something that makes sense for your situation. Is there a range that would feel comfortable for you to invest, assuming we can deliver what you're describing?"
      },
      {
        "num": "05",
        "title": "Decision",
        "tagline": "Qualify the who, when, and how of their procurement decision.",
        "description": "Before presenting design plans or estimates, qualify the decision-making process completely. Pushing forward without this step is a fatal process error.",
        "pillars": [
          { "title": "Who is Involved?", "description": "Identify all decision-makers and key stakeholders/influencers — spouses, architects, HOA boards. Never present a design to only one spouse.", "check": "What happens if you both don't agree on the layout?" },
          { "title": "How is it Made?", "description": "Understand their evaluation criteria. What specific metrics or details must they see to make a decision? What was their past landscape contractor experience?", "check": "How did you select your interior builder?" },
          { "title": "When will it occur?", "description": "Establish a definitive, hard timeline. Map backward from graduation, wedding, or summer season deadlines to calculate excavation and planting start dates.", "check": "To host by June, we must break ground by March." }
        ],
        "rehearsalProtocol": "When only one contact can attend, rehearse with them how they'll present Avalon to the final decision-maker. 'When you show these drainage plans to your spouse tonight, what questions do you expect them to ask? How can I best arm you with those answers?'"
      },
      {
        "num": "06",
        "title": "Presentation",
        "tagline": "Pitch tailored designs connected back to Core Buying Reasons.",
        "description": "Never send a proposal via email for the client to read alone. Present the proposal in person or via live video call, walking through solutions step-by-step. A successful close is the natural, frictionless consequence of solid Mutual Agreements throughout the entire funnel.",
        "presentationSteps": [
          { "step": "1-2", "title": "Review CBRs → Present in CBR Order", "description": "Begin by restating their emotional Core Buying Reasons. Walk them through their painful driveway swamp or graduation goal first. Then pitch solutions starting with their highest priority emotional item." },
          { "step": "3-4", "title": "Check Agreement → Review Investment", "description": "Stop after every single design solution. Ask: 'Do you agree that this French drain system completely resolves your backyard pooling?' Only after they've signed off on the design do you present pricing — state it confidently as an investment." },
          { "step": "5-6", "title": "Address Concerns → Ask for a Decision", "description": "Encourage questions. Handle technical stone or plant objections using Acknowledge → Reframe → Forward-question. Then ask for a commitment. Avoid: 'Let me know what you think.' Instead: secure a signed contract or deposit with a clear start date." }
        ],
        "handoffPacket": {
          "title": "Sales-to-Production Handoff",
          "phases": [
            { "phase": "Phase 1: The Handoff Packet", "items": ["Signed SOW & Design Plan", "Complete Cost Breakdown (COGs)", "Client CBR & Communication Profile", "Material delivery and access layout"] },
            { "phase": "Phase 2: The Alignment Meeting", "items": ["SOW walkthrough line-by-line", "Identify heavy machinery access paths", "Crew Leader signs off on estimated hours", "Review high-risk drainage specs"] },
            { "phase": "Phase 3: The Driveway Handshake", "items": ["Sales Rep meets on site on day one of mobilization", "Restate the Mutual Agreement live", "Crew Leader takes over daily client comms", "Verify property lines and utility markouts"] }
          ]
        }
      }
    ]
  },
  "stages": [
    {
      "id": 1,
      "title": "Lead Intake and Routing",
      "processStep": "Pre-Step",
      "owner": "Sales Lead / Admin Support",
      "purpose": "Decide what kind of opportunity this is before anyone starts selling.",
      "artifact": "Lead record with service line, owner, source, timing, and next step.",
      "gate": "Enough information exists to schedule a discovery call or site walk.",
      "dayUse": "Open this stage before moving an opportunity through lead intake and routing.",
      "actions": [
        "Record name, property address, contact details, lead source, service line, urgency, and preferred next step.",
        "Identify whether the request is maintenance, seasonal service, enhancement, drainage/hardscape, design-build, commercial scope, or specialty/site work.",
        "Screen for service area, general fit, timing, and any obvious red flags.",
        "Assign an owner and schedule the next step before the lead goes cold."
      ],
      "questions": [
        "What prompted you to reach out?",
        "What type of work are you hoping to have done?",
        "Where is the property located?",
        "Is there a specific deadline or event driving the timing?",
        "Who should be involved in the conversation?"
      ],
      "redFlags": [
        "Out of service area.",
        "Unclear decision-maker — client wants a number without a conversation.",
        "Timing is unrealistic for scope described.",
        "Work type does not match Avalon's model.",
        "No clear next step scheduled before lead goes cold."
      ]
    },
    {
      "id": 2,
      "title": "Discovery and Mutual Agreement",
      "processStep": "Steps 01–02",
      "owner": "Sales Lead / Account Manager",
      "purpose": "Create rapport, learn the real buyer story via CBRs, set T.A.P.P.O. agreements, and confirm the next step.",
      "artifact": "Discovery notes with Core Buying Reasons, decision map, timing, budget comfort, T.A.P.P.O. agreement, and fit assessment.",
      "gate": "Avalon understands the real CBRs well enough to inspect the site and shape scope. Budget comfort explored.",
      "dayUse": "Open this stage before moving an opportunity through discovery and mutual agreement.",
      "actions": [
        "Establish real rapport within the first 7 seconds — match communication style, enter their world.",
        "Set T.A.P.P.O. (Time, Agenda, People, Process, Outcome) at the start of the meeting.",
        "Use the 3+ Funneling Rule — ask at least 3 layered questions before accepting any surface-level answer.",
        "Uncover Core Buying Reasons using implication, consequence, and pain-to-pleasure questioning.",
        "Apply effective listening discipline — 3-second silences, verbatim feedback loops, no premature solution mode.",
        "Identify all decision-makers — never present to one spouse alone.",
        "Explore budget comfort: 'What is your comfortable investment tolerance?'",
        "Set a mutual agreement for the site walk or proposal process."
      ],
      "questions": [
        "What made you reach out now — specifically?",
        "What is not working today?",
        "What would make this project feel like a complete win 6 months after it's done?",
        "Who else needs to weigh in?",
        "Have you done work like this before?",
        "What timing matters most?",
        "Have you thought about the level of investment you're comfortable with?"
      ],
      "redFlags": [
        "Client refuses to share priorities or buying reasons.",
        "Decision process is hidden — one spouse absent.",
        "Budget expectations are far below likely scope.",
        "Multiple stakeholders are not aligned.",
        "No T.A.P.P.O. set — meeting has no structure.",
        "Rep accepted first surface-level answer without 3+ funneling."
      ]
    },
    {
      "id": 3,
      "title": "Site Walk and Opportunity Qualification",
      "processStep": "Steps 02–03",
      "owner": "Sales Lead with Estimator / Project Lead as needed",
      "purpose": "Confirm site conditions, constraints, quality expectations, and project fit. Deepen CBR understanding on-site.",
      "artifact": "Site walk notes with photos, measurements, scope clarity, CBR reinforcement, risk notes, and fit decision.",
      "gate": "Avalon can accurately estimate and deliver this project at acceptable quality and margin.",
      "dayUse": "Open this stage before moving an opportunity through site walk and qualification.",
      "actions": [
        "Walk the site with the client — revisit their Core Buying Reasons while walking.",
        "Take photos and measurements that support estimating and production.",
        "Inspect access, drainage, grade, utilities, existing hardscape, plant health, staging areas, and material handling constraints.",
        "Separate must-haves from nice-to-haves.",
        "Hand kinesthetic clients a paving stone or material sample — build physical trust.",
        "Classify as: straightforward quote, scoped proposal, or roadmap/preconstruction package.",
        "Make the fit decision before leaving the site — be direct."
      ],
      "questions": [
        "Which areas matter most to you?",
        "What would you change first if we phased the project?",
        "Where have you seen water, erosion, settling, or access issues?",
        "Are there HOA, utility, neighbor, or permit issues we should know about?",
        "What do you want to avoid?"
      ],
      "redFlags": [
        "Missing access to critical areas.",
        "Unknown utilities or significant drainage ambiguity.",
        "Unclear property lines.",
        "Scope keeps expanding without priority — client can't decide what matters most.",
        "Fit decision was not made before leaving the site.",
        "No photos or measurements taken."
      ]
    },
    {
      "id": 4,
      "title": "Internal Scope Development",
      "processStep": "Step 03–04",
      "owner": "Sales Lead / Estimator",
      "purpose": "Convert site walk findings into a complete, defensible scope before estimating begins.",
      "artifact": "Scoped worksheet, material list, labor activity breakdown, assumptions, exclusions, and risk flags.",
      "gate": "Scope is complete enough to estimate without guessing. All risks are flagged.",
      "dayUse": "Open this stage before moving an opportunity through internal scope development.",
      "actions": [
        "Break the work into logical sections: plant material, landscaping services, hardscaping/drainage, miscellaneous, and coordination items.",
        "Define quantities, labor activities, materials, assumptions, exclusions, dependencies, and risk flags.",
        "Identify permit, engineering, utility, subcontractor, disposal, access, or staging concerns.",
        "Confirm whether the scope needs options, phases, allowances, or exclusions.",
        "Write exclusions in plain language — every unknown must be called out."
      ],
      "questions": [
        "What exactly are we furnishing and installing?",
        "What is included, excluded, assumed, or unknown?",
        "Where could production lose time or margin?",
        "What does the client need to decide now versus later?"
      ],
      "redFlags": [
        "Missing quantities — labor hours guessed.",
        "No defined production method for complex work.",
        "No exclusions written for unknowns.",
        "No contingency where risk is high.",
        "Scope was built from memory — no site walk documentation used."
      ]
    },
    {
      "id": 5,
      "title": "Estimating, Costing, and Margin Review",
      "processStep": "Step 04",
      "owner": "Estimator / Sales Lead (with Manager review for $2,500+)",
      "purpose": "Build an estimate that protects labor, material, overhead, contingency, and margin.",
      "artifact": "Internal estimate, margin check, pricing recommendation, and reviewer sign-off when required.",
      "gate": "Gross margin target met. Final sales number approved by appropriate authority level.",
      "dayUse": "Open this stage before moving an opportunity through estimating and costing.",
      "actions": [
        "Separate plant/tree material, site materials, labor, equipment, subcontractors, disposal, overhead, contingency, and margin.",
        "Review labor assumptions against actual production capacity.",
        "Adjust for hidden risks: access, weather, soil, utilities, unknown existing conditions, phased inefficiency.",
        "Confirm gross margin target and final sales number.",
        "Get manager review for $2,500–$10,000 jobs. Tyler approval required for $10,001+ and all hardscape/drainage/design-build."
      ],
      "approvalMatrix": [
        { "range": "Under $2,500", "approval": "Ryan may price using approved templates after training" },
        { "range": "$2,500 – $10,000", "approval": "Manager review required before final approval" },
        { "range": "$10,001+", "approval": "Tyler or senior management approval required" },
        { "range": "Hardscape / Drainage / Grading / Design-Build", "approval": "Management approval always required" }
      ],
      "redFlags": [
        "Labor hours guessed — no production rate reference.",
        "Materials undercounted or forgotten.",
        "No contingency on complex work.",
        "Sales number reduced without scope reduction.",
        "No reviewer sign-off on jobs requiring approval."
      ]
    },
    {
      "id": 6,
      "title": "Proposal Strategy and Packaging",
      "processStep": "Step 05–06",
      "owner": "Sales Lead",
      "purpose": "Build a client-ready proposal that makes it easy to say yes — framed by outcome, not just tasks.",
      "artifact": "Client-ready proposal with outcome framing, clear scope, investment, timeline, assumptions, exclusions, deposit/authorization, and next-step CTA.",
      "gate": "Proposal is reviewed and approved per authority matrix. Delivery method confirmed.",
      "dayUse": "Open this stage before moving an opportunity through proposal packaging.",
      "actions": [
        "Choose the proposal format based on complexity.",
        "Frame the client outcome BEFORE listing tasks — link to their Core Buying Reasons.",
        "Include: clear scope, investment, timeline, assumptions, exclusions, deposit/authorization, next-step call to action.",
        "Keep internal operational details out of the client proposal.",
        "Get manager review if required. Set delivery method and follow-up date before sending."
      ],
      "proposalStructure": [
        "1. Project summary and client outcome framing (CBRs first)",
        "2. Scope of work by section",
        "3. Investment",
        "4. Timeline or sequencing",
        "5. Assumptions and exclusions",
        "6. Deposit and authorization",
        "7. Next-step call to action"
      ],
      "redFlags": [
        "Proposal reads like a material dump — no outcome framing.",
        "No clear next step or decision date.",
        "Assumptions and exclusions are hidden in fine print.",
        "Proposal was emailed without scheduling a review call for complex work.",
        "Price is presented before value has been established."
      ]
    },
    {
      "id": 7,
      "title": "Proposal Delivery and Presentation",
      "processStep": "Step 06",
      "owner": "Sales Lead",
      "purpose": "Present solutions connected to CBRs, then walk through the investment confidently, and ask for a decision.",
      "artifact": "Delivered proposal, presentation notes, questions/concerns list, and defined decision timing.",
      "gate": "All decision-makers present. Client has heard the proposal live. Next step is defined.",
      "dayUse": "Open this stage before moving an opportunity through proposal delivery.",
      "actions": [
        "Present live or via video call — NEVER email a complex proposal for the client to read alone.",
        "Open by restating their Core Buying Reasons before touching the proposal.",
        "Present solutions in priority order of their CBRs.",
        "Stop after each solution and confirm agreement: 'Do you agree this resolves your backyard pooling?'",
        "Only after design sign-off: present the investment, stated confidently as an investment — not a cost.",
        "Address concerns using Acknowledge → Reframe → Forward-question.",
        "Ask for a decision or a specific decision date before ending the meeting."
      ],
      "questions": [
        "Does this match what you were hoping to solve?",
        "Is there anything here that feels unclear or misaligned?",
        "What questions do you have about the investment?",
        "What would you need from us to feel comfortable moving forward?",
        "What is the best next step from here?"
      ],
      "redFlags": [
        "Proposal emailed with no context on complex work.",
        "Decision-maker absent from presentation.",
        "No defined decision date established.",
        "Price discussed before value was established.",
        "Rep apologized for the price."
      ]
    },
    {
      "id": 8,
      "title": "Follow-Up, Objections, and Decision Management",
      "processStep": "Step 06",
      "owner": "Sales Lead",
      "purpose": "Stay in contact on a defined cadence, resolve real objections, and move clients toward a clear decision.",
      "artifact": "Follow-up log, objection notes, revised scope if needed, and won/lost/hold status.",
      "gate": "Client has given a clear yes, no, hold, or revision request. Status is documented.",
      "dayUse": "Open this stage before moving an opportunity through follow-up and objection handling.",
      "actions": [
        "Follow up on a defined cadence — Day 3, Day 7, Day 14 — not random check-ins.",
        "Clarify vague objections before answering them: 'Is it the price, scope, timing, or something else?'",
        "Revisit Core Buying Reasons and decision priorities.",
        "Offer revisions ONLY when scope, timing, or investment truly need to change.",
        "Apply the 5-step objection framework: Pause → Clarify → Reconnect to CBRs → Offer a path → Confirm next step.",
        "Close the loop when the client goes quiet — set a final follow-up and be honest."
      ],
      "objectionFramework": [
        "1. Pause and acknowledge. Do not defend immediately.",
        "2. Clarify the real issue: investment, scope, timing, trust, priority, or decision process.",
        "3. Reconnect the conversation to the client's Core Buying Reasons.",
        "4. Offer a path: proceed, revise scope, phase, hold, or close out.",
        "5. Confirm the next step and date."
      ],
      "followUpCadence": [
        { "day": "Day 1", "action": "Confirm proposal was received. Offer to schedule a review call." },
        { "day": "Day 3", "action": "First follow-up: 'I want to make sure you have everything you need to make a comfortable decision. Any questions come up?'" },
        { "day": "Day 7", "action": "Second follow-up: Revisit their CBRs. Ask what specifically they're still weighing." },
        { "day": "Day 14", "action": "Direct decision ask: 'Are we moving forward, is there something holding you back, or is this off the table right now?'" },
        { "day": "Day 21+", "action": "Final follow-up or hold classification. 'Should I keep this active or close it out for now?'" }
      ],
      "redFlags": [
        "No follow-up cadence — random or no contact after proposal sent.",
        "Rep argues with the objection instead of clarifying it.",
        "Repeated discounts offered without scope change.",
        "Opportunity drifts for 14+ days with no next step.",
        "Client goes quiet and rep takes no action."
      ]
    },
    {
      "id": 9,
      "title": "Sold Job Activation",
      "processStep": "Post-Close Step 1",
      "owner": "Sales Lead + Operations",
      "purpose": "Convert the verbal yes into a locked, documented, production-ready job.",
      "artifact": "Signed approval, deposit confirmation, activated job file, and production handoff checklist.",
      "gate": "Signed SOW and deposit received. Scope matches estimate. Production owner assigned.",
      "dayUse": "Open this stage before moving a sold job through activation.",
      "actions": [
        "Confirm signed proposal or SOW received.",
        "Confirm deposit or payment requirement met.",
        "Lock scope, assumptions, exclusions, and client commitments — no verbal changes accepted.",
        "Finalize internal cost file and production notes.",
        "Assign production ownership and confirm scheduling path.",
        "Identify subs, permits, compliance, utilities, and special materials."
      ],
      "questions": [
        "Is the signed scope the same as the estimate?",
        "Has deposit been received?",
        "What does production need to know before scheduling?",
        "What client expectations must be restated before work begins?"
      ],
      "redFlags": [
        "Signed scope differs from the estimate — scope creep introduced.",
        "Deposit missing before scheduling.",
        "No production owner assigned.",
        "Unclear start conditions or access.",
        "Change in scope accepted verbally without written amendment."
      ]
    },
    {
      "id": 10,
      "title": "Pre-Production Roadmap and Client Communication",
      "processStep": "Post-Close Step 2",
      "owner": "Sales Lead + Project Manager",
      "purpose": "Set clear expectations, confirm client preparation, and establish a communication rhythm before crews arrive.",
      "artifact": "Client roadmap, pre-production email, communication schedule, and preparation checklist.",
      "gate": "Client knows start conditions, daily contact, and what to expect. No surprises.",
      "dayUse": "Open this stage before moving an activated job through pre-production setup.",
      "actions": [
        "For larger jobs: issue a simple roadmap with phases, sequencing, dependencies, and watch-outs.",
        "Confirm client preparation: access, pets, gates, vehicles, irrigation, utilities, and material staging.",
        "Set communication rhythm: weekly Friday updates for larger active jobs.",
        "Explain what may change due to weather, deliveries, site conditions, or change orders.",
        "The Driveway Handshake: Sales Rep meets on site on Day 1 of mobilization. Walks property with client and Crew Leader. Formally passes the baton."
      ],
      "questions": [
        "Who should receive updates?",
        "Are there access restrictions — pets, gates, parking, neighbors?",
        "What needs to happen before crews arrive?",
        "Is irrigation marked and shut off if needed?"
      ],
      "redFlags": [
        "Client does not know start conditions or who their daily contact is.",
        "No communication owner assigned.",
        "Complex job begins without a pre-production roadmap.",
        "Sales Rep does not appear on Day 1 for the Driveway Handshake."
      ]
    },
    {
      "id": 11,
      "title": "Production Feedback Loop",
      "processStep": "Post-Completion Step 1",
      "owner": "Operations + Sales Lead",
      "purpose": "Capture what happened vs. what was sold — and use it to improve future estimating and sales behavior.",
      "artifact": "Production feedback notes, margin variance notes, and process improvement items.",
      "gate": "All scope misses, labor variances, and client expectation gaps are documented and reviewed.",
      "dayUse": "Open this stage before closing out a completed job.",
      "actions": [
        "Capture scope misses, labor overages, material issues, client expectation gaps, and production friction.",
        "Compare estimate assumptions to actual execution.",
        "Identify what should change in future discovery, scoping, pricing, or handoff.",
        "Review lessons in weekly sales/production rhythm.",
        "Never let a margin loss disappear without review — the same mistake repeating is a system failure."
      ],
      "questions": [
        "What did we miss in the estimate or scope?",
        "Where did labor differ from estimate?",
        "What made the job smoother or harder than expected?",
        "What should sales ask differently next time?",
        "What should estimating price differently next time?"
      ],
      "redFlags": [
        "Same mistake repeats without investigation.",
        "Production complaints do not reach the sales team.",
        "Margin loss is never reviewed.",
        "No feedback loop meeting scheduled."
      ]
    },
    {
      "id": 12,
      "title": "Closeout, Renewal, and Expansion",
      "processStep": "Post-Completion Step 2",
      "owner": "Sales Lead / Account Manager",
      "purpose": "Close every job cleanly, capture satisfaction, and convert happy clients into future revenue — reviews, referrals, and phase 2.",
      "artifact": "Closeout note, review/referral request, future opportunity record, and maintenance or phase 2 prompt.",
      "gate": "Client satisfaction confirmed. Review requested. Next opportunity identified and logged.",
      "dayUse": "Open this stage when closing out any completed job.",
      "actions": [
        "Confirm completion and client satisfaction personally — not through production crew.",
        "Ask for a review or referral when appropriate: 'Would you be comfortable leaving us a review on Google?'",
        "Identify phase 2 work, maintenance conversion, seasonal service, or adjacent improvements.",
        "Log the next opportunity with timing and owner — do not let it drift.",
        "Close the file with notes useful for future work on this property."
      ],
      "questions": [
        "How does everything look now that the work is complete?",
        "Is there anything we should address before we close this out?",
        "Would you like us to help maintain or protect this investment?",
        "What would you want to tackle next?",
        "Would you be comfortable leaving us a review?"
      ],
      "redFlags": [
        "Job ends silently with no closeout call.",
        "No review or referral request made.",
        "Future work is discussed but not logged.",
        "Client concerns are unresolved at closeout.",
        "No maintenance conversion conversation attempted."
      ]
    }
  ],
  "forms": [
    {
      "id": "lead_intake",
      "title": "Lead Intake Form",
      "stage": 1,
      "fields": [
        { "label": "Client Name", "type": "text", "required": true },
        { "label": "Property Address", "type": "text", "required": true },
        { "label": "Phone", "type": "tel", "required": true },
        { "label": "Email", "type": "email", "required": false },
        { "label": "Lead Source", "type": "select", "options": ["Website", "Referral", "Google", "Social Media", "Yard Sign", "Door Hanger", "Cold Call", "Neighborhood Canvass", "Past Client", "Other"], "required": true },
        { "label": "Service Line", "type": "select", "options": ["Landscape / Enhancement", "Maintenance – One-Time", "Maintenance – Recurring", "Hardscape / Drainage", "Design-Build", "Irrigation", "Outdoor Lighting", "Commercial Scope", "Other"], "required": true },
        { "label": "Client Type", "type": "select", "options": ["Residential", "Commercial"], "required": true },
        { "label": "Urgency / Timing", "type": "text", "required": true },
        { "label": "What prompted the inquiry?", "type": "textarea", "required": true },
        { "label": "Decision-maker identified?", "type": "checkbox", "required": false },
        { "label": "Assigned Owner", "type": "text", "required": true },
        { "label": "Next Step", "type": "text", "required": true },
        { "label": "Next Step Date", "type": "date", "required": true }
      ]
    },
    {
      "id": "discovery",
      "title": "Discovery Notes Form",
      "stage": 2,
      "fields": [
        { "label": "Core Buying Reason #1 (Surface)", "type": "text", "required": true },
        { "label": "Core Buying Reason #2 (Deeper)", "type": "text", "required": true },
        { "label": "Core Buying Reason #3 (Real / Emotional)", "type": "text", "required": true },
        { "label": "Decision-makers identified", "type": "text", "required": true },
        { "label": "T.A.P.P.O. set?", "type": "checkbox", "required": false },
        { "label": "Budget comfort explored ($)", "type": "text", "required": false },
        { "label": "Client timeline / deadline", "type": "text", "required": true },
        { "label": "Past contractor experience / frustrations", "type": "textarea", "required": false },
        { "label": "Communication style (Visual / Auditory / Kinesthetic / Digital)", "type": "text", "required": false },
        { "label": "Mutual Agreement for next step", "type": "text", "required": true }
      ]
    },
    {
      "id": "site_walk",
      "title": "Site Walk Checklist Form",
      "stage": 3,
      "fields": [
        { "label": "Photos taken?", "type": "checkbox", "required": false },
        { "label": "Measurements captured", "type": "text", "required": true },
        { "label": "Access / staging notes", "type": "textarea", "required": true },
        { "label": "Drainage / grade issues noted", "type": "textarea", "required": false },
        { "label": "Utilities / property lines / HOA concerns", "type": "textarea", "required": false },
        { "label": "Must-haves (client confirmed)", "type": "textarea", "required": true },
        { "label": "Nice-to-haves (optional)", "type": "textarea", "required": false },
        { "label": "Opportunity path selected", "type": "select", "options": ["Straightforward Quote", "Scoped Proposal", "Roadmap / Preconstruction Package"], "required": true },
        { "label": "Fit decision made?", "type": "checkbox", "required": false },
        { "label": "Next step confirmed with client", "type": "text", "required": true }
      ]
    },
    {
      "id": "scope",
      "title": "Internal Scope Worksheet",
      "stage": 4,
      "fields": [
        { "label": "Plant / Material List", "type": "textarea", "required": true },
        { "label": "Labor Activity Breakdown", "type": "textarea", "required": true },
        { "label": "Hardscape / Drainage Method", "type": "textarea", "required": false },
        { "label": "Quantities and Unit Assumptions", "type": "textarea", "required": true },
        { "label": "Subcontractors / Permits / Utilities", "type": "textarea", "required": false },
        { "label": "Assumptions", "type": "textarea", "required": true },
        { "label": "Exclusions", "type": "textarea", "required": true },
        { "label": "Risk Flags", "type": "textarea", "required": false },
        { "label": "Contingency %", "type": "text", "required": false }
      ]
    },
    {
      "id": "sold_activation",
      "title": "Sold Job Activation Checklist",
      "stage": 9,
      "fields": [
        { "label": "Signed SOW / Proposal received?", "type": "checkbox", "required": false },
        { "label": "Deposit confirmed ($)", "type": "text", "required": true },
        { "label": "Approved scope matches estimate?", "type": "checkbox", "required": false },
        { "label": "Production notes created?", "type": "checkbox", "required": false },
        { "label": "Materials / subs / permits flagged", "type": "textarea", "required": false },
        { "label": "Production owner assigned", "type": "text", "required": true },
        { "label": "Client pre-production communication planned?", "type": "checkbox", "required": false },
        { "label": "Driveway Handshake scheduled (Day 1 on-site)?", "type": "checkbox", "required": false }
      ]
    },
    {
      "id": "closeout",
      "title": "Job Closeout Form",
      "stage": 12,
      "fields": [
        { "label": "Completion confirmed internally?", "type": "checkbox", "required": false },
        { "label": "Client satisfaction confirmed?", "type": "checkbox", "required": false },
        { "label": "Open issues (if any)", "type": "textarea", "required": false },
        { "label": "Review / referral requested?", "type": "checkbox", "required": false },
        { "label": "Future phase / maintenance opportunity identified", "type": "textarea", "required": false },
        { "label": "Next opportunity logged (with timing and owner)?", "type": "checkbox", "required": false },
        { "label": "Lessons learned", "type": "textarea", "required": false }
      ]
    }
  ],
  "scripts": [
    {
      "category": "⭐ VERBATIM — Driveway T.A.P.P.O.",
      "title": "Driveway T.A.P.P.O. Script — Stage 2 Gate (VERBATIM — Do Not Deviate)",
      "crmAction": "Once client agrees → tick 'Driveway T.A.P.P.O. Confirmed' checkbox → advance to Stage 2.",
      "body": "\"Thanks for having me out. Just to review what we agreed to: we have about 45 minutes today (Time). We'll walk the property to review the drainage issues and outdoor kitchen goals (Agenda), with both you and your spouse (People). We'll take rough measurements and discuss your budget tolerance (Process). By the end, we'll decide if it makes sense to move forward with a full design agreement (Outcome). Does that still sound good?\""
    },
    {
      "category": "⭐ VERBATIM — Budget Bracketing",
      "title": "Budget Bracketing Script — Stage 4 Gate (VERBATIM — Use When Client Deflects Budget)",
      "crmAction": "Record client's comfort range in 'Target Investment Tolerance' currency field → populates Stage 4 gate.",
      "body": "\"Typically, a backyard layout of this scope with premium thermal flagstone and a complete French drain remediation runs between $100,000 and $130,000. Some go above $150,000 with extensive masonry work. Where on that spectrum do you feel most comfortable aligning your investment?\""
    },
    {
      "category": "⭐ VERBATIM — Objection Handling",
      "title": "Acknowledge → Reframe → Forward-Question (VERBATIM — Use at Any Stage for Any Objection)",
      "note": "Apply at any stage when an objection (price, timing, decision delay) surfaces.",
      "body": "STEP 1 — ACKNOWLEDGE (validate the feeling):\n\"I can appreciate that a $120,000 budget is a significant investment.\"\n\nSTEP 2 — REFRAME (redirect to emotional CBR):\n\"However, keeping this baseline budget guarantees that your basement remains dry and that we have the entire backyard paved and ready to host your daughter's graduation next June.\"\n\nSTEP 3 — FORWARD-QUESTION (regain control with a choice):\n\"When you look at the graduation date, is completing this before the family arrives the highest priority, or would you prefer we phase the softscaping across next fall?\""
    },
    {
      "category": "First Contact",
      "title": "Inbound Lead Response",
      "body": "Hi [Name], this is [Your Name] with Avalon Landscape Construction. Thank you for reaching out — I wanted to connect quickly to learn more about your project and see if we might be a good fit.\n\nCan you tell me a little about what you're looking to get done and what's prompting the project right now?"
    },
    {
      "category": "First Contact",
      "title": "Referral Introduction",
      "body": "Hi [Name], this is [Your Name] with Avalon. [Referrer name] suggested I reach out — they mentioned you may be looking at a [project type].\n\nI appreciate the introduction. I'd love to learn more about what you're working on. Do you have a few minutes to talk through it now, or is there a better time this week?"
    },
    {
      "category": "First Contact",
      "title": "Ryan's Outbound Cold Call",
      "body": "Hi, this is Ryan with Avalon Landscape Construction. I was in the neighborhood doing some work nearby and wanted to introduce myself. We specialize in [landscape / maintenance / enhancement] for [residential / commercial] properties in this area.\n\nIs this a good time for a quick 2-minute introduction? I don't want to take much of your time — I just want to make sure you know who we are if you ever need a reliable team."
    },
    {
      "category": "Rapport — T.A.P.P.O. Opening",
      "title": "Setting Mutual Agreements at Meeting Start",
      "body": "Before we get into anything, I want to set up a quick roadmap for our time together so we're both on the same page.\n\nTime: I've blocked [X] minutes for us today — does that still work for you?\nAgenda: My goal is to understand what you're looking to accomplish, then walk the site together so I can give you an accurate picture. You had mentioned wanting to cover [their stated goal] — is there anything else?\nPeople: Is everyone who needs to weigh in on this joining us today?\nProcess: I'll ask you some questions first, then we'll walk the site, and I'll share my initial thoughts before I leave.\nOutcome: By the end, we'll both know whether this is a good fit and what the next step looks like.\n\nDoes that sound right to you?"
    },
    {
      "category": "Discovery — 3+ Funneling",
      "title": "Core Buying Reason Deep Dive",
      "body": "Before I start asking about scope or price, I want to make sure I actually understand what you're trying to solve. So let me ask — what's the main thing that prompted you to start looking at this now?\n\n[Wait for answer.]\n\nOkay, help me understand that a bit more — when you say [repeat their answer], what specifically about that is the issue?\n\n[Wait for answer.]\n\nAnd if we could fix that completely — what would that mean for you and your family? What changes?\n\n[This is the real Core Buying Reason. Document it verbatim.]"
    },
    {
      "category": "Discovery — Listening",
      "title": "Verbatim Feedback Loop",
      "body": "Just to make sure I fully understand before we walk the site — when you say you want something 'low maintenance,' you mean you don't want to be weeding or resealing anything seasonally, correct? You're looking for a solution that basically takes care of itself?\n\n[Repeat their exact words back. Let them correct you. This is the highest-trust move in the conversation.]"
    },
    {
      "category": "Discovery — Budget",
      "title": "Budget Comfort Exploration",
      "body": "I know investment tolerance is a sensitive topic, so I'll be direct rather than dance around it. For a project like what you're describing, we typically see investments in the range of [range]. That's a broad range because every site is different.\n\nI'm not asking you to commit to anything today — I just want to make sure I build you something that makes financial sense for your situation. Is there a range that feels comfortable, assuming we can deliver exactly what you're describing?"
    },
    {
      "category": "Discovery — Decision",
      "title": "Decision-Maker Confirmation",
      "body": "I want to make sure I'm bringing the right information to the right people. When it comes to a decision like this — is it primarily you, or is there a partner or family member who would be part of the final call?\n\nI ask because I want to make sure whoever needs to be in the conversation is included from the start. I've found it saves everyone time when the right people are in the room for the proposal — otherwise we end up presenting twice."
    },
    {
      "category": "Discovery — Consequence",
      "title": "Implication & Consequence Question",
      "body": "Help me understand the full picture here. What happens if we don't address [the drainage issue / the retaining wall / the overgrown areas] this season?\n\n[Wait for answer.]\n\nAnd then what? What's the downstream impact of leaving that unresolved?\n\n[This surfaces urgency without pressure. Let them feel the cost of inaction.]"
    },
    {
      "category": "Discovery — Struggling Statement",
      "title": "The Struggling Statement (Vulnerable Close)",
      "body": "Help me out here — I might be missing something. Earlier you mentioned you wanted to move quickly on this because of the event in June, but now it sounds like the timing might be more flexible. Can you help me understand which is more accurate?\n\n[This removes vendor tension, invites honesty, and surfaces any hidden objections before they become blockers.]"
    },
    {
      "category": "Site Walk",
      "title": "Site Walk Opening",
      "body": "Thanks for having me out. Before we walk anything, let me just confirm — the main thing we're here to look at today is [scope summary]. Does that still reflect what you're thinking, or has anything changed since we last spoke?\n\nAnd while we walk, if you have any concerns or things you want me to pay special attention to, please point them out. That detail always helps us get the estimate right."
    },
    {
      "category": "Site Walk",
      "title": "Fit Decision Conversation",
      "body": "Based on what I've seen today, I want to be straightforward with you. This is [a strong fit / a project we can do well / something I want to think about before committing].\n\nHere's what I'm thinking from our side — [brief summary]. Does that align with your expectations, and does it make sense to move forward with an estimate?"
    },
    {
      "category": "Proposal",
      "title": "Proposal Walk-Through Opening (CBRs First)",
      "body": "Before I walk you through the numbers, I want to start where we started — with what matters most to you.\n\nYou told me that the reason you reached out was [Core Buying Reason — use their words]. And you said that if we didn't fix this, [consequence they named]. That is exactly what this proposal is built around.\n\nEverything I'm about to show you is organized around solving that problem first. Then we'll look at the investment. Sound good?"
    },
    {
      "category": "Proposal",
      "title": "Anchoring the Investment (Not the Price)",
      "body": "The total investment for this scope is [price].\n\nThe way we built this — [brief explanation of cost drivers: labor, materials, complexity]. We're not the lowest-cost option in the market, and that's intentional. What you're getting with Avalon is [differentiator: quality, warranty, project management, no guessing on the back end].\n\nDoes this feel like the right investment to accomplish what you've told me matters most?"
    },
    {
      "category": "Proposal",
      "title": "Decision Rehearsal (One Spouse Missing)",
      "body": "Before we wrap up today, I want to help you with one thing. When you share these plans with [spouse/partner] tonight, what questions do you think they're going to ask?\n\n[Let them answer. Address each one now.]\n\nHere's how I'd frame it for them: [provide their talking points]. That way, when they see the investment, they already understand what it solves and why it's priced the way it is. Does that help?"
    },
    {
      "category": "Follow-Up",
      "title": "Post-Proposal Check-In (Day 3)",
      "body": "Hi [Name], this is [Your Name] with Avalon. I sent over the proposal [X days ago] and wanted to follow up. I don't want to pressure you — I just want to make sure you have everything you need to make a comfortable decision.\n\nIs there anything in the proposal you'd like me to clarify, or any concerns that came up since we last spoke?"
    },
    {
      "category": "Follow-Up",
      "title": "Objection Clarifier",
      "body": "I want to make sure I'm actually addressing the right thing. When you say [their objection] — help me understand. Is the concern primarily:\n- The total investment amount?\n- What's included in the scope?\n- The timing of the project?\n- Something about how we'd work together?\n\nAny one of those I can address differently. I just want to make sure I'm not answering the wrong question."
    },
    {
      "category": "Follow-Up",
      "title": "Direct Decision Ask (Day 14)",
      "body": "I want to be respectful of your time and mine, so I'll be direct. We've talked through the project, you've seen the proposal, and I've addressed the questions I know about.\n\nWhere are you at with this? Are we moving forward, is there something that's holding you back, or is this something that's off the table right now?\n\nAny of those answers is fine — I just want to make sure we're both clear on where things stand."
    },
    {
      "category": "Closing",
      "title": "Verbal Yes Confirmation",
      "body": "Excellent — I appreciate the confidence. Let me confirm what we've agreed to: [scope], at [price], starting [timeline].\n\nThe next step is getting the paperwork over to you. I'll send the contract and deposit instructions today. Once those are received, we'll lock in your spot in the schedule.\n\nIs there anything you need from me before you sign?"
    },
    {
      "category": "Closing",
      "title": "Asking for the Decision (Avoid Weak Closes)",
      "body": "We've walked through everything — the design matches what you told me matters most, and the investment reflects what we'd actually need to do this right.\n\nI'd like to move forward. Can we lock this in today?\n\n[Do NOT say 'Let me know what you think.' or 'Take your time.' Ask for the business directly — the close is a natural result of the process.]"
    },
    {
      "category": "Closing",
      "title": "Closeout and Referral Request",
      "body": "Now that the project is complete, I wanted to check in personally. Is everything looking the way you expected?\n\n[If yes:] I'm really glad to hear that. If you were happy with the experience, the biggest thing that helps us is a Google review — it only takes a minute and it helps other families in the area find us. I'll send you the link.\n\nAnd honestly — if you know anyone who's been talking about a [landscape / drainage / maintenance] project, I'd love the introduction. We treat referrals the same way we treated you."
    }
  ],
  "templates": [
    {
      "category": "First Contact",
      "title": "Inbound Lead Acknowledgment",
      "subject": "Avalon Landscape Construction — Your Inquiry",
      "body": "Hi [Name],\n\nThank you for reaching out to Avalon. I received your inquiry and wanted to get back to you quickly.\n\nI'd love to learn more about your project and see if we might be a good fit. Would you be available for a quick 15-minute call this week? I'm flexible on timing — just let me know what works for you.\n\nLooking forward to connecting.\n\nBest,\n[Your Name]\nAvalon Landscape Construction\n[Phone] | [Email]"
    },
    {
      "category": "First Contact",
      "title": "Referral Follow-Up",
      "subject": "Introduction from [Referrer Name] — Avalon Landscape Construction",
      "body": "Hi [Name],\n\n[Referrer name] suggested I reach out — they mentioned you may be thinking about a landscape project and thought we might be worth talking to.\n\nAvalon Landscape Construction specializes in [service lines]. We're known for clean estimates, transparent scopes, and projects that finish the way they were sold.\n\nIf you're open to a quick conversation, I'd love to hear about what you're working on. No pressure — just an introduction.\n\nBest,\n[Your Name]\nAvalon Landscape Construction\n[Phone] | [Email]"
    },
    {
      "category": "Post-Discovery",
      "title": "Discovery Summary and Next Step",
      "subject": "Summary from Our Conversation — Avalon",
      "body": "Hi [Name],\n\nThanks for the time today. I wanted to capture what we discussed so we're both on the same page.\n\nProject: [Summary of project]\nWhat matters most to you: [Core Buying Reason in their words]\nTimeline: [What was discussed]\nNext step: [Site walk / additional info / proposal]\nDate/time confirmed: [Date]\n\nIf I missed anything or something has changed, just let me know. I'll follow up as planned.\n\nBest,\n[Your Name]\nAvalon Landscape Construction"
    },
    {
      "category": "Post-Site Walk",
      "title": "Site Walk Summary and Estimate Timeline",
      "subject": "Site Walk Summary — [Client Name] Project",
      "body": "Hi [Name],\n\nThank you for your time today. I enjoyed walking the site and getting a clear picture of what you're looking to accomplish.\n\nHere's a quick recap:\n- Project scope: [Summary]\n- Key notes from the walk: [Any conditions or preferences]\n- Must-haves confirmed: [List]\n- Next step: We'll have the estimate ready by [date]\n\nI'll be in touch by then. In the meantime, feel free to reach out if any questions come up.\n\nBest,\n[Your Name]\nAvalon Landscape Construction"
    },
    {
      "category": "Proposal",
      "title": "Proposal Delivery",
      "subject": "Avalon Proposal — [Project Name]",
      "body": "Hi [Name],\n\nAttached is the proposal for your [project type] project at [address].\n\nBefore you dig in, I want to remind you of what we're solving: [their Core Buying Reason in their words]. Everything in this proposal is organized around that.\n\nThe total investment is [price]. I've included the scope, exclusions, assumptions, and next steps inside.\n\nI'd suggest we take 15 minutes to walk through it together — that way any questions get answered quickly and nothing is left unclear. Are you available [day/time]?\n\nBest,\n[Your Name]\nAvalon Landscape Construction"
    },
    {
      "category": "Follow-Up",
      "title": "Post-Proposal Follow-Up (Day 3)",
      "subject": "Following Up — Avalon Proposal",
      "body": "Hi [Name],\n\nJust following up on the proposal I sent [X days ago]. I want to make sure you received it and that you have everything you need to make a comfortable decision.\n\nIf any questions have come up, or if you'd like to revisit anything in the scope, I'm happy to connect. Even a 10-minute call can often resolve what an email back-and-forth can't.\n\nLet me know the best way to move forward from here.\n\nBest,\n[Your Name]\nAvalon Landscape Construction"
    },
    {
      "category": "Follow-Up",
      "title": "Direct Check-In (Day 14)",
      "subject": "Where Are We At? — Avalon",
      "body": "Hi [Name],\n\nI don't want to leave this open-ended. We've invested time on both sides, and I'd rather know where things stand than let this drift.\n\nAre we moving forward, is there something I can help address, or is this off the table for now? Any of those answers is completely fine — I just want to be honest with you about where I'm at.\n\nBest,\n[Your Name]\nAvalon Landscape Construction"
    },
    {
      "category": "Post-Sale",
      "title": "Verbal Yes Confirmation",
      "subject": "Great News — Next Steps for Your Project",
      "body": "Hi [Name],\n\nI'm glad we're moving forward! I wanted to confirm what we've agreed to so everything is clear going in.\n\nScope: [Summary]\nPrice: [Amount]\nTimeline: [Expected start]\nNext step: I'll send the contract and deposit instructions shortly.\n\nOnce those are received, we'll lock in your spot in the schedule and get everything set in motion. Please don't hesitate to reach out with any questions between now and then.\n\nThank you for trusting us with this project.\n\nBest,\n[Your Name]\nAvalon Landscape Construction"
    },
    {
      "category": "Post-Sale",
      "title": "Sold Job Welcome",
      "subject": "Welcome to the Avalon Family — Your Project is Confirmed",
      "body": "Hi [Name],\n\nThank you — your contract and deposit have been received. Your project is officially confirmed.\n\nHere's what to expect:\n- You'll hear from our project team to coordinate access and final details.\n- Estimated start: [Date]\n- Your primary contact during production will be [Project Lead Name] at [contact info].\n- I'll personally be on-site on Day 1 to make sure the handoff goes smoothly.\n\nIf anything comes up before then, you're always welcome to reach out to me directly.\n\nWe're looking forward to doing great work for you.\n\nBest,\n[Your Name]\nAvalon Landscape Construction"
    },
    {
      "category": "Post-Sale",
      "title": "Closeout and Review Request",
      "subject": "Thank You — How Did We Do?",
      "body": "Hi [Name],\n\nNow that your project is complete, I wanted to check in personally. Is everything looking the way you expected?\n\nIf there's anything we missed or anything you'd like to discuss, please let me know right away — we always want to make it right.\n\nIf you're happy with the work, we'd really appreciate a quick review on Google. It only takes a minute and it helps other families and businesses in the area find us:\n[Google Review Link]\n\nAnd if you know anyone who's been talking about a landscape, maintenance, or enhancement project — we'd love the introduction.\n\nThank you again for the opportunity.\n\nBest,\n[Your Name]\nAvalon Landscape Construction"
    }
  ],
  "objections": [
    {
      "title": "Your price is too high.",
      "meaning": "They may be comparing to a lower quote, have an unrealistic expectation, or don't yet see the value difference.",
      "response": [
        "Acknowledge the concern without defending immediately.",
        "Ask what they're comparing it to — price only makes sense in context.",
        "Walk back through what is included and what competitors may be excluding.",
        "Ask: is the concern the total number, or the value for that number?"
      ],
      "say": "I hear you — and I appreciate you being direct. Can I ask what you're comparing it to? The reason I ask is that scope can vary significantly between proposals, and I want to make sure we're comparing the same thing. Walk me through what the other number includes and we can have a real conversation about the difference."
    },
    {
      "title": "I need to think about it.",
      "meaning": "There is likely an unspoken concern. They may not feel ready to decide, or something in the proposal wasn't clear.",
      "response": [
        "Don't push. Ask what specifically they need to think about.",
        "Use the objection clarifier: 'Is it the price, scope, timing, or fit?'",
        "Identify the real concern behind the vague response.",
        "Offer a specific time to reconnect rather than leaving it open."
      ],
      "say": "Absolutely — this isn't a small decision. Help me understand what you're thinking through. Is it the price, the scope, the timing, or something about fit? I'd rather answer a real question than have you sit on something that I could clear up in five minutes."
    },
    {
      "title": "I got a cheaper quote.",
      "meaning": "A competitor has quoted lower. This could be a scope difference, a quality difference, or a credibility play.",
      "response": [
        "Ask to see the other proposal or at least understand what it includes.",
        "Do not match price — instead, explain what's different.",
        "Protect scope quality rather than cutting to compete.",
        "Ask what the other contractor's warranty, supervision, and change order process looks like."
      ],
      "say": "I'm glad you're comparing — that's smart. The question I'd want you to ask is: what's in their scope that's not in mine, and vice versa? Price only matters when the scope is identical. If you're comfortable sharing the other quote, I can walk you through the differences. If not, I can at least walk you through what makes ours what it is."
    },
    {
      "title": "Can you do it cheaper?",
      "meaning": "They want a lower number. The cause could be budget, value perception, or they're testing your flexibility.",
      "response": [
        "Do not discount without changing scope.",
        "Offer a scope reduction or phasing option if appropriate.",
        "Be honest about what cannot be cut without compromising quality.",
        "Connect the scope to their Core Buying Reason: 'If we cut X, we don't solve Y — which was the main thing you said you needed.'"
      ],
      "say": "The short answer is: yes, but only if we change what we're doing. I don't want to strip margin from the same scope — that leads to problems on the job. What I can do is look at what could be phased, reduced, or removed if that gets you to a number that works. What's the most important part of this for you?"
    },
    {
      "title": "I'm not sure this is the right time.",
      "meaning": "They may have budget pressure, competing priorities, or fear of commitment. Timing objections are often really risk objections.",
      "response": [
        "Explore what would need to be different for the timing to feel right.",
        "Ask what the cost of waiting is — sometimes urgency is real.",
        "Offer to hold a spot if scheduling allows.",
        "Map timing to their deadline: 'You mentioned the event in June — to hit that, we'd need to start by [date].'"
      ],
      "say": "That's fair. Help me understand what would need to change for the timing to feel right. Is it a financial thing, a life timing thing, or something about the project itself? I ask because sometimes we can work around timing, and sometimes we can't — but I'd rather know what we're actually dealing with."
    },
    {
      "title": "I want to get a few more quotes.",
      "meaning": "They haven't made up their mind. They may be comparison shopping or still building trust.",
      "response": [
        "Encourage it — confidence wins over desperation.",
        "Ask what criteria they'll use to decide.",
        "Tell them what to look for: scope detail, exclusion language, change order process.",
        "Set a follow-up after they've completed their process."
      ],
      "say": "Please do — that's completely reasonable. I'd rather you compare than sign with us without confidence. When you're doing that, here's what I'd suggest paying attention to: scope detail, exclusion language, and what happens if something changes during the project. Those areas are where proposals vary most. When do you plan to have all the quotes back? I'll follow up around then."
    }
  ],
  "modules": [
    {
      "id": "M1",
      "title": "The Avalon Way of Selling",
      "objective": "Understand why Avalon sells differently — consultative, process-driven, and margin-protective — and why it creates a 25% lift in results.",
      "keyPoints": [
        "+25% sales increase when a company-wide process is consistently followed (Dave Kurlan, Objective Management Group)",
        "Sales is not simply sending a price — it is understanding the client, defining the problem, shaping scope, and protecting the business.",
        "A qualified 'no' is better than a confusing 'maybe' that burns estimating time.",
        "The best proposal is not the longest proposal — it is the clearest decision tool.",
        "Objectives are not attacks — they are signals that something still needs to be understood."
      ],
      "lessons": [
        "What consultative selling means at Avalon vs. transactional selling",
        "The Avalon Sales Promise — 8 commitments that define what good sales looks like",
        "Why margin matters to every member of the team",
        "The role of trust in landscape sales — how it's built in 7 seconds and lost in 1 mistake",
        "Self-limiting beliefs vs. supportive beliefs — the psychology of the close"
      ],
      "quiz": [
        "What is the Avalon sales philosophy in one sentence?",
        "Why does scope clarity protect both the client and Avalon?",
        "What does 'operationally clean' mean in sales context?",
        "What happens to gross margins when proposals are built on unqualified budgets?"
      ]
    },
    {
      "id": "M2",
      "title": "The 6-Step Avalon Sales Process",
      "objective": "Know all 6 steps by heart and understand why skipping any step creates process friction, burns estimating hours, and destroys margin.",
      "keyPoints": [
        "Step 01: Rapport — Real vs. Social. 7 seconds. 4 communication styles. NLP mirroring.",
        "Step 02: Mutual Agreements — T.A.P.P.O. sets the roadmap and eliminates scope creep.",
        "Step 03: Discovery — CBRs + 3+ Funneling Rule. Ask 3 layers before accepting any answer.",
        "Step 04: Budget — Reframe Cost to Investment. No budget = No breakdown shared.",
        "Step 05: Decision — Qualify who, how, and when before any proposal is built.",
        "Step 06: Presentation — CBRs first, solutions aligned, investment last, ask for the close."
      ],
      "lessons": [
        "Why the funnel is sacred — what happens when steps are skipped",
        "The 4 communication preferences and how to identify them in the first 5 minutes",
        "T.A.P.P.O. — scripting and role-playing the mutual agreement opening",
        "The 3+ Funneling Rule in practice — live examples from landscape sales",
        "Decision qualification — the Rehearsal Protocol for absent decision-makers"
      ],
      "quiz": [
        "Name all 5 elements of T.A.P.P.O. and what each one does.",
        "Why must budget be explored before any site plan or breakdown is shared?",
        "What is the 3+ Funneling Rule and why does it matter?",
        "What is the Rehearsal Protocol and when do you use it?"
      ]
    },
    {
      "id": "M3",
      "title": "Discovery, CBRs, and Listening Discipline",
      "objective": "Run discovery conversations that reveal the real Core Buying Reason and create deep, lasting trust.",
      "keyPoints": [
        "CBRs are the emotional drivers behind the purchase — not the surface request.",
        "We think at 3,000 words/min but listen at 150. 75% of the time we're distracted.",
        "Silence is power — pause 3 seconds after they finish. Let them fill the quiet.",
        "Verbatim feedback loops are the highest-trust move in a discovery conversation.",
        "Shifting Pain to Pleasure: establish consequences fully before transitioning to solutions."
      ],
      "lessons": [
        "The 6 Questioning Tactics: 3+ Funneling, Implication/Consequence, Pain to Pleasure, Nurturing Statements, Struggling Statements, Listening Discipline",
        "The 4 Listening Traps: Formulating Responses, Premature Fix-it Mode, Assumptive Hearing, Phone Distractions",
        "Effective Listening Protocol: Silence, Nod/Validate, Clarify Definitions, Verbatim Feedback",
        "Role-play: CBR deep dive on a drainage project vs. a maintenance upsell",
        "Practice: 3+ Funnel from 'I just want it to look nice' to the real emotional driver"
      ],
      "quiz": [
        "What is a Core Buying Reason and how is it different from a surface request?",
        "Name the 4 listening traps and what each one costs you.",
        "What is a verbatim feedback loop and when do you use it?",
        "How do you shift from pain establishment to pleasure/solution?"
      ]
    },
    {
      "id": "M4",
      "title": "Site Walks and Opportunity Qualification",
      "objective": "Use the site walk to confirm fit, gather production-grade data, deepen CBR understanding, and set scope expectations before estimating.",
      "keyPoints": [
        "Hand kinesthetic clients something to touch — a paving stone, a sample. Do it early.",
        "The fit decision must be made before you leave the site. Not later. Not by email.",
        "Opportunity path: Straightforward Quote vs. Scoped Proposal vs. Roadmap/Preconstruction Package.",
        "Separate must-haves from nice-to-haves on site — with the client present.",
        "No estimate should begin without photos, measurements, and a written site walk summary."
      ],
      "lessons": [
        "What to inspect on every site walk — access, drainage, grade, utilities, hardscape, plant health",
        "How to make a clear fit decision on-site and communicate it professionally",
        "Documenting site conditions for estimating accuracy — the 8 required elements",
        "Setting scope expectations before leaving — what NOT to promise",
        "The Site Walk Checklist — walk through it live with a real or mock opportunity"
      ],
      "quiz": [
        "What is the fit decision and when must it be made?",
        "What 8 things must you inspect on every site walk?",
        "What should never be promised on the site walk?",
        "What documentation must come out of every site walk before estimating begins?"
      ]
    },
    {
      "id": "M5",
      "title": "Scope Development, Estimating, and Margin Protection",
      "objective": "Build scopes that are accurate, defensible, and protect Avalon's margin — never guess.",
      "keyPoints": [
        "Scope first, estimate second — never price before scope is locked.",
        "Every unknown must be called out as an exclusion — in plain language.",
        "The approval matrix: Ryan < $2,500 (templates), $2,500–$10,000 (manager), $10,001+ (Tyler), hardscape/drainage always (management).",
        "No sales number is reduced without a matching scope reduction.",
        "Contingency is not optional on complex work — it is margin protection."
      ],
      "lessons": [
        "The Internal Scope Structure — 10 required elements",
        "Writing exclusions that actually protect Avalon",
        "The Estimate Review Checklist — walk through every line",
        "The approval matrix — who approves what and why",
        "Common margin killers in landscape estimating and how to avoid them"
      ],
      "quiz": [
        "What is the difference between a scope and a proposal?",
        "Why must exclusions be documented in writing?",
        "What happens when scope changes after estimating without a written amendment?",
        "Who must approve a $12,000 landscape enhancement job?"
      ]
    },
    {
      "id": "M6",
      "title": "Proposal Delivery and Presentation",
      "objective": "Present proposals in a way that builds confidence, connects to CBRs, and creates natural momentum toward a committed decision.",
      "keyPoints": [
        "Never email a complex proposal for the client to read alone — present live or on video.",
        "Always open by restating their CBRs before touching the proposal document.",
        "Present solutions in CBR priority order — not task order.",
        "Design sign-off first, then investment — never lead with price.",
        "Ask for the decision directly: 'Can we lock this in today?' Not 'Let me know what you think.'"
      ],
      "lessons": [
        "The 6-step presentation sequence: CBR Review → CBR-Order Solutions → Check Agreement → Review Investment → Address Concerns → Ask for Decision",
        "How to state the investment confidently without apologizing",
        "The Rehearsal Protocol for absent decision-makers",
        "Acknowledge → Reframe → Forward-question for technical objections",
        "The anatomy of a weak close vs. a direct, confident close"
      ],
      "quiz": [
        "What is the biggest mistake salespeople make at proposal delivery?",
        "In what order should solutions be presented — and why?",
        "How should exclusions be handled at presentation?",
        "What should always happen before the client leaves the proposal conversation?"
      ]
    },
    {
      "id": "M7",
      "title": "Follow-Up, Objection Handling, and Decision Management",
      "objective": "Stay in contact on a defined cadence, resolve real objections using the 5-step framework, and move every opportunity to a clear status.",
      "keyPoints": [
        "Follow-up cadence: Day 3, Day 7, Day 14, Day 21+ — not random.",
        "Clarify before answering: 'Is it the price, scope, timing, or fit?'",
        "The 5-step objection framework: Pause → Clarify → Reconnect to CBRs → Offer a path → Confirm next step.",
        "Never discount without changing scope — it trains clients to stall for price reductions.",
        "Every open opportunity must have a defined next step with a date."
      ],
      "lessons": [
        "The Avalon follow-up cadence — scripted responses for each touchpoint",
        "How to tell the difference between a real objection and a stall tactic",
        "The 6 most common objections — full response scripts for each",
        "When to stop following up — and how to close it gracefully without burning the relationship",
        "Handling 'I got a cheaper quote' without matching price"
      ],
      "quiz": [
        "What is the first follow-up question after sending a proposal?",
        "How do you respond to 'Your price is too high'? Step by step.",
        "When is it appropriate to stop following up?",
        "How do you handle a discount request without dropping the price?"
      ]
    },
    {
      "id": "M8",
      "title": "Closing, Sold Job Activation, and Production Handoff",
      "objective": "Confirm commitments clearly, lock the scope, and hand off to production in a way that eliminates guessing and protects the client relationship.",
      "keyPoints": [
        "The close is the natural result of a well-run process — not a pressure tactic.",
        "Signed SOW + deposit = activation. Verbal yes alone is not enough.",
        "The Handoff Packet: SOW, COGs, CBR Profile, Material/Access layout.",
        "The Alignment Meeting: Sales + Ops + Crew Leader. SOW line-by-line.",
        "The Driveway Handshake: Sales Rep on-site Day 1. Walk with client and Crew Leader. Pass the baton officially."
      ],
      "lessons": [
        "What a verbal yes requires — and what it doesn't authorize",
        "The Sold Job Activation Checklist — every line, every time",
        "The 3-phase handoff: Handoff Packet → Alignment Meeting → Driveway Handshake",
        "How a botched handoff destroys field labor efficiency and client trust",
        "What Sales must never do after handoff to production"
      ],
      "quiz": [
        "What must be in the handoff packet before any field crew begins excavation?",
        "What happens at the Driveway Handshake?",
        "What is in the Sold Job Activation Checklist?",
        "What should sales never do after formal handoff to production?"
      ]
    },
    {
      "id": "M9",
      "title": "Closeout, Reviews, Referrals, and Revenue Expansion",
      "objective": "Close every job cleanly, capture satisfaction, and convert happy clients into ongoing revenue — reviews, referrals, maintenance, and phase 2.",
      "keyPoints": [
        "Every job ends with a personal closeout conversation from Sales — not production.",
        "Review request timing: 48–72 hours after final walkthrough.",
        "Referral conversation: 'We treat referrals the same way we treated you.'",
        "Maintenance conversion: 'Would you like us to help maintain or protect this investment?'",
        "Phase 2 prompt: 'What would you want to tackle next?' — log with timing and owner."
      ],
      "lessons": [
        "The closeout conversation — timing, structure, and what to confirm",
        "How to ask for a Google review in a way that actually gets results",
        "Turning a satisfied client into a referral source — the exact language",
        "Maintenance conversion from a landscape job — the bridge question",
        "Handling dissatisfied clients before they go public — de-escalation and resolution"
      ],
      "quiz": [
        "When should the closeout call happen?",
        "How do you ask for a review in a way that gets results?",
        "What is the referral conversation opener?",
        "What question opens the door to a phase 2 or maintenance conversation?"
      ]
    }
  ],
  "checklists": [
    {
      "id": "lead_intake",
      "title": "Lead Intake Checklist",
      "stage": 1,
      "items": [
        "Client name and contact info captured",
        "Property address confirmed",
        "Service line categorized (Landscape / Maintenance / Hardscape / etc.)",
        "Client type confirmed (Residential / Commercial)",
        "Lead source recorded",
        "Urgency and desired timing captured",
        "What prompted the inquiry — documented in their words",
        "Decision-maker identified or flagged",
        "Owner assigned",
        "Next step scheduled with date and time"
      ]
    },
    {
      "id": "discovery",
      "title": "Discovery Checklist",
      "stage": 2,
      "items": [
        "Real rapport established — communication style identified",
        "T.A.P.P.O. set at the start of the meeting (Time, Agenda, People, Process, Outcome)",
        "What prompted the inquiry — understood and documented",
        "3+ Funneling Rule applied — at least 3 layers of CBR questioning completed",
        "Core Buying Reason #1 (surface) documented in client's words",
        "Core Buying Reason #2 (deeper) documented",
        "Core Buying Reason #3 (emotional/real) documented",
        "Pain and consequences fully explored before shifting to pleasure/solutions",
        "Effective listening discipline applied — silences, no premature fix-it mode",
        "All decision-makers identified",
        "Timing is understood and documented",
        "Budget comfort explored where appropriate",
        "Mutual agreement for next step is set"
      ]
    },
    {
      "id": "site_walk",
      "title": "Site Walk Checklist",
      "stage": 3,
      "items": [
        "CBRs revisited at the start of the walk — confirmed with client",
        "Client's communication style matched during the walk",
        "Material sample handed to kinesthetic client",
        "Photos taken of all relevant areas",
        "Measurements captured for all critical dimensions",
        "Access and staging areas reviewed",
        "Drainage and grade issues noted",
        "Utilities, property lines, and HOA concerns asked about",
        "Must-haves separated from nice-to-haves — confirmed with client",
        "Opportunity path selected (Quote / Scoped Proposal / Roadmap)",
        "Fit decision made before leaving the site",
        "Next step confirmed with client before leaving"
      ]
    },
    {
      "id": "internal_scope",
      "title": "Internal Scope Checklist",
      "stage": 4,
      "items": [
        "Scope divided into clear sections (plants, landscaping, hardscape, misc, coordination)",
        "Quantities defined — nothing estimated from memory",
        "Materials listed with specifications",
        "Labor activities broken down by task",
        "Assumptions written in plain language",
        "Exclusions written in plain language — every unknown called out",
        "Risks flagged explicitly",
        "Subcontractors, permits, and utilities identified if needed",
        "Phases or options confirmed if required",
        "Contingency applied where risk is high"
      ]
    },
    {
      "id": "estimate_review",
      "title": "Estimate Review Checklist",
      "stage": 5,
      "items": [
        "Materials priced — all items included",
        "Labor hours reviewed against actual production capacity (not guessed)",
        "Equipment, subs, and disposal included",
        "Overhead accounted for",
        "Contingency applied where needed",
        "Target gross margin checked and confirmed",
        "Final sales number approved at the correct authority level",
        "Ryan: under $2,500 with approved templates",
        "Manager review: $2,500–$10,000",
        "Tyler approval: $10,001+ and all hardscape/drainage/design-build"
      ]
    },
    {
      "id": "proposal_review",
      "title": "Proposal Review Checklist",
      "stage": 6,
      "items": [
        "Client outcome framing included — CBRs referenced first",
        "Scope is clear and written for the client (not internal jargon)",
        "Investment is presented clearly — stated as an investment, not a cost",
        "Timeline or sequencing included",
        "Assumptions written in plain language",
        "Exclusions written in plain language",
        "Deposit and authorization language included",
        "Next step is obvious — what happens after they sign",
        "Internal reviewer approved if required by authority matrix",
        "Delivery method confirmed (live / Zoom / email + review call)"
      ]
    },
    {
      "id": "sold_activation",
      "title": "Sold Job Activation Checklist",
      "stage": 9,
      "items": [
        "Signed proposal or SOW received",
        "Deposit confirmed — amount and receipt date logged",
        "Approved scope matches the estimate exactly",
        "Production notes created and organized",
        "Materials, subs, and permits flagged for production",
        "Production owner assigned with name and contact",
        "Client pre-production communication planned and scheduled",
        "Driveway Handshake scheduled (Sales Rep on-site Day 1 of mobilization)",
        "Alignment Meeting scheduled with Ops Manager and Crew Leader"
      ]
    },
    {
      "id": "closeout",
      "title": "Closeout Checklist",
      "stage": 12,
      "items": [
        "Completion confirmed internally",
        "Personal closeout call made by Sales — not production",
        "Client satisfaction confirmed in the conversation",
        "Open issues resolved or assigned with owner and date",
        "Review request made (Google) — with direct link sent",
        "Referral conversation completed where appropriate",
        "Future phase or maintenance opportunity identified and discussed",
        "Next opportunity logged with timing and assigned owner",
        "Lessons learned captured for production feedback loop",
        "Job file closed with notes useful for future work"
      ]
    },
    {
      "id": "daily",
      "title": "Daily Sales Start-Up",
      "stage": 0,
      "items": [
        "Review all open opportunities and follow-up dates",
        "Identify the top 3 priorities for today",
        "Check for any overdue follow-ups (7+ days no contact)",
        "Confirm all scheduled calls, site walks, and meetings for today",
        "Review any outstanding proposals awaiting decision",
        "Prepare for any discovery calls or site walks scheduled today",
        "Update the pipeline after any calls or site visits",
        "Log all activity, notes, and next steps in the system"
      ]
    },
    {
      "id": "weekly",
      "title": "Weekly Sales Review",
      "stage": 0,
      "items": [
        "Review all opportunities by stage",
        "Identify any stuck deals (14+ days without movement) and plan a next action",
        "Check for any leads that haven't been contacted in 7+ days",
        "Review closed and lost jobs from the week — what happened?",
        "Update pipeline totals and conversion metrics",
        "Review weekly activity scoreboard vs. targets",
        "Set priorities for next week",
        "Submit any manager reports or pipeline updates",
        "Weekly sales coaching meeting completed"
      ]
    }
  ],
  "activityTargets": {
    "ryan": {
      "proactiveSalesCalls":    { "target": 5,  "label": "Proactive Sales Calls / Week",     "description": "Outreach to past clients from 2023, 2024, 2025" },
      "referralAsks":           { "target": 2,  "label": "Referral Asks / Week",              "description": "Asking satisfied active clients for warm introductions" },
      "pastClientTouches":      { "target": 1,  "label": "Past Client Touches / Week",        "description": "Warranty follow-ups, spring/fall landscape walkthrough invites" },
      "onSiteVisits":           { "target": 2,  "label": "On-Site Visits / Week",             "description": "Property walks; re-confirming Mutual Agreements live" },
      "proactiveUpsellProposals":{ "target": 1, "label": "Proactive Upsell Proposals / Week", "description": "Generated detail on pruning, mulch, or drainage upgrades" },
      "hubspotHygiene":         { "target": 0,  "label": "Stale Deals > 14 Days",            "description": "HubSpot stage hygiene — must be zero stale deals weekly", "floor": true },
      "weeklyPipelineReview":   { "target": 1,  "label": "Weekly Pipeline Review Meeting",    "description": "With owner — stage movement, slip risk" }
    }
  },
  "managerAgenda": [
    "Review pipeline by stage — where are deals stuck (14+ days without movement)?",
    "Identify any opportunities without a defined next step and owner.",
    "Review proposals sent vs. proposals closed this week — what's the conversion rate?",
    "Discuss any objections or discovery issues from the week.",
    "Check sold job activations — were handoffs clean? Was the Driveway Handshake completed?",
    "Review any closed lost jobs — what happened? What should we learn?",
    "Review weekly activity scoreboard vs. targets for each rep.",
    "Confirm training progress and skill development priorities.",
    "Set individual rep priorities and commitments for next week.",
    "Review any commission approval requests for $10K+ jobs."
  ],
  "kpis": {
    "landscape": [
      { "kpi": "2026 Annual Target",      "value": "$525,000",        "cadence": "Annual" },
      { "kpi": "% of Company Sales",      "value": "42.2%",           "cadence": "Annual" },
      { "kpi": "Actual as of 5/21/26",    "value": "$153,048",        "cadence": "YTD" },
      { "kpi": "Remaining to Goal",       "value": "$371,952",        "cadence": "YTD" },
      { "kpi": "Jobs Target (2026)",      "value": "75 jobs",         "cadence": "Annual" },
      { "kpi": "Mean Ticket",             "value": "$6,500",          "cadence": "Per deal" },
      { "kpi": "Median Ticket",           "value": "$4,000",          "cadence": "Per deal" },
      { "kpi": "Gross Margin Floor",      "value": "≥ 50%",           "cadence": "Per deal" },
      { "kpi": "Close Rate",              "value": "20–25%",          "cadence": "Rolling 90-day" },
      { "kpi": "AR Days",                 "value": "≤ 30",            "cadence": "Monthly" },
      { "kpi": "Deposit at Signing",      "value": "≥ 40%",          "cadence": "Per deal" },
      { "kpi": "Lead Response SLA",       "value": "≤ 24 hours",      "cadence": "Per lead" },
      { "kpi": "Direct Labor %",          "value": "20–25% of job",   "cadence": "Per job" },
      { "kpi": "Materials %",             "value": "≤ 40% of job",    "cadence": "Per job" }
    ],
    "maintenance": [
      { "kpi": "2026 Annual Target",      "value": "$543,000",        "cadence": "Annual" },
      { "kpi": "% of Company Sales",      "value": "43.6%",           "cadence": "Annual" },
      { "kpi": "Actual as of 5/21/26",    "value": "$202,000",        "cadence": "YTD" },
      { "kpi": "Remaining to Goal",       "value": "$341,000",        "cadence": "YTD" },
      { "kpi": "Contracted Base (2026)",  "value": "$378,614",        "cadence": "Annual" },
      { "kpi": "Growth Target (Ryan)",    "value": "$165,000 to sell", "cadence": "Annual" },
      { "kpi": "Monthly Revenue Pace",    "value": "~$45,250/mo",     "cadence": "Monthly" },
      { "kpi": "Gross Margin Floor",      "value": "≥ 32%",           "cadence": "Per route" },
      { "kpi": "Quote-to-Close Rate",     "value": "50–60%",          "cadence": "Rolling 90-day" },
      { "kpi": "AR Days",                 "value": "≤ 30",            "cadence": "Monthly" },
      { "kpi": "CC on File Before Service","value": "100% of accounts","cadence": "Per activation" },
      { "kpi": "Route Labor %",           "value": "≤ 40% of route",  "cadence": "Per route" },
      { "kpi": "Materials/Chemicals %",   "value": "18–22% of route", "cadence": "Per route" },
      { "kpi": "Enhancements Sold",       "value": "≥ $8,000/month",  "cadence": "Monthly" },
      { "kpi": "Client Churn",            "value": "Tracked monthly",  "cadence": "Monthly" }
    ],
    "snow": [
      { "kpi": "2026 Annual Target",      "value": "$177,000",        "cadence": "Annual" },
      { "kpi": "% of Company Sales",      "value": "14.2%",           "cadence": "Annual" },
      { "kpi": "Actual as of 5/21/26",    "value": "$178,101",        "cadence": "YTD — ABOVE PLAN" },
      { "kpi": "Remaining to Goal",       "value": "($1,101) — DONE", "cadence": "YTD" },
      { "kpi": "Gross Margin Floor",      "value": "≥ 50%",           "cadence": "Per event" },
      { "kpi": "Close Rate",              "value": "30–40%",          "cadence": "Rolling" },
      { "kpi": "AR Days",                 "value": "≤ 15 days",       "cadence": "Per event" },
      { "kpi": "Storm Response",          "value": "≤ 4 hours of trigger", "cadence": "Per event" },
      { "kpi": "Pre-Storm Comm",          "value": "100% notified ≤ 12 hrs pre-event", "cadence": "Per storm" },
      { "kpi": "Equipment ROI",           "value": "> 2.5× season ROI per unit", "cadence": "Seasonal" },
      { "kpi": "Client Churn YoY",        "value": "≤ 10%",           "cadence": "Annual" },
      { "kpi": "Salt/Brine Cost",         "value": "15–20% of event", "cadence": "Per event" }
    ],
    "company": [
      { "kpi": "Budgeted Annual Revenue", "value": "$1,245,000",      "cadence": "Annual" },
      { "kpi": "Actual as of 5/21/26",    "value": "$533,148.94",     "cadence": "YTD" },
      { "kpi": "Remaining to Goal",       "value": "$711,851.06",     "cadence": "YTD" },
      { "kpi": "Avg Needed / Month Remaining", "value": "$101,693",   "cadence": "Monthly (Jun–Dec)" },
      { "kpi": "Operating Gross Margin",  "value": "39%",             "cadence": "Operating budget" },
      { "kpi": "Net Operating Income",    "value": "$109,495",        "cadence": "Budgeted" },
      { "kpi": "True Net (After Debt)",   "value": "$22,723",         "cadence": "Budgeted" },
      { "kpi": "Loan Payments",           "value": "$7,421.60/mo",    "cadence": "Monthly" }
    ]
  },
  "nonNegotiables": [
    "No estimate goes out without scope clarity — every unknown must be an exclusion.",
    "No proposal goes out without margin review and approval at the right authority level.",
    "No sold job enters production without signed approval and formal handoff packet.",
    "No client should go dark without a defined follow-up cadence.",
    "No production issue that hurt margin or trust should disappear without being captured in the feedback loop.",
    "No rep should present price without first understanding the client's decision process.",
    "No discount should be offered without a matching scope, timing, or value adjustment.",
    "No complex project should begin without a pre-production communication plan.",
    "No budget qualification = no site plan or breakdown shared.",
    "Unidentified decision-makers = no final proposal review.",
    "Mutual Agreement broken = stop work immediately and debrief.",
    "Commission is paid only on approved, sold, and collected work — properly documented."
  ]
};
