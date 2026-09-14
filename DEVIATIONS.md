# Where the build deviated from the Mission #3 design, and why

Objective 3 asks for this explicitly. Volunteering it is stronger than being asked.

## 1. Vector database replaced by lexical retrieval
**Design:** S12 step 7 — semantic candidate retrieval from a Vector DB.
**Build:** scored lexical match over title, category, style tags, material and colour.
**Why:** the personalisation claim rests on how candidates are *ranked* by segment, not
on how they are retrieved. An embedding index would have cost a day and moved nothing
the mission grades. The retrieval call sits behind the `catalogue.search` contract, so
swapping in a vector store changes one service implementation and no agent code.

## 2. Event bus replaced by synchronous dispatch
**Design:** S6 / S23 — Kafka event bus feeding the Intent Router.
**Build:** service-binding call into the Session Durable Object; events are recorded to
the event store after the fact.
**Why:** the async paths in the M3 design (Upsell at 800 ms, Loyalty at 2 s) are stated
as non-blocking precisely so they can be deferred. The trace still shows the four
orchestration stages in order. Cloudflare Queues would close this properly and is the
obvious next step, but it adds a moving part the mission does not grade.

## 3. Policy-as-code is TypeScript predicates, not Rego
**Design:** S9 — declarative rules in an OPA/Rego style.
**Build:** `src/app/policy.ts`, four pure predicates returning a verdict plus a reason.
**Why:** the property that matters is that policies are evaluated inline, separately from
agent logic, and that an agent cannot overrule one. That holds here. The rules are pure
functions over agent output, so lifting them into OPA is mechanical.

## 4. Fairness guardrail restated
**Design:** S9/S12 — block ranking decisions "outside an approved, auditable band".
**Build:** two concrete rules — no price tier may be excluded from a segment's top 10,
and the candidate eligibility pool must be identical across segments.
**Why:** "band" was not operationalised in the design. A pure overlap-with-neutral metric
punishes legitimate personalisation, which is the wrong behaviour. The rule the design
actually argues for is *different ranges, never different access* — that is what is
implemented, and it is measurable.

The agent also applies its own diversity floor before the guardrail sees the result. The
guardrail is the backstop, not the mechanism. Send `unsafeRanking: true` on a message to
disable the floor and watch the guardrail block and fall back to a neutral ranking.

## 5. Fit confidence is a scorecard, not a learned model
**Design:** S13 — recommended size with a confidence score, abstain below 70%.
**Build:** additive scorecard over observation depth, grading distance against the brand
chart, brand cut, and prior fit-related returns with that brand.
**Why:** no training data exists in a seeded corpus, and a learned model here would be
theatre. The scorecard is inspectable, which is what "surface the reasoning" asks for.
The threshold and abstain behaviour are exactly as designed.

## 6. Both monetisation agents built
**Brief:** "Service Upsell or Loyalty Accrual (select one)" on page 1, but Objective 3
asks for five functionalities end to end.
**Build:** both, with Upsell as the nominated one.
**Why:** the entitlement written by the Upsell Agent is what the Loyalty Agent reads for
its 2× multiplier. That handoff is the clearest available proof of cross-agent shared
context, and dropping either half would have removed it.

## 7. Profiling is computed live, not pre-seeded
**Brief:** segmentation "can happen offline/pre-seeded".
**Build:** computed on first turn of each session from service data, then cached in
session context and written to long-term context.
**Why:** it costs one extra service call and makes the segmentation logic visible in the
trace instead of being a column in the database.

## 8. Platform substitutions on Cloudflare
These are deliberate and, in each case, stronger than what they replace.

- **Sessions are Durable Objects, not an in-process map.** Turns for one session are
  serialised by the runtime, state is durable across deploys, and context cannot leak
  between customers. The M3 design named a Context Manager; a DO per session is a more
  faithful implementation of it than a shared map ever was.
- **Model logging, caching and rate limiting are AI Gateway**, not code we wrote. The
  gateway Worker keeps only the versioned prompt registry and the class-to-model routing
  policy — the parts that are genuinely ours.
- **Tool audit is Analytics Engine**, not a JSONL file. Append-only and queryable, which
  is closer to the "immutable audit" the M3 governance slide asks for, though still not
  tamper-evident.
- **The tool registry is KV**, so runtime installation is a real write to a real store.
- **Isolation is enforced by bindings, not imports.** Three of the four Workers have no
  D1 binding. The agents Worker cannot reach the database even if an agent tried.

## 9. Not built
- AR try-on and the store/POS channel — front-stage surfaces, outside the agent layer.
- Tamper-evident audit — Analytics Engine is append-only but not cryptographically verifiable.
- Model registry and drift monitoring — named in the M3 platform, no prototype surface.
- Identity resolution across two source records — the seed has one customer master, so
  the merge step in S11 is represented but not exercised.
