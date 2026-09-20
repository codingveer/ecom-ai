#!/usr/bin/env python3
"""
Neu.Tail — Hackathon Presentation Generator (PowerPoint .pptx)
Builds a 14-slide executive & technical presentation deck in 16:9 widescreen format.
"""

import os
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

def create_deck(output_path="neu_tail_presentation.pptx"):
    prs = Presentation()
    # 16:9 widescreen
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank_layout = prs.slide_layouts[6]

    # Theme colors
    BG_DARK = RGBColor(11, 15, 25)         # #0B0F19
    BG_CARD = RGBColor(24, 32, 51)         # #182033
    BG_CARD_LIGHT = RGBColor(30, 41, 65)   # #1E2941
    ACCENT_CYAN = RGBColor(56, 189, 248)   # #38BDF8
    ACCENT_GOLD = RGBColor(245, 158, 11)   # #F59E0B
    ACCENT_EMERALD = RGBColor(16, 185, 129)# #10B981
    ACCENT_ROSE = RGBColor(244, 63, 94)    # #F43F5E
    ACCENT_PURPLE = RGBColor(168, 85, 247) # #A855F7
    TEXT_WHITE = RGBColor(248, 250, 252)   # #F8FAFC
    TEXT_MUTED = RGBColor(148, 163, 184)   # #94A3B8
    BORDER_COLOR = RGBColor(51, 65, 85)    # #334155

    def add_slide_bg(slide):
        bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
        bg.fill.solid()
        bg.fill.fore_color.rgb = BG_DARK
        bg.line.fill.background()
        return bg

    def add_header(slide, category, title, subtitle=None):
        # Category pill/tracker
        cat_box = slide.shapes.add_textbox(Inches(0.8), Inches(0.4), Inches(11.7), Inches(0.35))
        tf_c = cat_box.text_frame
        tf_c.word_wrap = True
        tf_c.margin_left = tf_c.margin_right = tf_c.margin_top = tf_c.margin_bottom = 0
        p_c = tf_c.paragraphs[0]
        p_c.text = category.upper()
        p_c.font.size = Pt(10)
        p_c.font.bold = True
        p_c.font.color.rgb = ACCENT_CYAN

        # Main Title
        title_box = slide.shapes.add_textbox(Inches(0.8), Inches(0.75), Inches(11.7), Inches(0.6))
        tf_t = title_box.text_frame
        tf_t.word_wrap = True
        tf_t.margin_left = tf_t.margin_right = tf_t.margin_top = tf_t.margin_bottom = 0
        p_t = tf_t.paragraphs[0]
        p_t.text = title
        p_t.font.size = Pt(22)
        p_t.font.bold = True
        p_t.font.color.rgb = TEXT_WHITE

        # Subtitle
        if subtitle:
            sub_box = slide.shapes.add_textbox(Inches(0.8), Inches(1.35), Inches(11.7), Inches(0.4))
            tf_s = sub_box.text_frame
            tf_s.word_wrap = True
            tf_s.margin_left = tf_s.margin_right = tf_s.margin_top = tf_s.margin_bottom = 0
            p_s = tf_s.paragraphs[0]
            p_s.text = subtitle
            p_s.font.size = Pt(12)
            p_s.font.color.rgb = TEXT_MUTED

    def add_card(slide, left, top, width, height, title=None, title_color=ACCENT_CYAN, bg_color=BG_CARD):
        card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
        card.fill.solid()
        card.fill.fore_color.rgb = bg_color
        card.line.color.rgb = BORDER_COLOR
        card.line.width = Pt(1)

        if title:
            tb = slide.shapes.add_textbox(left + Inches(0.25), top + Inches(0.2), width - Inches(0.5), Inches(0.4))
            tf = tb.text_frame
            tf.word_wrap = True
            tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
            p = tf.paragraphs[0]
            p.text = title
            p.font.size = Pt(14)
            p.font.bold = True
            p.font.color.rgb = title_color
        return card

    # =========================================================================
    # SLIDE 1: Title Slide
    # =========================================================================
    s1 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s1)

    # Accent decorative banner
    badge = s1.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(0.8), Inches(1.8), Inches(4.5), Inches(0.45))
    badge.fill.solid()
    badge.fill.fore_color.rgb = BG_CARD_LIGHT
    badge.line.color.rgb = ACCENT_CYAN
    badge.line.width = Pt(1)
    tf_b = badge.text_frame
    p_b = tf_b.paragraphs[0]
    p_b.text = "MISSION #4 — WORKING PROTOTYPE DEMO"
    p_b.font.size = Pt(10)
    p_b.font.bold = True
    p_b.font.color.rgb = ACCENT_CYAN
    p_b.alignment = PP_ALIGN.CENTER

    # Hero Title
    hero_box = s1.shapes.add_textbox(Inches(0.8), Inches(2.5), Inches(11.5), Inches(1.8))
    tf_h = hero_box.text_frame
    tf_h.word_wrap = True
    p_h1 = tf_h.paragraphs[0]
    p_h1.text = "Neu.Tail — Digital Personalisation Assistant"
    p_h1.font.size = Pt(36)
    p_h1.font.bold = True
    p_h1.font.color.rgb = TEXT_WHITE

    p_h2 = tf_h.add_paragraph()
    p_h2.text = "Edge-Native Multi-Agent Personalization with Platform-Enforced Zero-Trust Data Isolation"
    p_h2.font.size = Pt(18)
    p_h2.font.color.rgb = ACCENT_GOLD
    p_h2.space_before = Pt(10)

    # Sub details card
    c_s1 = add_card(s1, Inches(0.8), Inches(4.7), Inches(11.7), Inches(1.8), bg_color=BG_CARD)
    tb_s1 = s1.shapes.add_textbox(Inches(1.1), Inches(4.9), Inches(11.1), Inches(1.4))
    tf_s1 = tb_s1.text_frame
    tf_s1.word_wrap = True

    bullets_s1 = [
        ("Platform:", " 4 Isolated Cloudflare Workers (Services, Tools MCP, LLM Gateway, Orchestrator App)"),
        ("Architecture:", " 5 Specialized Autonomous Agents, Durable Objects for Serialized Sessions, KV Tool Registry"),
        ("Measurable Impact:", " Reduces apparel baseline return rate from 34.0% down to 20.4% via anthropometric sizing"),
        ("Hackathon Mission:", " Digital Architect Society — Mission #4 Complete Build & Verification")
    ]
    for i, (k, v) in enumerate(bullets_s1):
        p = tf_s1.paragraphs[0] if i == 0 else tf_s1.add_paragraph()
        run1 = p.add_run()
        run1.text = "•  " + k
        run1.font.bold = True
        run1.font.size = Pt(13)
        run1.font.color.rgb = ACCENT_CYAN
        run2 = p.add_run()
        run2.text = v
        run2.font.size = Pt(13)
        run2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(4)

    s1.notes_slide.notes_text_frame.text = (
        "Welcome judges. Today we are demonstrating Neu.Tail, our edge-native multi-agent assistant built for Mission #4. "
        "We are moving eCommerce personalization from generic marketing chat into an explainable, zero-trust system that "
        "actively solves fashion's greatest crisis: the 34% return rate."
    )

    # =========================================================================
    # SLIDE 2: The Core Problem & Baseline
    # =========================================================================
    s2 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s2)
    add_header(s2, "Problem Statement & Commercial Foundation", "The 34% Returns Crisis in Fashion eCommerce",
               "eCommerce profitability is bleeding from reverse logistics, driven by size mismatches and unguided discovery.")

    # 3 Metrics Cards
    m1 = add_card(s2, Inches(0.8), Inches(1.9), Inches(3.6), Inches(2.2), "34.0% Baseline Return Rate", ACCENT_ROSE)
    tb_m1 = s2.shapes.add_textbox(Inches(1.0), Inches(2.5), Inches(3.2), Inches(1.4))
    tf_m1 = tb_m1.text_frame
    tf_m1.word_wrap = True
    p = tf_m1.paragraphs[0]
    p.text = "Synthetic Universe Grounding:\n• 1,120 Order items\n• 381 Total returns\n• Exact baseline match from M3 blueprint"
    p.font.size = Pt(12)
    p.font.color.rgb = TEXT_WHITE

    m2 = add_card(s2, Inches(4.85), Inches(1.9), Inches(3.6), Inches(2.2), "58.0% Size & Fit Driven", ACCENT_GOLD)
    tb_m2 = s2.shapes.add_textbox(Inches(5.05), Inches(2.5), Inches(3.2), Inches(1.4))
    tf_m2 = tb_m2.text_frame
    tf_m2.word_wrap = True
    p = tf_m2.paragraphs[0]
    p.text = "Root Cause Breakdown:\n• 19.7 points of the 34%\n• Customers ordering multiple sizes\n• Brand grading variations"
    p.font.size = Pt(12)
    p.font.color.rgb = TEXT_WHITE

    m3 = add_card(s2, Inches(8.9), Inches(1.9), Inches(3.6), Inches(2.2), "22.0% Changed Mind / Style", ACCENT_CYAN)
    tb_m3 = s2.shapes.add_textbox(Inches(9.1), Inches(2.5), Inches(3.2), Inches(1.4))
    tf_m3 = tb_m3.text_frame
    tf_m3.word_wrap = True
    p = tf_m3.paragraphs[0]
    p.text = "Discovery Misalignment:\n• 7.5 points of the 34%\n• Uncurated recommendations\n• Mismatched price/quality expectations"
    p.font.size = Pt(12)
    p.font.color.rgb = TEXT_WHITE

    # Bottom Takeaway Card
    bot2 = add_card(s2, Inches(0.8), Inches(4.5), Inches(11.7), Inches(2.4), "The Core Engineering Hypothesis", ACCENT_EMERALD)
    tb_b2 = s2.shapes.add_textbox(Inches(1.1), Inches(5.0), Inches(11.1), Inches(1.7))
    tf_b2 = tb_b2.text_frame
    tf_b2.word_wrap = True
    points_s2 = [
        ("The AI Trap: ", "Generic chatbots increase returns by enthusiastically confirming wrong sizes based on probabilistic guesses."),
        ("The Neu.Tail Rule: ", "A size recommendation must be grounded in empirical anthropometrics, and the agent must ABSTAIN when confidence is <70%."),
        ("Commercial Goal: ", "Safely capture 13.6 percentage points of returns reduction, dropping baseline returns from 34.0% to 20.4%.")
    ]
    for i, (k, v) in enumerate(points_s2):
        p = tf_b2.paragraphs[0] if i == 0 else tf_b2.add_paragraph()
        r1 = p.add_run()
        r1.text = "✓  " + k
        r1.font.bold = True
        r1.font.size = Pt(13)
        r1.font.color.rgb = ACCENT_EMERALD
        r2 = p.add_run()
        r2.text = v
        r2.font.size = Pt(13)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    s2.notes_slide.notes_text_frame.text = (
        "We start with the empirical baseline. In our committed seed dataset, there are 1,120 items and 381 returns—exactly 34.0%. "
        "58% of these returns are tagged size_fit. Our mission is to move this number using specialized agents."
    )

    # =========================================================================
    # SLIDE 3: System Architecture (Zero-Trust)
    # =========================================================================
    s3 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s3)
    add_header(s3, "Architecture & Infrastructure", "Platform-Enforced Zero-Trust Micro-Workers",
               "Security and isolation are enforced by Cloudflare Worker capability bindings, not developer discipline.")

    # 4 Workers Columns
    col_w = Inches(2.75)
    gap = Inches(0.23)

    w_data = [
        ("Worker #1: Services", "neutail-services", ACCENT_CYAN,
         ["• SOLE database binding (D1)", "• SQL Customer 360, Products, Orders", "• Anthropometric size charts", "• Unroutable from public web"]),
        ("Worker #2: Tools (MCP)", "neutail-tools", ACCENT_PURPLE,
         ["• Cut-down MCP Access Layer", "• Declarative JSON Contracts", "• Runtime KV Tool Registry", "• Append-only Analytics Audit"]),
        ("Worker #3: LLM Gateway", "neutail-llm", ACCENT_GOLD,
         ["• Model class routing (reasoning/low_lat)", "• Cloudflare AI Gateway (caching/limits)", "• UsageCounter Durable Object", "• Graceful mock degradation"]),
        ("Worker #4: App / Agents", "neutail-app", ACCENT_EMERALD,
         ["• SessionAgent Durable Object", "• Five Specialized Agent modules", "• Inline Policy-as-code guardrails", "• ZERO database bindings"])
    ]

    for i, (title, subtitle, color, bullets) in enumerate(w_data):
        c_left = Inches(0.8) + i * (col_w + gap)
        add_card(s3, c_left, Inches(1.9), col_w, Inches(4.0), title, color)
        # Subtitle
        st_box = s3.shapes.add_textbox(c_left + Inches(0.25), Inches(2.4), col_w - Inches(0.5), Inches(0.3))
        p_st = st_box.text_frame.paragraphs[0]
        p_st.text = subtitle
        p_st.font.size = Pt(10)
        p_st.font.bold = True
        p_st.font.color.rgb = TEXT_MUTED

        tb = s3.shapes.add_textbox(c_left + Inches(0.2), Inches(2.8), col_w - Inches(0.4), Inches(2.9))
        tf = tb.text_frame
        tf.word_wrap = True
        for j, b in enumerate(bullets):
            p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
            p.text = b
            p.font.size = Pt(11)
            p.font.color.rgb = TEXT_WHITE
            p.space_before = Pt(6)

    # Callout Banner
    bot3 = add_card(s3, Inches(0.8), Inches(6.1), Inches(11.7), Inches(0.9), bg_color=BG_CARD_LIGHT)
    tb_b3 = s3.shapes.add_textbox(Inches(1.0), Inches(6.25), Inches(11.3), Inches(0.6))
    p = tb_b3.text_frame.paragraphs[0]
    r1 = p.add_run()
    r1.text = "THE ZERO-TRUST ENFORCEMENT: "
    r1.font.bold = True
    r1.font.size = Pt(11)
    r1.font.color.rgb = ACCENT_ROSE
    r2 = p.add_run()
    r2.text = "Look at the 4 wrangler configs. 3 have NO database binding. The agent Worker physically cannot run SQL or leak raw data—the platform denies it."
    r2.font.size = Pt(11)
    r2.font.color.rgb = TEXT_WHITE

    s3.notes_slide.notes_text_frame.text = (
        "Here is the architectural mic-drop for the judges: 3 of our 4 Workers have NO D1 database binding. "
        "Agents communicate exclusively via typed MCP contracts over private Service Bindings. The agent cannot leak data."
    )

    # =========================================================================
    # SLIDE 4: Orchestrator & Turn Lifecycle
    # =========================================================================
    s4 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s4)
    add_header(s4, "Orchestration & State Management", "Turn Lifecycle & Durable Session Isolation",
               "Every turn is serialised inside a Cloudflare Durable Object with zero cross-customer leakage.")

    # Left: Lifecycle Steps
    add_card(s4, Inches(0.8), Inches(1.9), Inches(6.8), Inches(5.1), "Orchestration Execution Pipeline", ACCENT_CYAN)
    tb_pipe = s4.shapes.add_textbox(Inches(1.1), Inches(2.4), Inches(6.2), Inches(4.3))
    tf_pipe = tb_pipe.text_frame
    tf_pipe.word_wrap = True

    steps = [
        ("1. Ingestion & Credit Gate: ", "WebSocket / HTTP invokes handleTurn(); turn credits verified to prevent runaway LLM costs."),
        ("2. Customer Isolation Check: ", "If customerId differs from stored session, DO wipes memory clean immediately."),
        ("3. Lazy Profiling Dispatch (S1.6): ", "If session has no segment, Profiling Agent computes affluence & writes to D1 context."),
        ("4. Intent Classification (S1.4): ", "LLM Gateway classifies intent with 4-turn dialogue context into one of five agents."),
        ("5. Agent Execution & Policy Backstop: ", "Specialized agent invokes MCP tools & evaluates inline TypeScript policy predicates."),
        ("6. Explainable Rationale & Trace: ", "Kernel assembles response with complete trace array mapped to M3 blueprint steps.")
    ]
    for i, (k, v) in enumerate(steps):
        p = tf_pipe.paragraphs[0] if i == 0 else tf_pipe.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(11)
        r1.font.color.rgb = ACCENT_CYAN
        r2 = p.add_run()
        r2.text = v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    # Right: Two-Tier Memory
    add_card(s4, Inches(7.8), Inches(1.9), Inches(4.7), Inches(5.1), "Two-Tier Memory Architecture", ACCENT_GOLD)
    tb_mem = s4.shapes.add_textbox(Inches(8.1), Inches(2.4), Inches(4.1), Inches(4.3))
    tf_mem = tb_mem.text_frame
    tf_mem.word_wrap = True

    mem_points = [
        ("Within-Session Memory: ", "Durable Object storage (ctx.storage)\n• Turn history & detected intents\n• Working customer segment\n• Last viewed SKU & category\n• Pending upsell offer state\n• Survives deploys and restarts!"),
        ("Across-Session Memory: ", "Cloudflare D1 (context_store table)\n• Long-term segment & propensity\n• Confirmed fit recommendations\n• Active subscription entitlements\n• Engagement & loyalty balance"),
        ("Strict Boundary Guarantee: ", "No customer context ever crosses IDs, even if a session identifier is accidentally reused.")
    ]
    for i, (k, v) in enumerate(mem_points):
        p = tf_mem.paragraphs[0] if i == 0 else tf_mem.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(12)
        r1.font.color.rgb = ACCENT_GOLD
        r2 = p.add_run()
        r2.text = "\n" + v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(8)

    s4.notes_slide.notes_text_frame.text = (
        "Notice the two tiers of memory. Within-session memory lives in Durable Objects—it survives deploys and cold starts. "
        "Across-session memory writes back to D1 through context service contracts. Context never leaks between customers."
    )

    # =========================================================================
    # SLIDE 5: Agent 1 - Profiling & Segmentation
    # =========================================================================
    s5 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s5)
    add_header(s5, "Agent #1: Profiling & Segmentation (M3 Sequence 1)", "Deterministic Affluence & PII Minimisation",
               "Profiles customers live on Turn 1 from observable purchase patterns without using any protected attributes.")

    # Left: The Math
    add_card(s5, Inches(0.8), Inches(1.9), Inches(5.7), Inches(5.1), "Objective Affluence Scoring Formula", ACCENT_CYAN)
    tb_form = s5.shapes.add_textbox(Inches(1.1), Inches(2.5), Inches(5.1), Inches(4.2))
    tf_form = tb_form.text_frame
    tf_form.word_wrap = True

    p = tf_form.paragraphs[0]
    p.text = "Affluence Score = 0.40 × AUP_Score + 0.35 × Premium_Share + 0.25 × Spend_Score"
    p.font.size = Pt(12)
    p.font.bold = True
    p.font.color.rgb = ACCENT_GOLD

    details_s5 = [
        ("AUP Score (40%): ", "min(1.0, Average Unit Price GBP / 120)"),
        ("Premium Share (35%): ", "min(1.0, Premium SKUs bought / 0.60)"),
        ("Spend Score (25%): ", "min(1.0, Annual Spend GBP / 3,500)"),
        ("Segment Classification: ", "• Score >= 0.62 -> Affluent (Priya C001: 0.77)\n• Score >= 0.32 -> Mid (Arjun C004: 0.44)\n• Score < 0.32 -> Value-Seeking (Aditi C002: 0.18)"),
        ("Loyalty Status: ", "Orders >= 8 & Tenure > 270d -> 'loyal'\nOrders >= 3 -> 'developing', else 'new'")
    ]
    for k, v in details_s5:
        p = tf_form.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(11)
        r1.font.color.rgb = ACCENT_CYAN
        r2 = p.add_run()
        r2.text = v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    # Right: PII Guardrail
    add_card(s5, Inches(6.8), Inches(1.9), Inches(5.7), Inches(5.1), "Inline Policy Guardrail: PII Minimisation", ACCENT_EMERALD)
    tb_pii = s5.shapes.add_textbox(Inches(7.1), Inches(2.5), Inches(5.1), Inches(4.2))
    tf_pii = tb_pii.text_frame
    tf_pii.word_wrap = True

    pii_bullets = [
        ("The Rule: ", "No raw personal identity markers (names, emails, phone numbers, addresses) may ever leave the Customer 360 boundary."),
        ("Execution Point: ", "Evaluated inline via piiMinimisation() before segment is passed to any downstream agent or LLM prompt."),
        ("Downstream Model Payload: ", "Carries ONLY derived features:\n• affluence: 'affluent' / 'value_seeking'\n• loyalty_status: 'loyal' / 'new'\n• avg_unit_price: 114.20\n• tenure_days: 340"),
        ("Audit Logging: ", "Pass/block verdict is permanently recorded in the response trace and Cloudflare Analytics Engine.")
    ]
    for i, (k, v) in enumerate(pii_bullets):
        p = tf_pii.paragraphs[0] if i == 0 else tf_pii.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(12)
        r1.font.color.rgb = ACCENT_EMERALD
        r2 = p.add_run()
        r2.text = "\n" + v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(8)

    s5.notes_slide.notes_text_frame.text = (
        "Agent 1 profiles customers without asking intrusive questions. It uses 3 weighted behavioral signals. "
        "Notice the PII guardrail: raw identifiers are scrubbed before any model call."
    )

    # =========================================================================
    # SLIDE 6: Agent 2 - Discovery & Fairness
    # =========================================================================
    s6 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s6)
    add_header(s6, "Agent #2: Discovery & Recommendation (M3 Sequence 2)", "Personalised Ranking with Algorithmic Fairness",
               "Same query returns different products for affluent vs value customers, while guaranteeing equal access.")

    # Left: Ranking Function
    add_card(s6, Inches(0.8), Inches(1.9), Inches(5.7), Inches(5.1), "Multi-Factor Ranking Objective Function", ACCENT_CYAN)
    tb_rk = s6.shapes.add_textbox(Inches(1.1), Inches(2.5), Inches(5.1), Inches(4.2))
    tf_rk = tb_rk.text_frame
    tf_rk.word_wrap = True

    p = tf_rk.paragraphs[0]
    p.text = "Score = Relevance + (TierWeight × 0.5) + (Rating × 0.35) + StockBoost + FitBoost - (ReturnRate × 1.2)"
    p.font.size = Pt(11)
    p.font.bold = True
    p.font.color.rgb = ACCENT_GOLD

    rk_bullets = [
        ("Affluent Tier Weights: ", "Premium (3.0x), Core (1.6x), Private Label (0.4x), Value (0.2x)"),
        ("Value-Seeking Tier Weights: ", "Value (3.0x), Private Label (2.6x), Core (1.2x), Premium (0.3x)"),
        ("Fit-Aware Weighting: ", "+0.6 boost if customer's known size is currently in stock!"),
        ("Return Rate Penalty: ", "Directly penalizes SKUs with high historical return rates (-1.2x return_rate)."),
        ("Dual Search Mode: ", "Fast lexical default + Opt-in semantic search with Cloudflare Vectorize (BGE-base-en-v1.5).")
    ]
    for k, v in rk_bullets:
        p = tf_rk.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(11)
        r1.font.color.rgb = ACCENT_CYAN
        r2 = p.add_run()
        r2.text = v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    # Right: Fairness Guardrail
    add_card(s6, Inches(6.8), Inches(1.9), Inches(5.7), Inches(5.1), "Diversity Floor & Fairness Guardrail", ACCENT_ROSE)
    tb_fair = s6.shapes.add_textbox(Inches(7.1), Inches(2.5), Inches(5.1), Inches(4.2))
    tf_fair = tb_fair.text_frame
    tf_fair.word_wrap = True

    fair_bullets = [
        ("The Core Motto: ", "\"Ranking differs, access does not.\""),
        ("Criterion 1: Identical Eligibility: ", "Candidate pool size must be 100% identical across segments (zero catalog redlining)."),
        ("Criterion 2: Diversity Floor: ", "Agent enforces at least two price tiers in the top 10 to prevent algorithmic exclusion."),
        ("Criterion 3: Neutral Comparator: ", "Personalized rankings are verified against a neutral sorting (relevance & rating only)."),
        ("Live Demo Toggle (unsafeRanking): ", "Sending unsafeRanking: true disables the diversity floor; the fairness guardrail visibly BLOCKS and serves neutral ranking!")
    ]
    for i, (k, v) in enumerate(fair_bullets):
        p = tf_fair.paragraphs[0] if i == 0 else tf_fair.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(11)
        r1.font.color.rgb = ACCENT_ROSE
        r2 = p.add_run()
        r2.text = "\n" + v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    s6.notes_slide.notes_text_frame.text = (
        "Agent 2 demonstrates discovery personalization. Same query, different results. "
        "Notice our fairness backstop: if personalization tries to isolate a shopper in a single tier, the guardrail blocks."
    )

    # =========================================================================
    # SLIDE 7: Agent 3 - Size & Fit Personalisation
    # =========================================================================
    s7 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s7)
    add_header(s7, "Agent #3: Size & Fit Personalisation (M3 Sequence 3)", "Anthropometric Sizing Science & The Abstain Rule",
               "The direct lever on 58% of the returns crisis, combining real data with strict consent.")

    # 3 Horizontal Cards
    c1 = add_card(s7, Inches(0.8), Inches(1.9), Inches(3.6), Inches(5.1), "1. Strict Consent Gate", ACCENT_GOLD)
    tb_c1 = s7.shapes.add_textbox(Inches(1.0), Inches(2.5), Inches(3.2), Inches(4.2))
    tf_c1 = tb_c1.text_frame
    tf_c1.word_wrap = True
    p = tf_c1.paragraphs[0]
    p.text = "Body measurements are highly sensitive data.\n\n• Checked via fitConsent() before reading any metrics.\n\n• If consent_fit = false, measurements are NOT read.\n\n• Immediately degrades to generic size chart.\n\n• Zero unauthorized biometric processing."
    p.font.size = Pt(12)
    p.font.color.rgb = TEXT_WHITE

    c2 = add_card(s7, Inches(4.85), Inches(1.9), Inches(3.6), Inches(5.1), "2. 120k Anthropometrics", ACCENT_CYAN)
    tb_c2 = s7.shapes.add_textbox(Inches(5.05), Inches(2.5), Inches(3.2), Inches(4.2))
    tf_c2 = tb_c2.text_frame
    tf_c2.word_wrap = True
    p = tf_c2.paragraphs[0]
    p.text = "Grounded on 120,000 real sizing records (fitment_dat.csv):\n\n• Category distribution: height/weight averages & stdevs.\n\n• Normalised Z-score distance:\n  Delta = (|H - avg_H| / std_H + |W - avg_W| / std_W) / 2\n\n• Brand cut compensation:\n  (runs_small, runs_large, relaxed fit)."
    p.font.size = Pt(12)
    p.font.color.rgb = TEXT_WHITE

    c3 = add_card(s7, Inches(8.9), Inches(1.9), Inches(3.6), Inches(5.1), "3. The 70% Abstain Rule", ACCENT_EMERALD)
    tb_c3 = s7.shapes.add_textbox(Inches(9.1), Inches(2.5), Inches(3.2), Inches(4.2))
    tf_c3 = tb_c3.text_frame
    tf_c3.word_wrap = True
    p = tf_c3.paragraphs[0]
    p.text = "Confidence Scorecard:\n• Base: 45 pts\n• +5 pts per kept purchase\n• +20 pts for low Z-distance\n• -12 pts per prior return with brand\n\nTHE COMMERCIAL RULE:\nIf confidence < 70% -> ABSTAIN!\nWrong recommendations create returns. Silence protects margin."
    p.font.size = Pt(12)
    p.font.color.rgb = TEXT_WHITE

    s7.notes_slide.notes_text_frame.text = (
        "Agent 3 is our direct lever on returns. We don't use fake centimeter offsets—we derive sizing from 120k real rows. "
        "Crucially, if confidence is below 70%, the agent abstains. No guessing."
    )

    # =========================================================================
    # SLIDE 8: Agents 4 & 5 - Upsell & Loyalty Handoff
    # =========================================================================
    s8 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s8)
    add_header(s8, "Agents #4 & #5: Monetisation & Loyalty (M3 Sequences 4 & 5)", "Value-Timed Upsell & Cross-Agent Shared Memory",
               "Proving cross-agent collaboration: the Loyalty Agent reads the entitlement written by the Upsell Agent.")

    # Left: Agent 4 Upsell
    add_card(s8, Inches(0.8), Inches(1.9), Inches(5.7), Inches(5.1), "Agent #4: Styling Advisory Upsell", ACCENT_GOLD)
    tb_u = s8.shapes.add_textbox(Inches(1.1), Inches(2.5), Inches(5.1), Inches(4.2))
    tf_u = tb_u.text_frame
    tf_u.word_wrap = True

    u_bullets = [
        ("Moment of Demonstrated Value: ", "Free Styling Advisory sessions are tracked; offer fires ONLY at the 3rd completed session (Meera C003)."),
        ("Policy-Governed Frequency Cap: ", "upsellFrequencyCap() enforces 7-day cooldown; permanently suppresses after 2 declined offers. Agent cannot overrule policy!"),
        ("Offer Presentation: ", "Styling Plus for £4.99/mo with AI concierge and 2x loyalty accrual multiplier."),
        ("Entitlement Write: ", "Upon customer 'accept', writes tier: 'plus' to persistent D1 context_store.")
    ]
    for i, (k, v) in enumerate(u_bullets):
        p = tf_u.paragraphs[0] if i == 0 else tf_u.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(12)
        r1.font.color.rgb = ACCENT_GOLD
        r2 = p.add_run()
        r2.text = "\n" + v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(8)

    # Right: Agent 5 Loyalty
    add_card(s8, Inches(6.8), Inches(1.9), Inches(5.7), Inches(5.1), "Agent #5: Cross-Agent Loyalty Accrual", ACCENT_CYAN)
    tb_l = s8.shapes.add_textbox(Inches(7.1), Inches(2.5), Inches(5.1), Inches(4.2))
    tf_l = tb_l.text_frame
    tf_l.word_wrap = True

    l_bullets = [
        ("The Cross-Agent Handshake: ", "When loyalty balance or accrual is checked, Loyalty Agent calls subscription.get via MCP tool gateway."),
        ("Entitlement Read: ", "Reads the 'plus' subscription tier written by Agent #4 in the previous turn!"),
        ("Dynamic Multiplier Application: ", "Automatically upgrades point multiplier from 1x to 2x (or 3x for Premium)."),
        ("Gamification & Liability Tracking: ", "Computes points to next tier and releases financial points liability upon redemption.")
    ]
    for i, (k, v) in enumerate(l_bullets):
        p = tf_l.paragraphs[0] if i == 0 else tf_l.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(12)
        r1.font.color.rgb = ACCENT_CYAN
        r2 = p.add_run()
        r2.text = "\n" + v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(8)

    s8.notes_slide.notes_text_frame.text = (
        "The hackathon brief permitted selecting either Upsell or Loyalty. We built BOTH because the handoff between them "
        "is the ultimate proof of cross-agent shared memory. Loyalty reads what Upsell wrote."
    )

    # =========================================================================
    # SLIDE 9: Infrastructure Gateways (MCP & LLM)
    # =========================================================================
    s9 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s9)
    add_header(s9, "Objective 2 Compliance", "Cut-Down MCP Tool Gateway & Unified LLM Gateway",
               "Zero hardcoded endpoints in agents; strict schema enforcement and provider interoperability.")

    # Left: Tool Gateway
    add_card(s9, Inches(0.8), Inches(1.9), Inches(5.7), Inches(5.1), "Cut-Down MCP Tool Gateway (Worker #2)", ACCENT_PURPLE)
    tb_tg = s9.shapes.add_textbox(Inches(1.1), Inches(2.5), Inches(5.1), Inches(4.2))
    tf_tg = tb_tg.text_frame
    tf_tg.word_wrap = True

    tg_bullets = [
        ("Explicit Tool Contracts: ", "Each tool declares: name, version, purpose, allowed_agents, input_schema, output_schema, transport."),
        ("Permission Enforcement: ", "If Discovery attempts to call loyalty.accrue -> Gateway returns 403 permission_denied."),
        ("Hot-Installation at Runtime: ", "Contracts live in Cloudflare KV. Installing catalogue.trending.get increments registry from 22 to 23 tools with ZERO redeploy!"),
        ("Immutable Tool Audit: ", "Invocations streamed to Cloudflare Analytics Engine dataset.")
    ]
    for i, (k, v) in enumerate(tg_bullets):
        p = tf_tg.paragraphs[0] if i == 0 else tf_tg.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(12)
        r1.font.color.rgb = ACCENT_PURPLE
        r2 = p.add_run()
        r2.text = "\n" + v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(8)

    # Right: LLM Gateway
    add_card(s9, Inches(6.8), Inches(1.9), Inches(5.7), Inches(5.1), "Enterprise LLM Gateway (Worker #3)", ACCENT_GOLD)
    tb_lg = s9.shapes.add_textbox(Inches(7.1), Inches(2.5), Inches(5.1), Inches(4.2))
    tf_lg = tb_lg.text_frame
    tf_lg.word_wrap = True

    lg_bullets = [
        ("Model Class Routing: ", "Agents request a model class ('reasoning' or 'low_latency'), NEVER a provider name or raw model identifier."),
        ("Provider Interoperability: ", "Config switch toggles between Mock, OpenAI, Anthropic, and Workers AI with zero agent code change."),
        ("Cloudflare AI Gateway: ", "Universal upstream caching, unified request logging, rate-limiting, and analytics."),
        ("Graceful Degradation: ", "Catches provider timeouts/errors and gracefully degrades to mock Complete with degraded: true flag."),
        ("Token Accounting: ", "UsageCounter Durable Object maintains globally consistent token spend.")
    ]
    for i, (k, v) in enumerate(lg_bullets):
        p = tf_lg.paragraphs[0] if i == 0 else tf_lg.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(12)
        r1.font.color.rgb = ACCENT_GOLD
        r2 = p.add_run()
        r2.text = "\n" + v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    s9.notes_slide.notes_text_frame.text = (
        "Objective 2 asks for a cut-down MCP layer and an LLM gateway. "
        "Our tools live in KV—we can install new tools live with curl. Our LLM gateway abstracts all provider models."
    )

    # =========================================================================
    # SLIDE 10: Unit Economics & Business Outcome
    # =========================================================================
    s10 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s10)
    add_header(s10, "Business Outcome & Return Economics", "Mathematical Return Reduction: 34.0% -> 20.4%",
               "Computed directly from live synthetic data via GET /outcome with transparent unit economics.")

    # Left: The Table / Decomposition
    add_card(s10, Inches(0.8), Inches(1.9), Inches(6.8), Inches(5.1), "Live Corpus Outcome Decomposition", ACCENT_CYAN)
    tb_dec = s10.shapes.add_textbox(Inches(1.1), Inches(2.5), Inches(6.2), Inches(4.2))
    tf_dec = tb_dec.text_frame
    tf_dec.word_wrap = True

    dec_data = [
        ("Baseline Return Rate: ", "34.0% across 1,120 items (381 returns)"),
        ("• Size & Fit Lever: ", "19.7 pts × 65% reachable × 75% captured = -9.6 pp\n(Delivered by Agent #3 Sizing & Abstain Policy)"),
        ("• Changed Mind Lever: ", "7.5 pts × 100% reachable × 40% captured = -3.0 pp\n(Delivered by Discovery relevance + AR virtual try-on)"),
        ("• Quality Defect Lever: ", "4.1 pts × 100% reachable × 25% captured = -1.0 pp\n(Delivered by Supplier Quality Feedback Loop)"),
        ("• Other / Damaged: ", "2.7 pts — no claim made (0.0 pp)"),
        ("PROJECTED RETURN RATE: ", "20.4% (-13.6 percentage points removed)")
    ]
    for i, (k, v) in enumerate(dec_data):
        p = tf_dec.paragraphs[0] if i == 0 else tf_dec.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(11)
        r1.font.color.rgb = ACCENT_GOLD if "PROJECTED" in k or "Baseline" in k else ACCENT_CYAN
        r2 = p.add_run()
        r2.text = v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    # Right: The Honest Architect Stance
    add_card(s10, Inches(7.8), Inches(1.9), Inches(4.7), Inches(5.1), "The 'Honest Architect' Reality", ACCENT_EMERALD)
    tb_hon = s10.shapes.add_textbox(Inches(8.1), Inches(2.5), Inches(4.1), Inches(4.2))
    tf_hon = tb_hon.text_frame
    tf_hon.word_wrap = True

    hon_bullets = [
        ("Brief Target Band: ", "10% to 15% return rate."),
        ("The Architectural Reality: ", "Personalisation & sizing AI alone remove 13.6 percentage points, reaching 20.4%."),
        ("Why Claiming 10% is False: ", "Anyone claiming AI alone reaches 10% in fashion is ignoring retail physics. Sizing AI cannot fix fabric snags or buyer remorse."),
        ("What Closes the Remaining Gap: ", "Assortment rationalization, supplier remediation, and commercial policy changes (e.g. charging return fees for multi-size brackets)."),
        ("The Winning Pitch: ", "Defensible engineering and commercial honesty beat hand-waving claims every single time.")
    ]
    for i, (k, v) in enumerate(hon_bullets):
        p = tf_hon.paragraphs[0] if i == 0 else tf_hon.add_paragraph()
        r1 = p.add_run()
        r1.text = k
        r1.font.bold = True
        r1.font.size = Pt(12)
        r1.font.color.rgb = ACCENT_EMERALD
        r2 = p.add_run()
        r2.text = "\n" + v
        r2.font.size = Pt(11)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    s10.notes_slide.notes_text_frame.text = (
        "Here is where we win the technical judges: our return reduction is modeled from the live database. "
        "We also tell the truth: AI alone drops returns to 20.4%. Closing to 10% requires retail policy changes."
    )

    # =========================================================================
    # SLIDE 11: Deviations from Mission #3 Blueprint
    # =========================================================================
    s11 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s11)
    add_header(s11, "Objective 3 Compliance", "Eight Deliberate Blueprint Deviations",
               "Calling out where the build improved on the M3 blueprint shows engineering maturity.")

    # 4 Cards Layout (2x2 Grid)
    gw = Inches(5.7)
    gh = Inches(2.4)

    devs = [
        ("1. Durable Objects over Memory Maps", ACCENT_CYAN,
         "Blueprint named Context Manager. We replaced single-process Maps with Cloudflare Durable Objects. Sessions are serialised, durable across deploys, and impossible to leak across customers."),
        ("2. Synchronous Bindings over Kafka", ACCENT_GOLD,
         "Blueprint proposed Kafka bus. We substituted zero-latency Worker Service Bindings. Async paths are preserved without Kafka operational overhead at the edge."),
        ("3. TypeScript Predicates over Rego/OPA", ACCENT_EMERALD,
         "Policy-as-code is implemented as pure TypeScript predicates. Same guarantee: evaluated inline, agent cannot overrule, and trace is permanently recorded."),
        ("4. Both Monetization Agents Built", ACCENT_PURPLE,
         "Brief permitted selecting Upsell OR Loyalty. We built both to definitively prove cross-agent memory handoff (Loyalty reads Upsell's written entitlement for 2x multiplier).")
    ]

    for i, (title, color, desc) in enumerate(devs):
        x = Inches(0.8) if i % 2 == 0 else Inches(6.8)
        y = Inches(1.9) if i < 2 else Inches(4.6)
        add_card(s11, x, y, gw, gh, title, color)
        tb = s11.shapes.add_textbox(x + Inches(0.25), y + Inches(0.6), gw - Inches(0.5), gh - Inches(0.8))
        tf = tb.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = desc
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_WHITE

    s11.notes_slide.notes_text_frame.text = (
        "Objective 3 explicitly asks to call out deviations. Volunteering these before judges ask shows senior engineering judgment. "
        "Every deviation was an architectural upgrade."
    )

    # =========================================================================
    # SLIDE 12: 8-Minute Live Demo Cue Sheet
    # =========================================================================
    s12 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s12)
    add_header(s12, "Live Demo Playbook", "The 8-Minute Winning Rehearsal Script",
               "A tightly scripted live run covering all five functionalities, guardrails, and gateway tools.")

    # 2 Columns of Beats
    add_card(s12, Inches(0.8), Inches(1.9), Inches(5.7), Inches(5.1), "Part 1: The Personalisation Story", ACCENT_CYAN)
    tb_p1 = s12.shapes.add_textbox(Inches(1.1), Inches(2.4), Inches(5.1), Inches(4.3))
    tf_p1 = tb_p1.text_frame
    tf_p1.word_wrap = True

    b1_items = [
        ("Beat 0 (30s): Baseline Grounding", "curl return-rate -> 34.0% across 1,120 items."),
        ("Beat 1 (60s): Affluent Customer (Priya)", "'show me an occasion dress' -> Profiling fires, 0.77 score, premium ranking."),
        ("Beat 2 (60s): Value Customer (Aditi)", "SAME query -> Value/core ranking. 'Ranking differs, access does not.'"),
        ("Beat 3 (45s): Fit with History", "'what size should I get?' -> Size M at 99% confidence from 120k dataset Z-score."),
        ("Beat 4 (45s): Fit without History", "Aditi asks same question -> Consent passes, history missing -> AGENT ABSTAINS.")
    ]
    for i, (k, v) in enumerate(b1_items):
        p = tf_p1.paragraphs[0] if i == 0 else tf_p1.add_paragraph()
        r1 = p.add_run()
        r1.text = k + "\n"
        r1.font.bold = True
        r1.font.size = Pt(11)
        r1.font.color.rgb = ACCENT_CYAN
        r2 = p.add_run()
        r2.text = v
        r2.font.size = Pt(10)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    add_card(s12, Inches(6.8), Inches(1.9), Inches(5.7), Inches(5.1), "Part 2: Governance & Platform", ACCENT_GOLD)
    tb_p2 = s12.shapes.add_textbox(Inches(7.1), Inches(2.4), Inches(5.1), Inches(4.3))
    tf_p2 = tb_p2.text_frame
    tf_p2.word_wrap = True

    b2_items = [
        ("Beat 5 (60s): Demonstrated Value Upsell", "Meera (3rd session) -> Styling Plus offer (£4.99/mo). Reply: 'accept'."),
        ("Beat 6 (45s): Loyalty Memory Handoff", "'how many points did I earn?' -> Reads entitlement -> 2x multiplier applied!"),
        ("Beat 7 (45s): Fairness Guardrail Block", "unsafeRanking=true -> Diversity floor skips -> Fairness guardrail BLOCKS!"),
        ("Beat 8 (60s): MCP Permissions & Hot-Load", "Discovery calls loyalty -> 403 denied. Install trending tool -> 22 to 23 tools live."),
        ("Beat 9-10 (60s): Interop & Outcome", "Switch LLM provider with zero code change -> curl /outcome -> 34% to 20.4%.")
    ]
    for i, (k, v) in enumerate(b2_items):
        p = tf_p2.paragraphs[0] if i == 0 else tf_p2.add_paragraph()
        r1 = p.add_run()
        r1.text = k + "\n"
        r1.font.bold = True
        r1.font.size = Pt(11)
        r1.font.color.rgb = ACCENT_GOLD
        r2 = p.add_run()
        r2.text = v
        r2.font.size = Pt(10)
        r2.font.color.rgb = TEXT_WHITE
        p.space_before = Pt(6)

    s12.notes_slide.notes_text_frame.text = (
        "Follow this exact 10-beat cue sheet during the live demo. It guarantees every hackathon objective is hit within 8 minutes."
    )

    # =========================================================================
    # SLIDE 13: Anticipated Judge Q&A
    # =========================================================================
    s13 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s13)
    add_header(s13, "Judge Defense Cheat Sheet", "Anticipated Technical Questions & Winning Answers",
               "Pre-empting tough questions with platform evidence and architectural proofs.")

    # 3 Q&A Cards
    qa_list = [
        ("Q1: 'Can an agent perform SQL injection or dump customer data?'", ACCENT_ROSE,
         "Answer: Platform capability denial. Look at wrangler.jsonc—3 of the 4 Workers have NO D1 binding. The agent runtime does not possess a database handle. Platform security beats prompt instructions."),
        ("Q2: 'Does affluence ranking discriminate against lower-income shoppers?'", ACCENT_CYAN,
         "Answer: 'Ranking differs, access does not.' Our fairness guardrail mathematically guarantees identical candidate pool eligibility and enforces multi-tier diversity. Any exclusion triggers an automatic fallback to neutral ranking."),
        ("Q3: 'What happens if OpenAI or Anthropic goes down during shopping?'", ACCENT_EMERALD,
         "Answer: Graceful edge degradation. The LLM Gateway catches upstream timeouts, falls back to deterministic mock output with degraded: true, and never breaks the customer shopping session.")
    ]

    for i, (q, color, a) in enumerate(qa_list):
        y = Inches(1.9) + i * Inches(1.7)
        add_card(s13, Inches(0.8), y, Inches(11.7), Inches(1.5), q, color)
        tb = s13.shapes.add_textbox(Inches(1.1), y + Inches(0.5), Inches(11.1), Inches(0.9))
        tf = tb.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = a
        p.font.size = Pt(11)
        p.font.color.rgb = TEXT_WHITE

    s13.notes_slide.notes_text_frame.text = (
        "Keep these three answers in mind during Q&A. They address security, ethics, and reliability head-on."
    )

    # =========================================================================
    # SLIDE 14: Summary & Conclusion
    # =========================================================================
    s14 = prs.slides.add_slide(blank_layout)
    add_slide_bg(s14)
    add_header(s14, "Executive Summary", "Why Neu.Tail Sets the Standard for Agentic Retail",
               "A complete, working, edge-native personalization assistant grounded in real unit economics.")

    # 3 Pillars Card
    p1 = add_card(s14, Inches(0.8), Inches(1.9), Inches(3.6), Inches(4.9), "1. Real Engineering", ACCENT_CYAN)
    tb_p1 = s14.shapes.add_textbox(Inches(1.0), Inches(2.5), Inches(3.2), Inches(4.0))
    tf_p1 = tb_p1.text_frame
    tf_p1.word_wrap = True
    p = tf_p1.paragraphs[0]
    p.text = "• 4 Isolated Cloudflare Workers\n• Platform zero-trust data model\n• Durable Objects for session turns\n• KV-backed runtime MCP tool contracts\n• AI Gateway caching & rate-limiting\n• Braintrust automated prompt evals"
    p.font.size = Pt(12)
    p.font.color.rgb = TEXT_WHITE

    p2 = add_card(s14, Inches(4.85), Inches(1.9), Inches(3.6), Inches(4.9), "2. Ethical & Governed", ACCENT_GOLD)
    tb_p2 = s14.shapes.add_textbox(Inches(5.05), Inches(2.5), Inches(3.2), Inches(4.0))
    tf_p2 = tb_p2.text_frame
    tf_p2.word_wrap = True
    p = tf_p2.paragraphs[0]
    p.text = "• Inline PII Minimisation\n• Biometric sizing consent gate\n• Mathematical fairness guardrails\n• Single-tier exclusion prevention\n• 70% confidence abstain rule\n• Append-only Analytics Engine audit"
    p.font.size = Pt(12)
    p.font.color.rgb = TEXT_WHITE

    p3 = add_card(s14, Inches(8.9), Inches(1.9), Inches(3.6), Inches(4.9), "3. Commercial Impact", ACCENT_EMERALD)
    tb_p3 = s14.shapes.add_textbox(Inches(9.1), Inches(2.5), Inches(3.2), Inches(4.0))
    tf_p3 = tb_p3.text_frame
    tf_p3.word_wrap = True
    p = tf_p3.paragraphs[0]
    p.text = "• 34.0% -> 20.4% return rate reduction\n• 13.6 percentage points removed\n• Value-timed service upsell (£4.99/mo)\n• 2x loyalty accrual cross-agent loop\n• Honest retail economic breakdown\n• Production-ready on Cloudflare"
    p.font.size = Pt(12)
    p.font.color.rgb = TEXT_WHITE

    s14.notes_slide.notes_text_frame.text = (
        "Thank you. Neu.Tail proves that multi-agent systems in retail can be secure, fair, explainable, and profitable. "
        "We are ready for questions."
    )

    # Save presentation
    prs.save(output_path)
    print(f"Presentation saved successfully to: {output_path}")

if __name__ == "__main__":
    create_deck()
