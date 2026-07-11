// ═══════════════════════════════════════════════════════════════════════════
// Sales Academy 2.0 — Engine + Data Layer  (academy.js)
// ═══════════════════════════════════════════════════════════════════════════
(function () {
'use strict';

// ─── Keys ────────────────────────────────────────────────────────────────────
const CONTENT_KEY  = 'avalonAcademyContentV1';
const PROGRESS_KEY = 'avalonAcademyProgressV1';
const ATTEMPTS_KEY = 'avalonAcademyAttemptsV1';
const EVENTS_KEY   = 'avalonAcademyEventsV1';

// ─── Points ──────────────────────────────────────────────────────────────────
const POINTS = {
  section_complete:     5,
  module_complete:     25,
  quiz_first_pass:     20,
  quiz_90_bonus:       10,
  quiz_retry_pass:     10,
  streak_milestone:    10
};

// ─── Levels (no emojis — use id for SVG lookup) ──────────────────────────────
const LEVELS = [
  { id:'l1', name:'New Hire',         minPoints:0,    color:'#64748b' },
  { id:'l2', name:'Apprentice',       minPoints:50,   color:'#6366f1' },
  { id:'l3', name:'Qualified Rep',    minPoints:150,  color:'#0ea5e9' },
  { id:'l4', name:'Process Runner',   minPoints:300,  color:'#10b981' },
  { id:'l5', name:'Closer',           minPoints:500,  color:'#f59e0b' },
  { id:'l6', name:'Growth Rep',       minPoints:750,  color:'#f97316' },
  { id:'l7', name:'Avalon Certified', minPoints:1000, color:'#ec4899' },
  { id:'l8', name:'Senior Performer', minPoints:1400, color:'#8b5cf6' },
  { id:'l9', name:'Mentor',           minPoints:1800, color:'#00A7E1' },
];

// ─── Badge Definitions (no emojis) ───────────────────────────────────────────
const BADGE_DEFS = [
  { id:'foundations',     name:'Foundations',          shape:'hex',  color:'#6366f1', desc:'Complete Module 1 — The Avalon Way',               type:'completion', criteria:{ moduleId:'M1' } },
  { id:'process_runner',  name:'Process Runner',        shape:'star', color:'#0ea5e9', desc:'Complete Module 2 with 85%+ quiz score',           type:'skill',      criteria:{ moduleId:'M2', minQuizScore:85 } },
  { id:'discovery_master',name:'Discovery Master',      shape:'hex',  color:'#10b981', desc:'Complete Module 3 — CBRs & Listening',             type:'skill',      criteria:{ moduleId:'M3' } },
  { id:'site_pro',        name:'Site Pro',              shape:'shield',color:'#0ea5e9',desc:'Complete Module 4 — Site Walks',                   type:'completion', criteria:{ moduleId:'M4' } },
  { id:'margin_guardian', name:'Margin Guardian',       shape:'shield',color:'#10b981',desc:'Complete Module 5 with 80%+ quiz score',           type:'mastery',    criteria:{ moduleId:'M5', minQuizScore:80 } },
  { id:'presenter',       name:'Presenter',             shape:'star', color:'#f59e0b', desc:'Complete Module 6 — Proposal Delivery',            type:'skill',      criteria:{ moduleId:'M6' } },
  { id:'objection_nav',   name:'Objection Navigator',   shape:'hex',  color:'#f97316', desc:'Complete Module 7 with 85%+ quiz score',          type:'mastery',    criteria:{ moduleId:'M7', minQuizScore:85 } },
  { id:'closer',          name:'Closer',                shape:'star', color:'#ec4899', desc:'Complete Module 8 — Closing & Handoff',           type:'skill',      criteria:{ moduleId:'M8' } },
  { id:'revenue_builder', name:'Revenue Builder',       shape:'hex',  color:'#8b5cf6', desc:'Complete Module 9 — Closeout & Expansion',        type:'completion', criteria:{ moduleId:'M9' } },
  { id:'core_complete',   name:'Academy Graduate',      shape:'trophy',color:'#f59e0b',desc:'Complete all 9 core modules',                     type:'milestone',  criteria:{ allPhases:true } },
  { id:'streak_7',        name:'7-Day Streak',          shape:'flame', color:'#f97316',desc:'7 consecutive days of academy activity',           type:'streak',     criteria:{ streakDays:7 } },
  { id:'streak_30',       name:'30-Day Streak',         shape:'flame', color:'#ec4899',desc:'30 consecutive days of academy activity',          type:'streak',     criteria:{ streakDays:30 } },
  { id:'first_quiz',      name:'Quiz Taker',            shape:'check', color:'#10b981',desc:'Pass your first module quiz',                      type:'milestone',  criteria:{ quizzesPassed:1 } },
  { id:'quiz_master',     name:'Quiz Master',           shape:'trophy',color:'#00A7E1',desc:'Pass all 9 module quizzes',                        type:'mastery',    criteria:{ allQuizzesPassed:true } },
  { id:'fast_learner',    name:'Fast Learner',          shape:'bolt',  color:'#6366f1',desc:'Complete 3 modules within your first 7 days',      type:'milestone',  criteria:{ modulesIn7Days:3 } },
];

// ─── Phases ───────────────────────────────────────────────────────────────────
const SEED_PHASES = [
  {
    id:'phase_1', title:'Foundations', sort_order:1,
    color:'#6366f1', borderColor:'rgba(99,102,241,0.3)',
    short_description:'Master the Avalon mindset, consultative process, and discovery discipline — the bedrock of every sale.',
    long_description:'This phase establishes why Avalon sells differently, how the 6-step process protects every deal, and how deep listening and discovery uncover the real reasons clients buy. Complete all three modules to unlock Phase 2.',
    unlock_mode:'immediate', module_ids:['M1','M2','M3'],
    certification_name:'Foundations Certification'
  },
  {
    id:'phase_2', title:'Execution', sort_order:2,
    color:'#10b981', borderColor:'rgba(16,185,129,0.3)',
    short_description:'Site walks, scoping, estimating, and delivering proposals that close at the right margin.',
    long_description:'Move from mindset into field execution. This phase covers how to qualify opportunities on-site, build scopes that protect Avalon\'s margin, and present proposals in a way that creates momentum toward a committed decision.',
    unlock_mode:'prerequisite', prerequisite_phase_id:'phase_1', module_ids:['M4','M5','M6'],
    certification_name:'Execution Certification'
  },
  {
    id:'phase_3', title:'Mastery', sort_order:3,
    color:'#f59e0b', borderColor:'rgba(245,158,11,0.3)',
    short_description:'Close deals confidently, hand off cleanly, and convert happy clients into ongoing revenue.',
    long_description:'The final phase covers the full close-to-handoff-to-expansion cycle. Reps who complete this phase can consistently win deals, activate jobs without field surprises, and build a referral and maintenance pipeline from every satisfied client.',
    unlock_mode:'prerequisite', prerequisite_phase_id:'phase_2', module_ids:['M7','M8','M9'],
    certification_name:'Mastery Certification'
  }
];

// ─── Rich Lesson Content ───────────────────────────────────────────────────────
// Each module has sections: overview, lessons (rich), quiz
const RICH_LESSONS = {

  M1: [
    {
      id:'M1_L1', title:'What Consultative Selling Really Means',
      body:`<p>Transactional selling sends a price. Consultative selling earns a decision. The difference isn't the proposal — it's everything that happens before it lands in the client's hands.</p>
<p>At Avalon, every rep is expected to act as a trusted advisor, not an order-taker. That means asking better questions than your competitors, understanding the emotional drivers behind a project, and protecting the client from scope decisions they'll regret later.</p>`,
      callout:{ type:'principle', title:'The Avalon Sales Promise', body:'We commit to understanding your project fully before proposing anything. We will never recommend scope that doesn\'t serve your goals, and we will tell you the truth about fit — even when a "no" is the right answer.' },
      examples:[
        { label:'Transactional rep', text:'"Client wants a patio. I\'ll send them a price for a 400 sq ft bluestone patio."' },
        { label:'Avalon rep', text:'"Client mentioned a patio — but why? What\'s the real outcome they want? Let me ask three more layers before I put anything on paper."' }
      ],
      note_prompt:'Write down one situation from your own experience where someone sold you something without truly understanding what you needed. What did that feel like? What would have changed if they\'d asked better questions first?'
    },
    {
      id:'M1_L2', title:'Why Margin Matters to Every Rep',
      body:`<p>Commission is calculated on margin, not revenue. When a deal closes at the wrong price, everyone loses — the company, production, and the rep. Understanding this creates a shared language between sales and operations.</p>
<p>The gross margin floor for landscape work at Avalon is 50%. That number exists because it covers field labor, materials, overhead, and leaves room for the company to reinvest. When a rep discounts below that floor, they're not just cutting their commission — they're borrowing from the crew's paycheck and the company's future.</p>`,
      callout:{ type:'warning', title:'The Discount Trap', body:'A 10% discount on a $20,000 job doesn\'t just cost $2,000 in revenue. At a 50% margin, it wipes out 40% of your gross profit on that job. The crew still costs the same. Materials still cost the same. Only the company\'s share shrinks.' },
      examples:[
        { label:'The math', text:'$20,000 job at 50% GM = $10,000 GP. Drop price to $18,000 = $8,000 GP. You just gave away 20% of profit to close faster.' },
        { label:'The right move', text:'If a client pushes on price, reduce scope — not margin. "We can do the hardscape and hold the planting until Phase 2 to bring this into your range."' }
      ],
      note_prompt:'What is the gross margin floor for landscape work? What does "scope reduction before discount" mean in practice? Write a one-sentence rule you can use when a client asks you to lower your price.'
    },
    {
      id:'M1_L3', title:'The 8 Avalon Sales Commitments',
      body:`<p>These eight commitments define what good looks like at Avalon. They're not aspirational — they're operational standards. Every rep is expected to demonstrate all eight on every opportunity.</p>`,
      callout:{ type:'list', title:'The 8 Commitments', items:[
        '1. Respond to every inquiry within 24 hours — even if just to set the next step.',
        '2. Never build a proposal without a complete discovery conversation.',
        '3. Always discuss budget before sharing any scope or pricing.',
        '4. Make the fit decision on-site — not later by email.',
        '5. Never discount without a matching scope reduction.',
        '6. Present proposals live — never email a complex proposal cold.',
        '7. Every open opportunity has a defined next step with a date.',
        '8. Hand off every sold job with a full packet, not a verbal summary.'
      ]},
      examples:[
        { label:'Commitment in action', text:'Client calls on Friday at 4pm. You\'re heading out. The right move: "I\'ll call you Monday at 9am to set up a site walk — does that work?" That\'s commitment #1 and #7 in one sentence.' }
      ],
      note_prompt:'Which of the 8 commitments do you feel most confident about today? Which one will require the most effort to build into a consistent habit? Write two sentences on each.'
    }
  ],

  M2: [
    {
      id:'M2_L1', title:'The 6-Step Process — Why Order Matters',
      body:`<p>The six steps are not suggestions. They exist in a specific sequence because each one creates the conditions for the next. Skipping Step 3 (Discovery) to get to Step 5 (Decision) is like pouring concrete before digging the footings — it looks like progress but creates an unstable foundation.</p>
<p>The six steps: <strong>Rapport → Mutual Agreement (T.A.P.P.O.) → Discovery → Budget → Decision → Presentation.</strong> Every deal that fails to close can usually be traced to a step that was skipped or rushed.</p>`,
      callout:{ type:'principle', title:'T.A.P.P.O. — The Mutual Agreement Framework', body:'Time: How long we have. Agenda: What we\'ll cover. Purpose: Why this meeting matters. Permission: To ask direct questions. Outcome: What a good result looks like for both sides.' },
      examples:[
        { label:'T.A.P.P.O. scripted', text:'"I\'ve set aside about 45 minutes for us today. I\'d like to walk through what you\'re envisioning, understand your priorities and budget range, and by the end we\'ll know whether it makes sense to move to the next step. Does that work for you?"' },
        { label:'What skipping looks like', text:'Rep shows up, listens for 5 minutes, sketches ideas on a napkin, says "I\'ll put something together." Three weeks later the estimate goes out cold. Client ghosts. No one knows why.' }
      ],
      note_prompt:'Write out your own version of a T.A.P.P.O. opening for a first meeting with a residential landscape client who found you through a referral. Keep it under 60 words. Sound like yourself, not a script.'
    },
    {
      id:'M2_L2', title:'The 4 Communication Preferences',
      body:`<p>People don't all receive information the same way. The four primary communication styles — Driver, Analytical, Expressive, and Amiable — each have different needs, paces, and triggers. A rep who communicates the same way with every client will win some and lose others for reasons they can't explain.</p>
<p><strong>Driver:</strong> Wants results, hates small talk, decides fast. Lead with outcomes and timeline. <strong>Analytical:</strong> Wants data, proof, and details. Never rush them. <strong>Expressive:</strong> Wants vision, excitement, and relationship. Paint the picture. <strong>Amiable:</strong> Wants harmony, trust, and low risk. Never pressure.</p>`,
      callout:{ type:'warning', title:'The Biggest Mistake', body:'Presenting the same way to every client. The Analytical client who gets an Expressive pitch feels like they\'re being sold to. The Driver client who gets an Amiable pace feels like the rep isn\'t serious. Match the style, not the script.' },
      examples:[
        { label:'Driver client', text:'"Here\'s what we\'d build, here\'s the timeline, here\'s the investment. Want to move forward?" — Done.' },
        { label:'Analytical client', text:'"I\'ll walk you through the material specs, our standard installation tolerances, and how we\'ve handled drainage on three similar projects in your area." — Then pause and let them process.' }
      ],
      note_prompt:'Think of your last three client interactions. What communication style did each person seem to prefer? Did you adjust your approach, or did you pitch the same way to all three? What would you do differently?'
    },
    {
      id:'M2_L3', title:'Budget — Reframing Cost as Investment',
      body:`<p>The budget conversation is where most sales reps check out. They fear it will offend the client or kill the deal. The opposite is true: avoiding it is what kills the deal — just later, after you've spent 12 hours estimating.</p>
<p>Budget is not about asking "how much do you want to spend?" It's about reframing the conversation from cost to investment, establishing a range, and qualifying whether this is a project Avalon can serve profitably.</p>`,
      callout:{ type:'principle', title:'The Investment Reframe Script', body:'"Most clients we work with for a project like this invest somewhere between $X and $Y depending on scope and materials. Does that range feel like it lines up with where you\'re thinking, or do we need to talk through what\'s possible at different levels?"' },
      examples:[
        { label:'What not to say', text:'"What\'s your budget?" — Too blunt. Clients feel interrogated and often deflect with a low number to anchor the price.' },
        { label:'What to say instead', text:'"To make sure I\'m scoping this correctly — clients with a similar project typically invest between $18,000 and $35,000. Are we in the right neighborhood, or should we talk through what fits your situation?"' }
      ],
      note_prompt:'Write your own version of the investment reframe for a hardscape patio project. Don\'t use the script word-for-word — adapt it to how you naturally speak. Then write what you\'ll do if the client says "that\'s way more than I expected."'
    }
  ],

  M3: [
    {
      id:'M3_L1', title:'Core Buying Reasons — Finding What Actually Drives the Decision',
      body:`<p>A Core Buying Reason (CBR) is not what the client says they want. It's the emotional outcome beneath the request. "I want a patio" is a feature. The CBR might be "I want my kids to actually use the backyard instead of staying inside" or "I want this house to be the one we entertain at before my parents get too old to travel."</p>
<p>CBRs are discovered, not assumed. They live three to four questions below the surface. The rep who finds them can build a proposal that connects emotionally — and emotional connection is what moves people to sign.</p>`,
      callout:{ type:'principle', title:'The 3+ Funneling Rule', body:'Never accept the first answer to a discovery question. Ask at least three layers deep. Layer 1: "What are you thinking about for the back yard?" Layer 2: "What\'s driving that?" Layer 3: "What would it mean for your family if that was done by summer?" That\'s where the CBR lives.' },
      examples:[
        { label:'Surface answer', text:'Client: "I just want it to look nicer back there."' },
        { label:'After 3 funnel layers', text:'Client: "My daughter is getting married here in October and I want her to be proud of the house. We\'ve talked about fixing this yard for 10 years and I don\'t want to keep putting it off."' },
        { label:'How this changes the proposal', text:'You now open every proposal section with: "This space will be ready for October — and for every gathering after that." That\'s a CBR-connected close.' }
      ],
      note_prompt:'Write three funnel questions you could ask after a client says "I\'m thinking about adding a patio." Each question should go one layer deeper than the last. What CBR might you uncover by the third question?'
    },
    {
      id:'M3_L2', title:'The 4 Listening Traps — What Kills Discovery',
      body:`<p>Research shows we think at roughly 3,000 words per minute but listen at only 150. That gap is where deals are lost. Most salespeople aren't listening — they're waiting to talk. The four listening traps are the specific behaviors that destroy discovery conversations.</p>
<p><strong>Trap 1 — Formulating Responses:</strong> While the client talks, you're building your next sentence. You miss the most important thing they said. <strong>Trap 2 — Premature Fix-it Mode:</strong> The moment you identify a problem, you start solving it out loud. Now you're presenting, not discovering. <strong>Trap 3 — Assumptive Hearing:</strong> You think you know what they mean before they finish. You don't. <strong>Trap 4 — Phone Distractions:</strong> Self-explanatory. Put it face down.</p>`,
      callout:{ type:'warning', title:'The Silence Rule', body:'After a client finishes speaking, wait 3 full seconds before responding. This is uncomfortable. Do it anyway. That silence is what prompts them to add the detail that changes everything. Most reps jump in at 0.5 seconds and never hear the real answer.' },
      examples:[
        { label:'Trap 2 in action', text:'Client: "The back yard is a mess — there\'s a drainage issue, the grass is dead, and—" Rep: "Oh, drainage — yeah, we do a lot of that. We usually run a French drain along the property line..." Client nods politely. CBR conversation is over.' },
        { label:'Clean discovery', text:'Client: "The back yard is a mess — there\'s a drainage issue, the grass is dead, and—" Rep: [nods, waits] Client: "...and honestly, my wife and I have been arguing about this for two years and I just want it done." Now you have the real driver.' }
      ],
      note_prompt:'Which listening trap do you fall into most often? Be honest. Write two specific things you will do differently in your next client conversation to avoid that trap.'
    },
    {
      id:'M3_L3', title:'Verbatim Feedback and Effective Listening Protocol',
      body:`<p>The verbatim feedback loop is the single highest-trust move in a discovery conversation. It involves repeating back the client's exact words — not a paraphrase, not a summary — their words.</p>
<p>It works because it proves you heard them. It gives them the chance to clarify or expand. And it signals that you're not rushing to the next step. The full Effective Listening Protocol: Silence → Nod/Validate → Clarify Definitions → Verbatim Feedback.</p>`,
      callout:{ type:'principle', title:'Shifting Pain to Pleasure', body:'You must fully establish the consequence of the problem before you offer a solution. If you solve too early, the client doesn\'t value the investment. The sequence: Establish the pain → let it land → then ask "Would it help if I walked you through how we\'ve solved this for clients in similar situations?"' },
      examples:[
        { label:'Verbatim feedback example', text:'Client: "I just feel like every contractor we\'ve hired has overpromised and underdelivered." Rep: "Every contractor has overpromised and underdelivered." [pause] Client: "Yeah — the last guy said he\'d be done in three weeks and it took four months. I\'m not going through that again." Now you know the real objection before the proposal is even written.' }
      ],
      note_prompt:'Practice the verbatim feedback loop. Write a short imaginary client statement, then write back their words verbatim. Notice how different it feels from a paraphrase. What might a client add if you responded this way instead of jumping to a solution?'
    }
  ],

  M4: [
    {
      id:'M4_L1', title:'The Site Walk — What You\'re Actually There to Do',
      body:`<p>The site walk is not a field measurement trip. It's the most important discovery conversation in the sales process — it just happens outdoors. You're there to confirm fit, deepen your understanding of the CBRs, gather production-grade data, and set scope expectations before a single hour of estimating is spent.</p>
<p>The eight required inspection elements: <strong>Access</strong> (equipment, materials), <strong>Drainage</strong> (existing flow, problem areas), <strong>Grade</strong> (slopes, retaining needs), <strong>Utilities</strong> (gas, electric, irrigation), <strong>Hardscape</strong> (existing conditions, tie-in points), <strong>Plant health</strong> (what stays, what goes), <strong>Measurements</strong> (written, photographed), <strong>Adjacencies</strong> (neighbors, setbacks, permits).</p>`,
      callout:{ type:'principle', title:'The Fit Decision Rule', body:'The fit decision must be made before you leave the site. Not in the car. Not by email that evening. On the property, in conversation with the client. Either Avalon is the right partner for this project at our price point — or we\'re not. Be honest on-site.' },
      examples:[
        { label:'Kinesthetic technique', text:'For tactile clients: bring a sample paving stone, a mulch sample, or a plant tag. Hand it to them early. It anchors the conversation in the physical and keeps them engaged through the site walk.' },
        { label:'Setting expectations on-site', text:'"Based on what I\'m seeing here, this project is likely in the $22,000 to $28,000 range depending on some decisions we\'ll make during scoping. Does that feel like the right neighborhood before I put time into the estimate?"' }
      ],
      note_prompt:'List the 8 required inspection elements from memory. Then write one question you would ask a client for each element during a site walk — something that would deepen discovery while also gathering technical data.'
    },
    {
      id:'M4_L2', title:'Opportunity Path — Straightforward vs. Scoped vs. Roadmap',
      body:`<p>Not every project gets the same process. After the site walk, you make a path decision: <strong>Straightforward Quote</strong> (template-eligible, low complexity, &lt;$2,500), <strong>Scoped Proposal</strong> (custom scope, estimating required, $2,500–$50,000+), or <strong>Roadmap/Preconstruction Package</strong> (complex, phased, or large-scale project requiring a paid planning phase).</p>
<p>Choosing the wrong path wastes time in both directions. A complex hardscape job treated as a straightforward quote will miss scope, lose margin, or fail in the field. A simple mulch refresh run through a full scoping process wastes everyone's time.</p>`,
      callout:{ type:'warning', title:'What Not to Promise on the Site Walk', body:'Never quote a specific price on-site. Never promise a start date. Never say "that should be easy" before estimating. Each of those statements becomes a contractual expectation in the client\'s mind before you\'ve done the work to back them up.' },
      examples:[
        { label:'Path decision in practice', text:'Client wants a patio, drainage fix, and planting plan for a slope. That\'s three interdependent scopes, potential permit implications, and grading work. Path: Scoped Proposal, possibly Roadmap if the slope engineering is complex. Never a template quote.' }
      ],
      note_prompt:'What is the difference between a Scoped Proposal and a Roadmap/Preconstruction Package? Write one example of a project that would go each route, and explain why.'
    }
  ],

  M5: [
    {
      id:'M5_L1', title:'Scope First — Why You Never Estimate Without It',
      body:`<p>A scope is the internal technical document that defines exactly what will be built. A proposal is what the client sees. Scope comes first — always. You cannot estimate accurately without it, and you cannot protect Avalon's margin without defining every line before pricing begins.</p>
<p>The 10 required internal scope elements: <strong>Site conditions summary, Must-haves vs. nice-to-haves, Material specifications, Labor breakdown, Access and equipment requirements, Exclusions (explicit), Allowances and contingencies, Permit requirements, Production dependencies, Approval threshold.</strong></p>`,
      callout:{ type:'principle', title:'Scope First. Estimate Second. Always.', body:'If you find yourself pricing before scope is locked, stop. A price built on an incomplete scope is a promise you cannot keep. Every unknown must be documented as an exclusion in plain language the client can understand.' },
      examples:[
        { label:'Exclusion written right', text:'"This proposal does not include removal or relocation of the existing irrigation system. If irrigation lines are encountered during excavation, modifications will be scoped and priced separately."' },
        { label:'Exclusion written wrong', text:'"Irrigation not included." — This is ambiguous. Does it mean irrigation work? Irrigation protection? Irrigation repair? The client will interpret it in whichever way costs them less.' }
      ],
      note_prompt:'Write three exclusion statements for a typical hardscape project. Write them in plain language, as if explaining to a homeowner what will and won\'t be done. Check: are they specific enough that there\'s no room for misinterpretation?'
    },
    {
      id:'M5_L2', title:'The Approval Matrix and Margin Protection',
      body:`<p>Every proposal at Avalon must be approved before it goes to the client. The approval matrix exists to protect margin and catch scope errors before they become field problems. No rep submits without sign-off at the right level.</p>
<p>The matrix: <strong>Under $2,500</strong> — Ryan uses approved templates, no additional approval needed. <strong>$2,500–$10,000</strong> — Manager review and sign-off required. <strong>$10,001 and above</strong> — Tyler approves. <strong>All hardscape and drainage jobs regardless of price</strong> — Management review required. This is non-negotiable.</p>`,
      callout:{ type:'warning', title:'Common Margin Killers', body:'1. Underestimating labor hours on complex grades. 2. Material pricing built on old quotes (always re-price at time of estimate). 3. Missing permit costs. 4. No contingency on complex jobs. 5. Scope added verbally after the proposal is signed.' },
      examples:[
        { label:'Approval scenario', text:'Ryan gets a referral for a $9,500 patio. He builds the scope, prices it at 52% GM. He brings it to the manager for review — not because he doubts himself, but because that\'s the rule. Manager catches that the existing step demolition wasn\'t included. Price corrects to $11,200. Tyler now approves it.' }
      ],
      note_prompt:'Memorize the approval matrix. Then write a short paragraph explaining to a new rep why the matrix exists — not as a rule to follow, but as a protection for everyone involved, including the rep.'
    }
  ],

  M6: [
    {
      id:'M6_L1', title:'The 6-Step Presentation Sequence',
      body:`<p>Proposal delivery is not a reading exercise. It is the final sales conversation — the one where all the trust built in discovery either pays off or falls apart. The sequence matters because it mirrors how clients make decisions: emotionally first, then logically.</p>
<p>The sequence: <strong>1. CBR Review</strong> — Open by restating their exact words from discovery. <strong>2. CBR-Order Solutions</strong> — Present each element tied to a specific CBR. <strong>3. Check Agreement</strong> — "Does this address what you described?" <strong>4. Review Investment</strong> — State the number confidently, without apologizing. <strong>5. Address Concerns</strong> — Handle questions with the Acknowledge–Reframe–Forward framework. <strong>6. Ask for the Decision</strong> — Direct close, not a soft hand-off.</p>`,
      callout:{ type:'principle', title:'The Direct Close — Word for Word', body:'"Based on everything we\'ve discussed, I\'d like to get this locked in for you. Can we move forward today?" — Not "let me know what you think." Not "take your time." A direct close respects the client\'s time and your own.' },
      examples:[
        { label:'CBR-connected open', text:'"When we met, you told me you wanted this yard to be the place your family actually uses — especially with your daughter\'s wedding coming in October. Everything in this proposal was built with that in mind. Let me walk you through it."' },
        { label:'Stating investment without apology', text:'"The total investment for this project is $26,400." [pause. say nothing. let it land.] Not: "So... it came in at around... $26,400 which I know sounds like a lot but..."' }
      ],
      note_prompt:'Write your version of a CBR-connected proposal opening for a client who told you they wanted "a yard their teenagers would actually want to spend time in." How do you open the presentation? Write it out word for word.'
    },
    {
      id:'M6_L2', title:'Handling Objections at Presentation',
      body:`<p>Objections at proposal delivery are not attacks. They are signals that something in the client's mind still needs resolution. The rep who treats an objection as a problem to overcome has already lost the frame. The right frame: the objection is information, and your job is to understand it before responding to it.</p>
<p>The Acknowledge–Reframe–Forward framework: <strong>Acknowledge:</strong> "I hear that." <strong>Reframe:</strong> Connect back to the CBR. <strong>Forward question:</strong> "If we could address that, would the rest of the project make sense for you?"</p>`,
      callout:{ type:'warning', title:'The Rehearsal Protocol', body:'When a decision-maker is absent from the presentation: "I know [partner] will want to weigh in. Let me walk you through exactly how to present this to them so you\'re armed with the right answers. The most common questions they\'ll have are usually..." Then brief them. You\'re coaching your internal champion.' },
      examples:[
        { label:'"Your price is too high"', text:'Acknowledge: "I appreciate you being direct." Reframe: "The investment reflects the material quality and the installation method we discussed — the same ones that protect against the drainage issues you\'ve had before." Forward: "If the investment worked, would the rest of the scope feel right?"' }
      ],
      note_prompt:'Write the Acknowledge–Reframe–Forward response for this objection: "We got another quote that was $8,000 less than yours." Be specific. Use the CBR from Module 3\'s example (the October wedding). What does the reframe sound like when it\'s tied to an emotional driver?'
    }
  ],

  M7: [
    {
      id:'M7_L1', title:'The Follow-Up Cadence — Structured, Not Random',
      body:`<p>Random follow-up is the single most common failure in landscape sales. Reps send a proposal, wait a week, send a "just checking in" email, and wonder why deals go cold. The Avalon follow-up cadence removes randomness and replaces it with a defined sequence that feels professional, not pushy.</p>
<p>The cadence: <strong>Day 3:</strong> Confirmation call — "Did you have a chance to look through the proposal? Any initial questions?" <strong>Day 7:</strong> Clarification call — "Is it the scope, the investment, the timing, or something else?" <strong>Day 14:</strong> Decision call — "We're approaching the point where I need to know if we're moving forward or closing this out. What are your thoughts?" <strong>Day 21+:</strong> Final close — "I want to respect your time. Should we keep this active or close it out for now?"</p>`,
      callout:{ type:'principle', title:'Clarify Before You Answer', body:'Never answer a price objection without first knowing whether it\'s actually about price. "Is it the price, the scope, the timing, or something about fit?" The answer determines your entire response. Guessing wrong means defending the wrong thing.' },
      examples:[
        { label:'Day 7 call done right', text:'"Hi [name], I\'m following up on the proposal from last week. I want to make sure I\'m being useful here — is the hesitation about the investment, or is there something in the scope you\'re still thinking through?" [shut up and listen]' }
      ],
      note_prompt:'Build your personal follow-up cadence. Use the Avalon framework as a base but write the actual scripts you\'d use for each touchpoint in your own voice. Day 3, Day 7, Day 14, Day 21. Four scripts. Under 50 words each.'
    },
    {
      id:'M7_L2', title:'When to Stop — And How to Close It Gracefully',
      body:`<p>One of the hardest skills in sales is knowing when a deal is done — not closed, done. Some clients will never buy. Some projects don't fit. Some timelines don't align. Holding an opportunity open forever is not persistence — it's pipeline clutter that hides your real numbers.</p>
<p>The graceful close-out: "I want to be respectful of your time and mine. It sounds like the timing isn't right for this project. I'm going to close this out on our end — but I'll keep your notes on file and reach back out when you're ready to pick this up. Sound good?" That sentence preserves the relationship without holding a fake deal.</p>`,
      callout:{ type:'warning', title:'The Discount Rule — Final', body:'Never discount without changing scope. If you drop price without changing what\'s being built, you have trained that client to stall on every future project for a price reduction. You have also told every future Avalon rep who works with that client that our prices are negotiable. They\'re not.' },
      examples:[
        { label:'Cheap competitor quote', text:'"I appreciate you sharing that. I can\'t speak to what\'s included in their price — but I can walk you through exactly what\'s in ours and what\'s not, so you\'re comparing the same scope. Do you have their proposal in front of you?"' }
      ],
      note_prompt:'Write your own close-out script for a deal that\'s been open for 45 days with no decision. It should preserve the relationship, be honest about where things stand, and leave the door open without being vague. Under 75 words.'
    }
  ],

  M8: [
    {
      id:'M8_L1', title:'The Close — What Actually Has to Happen',
      body:`<p>A verbal yes is not a close. It is the beginning of the activation process — and if the activation steps are skipped or rushed, the deal can still fall apart in the field. The close is complete only when: <strong>Signed SOW is received. Deposit is collected (≥40% for landscape). Job is entered in production scheduling.</strong></p>
<p>The sold job activation checklist covers 12 items. Every one must be checked before field work begins. Skipping even one creates a gap that becomes a field problem, a client complaint, or a margin loss.</p>`,
      callout:{ type:'list', title:'Sold Job Activation Checklist', items:[
        '1. Signed SOW received and filed',
        '2. Deposit collected (minimum 40%)',
        '3. CBR Profile written and shared with production',
        '4. Site photos organized and labeled',
        '5. Material specs confirmed and priced',
        '6. Permit requirements identified',
        '7. Subcontractors flagged if needed',
        '8. Access confirmed (gates, equipment routes)',
        '9. Alignment Meeting scheduled with Ops + Crew Lead',
        '10. Handoff Packet assembled (SOW + COGs + CBR + Access layout)',
        '11. Start date confirmed with client',
        '12. Driveway Handshake scheduled for Day 1'
      ]},
      examples:[
        { label:'What a botched handoff looks like', text:'Rep closes a $34,000 patio job. Sends the proposal PDF to operations. "Here you go." Crew shows up Day 1 with no material list, no access plan, no idea the client has a dog that needs to be kept inside. Two hours lost. Client frustrated. Relationship damaged before the work even begins.' }
      ],
      note_prompt:'From memory, list all 12 items on the Sold Job Activation Checklist. Then identify which three items you think are most likely to be skipped under time pressure — and write a brief sentence on why each one matters.'
    },
    {
      id:'M8_L2', title:'The 3-Phase Handoff — Packet, Alignment, Driveway',
      body:`<p>The handoff is not a document drop. It is a structured three-phase process designed to eliminate field surprises, protect the client relationship, and ensure production has everything they need to deliver without coming back to Sales for answers.</p>
<p><strong>Phase 1 — Handoff Packet:</strong> SOW, COGs, CBR Profile, Material and Access layout. Assembled by Sales, reviewed by Ops. <strong>Phase 2 — Alignment Meeting:</strong> Sales + Ops + Crew Leader. Walk the SOW line by line. Resolve every open question. <strong>Phase 3 — Driveway Handshake:</strong> Sales Rep on-site Day 1. Walk the site with client and Crew Leader. Officially pass the baton. After this moment, all client communication goes through production.</p>`,
      callout:{ type:'warning', title:'What Sales Must Never Do After Handoff', body:'After the Driveway Handshake, Sales must not make promises to the client about schedule, scope changes, or crew decisions. Any client request goes back through production. Breaking this rule undermines the Crew Leader\'s authority and creates a dual-command problem in the field.' },
      examples:[
        { label:'The Driveway Handshake in words', text:'"[Client name], I want to introduce you to [Crew Lead name] — he\'s going to be leading your project from here. He knows every detail of what we\'ve planned. I\'ll still be reachable, but [Crew Lead] is your primary point of contact from today forward. You\'re in great hands."' }
      ],
      note_prompt:'Imagine you\'re preparing a Handoff Packet for a $28,000 hardscape project. What goes in each section? Write a brief outline: SOW summary, COGs notes, CBR Profile, Material/Access layout. What would you include that a new rep might forget?'
    }
  ],

  M9: [
    {
      id:'M9_L1', title:'The Closeout Conversation — Timing and Structure',
      body:`<p>The closeout call is Sales' last official touchpoint on a job — and it's the one most often skipped because the rep is already chasing the next deal. That's exactly why it matters: it's the moment that separates a satisfied client from a loyal one.</p>
<p>Timing: 48–72 hours after the final walkthrough. Initiated by Sales, not production. Format: personal phone call, not email. The structure: <strong>Confirm satisfaction → surface any unresolved concerns → ask for a review → plant the referral conversation → log Phase 2 or maintenance interest.</strong></p>`,
      callout:{ type:'principle', title:'The Review Request That Gets Results', body:'Don\'t say "would you mind leaving us a review?" Say: "When we talked about what you wanted from this project, you mentioned [their exact words]. If that\'s been delivered, would you be willing to share that experience in a Google review? Those words — from someone who\'s actually been through the process — mean everything to the families we work with."' },
      examples:[
        { label:'The referral opener', text:'"We treat every referral the same way we treated you — full process, no shortcuts. If you know anyone who\'s been putting off a project like this, I\'d love the chance to help them the same way." [pause. let them respond.]' }
      ],
      note_prompt:'Script your personal closeout call. It should cover all five structural elements in under 3 minutes. Write it out as you would actually say it — not formal, not scripted-sounding. Time yourself reading it out loud. Is it under 3 minutes?'
    },
    {
      id:'M9_L2', title:'Converting Clients into Revenue Streams',
      body:`<p>Every satisfied client is the beginning of a revenue stream, not the end of a transaction. The three conversion paths: <strong>Review</strong> (digital credibility), <strong>Referral</strong> (new pipeline), <strong>Expansion</strong> (maintenance, Phase 2, or additional scope).</p>
<p>The maintenance conversion bridge: "Would you like us to help maintain or protect this investment?" That one question, asked at the right moment, opens the door to a recurring revenue relationship. Log every Phase 2 interest with a timing estimate and owner assignment. These are not someday maybes — they are future pipeline with a timeline.</p>`,
      callout:{ type:'principle', title:'The Phase 2 Prompt', body:'"What would you want to tackle next?" — Log it with: what the scope is, when they\'d realistically want it done, and who the decision-maker is. Set a calendar reminder to follow up. A satisfied client who\'s given you a Phase 2 clue is the warmest lead you\'ll ever have.' },
      examples:[
        { label:'Maintenance bridge example', text:'Client just had a $24,000 planting and sod installation. "This planting is going to look incredible once it establishes. We offer a seasonal maintenance program that protects this investment — mulching, trimming, seasonal color. Would that be useful to look at?" Even a soft yes goes into pipeline.' }
      ],
      note_prompt:'Think of three past clients or relationships where a Phase 2 or maintenance conversation could have happened but didn\'t. Write what you would say today to open that conversation. What\'s the specific question that bridges from the completed project to the next opportunity?'
    }
  ]
};

// ─── Quiz Questions ────────────────────────────────────────────────────────────
const QUIZ_QUESTIONS = {
  M1:[
    { id:'M1Q1', prompt:'Avalon\'s sales approach is best described as:', points:1,
      explanation:'Avalon sells consultatively — understanding the client fully, defining the problem, shaping scope, and protecting both the client and the business. Sending prices is transactional selling, which Avalon deliberately avoids.',
      choices:[
        { value:'a', text:'Sending competitive estimates quickly to win on speed', correct:false },
        { value:'b', text:'Consultative, process-driven, and margin-protective', correct:true },
        { value:'c', text:'Building the most detailed proposal in the market', correct:false },
        { value:'d', text:'Leading with lowest price to establish the relationship', correct:false }
      ]
    },
    { id:'M1Q2', prompt:'Scope clarity protects the client by:', points:1,
      explanation:'Scope clarity eliminates surprise costs for the client and prevents margin erosion and field confusion for Avalon. It is a protection mechanism for both parties, not just a documentation exercise.',
      choices:[
        { value:'a', text:'Making proposals look more polished and professional', correct:false },
        { value:'b', text:'Preventing surprise costs and misaligned expectations', correct:true },
        { value:'c', text:'Speeding up the estimating and approval process', correct:false },
        { value:'d', text:'Helping the production team schedule their crew calendar', correct:false }
      ]
    },
    { id:'M1Q3', prompt:'Why is a qualified "no" better than a confusing "maybe"?', points:1,
      explanation:'A confusing maybe keeps an unwinnable opportunity open and burns estimating hours that could go toward real prospects. A clear no frees the team to focus energy where it will produce results.',
      choices:[
        { value:'a', text:'It is easier to log a closed-lost status in the pipeline', correct:false },
        { value:'b', text:'Clients prefer direct communication in all situations', correct:false },
        { value:'c', text:'A confusing maybe wastes estimating time on unwinnable deals', correct:true },
        { value:'d', text:'A no triggers a follow-up sequence that often reverses the decision', correct:false }
      ]
    },
    { id:'M1Q4', prompt:'"Operationally clean" in the Avalon context means:', points:1,
      explanation:'Operationally clean means every job handed to production is fully documented, scoped, and approved — no verbal summaries, no missing information, no field surprises.',
      choices:[
        { value:'a', text:'Using standardized and professionally designed proposal templates', correct:false },
        { value:'b', text:'Keeping the office and job files organized at all times', correct:false },
        { value:'c', text:'Every job is fully documented and approved before field work begins', correct:true },
        { value:'d', text:'Responding to all client inquiries within a 24-hour window', correct:false }
      ]
    }
  ],
  M2:[
    { id:'M2Q1', prompt:'In T.A.P.P.O., the "P" for Permission refers to:', points:1,
      explanation:'Permission means gaining the client\'s agreement to ask direct questions — about budget, decision process, and timeline — before those questions arise naturally. It prevents the client from feeling blindsided by pointed discovery questions.',
      choices:[
        { value:'a', text:'Permission to begin the site walk and take measurements', correct:false },
        { value:'b', text:'Permission to ask direct questions about budget and decisions', correct:true },
        { value:'c', text:'Permission to send a formal proposal after the meeting', correct:false },
        { value:'d', text:'Permission to contact the client\'s spouse or business partner', correct:false }
      ]
    },
    { id:'M2Q2', prompt:'Budget must be discussed before sharing scope or pricing because:', points:1,
      explanation:'Without a budget conversation, you risk spending hours estimating for a client who cannot or will not invest at Avalon\'s price level. Budget qualification protects the estimating team\'s time.',
      choices:[
        { value:'a', text:'Clients feel more respected when budget comes first in the process', correct:false },
        { value:'b', text:'It protects estimating hours from being spent on unqualified projects', correct:true },
        { value:'c', text:'Company policy requires it for all jobs over $5,000', correct:false },
        { value:'d', text:'It establishes a price anchor before the client sees the proposal', correct:false }
      ]
    },
    { id:'M2Q3', prompt:'The 3+ Funneling Rule means a rep should:', points:1,
      explanation:'The 3+ Funneling Rule requires asking at least three layers of questions before accepting any answer as complete. The first answer is almost never the real answer — CBRs live beneath the surface.',
      choices:[
        { value:'a', text:'Send at least three follow-up emails after every proposal delivery', correct:false },
        { value:'b', text:'Include at least three pricing options in every proposal', correct:false },
        { value:'c', text:'Ask at least three layers of questions before accepting any answer', correct:true },
        { value:'d', text:'Qualify at least three new leads each week to maintain pipeline', correct:false }
      ]
    },
    { id:'M2Q4', prompt:'The Rehearsal Protocol is used when:', points:1,
      explanation:'The Rehearsal Protocol is used when the decision-maker is not present at the proposal delivery. You coach the present person on exactly how to present and advocate for the proposal to their absent partner.',
      choices:[
        { value:'a', text:'A rep is preparing their own delivery before a major presentation', correct:false },
        { value:'b', text:'The team is role-playing scenarios during weekly training', correct:false },
        { value:'c', text:'The decision-maker is absent and the present person needs to advocate', correct:true },
        { value:'d', text:'A client requests a second presentation for a different family member', correct:false }
      ]
    }
  ],
  M3:[
    { id:'M3Q1', prompt:'A Core Buying Reason differs from a surface request because:', points:1,
      explanation:'A surface request is what the client says they want ("I want a patio"). A CBR is the emotional outcome beneath it ("I want my family to use the yard together before the kids go to college"). CBRs are discovered through layered questioning, not assumed from the first statement.',
      choices:[
        { value:'a', text:'A CBR is the stated budget range for the project', correct:false },
        { value:'b', text:'A CBR is the emotional outcome beneath the stated request', correct:true },
        { value:'c', text:'A CBR is the client\'s preferred completion timeline', correct:false },
        { value:'d', text:'A CBR is the list of features the client asked for by name', correct:false }
      ]
    },
    { id:'M3Q2', prompt:'Which behavior is NOT one of the four listening traps?', points:1,
      explanation:'The four listening traps are: Formulating Responses, Premature Fix-it Mode, Assumptive Hearing, and Phone Distractions. Active nodding is a positive listening technique — it encourages the client to continue and signals engagement.',
      choices:[
        { value:'a', text:'Formulating your next response while the client is still speaking', correct:false },
        { value:'b', text:'Jumping to solutions the moment you identify a problem', correct:false },
        { value:'c', text:'Nodding actively to signal that you are engaged and listening', correct:true },
        { value:'d', text:'Assuming you know what the client means before they finish', correct:false }
      ]
    },
    { id:'M3Q3', prompt:'A verbatim feedback loop involves:', points:1,
      explanation:'A verbatim feedback loop means repeating back the client\'s exact words — not a summary or paraphrase. It is the highest-trust move in discovery because it proves the rep heard precisely what was said and gives the client an opportunity to clarify or expand.',
      choices:[
        { value:'a', text:'Summarizing the client\'s main points in your own words', correct:false },
        { value:'b', text:'Repeating the client\'s exact words back to them verbatim', correct:true },
        { value:'c', text:'Taking written notes during every discovery conversation', correct:false },
        { value:'d', text:'Asking the client to repeat an important point for clarity', correct:false }
      ]
    },
    { id:'M3Q4', prompt:'Before transitioning from pain to solution, you must:', points:1,
      explanation:'The pain must be fully established — felt by the client — before you introduce a solution. Moving to solutions too quickly means the client hasn\'t internalized the cost of inaction, so they don\'t value the investment in fixing it.',
      choices:[
        { value:'a', text:'Offer your solution as soon as you identify the core problem', correct:false },
        { value:'b', text:'Ask permission before shifting to the solution phase', correct:false },
        { value:'c', text:'Let the consequence of the problem fully land before pivoting', correct:true },
        { value:'d', text:'Present solutions during discovery to keep momentum moving', correct:false }
      ]
    }
  ],
  M4:[
    { id:'M4Q1', prompt:'The fit decision must be made:', points:1,
      explanation:'The fit decision — whether Avalon is the right partner for this project at the right price point — must be made in person before leaving the site. Deferring it by email or phone after the fact costs time and creates ambiguity.',
      choices:[
        { value:'a', text:'By email within 24 hours of completing the site walk', correct:false },
        { value:'b', text:'In person before leaving the property on the day of the site walk', correct:true },
        { value:'c', text:'After the estimate has been reviewed and approved internally', correct:false },
        { value:'d', text:'During the proposal presentation once scope is confirmed', correct:false }
      ]
    },
    { id:'M4Q2', prompt:'Which item must NEVER be promised during a site walk?', points:1,
      explanation:'Specific pricing or cost estimates must never be promised on-site. Numbers require completed estimating. Making a price commitment before that work is done creates an expectation the proposal cannot honor.',
      choices:[
        { value:'a', text:'The general scope and approach being considered for the project', correct:false },
        { value:'b', text:'A specific price or cost estimate for the work discussed', correct:true },
        { value:'c', text:'The approximate timeline for delivering the completed proposal', correct:false },
        { value:'d', text:'Which items are must-haves versus nice-to-haves for the client', correct:false }
      ]
    },
    { id:'M4Q3', prompt:'Before estimating begins, a site walk must produce at minimum:', points:1,
      explanation:'Photos, measurements, and a written site walk summary are the three required outputs of every site walk before estimating begins. Relying on memory or verbal notes is not acceptable.',
      choices:[
        { value:'a', text:'A verbal summary shared with the production manager', correct:false },
        { value:'b', text:'A signed letter of intent from the client', correct:false },
        { value:'c', text:'Photos, written measurements, and a site walk summary', correct:true },
        { value:'d', text:'A preliminary budget range confirmed by the client in writing', correct:false }
      ]
    },
    { id:'M4Q4', prompt:'Must-haves versus nice-to-haves must be separated:', points:1,
      explanation:'This separation must happen with the client present on-site — not later in the office. It is a discovery exercise that requires the client\'s participation to be valid.',
      choices:[
        { value:'a', text:'During the proposal review meeting when the client sees pricing', correct:false },
        { value:'b', text:'While building the internal scope document in the office', correct:false },
        { value:'c', text:'With the client present on-site during or after the site walk', correct:true },
        { value:'d', text:'After the client receives the initial proposal and provides feedback', correct:false }
      ]
    }
  ],
  M5:[
    { id:'M5Q1', prompt:'A scope document differs from a proposal in that:', points:1,
      explanation:'A scope is an internal technical document defining what will be built. A proposal is the external client-facing document. Scope must be complete before any proposal is created.',
      choices:[
        { value:'a', text:'A scope includes pricing while a proposal describes only the work', correct:false },
        { value:'b', text:'A scope is internal and technical; a proposal is the client-facing document', correct:true },
        { value:'c', text:'A scope is required only for jobs over $10,000', correct:false },
        { value:'d', text:'A scope is optional when using pre-approved proposal templates', correct:false }
      ]
    },
    { id:'M5Q2', prompt:'A $12,000 landscape enhancement job must be approved by:', points:1,
      explanation:'The approval matrix: under $2,500 — template (Ryan); $2,500–$10,000 — manager; $10,001 and above — Tyler. A $12,000 job requires Tyler\'s approval.',
      choices:[
        { value:'a', text:'Ryan, using an approved template', correct:false },
        { value:'b', text:'The office manager with a standard review', correct:false },
        { value:'c', text:'Tyler, as it exceeds the $10,000 manager threshold', correct:true },
        { value:'d', text:'No additional approval is needed for landscape work', correct:false }
      ]
    },
    { id:'M5Q3', prompt:'Exclusions must be documented in writing because:', points:1,
      explanation:'Without written exclusions, any item not explicitly included in the scope becomes Avalon\'s problem to address at no additional cost. Written exclusions are the primary contractual protection against scope creep.',
      choices:[
        { value:'a', text:'Clients frequently forget verbal conversations after the site walk', correct:false },
        { value:'b', text:'Undocumented items become Avalon\'s liability to fix at no cost', correct:true },
        { value:'c', text:'The estimating software requires all exclusions to be listed', correct:false },
        { value:'d', text:'Exclusions make proposals appear more thorough to clients', correct:false }
      ]
    },
    { id:'M5Q4', prompt:'When scope changes after signing without a written amendment:', points:1,
      explanation:'Without a signed amendment, Avalon absorbs the cost of any scope change. This is the single largest margin killer in landscape contracting and is prevented only by a written change order process.',
      choices:[
        { value:'a', text:'The client pays a standard change order rate automatically', correct:false },
        { value:'b', text:'Production flags it and waits for manager approval to proceed', correct:false },
        { value:'c', text:'Avalon absorbs the cost — the leading cause of margin loss', correct:true },
        { value:'d', text:'The change is noted and included in the final billing statement', correct:false }
      ]
    }
  ],
  M6:[
    { id:'M6Q1', prompt:'The most damaging mistake at proposal delivery is:', points:1,
      explanation:'Emailing a complex proposal without presenting it live is the most common and damaging mistake. The rep loses control of the narrative, the CBR connection is broken, and the close never happens.',
      choices:[
        { value:'a', text:'Including too many line items, which overwhelms the client', correct:false },
        { value:'b', text:'Emailing a complex proposal for the client to review alone', correct:true },
        { value:'c', text:'Opening with the investment before building sufficient value', correct:false },
        { value:'d', text:'Scheduling the presentation too soon after the site walk', correct:false }
      ]
    },
    { id:'M6Q2', prompt:'Solutions in a proposal should be presented in:', points:1,
      explanation:'Solutions must be presented in CBR priority order — the element that matters most to the client emotionally comes first. This is not construction sequence order. It mirrors how the client thinks about their project.',
      choices:[
        { value:'a', text:'Construction sequence — what will be built in chronological order', correct:false },
        { value:'b', text:'Price order from the lowest to the highest investment item', correct:false },
        { value:'c', text:'CBR priority order — what matters most to the client goes first', correct:true },
        { value:'d', text:'Alphabetical order for easy client reference and review', correct:false }
      ]
    },
    { id:'M6Q3', prompt:'The correct direct close at the end of a proposal is:', points:1,
      explanation:'"Can we lock this in today?" is a direct, confident close that respects the client\'s time and creates a decision moment. Phrases like "let me know what you think" or "take your time" are not closes.',
      choices:[
        { value:'a', text:'"Let me know what you think and feel free to reach out anytime."', correct:false },
        { value:'b', text:'"Take your time — there\'s no rush on our end."', correct:false },
        { value:'c', text:'"Can we lock this in today?"', correct:true },
        { value:'d', text:'"What parts of this are you most excited about?"', correct:false }
      ]
    },
    { id:'M6Q4', prompt:'Before any proposal conversation ends, the rep must establish:', points:1,
      explanation:'A clear next step with a specific date must be established before the conversation ends. Vague endings like "think it over" or "be in touch" are not next steps — they are pipeline leaks.',
      choices:[
        { value:'a', text:'A signed acknowledgment that the client received the proposal', correct:false },
        { value:'b', text:'A clear next step with a specific date attached to it', correct:true },
        { value:'c', text:'A summary of all exclusions repeated one final time', correct:false },
        { value:'d', text:'The client\'s written confirmation of their budget range', correct:false }
      ]
    }
  ],
  M7:[
    { id:'M7Q1', prompt:'The first question after sending a proposal should be:', points:1,
      explanation:'"Is it the price, the scope, the timing, or something about fit?" identifies the real objection before the rep responds. Guessing the wrong category and defending against it wastes the conversation.',
      choices:[
        { value:'a', text:'"Did you get a chance to read through the proposal I sent?"', correct:false },
        { value:'b', text:'"Is there anything in the scope I can clarify for you?"', correct:false },
        { value:'c', text:'"Is it the price, scope, timing, or something about fit?"', correct:true },
        { value:'d', text:'"Are you ready to move forward with the project?"', correct:false }
      ]
    },
    { id:'M7Q2', prompt:'The Avalon follow-up cadence after proposal delivery is:', points:1,
      explanation:'Day 3 — confirmation, Day 7 — clarification, Day 14 — decision, Day 21+ — final close or graceful exit. This is a defined sequence, not a random check-in schedule.',
      choices:[
        { value:'a', text:'Weekly emails until the client responds with a decision', correct:false },
        { value:'b', text:'Day 3, Day 7, Day 14, Day 21+ — a structured defined cadence', correct:true },
        { value:'c', text:'Every 48 hours for the first two weeks after delivery', correct:false },
        { value:'d', text:'Only when the client initiates contact with a question', correct:false }
      ]
    },
    { id:'M7Q3', prompt:'When a client requests a discount, the correct response is to:', points:1,
      explanation:'A discount must always be matched by a scope reduction. Dropping price without changing scope trains the client that prices are negotiable and destroys margin without any corresponding reduction in cost.',
      choices:[
        { value:'a', text:'Offer a small goodwill percentage to preserve the relationship', correct:false },
        { value:'b', text:'Reduce scope proportionally — price only drops when scope drops', correct:true },
        { value:'c', text:'Explain that current margins are too tight to allow adjustments', correct:false },
        { value:'d', text:'Escalate to the manager to handle the pricing conversation', correct:false }
      ]
    },
    { id:'M7Q4', prompt:'To gracefully close out a stalled deal while preserving the relationship:', points:1,
      explanation:'The graceful close-out acknowledges reality, removes the deal from active pipeline, and leaves the door open without pretending the deal is still alive. It preserves the client relationship for future opportunities.',
      choices:[
        { value:'a', text:'Send one final discounted offer to create urgency', correct:false },
        { value:'b', text:'Stop following up and let the client come back when ready', correct:false },
        { value:'c', text:'Acknowledge the timing, close out the deal, and offer to reconnect later', correct:true },
        { value:'d', text:'Transfer the opportunity to a different rep for a fresh approach', correct:false }
      ]
    }
  ],
  M8:[
    { id:'M8Q1', prompt:'Activation of a sold job requires:', points:1,
      explanation:'A verbal yes alone does not activate a job. Activation requires a signed SOW and a deposit collected (minimum 40%). No field work begins without both.',
      choices:[
        { value:'a', text:'A verbal yes from the primary decision-maker', correct:false },
        { value:'b', text:'A signed SOW and collected deposit — both are required', correct:true },
        { value:'c', text:'A production manager confirmation that crew is available', correct:false },
        { value:'d', text:'Manager approval of the final scope before scheduling begins', correct:false }
      ]
    },
    { id:'M8Q2', prompt:'The Driveway Handshake involves:', points:1,
      explanation:'The Driveway Handshake is the Sales Rep on-site on Day 1 of production, walking the site with the client and Crew Leader, and officially transferring the client relationship to the production team.',
      choices:[
        { value:'a', text:'The client signing a final invoice and receiving a warranty document', correct:false },
        { value:'b', text:'Sales, client, and Crew Leader on-site Day 1 to walk the scope', correct:true },
        { value:'c', text:'The Crew Leader reviewing the handoff packet before crews arrive', correct:false },
        { value:'d', text:'The manager confirming the schedule with production before Day 1', correct:false }
      ]
    },
    { id:'M8Q3', prompt:'The Handoff Packet must contain:', points:1,
      explanation:'The Handoff Packet contains four required elements: the Signed SOW, COGs breakdown, CBR Profile, and Material/Access layout. All four must be present before any field work begins.',
      choices:[
        { value:'a', text:'Invoice, warranty documentation, and permit applications', correct:false },
        { value:'b', text:'Signed SOW, COGs, CBR Profile, and Material/Access layout', correct:true },
        { value:'c', text:'Site photos, client contact information, and payment receipt', correct:false },
        { value:'d', text:'Proposal document, deposit receipt, and crew work schedule', correct:false }
      ]
    },
    { id:'M8Q4', prompt:'After the Driveway Handshake, Sales must NOT:', points:1,
      explanation:'After the Driveway Handshake, all client communication goes through production. Sales making independent promises about scope, schedule, or changes after handoff creates a dual-command problem and undermines the Crew Leader\'s authority.',
      choices:[
        { value:'a', text:'Follow up with the client at closeout 48-72 hours after final walkthrough', correct:false },
        { value:'b', text:'Make promises to the client about scope, schedule, or changes', correct:true },
        { value:'c', text:'Attend the Driveway Handshake on production Day 1', correct:false },
        { value:'d', text:'Log the opportunity as Sold/Activation in the pipeline', correct:false }
      ]
    }
  ],
  M9:[
    { id:'M9Q1', prompt:'The closeout call should happen:', points:1,
      explanation:'48–72 hours after the final walkthrough is the optimal window — close enough that the experience is fresh, but far enough that any last-minute issues have surfaced. The call is initiated by Sales, not production.',
      choices:[
        { value:'a', text:'When production sends the final invoice to the client', correct:false },
        { value:'b', text:'48–72 hours after the final walkthrough, initiated by Sales', correct:true },
        { value:'c', text:'After the client has posted a Google review voluntarily', correct:false },
        { value:'d', text:'At the time of final payment collection by the office', correct:false }
      ]
    },
    { id:'M9Q2', prompt:'The most effective review request references:', points:1,
      explanation:'The most effective review request references the client\'s own specific words from earlier in the process and asks them to share that exact experience. Generic requests produce generic (or no) responses.',
      choices:[
        { value:'a', text:'A link to the Google review page and a polite general ask', correct:false },
        { value:'b', text:'The client\'s own words and their specific experience with the project', correct:true },
        { value:'c', text:'A follow-up text 24 hours after the verbal request is made', correct:false },
        { value:'d', text:'An incentive or discount offer in exchange for a review', correct:false }
      ]
    },
    { id:'M9Q3', prompt:'The referral conversation opener at Avalon is:', points:1,
      explanation:'"We treat referrals the same way we treated you" is the most natural and trust-grounded referral opener. It connects the referral experience to the client\'s own positive outcome, rather than asking them to do Avalon a favor.',
      choices:[
        { value:'a', text:'"Do you know anyone who might be interested in our services?"', correct:false },
        { value:'b', text:'"We treat referrals the same way we treated you."', correct:true },
        { value:'c', text:'"We offer a referral credit for every new client you send."', correct:false },
        { value:'d', text:'"Our best new clients always come from people like you."', correct:false }
      ]
    },
    { id:'M9Q4', prompt:'The Phase 2 or maintenance conversation is opened with:', points:1,
      explanation:'"What would you want to tackle next?" — logged with timing and owner — is the natural, low-pressure bridge to future revenue. It invites the client to envision the next step without feeling sold to.',
      choices:[
        { value:'a', text:'"Are you interested in signing up for a maintenance contract?"', correct:false },
        { value:'b', text:'"What would you want to tackle next?" — logged with timing and owner', correct:true },
        { value:'c', text:'"Can I send you our seasonal maintenance pricing sheet?"', correct:false },
        { value:'d', text:'"Would you like to schedule a six-month check-in visit?"', correct:false }
      ]
    }
  ]
};

// ─── Build sections from rich lesson data ─────────────────────────────────────
function buildSections(mod, sourceModule) {
  const sections = [];
  sections.push({
    id:`${mod.id}_overview`, title:'Overview', section_type:'overview',
    sort_order:1, estimated_minutes:5, is_required:true,
    content:{ objective:sourceModule.objective, keyPoints:sourceModule.keyPoints||[] }
  });
  const lessons = RICH_LESSONS[mod.id] || [];
  lessons.forEach((l, i) => {
    sections.push({
      id: l.id, title: l.title, section_type:'lesson',
      sort_order: i + 2, estimated_minutes: 10, is_required: true,
      content: l
    });
  });
  sections.push({
    id:`${mod.id}_quiz`, title:'Knowledge Check', section_type:'quiz',
    sort_order: sections.length + 1, estimated_minutes: 8, is_required:true,
    content:{ quizId:`quiz_${mod.id}` }
  });
  return sections;
}

// ─── Content Init ─────────────────────────────────────────────────────────────
function initContent() {
  const existing = localStorage.getItem(CONTENT_KEY);
  if (existing) { try { const p = JSON.parse(existing); if (p._version === 2) return p; } catch(e){} }
  const sourceModules = (window.AVALON_DATA && window.AVALON_DATA.modules) || [];
  const modules = sourceModules.map(sm => {
    const mod = {
      id: sm.id,
      phase_id: ['M1','M2','M3'].includes(sm.id)?'phase_1':['M4','M5','M6'].includes(sm.id)?'phase_2':'phase_3',
      title: sm.title, short_description: sm.objective,
      overview: sm.objective, objectives: sm.keyPoints||[],
      sort_order: parseInt(sm.id.slice(1)), estimated_minutes:35,
      difficulty: parseInt(sm.id.slice(1))<=3?'Beginner':parseInt(sm.id.slice(1))<=6?'Intermediate':'Advanced',
      status:'published', requires_quiz_pass:true, min_quiz_score:75,
      quiz:{ id:`quiz_${sm.id}`, pass_score:75, questions: QUIZ_QUESTIONS[sm.id]||[] }
    };
    mod.sections = buildSections(mod, sm);
    return mod;
  });
  const content = { _version:2, phases:SEED_PHASES, modules, badges:BADGE_DEFS, levels:LEVELS, seeded_at:new Date().toISOString() };
  localStorage.setItem(CONTENT_KEY, JSON.stringify(content));
  return content;
}

// ─── Progress helpers ─────────────────────────────────────────────────────────
function allProgress(){ try{ return JSON.parse(localStorage.getItem(PROGRESS_KEY))||{}; }catch(e){ return {}; } }
function saveAllProgress(d){ localStorage.setItem(PROGRESS_KEY, JSON.stringify(d)); }
function repProgress(repId){
  const a = allProgress();
  if(!a[repId]) a[repId]={ modules:{}, phases:{}, points:0, streak_days:0, last_activity:null, badges:[], quizzes_passed:0, modules_completed:0 };
  return a[repId];
}
function allAttempts(){ try{ return JSON.parse(localStorage.getItem(ATTEMPTS_KEY))||{}; }catch(e){ return {}; } }
function saveAttempts(d){ localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(d)); }

function modProgress(repId, moduleId){
  const rp = repProgress(repId);
  if(!rp.modules[moduleId]) rp.modules[moduleId]={ status:'not_started', sections_completed:[], quiz_passed:false, quiz_best_score:null, percent_complete:0, started_at:null, completed_at:null };
  return rp.modules[moduleId];
}

function savePoints(repId, all, pts){
  all[repId].points = (all[repId].points||0) + pts;
  saveAllProgress(all);
}

function updateStreak(repId, all){
  const today = new Date().toISOString().slice(0,10);
  const last = all[repId].last_activity;
  if(last===today) return;
  if(last){ const diff = Math.round((new Date(today)-new Date(last))/86400000); all[repId].streak_days = diff===1?(all[repId].streak_days||0)+1:1; }
  else { all[repId].streak_days = 1; }
  all[repId].last_activity = today;
  saveAllProgress(all);
}

function trackEvent(repId, name, props){
  try{
    const ev = JSON.parse(localStorage.getItem(EVENTS_KEY)||'[]');
    ev.unshift({ id:`ev_${Date.now()}`, user_id:repId, event_name:name, properties:props||{}, occurred_at:new Date().toISOString() });
    if(ev.length>500) ev.length=500;
    localStorage.setItem(EVENTS_KEY, JSON.stringify(ev));
  }catch(e){}
}

// ─── Section completion ───────────────────────────────────────────────────────
function markSectionComplete(repId, moduleId, sectionId){
  const all = allProgress();
  if(!all[repId]) all[repId]=repProgress(repId);
  if(!all[repId].modules[moduleId]) all[repId].modules[moduleId]={ status:'not_started', sections_completed:[], quiz_passed:false, quiz_best_score:null, percent_complete:0, started_at:null, completed_at:null };
  const mp = all[repId].modules[moduleId];
  if(!mp.sections_completed.includes(sectionId)){
    mp.sections_completed.push(sectionId);
    savePoints(repId, all, POINTS.section_complete);
    trackEvent(repId,'section_completed',{moduleId,sectionId});
  }
  if(mp.status==='not_started'){ mp.status='in_progress'; mp.started_at=new Date().toISOString(); }
  const content = initContent();
  const mod = content.modules.find(m=>m.id===moduleId);
  if(mod){
    const nonQuiz = mod.sections.filter(s=>s.is_required&&s.section_type!=='quiz');
    const done = nonQuiz.filter(s=>mp.sections_completed.includes(s.id)).length;
    mp.percent_complete = Math.min(100, Math.round((done/nonQuiz.length)*80)+(mp.quiz_passed?20:0));
  }
  all[repId].modules[moduleId]=mp;
  saveAllProgress(all);
  updateStreak(repId,all);
  checkModComplete(repId, moduleId, all);
  checkBadges(repId, all);
}

function checkModComplete(repId, moduleId, all){
  const mp = all[repId].modules[moduleId];
  if(mp.status==='completed') return;
  const content = initContent();
  const mod = content.modules.find(m=>m.id===moduleId);
  if(!mod) return;
  const nonQuizReq = mod.sections.filter(s=>s.is_required&&s.section_type!=='quiz');
  const allDone = nonQuizReq.every(s=>mp.sections_completed.includes(s.id));
  if(allDone && (!mod.requires_quiz_pass || mp.quiz_passed)){
    mp.status='completed'; mp.percent_complete=100; mp.completed_at=new Date().toISOString();
    all[repId].modules_completed=(all[repId].modules_completed||0)+1;
    savePoints(repId, all, POINTS.module_complete);
    trackEvent(repId,'module_completed',{moduleId});
    saveAllProgress(all);
    checkPhaseComplete(repId, mod.phase_id, all);
  }
}

function checkPhaseComplete(repId, phaseId, all){
  const content = initContent();
  const mods = content.modules.filter(m=>m.phase_id===phaseId);
  if(mods.every(m=>(all[repId].modules[m.id]||{}).status==='completed')){
    if(!all[repId].phases) all[repId].phases={};
    if(all[repId].phases[phaseId]!=='completed'){
      all[repId].phases[phaseId]='completed';
      trackEvent(repId,'phase_completed',{phaseId});
      saveAllProgress(all);
    }
  }
}

// ─── Quiz engine ──────────────────────────────────────────────────────────────
function getQuizAttempts(repId, quizId){ const a=allAttempts(); return (a[repId]&&a[repId][quizId])||[]; }

function submitQuiz(repId, quizId, moduleId, answers){
  const content = initContent();
  const mod = content.modules.find(m=>m.id===moduleId);
  if(!mod) return { error:'Module not found' };
  const quiz = mod.quiz;
  let rawScore=0, total=0;
  const feedback=[];
  quiz.questions.forEach(q=>{
    total+=q.points;
    const sub = answers[q.id];
    const correctVal = q.choices.find(c=>c.correct)?.value;
    const correct = sub===correctVal;
    if(correct) rawScore+=q.points;
    feedback.push({ questionId:q.id, correct, points_awarded:correct?q.points:0, explanation:q.explanation, correct_answer:correctVal });
  });
  const pct = total>0?Math.round((rawScore/total)*100):0;
  const passed = pct>=quiz.pass_score;
  const prev = getQuizAttempts(repId, quizId);
  const isFirstPass = passed&&!prev.some(a=>a.passed);
  const attempt={ id:`qa_${Date.now()}`, quiz_id:quizId, module_id:moduleId, attempt_number:prev.length+1, submitted_at:new Date().toISOString(), raw_score:rawScore, percent_score:pct, passed, feedback, answers };
  const atts=allAttempts();
  if(!atts[repId]) atts[repId]={};
  if(!atts[repId][quizId]) atts[repId][quizId]=[];
  atts[repId][quizId].push(attempt);
  saveAttempts(atts);
  const all=allProgress();
  if(!all[repId]) all[repId]=repProgress(repId);
  if(!all[repId].modules[moduleId]) all[repId].modules[moduleId]={ status:'in_progress', sections_completed:[], quiz_passed:false, quiz_best_score:null, percent_complete:0, started_at:new Date().toISOString(), completed_at:null };
  const mp=all[repId].modules[moduleId];
  if(passed){
    mp.quiz_passed=true;
    if(isFirstPass){ all[repId].quizzes_passed=(all[repId].quizzes_passed||0)+1; savePoints(repId,all,POINTS.quiz_first_pass+(pct>=90?POINTS.quiz_90_bonus:0)); }
    else if(!isFirstPass&&passed){ savePoints(repId,all,POINTS.quiz_retry_pass); }
    mp.sections_completed=[...new Set([...mp.sections_completed,`${moduleId}_quiz`])];
    trackEvent(repId,'quiz_passed',{quizId,moduleId,pct,attempt:attempt.attempt_number});
  } else { trackEvent(repId,'quiz_failed',{quizId,moduleId,pct}); }
  if(mp.quiz_best_score===null||pct>mp.quiz_best_score) mp.quiz_best_score=pct;
  saveAllProgress(all); updateStreak(repId,all);
  checkModComplete(repId,moduleId,all); checkBadges(repId,allProgress());
  return { attempt, passed, percentScore:pct, feedback, quiz };
}

// ─── Badge engine ─────────────────────────────────────────────────────────────
function checkBadges(repId, all){
  if(!all[repId]) return;
  const rp=all[repId]; const earned=new Set(rp.badges||[]); const content=initContent(); const changed=[];
  BADGE_DEFS.forEach(b=>{
    if(earned.has(b.id)) return;
    const c=b.criteria;
    let award=false;
    if(c.moduleId){ const mp=(rp.modules||{})[c.moduleId]; if(mp&&mp.status==='completed'&&(!c.minQuizScore||(mp.quiz_best_score&&mp.quiz_best_score>=c.minQuizScore))) award=true; }
    else if(c.allPhases){ award=content.modules.every(m=>(rp.modules||{})[m.id]?.status==='completed'); }
    else if(c.streakDays){ award=(rp.streak_days||0)>=c.streakDays; }
    else if(c.quizzesPassed){ award=(rp.quizzes_passed||0)>=c.quizzesPassed; }
    else if(c.allQuizzesPassed){ award=(rp.quizzes_passed||0)>=content.modules.length; }
    else if(c.modulesIn7Days){ const wk=Date.now()-7*86400000; award=Object.values(rp.modules||{}).filter(m=>m.status==='completed'&&m.completed_at&&new Date(m.completed_at).getTime()>wk).length>=c.modulesIn7Days; }
    if(award){ earned.add(b.id); changed.push(b.id); trackEvent(repId,'badge_earned',{badgeId:b.id}); savePoints(repId,all,10); }
  });
  if(changed.length){ all[repId].badges=[...earned]; saveAllProgress(all); }
}

// ─── Level helpers ────────────────────────────────────────────────────────────
function calcLevel(pts){ let l=LEVELS[0]; LEVELS.forEach(lv=>{ if(pts>=lv.minPoints) l=lv; }); return l; }
function nextLevel(pts){ return LEVELS.find(l=>l.minPoints>pts)||null; }

// ─── Is module locked ─────────────────────────────────────────────────────────
function isLocked(moduleId, repId){
  const content=initContent(); const mod=content.modules.find(m=>m.id===moduleId); if(!mod) return true;
  const ph=content.phases.find(p=>p.id===mod.phase_id);
  if(!ph||ph.unlock_mode!=='prerequisite'||!ph.prerequisite_phase_id) return false;
  const rp=repProgress(repId);
  return !content.modules.filter(m=>m.phase_id===ph.prerequisite_phase_id).every(m=>(rp.modules[m.id]||{}).status==='completed');
}

// ─── Home data ─────────────────────────────────────────────────────────────────
function getHomeData(repId){
  const content=initContent(); const rp=repProgress(repId);
  const allMods=content.modules;
  const completedMods=allMods.filter(m=>(rp.modules[m.id]||{}).status==='completed');
  const overallPct=Math.round((completedMods.length/allMods.length)*100);
  const level=calcLevel(rp.points||0); const next=nextLevel(rp.points||0);
  const phaseProgress=content.phases.map(ph=>{
    const pMods=allMods.filter(m=>m.phase_id===ph.id);
    const phComp=pMods.filter(m=>(rp.modules[m.id]||{}).status==='completed').length;
    const phInProg=pMods.filter(m=>(rp.modules[m.id]||{}).status==='in_progress').length;
    const pct=Math.round((phComp/pMods.length)*100);
    let locked=false;
    if(ph.unlock_mode==='prerequisite'&&ph.prerequisite_phase_id){
      const prereqMods=allMods.filter(m=>m.phase_id===ph.prerequisite_phase_id);
      locked=!prereqMods.every(m=>(rp.modules[m.id]||{}).status==='completed');
    }
    return {...ph, pct, modulesCompleted:phComp, totalModules:pMods.length, locked, inProgress:phInProg>0};
  });
  let nextModule=null;
  for(const ph of content.phases){
    if(phaseProgress.find(p=>p.id===ph.id)?.locked) continue;
    const pMods=allMods.filter(m=>m.phase_id===ph.id).sort((a,b)=>a.sort_order-b.sort_order);
    const inProg=pMods.find(m=>(rp.modules[m.id]||{}).status==='in_progress');
    if(inProg){ nextModule=inProg; break; }
    const notStarted=pMods.find(m=>!(rp.modules[m.id])||rp.modules[m.id].status==='not_started');
    if(notStarted){ nextModule=notStarted; break; }
  }
  const earned=new Set(rp.badges||[]);
  const upcomingBadges=BADGE_DEFS.filter(b=>!earned.has(b.id)).slice(0,3);
  const recentlyCompleted=allMods.filter(m=>(rp.modules[m.id]||{}).status==='completed'&&rp.modules[m.id]?.completed_at).sort((a,b)=>new Date(rp.modules[b.id].completed_at)-new Date(rp.modules[a.id].completed_at)).slice(0,3);
  return { repId, overallPct, level, nextLevel:next, points:rp.points||0, streak_days:rp.streak_days||0, completedModules:completedMods.length, totalModules:allMods.length, badgesEarned:(rp.badges||[]).length, totalBadges:BADGE_DEFS.length, quizzesPassed:rp.quizzes_passed||0, phaseProgress, nextModule, upcomingBadges, recentlyCompleted, earnedBadgeIds:[...earned] };
}

// ─── Admin: all reps ──────────────────────────────────────────────────────────
function getAllRepsProgress(){
  const content=initContent(); const repsRaw=window.REPS||[];
  return repsRaw.map(rep=>{
    const rp=repProgress(rep.id);
    const compMods=content.modules.filter(m=>(rp.modules[m.id]||{}).status==='completed').length;
    const pct=Math.round((compMods/content.modules.length)*100);
    const level=calcLevel(rp.points||0);
    const atts=allAttempts(); const repAtts=atts[rep.id]||{};
    const passedAtts=Object.values(repAtts).flatMap(a=>a).filter(a=>a.passed);
    const quizAvg=passedAtts.length?Math.round(passedAtts.reduce((s,a)=>s+a.percent_score,0)/passedAtts.length):null;
    // Per-module detail for admin
    const moduleDetail={};
    content.modules.forEach(m=>{
      const mp=rp.modules[m.id]||{};
      const mAtts=(repAtts[`quiz_${m.id}`]||[]);
      moduleDetail[m.id]={ status:mp.status||'not_started', pct:mp.percent_complete||0, quiz_best:mp.quiz_best_score, quiz_attempts:mAtts.length, quiz_passed:mp.quiz_passed||false, completed_at:mp.completed_at||null };
    });
    return { rep, pct, completedMods:compMods, totalMods:content.modules.length, level, points:rp.points||0, badgesEarned:(rp.badges||[]).length, quizzesPassed:rp.quizzes_passed||0, quizAvg, streak:rp.streak_days||0, last_activity:rp.last_activity, moduleDetail };
  });
}

// ─── Admin: reset a rep's progress ────────────────────────────────────────────
function adminResetRepProgress(repId){
  const all=allProgress(); delete all[repId]; saveAllProgress(all);
  const atts=allAttempts(); delete atts[repId]; saveAttempts(atts);
}

// ─── Admin: manually complete a module for a rep ─────────────────────────────
function adminMarkModuleComplete(repId, moduleId){
  const all=allProgress();
  if(!all[repId]) all[repId]=repProgress(repId);
  const content=initContent(); const mod=content.modules.find(m=>m.id===moduleId);
  if(!mod) return;
  all[repId].modules[moduleId]={
    status:'completed', sections_completed:mod.sections.map(s=>s.id),
    quiz_passed:true, quiz_best_score:100, percent_complete:100,
    started_at:all[repId].modules[moduleId]?.started_at||new Date().toISOString(),
    completed_at:new Date().toISOString()
  };
  all[repId].modules_completed=(all[repId].modules_completed||0)+1;
  saveAllProgress(all);
  trackEvent(repId,'admin_module_override',{moduleId});
}

// ─── Expose ───────────────────────────────────────────────────────────────────
window.Academy = {
  getContent:           initContent,
  getHomeData,
  // canonical names
  repProgress,
  modProgress,
  markSectionComplete,
  submitQuiz,
  getQuizAttempts,
  isLocked,
  calcLevel,
  nextLevel,
  getAllRepsProgress,
  adminResetRepProgress,
  adminMarkModuleComplete,
  trackEvent,
  POINTS, LEVELS, BADGE_DEFS, RICH_LESSONS,
  // view-layer aliases (app_premium.js uses these names)
  getRepProgress:       repProgress,
  getModuleProgress:    modProgress,
  isModuleLocked:       isLocked,
  submitQuizAttempt:    submitQuiz,
};

// Force re-seed with version 2 content
initContent();
console.log('[Academy 2.0 v2] Engine ready');
})();
