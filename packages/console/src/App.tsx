import { useEffect, useMemo, useState } from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import type { ChatMessage, TurnTrace } from './ChatMessage';

const PERSONAS = [
  { id: 'C001', name: 'Priya', note: 'affluent, loyal, rich fit history' },
  { id: 'C002', name: 'Aditi', note: 'value-seeking, new, no fit consent' },
  { id: 'C003', name: 'Meera', note: 'free tier, third styling session' },
  { id: 'C004', name: 'Arjun', note: 'menswear department, mid affluence' },
];
const SUGGESTIONS = [
  'show me an occasion dress',
  'what size should I get?',
  'tell me about the styling advisory plan',
  'how many points did I earn?',
];

const SESSION_STORAGE_KEY = 'neutail-console-session';

function newSessionId(customerId: string) {
  return 'web-' + customerId + '-' + Date.now();
}

/**
 * Resolves the (customerId, sessionId) pair used on first mount, and does it
 * exactly once per page load, at module-evaluation time - not inside a
 * `useState` lazy initializer.
 *
 * Two reasons, both discovered by hitting the crash live rather than by
 * inspection:
 *
 * 1. `useState(() => newSessionId('C001'))` is an IMPURE initializer (it
 *    embeds `Date.now()`). `useAgentChat` fetches the AIChatAgent's message
 *    history via React's `use()` on a promise keyed by the agent name
 *    (`agents/dist/chat/react.js`'s `doGetInitialMessages`/`requestCache`).
 *    Before the first commit, React can re-invoke a component's hooks - lazy
 *    initializers included - on each Suspense retry of that `use()` call. An
 *    impure initializer hands `useAgent` a DIFFERENT session id on every
 *    retry, which changes the cache key, which produces a brand-new,
 *    never-yet-settled promise every time - so the retry never converges, and
 *    React hard-crashes ("An unknown Component is an async Client Component
 *    ... Only Server Components can be async") once its internal retry
 *    budget (100 attempts) is exhausted. This reproduced deterministically:
 *    a literal/session-stable id never crashed; a freshly-`Date.now()`-computed
 *    one crashed every time, regardless of StrictMode. Resolving the id once,
 *    outside the render/retry cycle, removes the impurity entirely.
 * 2. Even ignoring the crash, a per-mount `Date.now()` id can never satisfy
 *    "reload the page and the transcript is still there": a full reload runs
 *    this module fresh, so a plain lazy initializer would hand every reload a
 *    brand-new (empty) session. Persisting the id in `sessionStorage` - and
 *    only minting a new one when nothing is stored yet - is what makes reload
 *    actually preserve history, while `switchCustomer` below still starts a
 *    deliberately fresh session (mint + overwrite storage) so the visible
 *    pane clears as the spec requires.
 */
function loadInitialSession(): { customerId: string; sessionId: string } {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore - storage unavailable or corrupt, fall through to a fresh session */ }
  const fresh = { customerId: 'C001', sessionId: newSessionId('C001') };
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(fresh)); } catch { /* ignore */ }
  return fresh;
}
const INITIAL_SESSION = loadInitialSession();

function traceOf(message: ChatMessage): TurnTrace | undefined {
  const part = message.parts.find(p => p.type === 'data-trace');
  return part && 'data' in part ? (part.data as TurnTrace) : undefined;
}

/**
 * Everything that talks to a single SessionAgent instance. Mounted with
 * `key={sessionId}` by `App` below, so switching customers - which always
 * mints a brand-new `sessionId` - fully unmounts and remounts this component
 * instead of transitioning `useAgent`'s `name` in place.
 *
 * This isn't cosmetic. `useAgent` (`agents/react`) wraps `usePartySocket`,
 * which replaces its underlying socket via an effect (one render after the
 * `name` prop changes) rather than synchronously - so for one transitional
 * render, `agent.name` already reflects the NEW session while
 * `agent.getHttpUrl()` still returns the OLD one. `useAgentChat`
 * (`agents/dist/chat/react.js`) fetches `get-messages` keyed by the new
 * `agent.name` but against that stale URL, then permanently caches the OLD
 * session's transcript under the NEW session's cache key
 * (`doGetInitialMessages`'s module-level `requestCache`) - so the chat pane
 * kept showing the previous customer's messages after a switch, confirmed by
 * instrumenting the library directly (a `Chat` instance recreated with the
 * new id, but seeded with the old messages). A `key`-forced remount sidesteps
 * this entirely: a freshly mounted instance has no "previous" identity to lag
 * behind, so `agent.name` and `agent.getHttpUrl()` are consistent from its
 * very first render.
 */
function ChatSession({ customerId, sessionId }: { customerId: string; sessionId: string }) {
  const [input, setInput] = useState('');
  const [memorySummary, setMemorySummary] = useState('');

  const agent = useAgent({ agent: 'SessionAgent', name: sessionId });
  const { messages, sendMessage, status } = useAgentChat<unknown, ChatMessage>({
    agent,
    body: () => ({ customerId }),
  });

  // Mount-time-only indicator that long-term context exists on file, before the first
  // message. A fresh session's own turns/working are always empty at mount (sessions are
  // minted fresh on load/switch - see loadInitialSession/switchCustomer above), so this
  // can never reflect the current turn; the per-turn meter below is computed from
  // `lastTrace` instead, not from this stale fetch.
  useEffect(() => {
    fetch(`/session/${sessionId}`)
      .then(r => r.json())
      .then((d: any) => {
        setMemorySummary(
          `session turns ${d.turns?.length ?? 0} · long-term keys ${Object.keys(d.working ?? {}).length}`,
        );
      })
      .catch(() => setMemorySummary(''));
  }, [sessionId]);

  function send(text: string) {
    if (!text.trim()) return;
    sendMessage({ text });
    setInput('');
  }

  const totals = useMemo(() => {
    const t = { tools: 0, llm: 0, tokens: 0, policy: 0 };
    for (const m of messages) {
      const tr = traceOf(m);
      if (!tr) continue;
      for (const s of tr.trace) {
        if (s.stage === 'tool') t.tools++;
        if (s.stage === 'policy') t.policy++;
        if (s.stage === 'llm') {
          t.llm++;
          const d = s.detail as any;
          t.tokens += (d?.tokens_in ?? 0) + (d?.tokens_out ?? 0);
        }
      }
    }
    return t;
  }, [messages]);

  const lastTrace = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const tr = traceOf(messages[i]);
      if (tr) return tr;
    }
    return undefined;
  }, [messages]);

  // `lastTrace.memory.within_session` is THIS session's turn history; `across_sessions`
  // is the D1-backed long-term context (segment, propensity, confirmed fit recs, ...) -
  // see packages/app/src/session-do.ts's handleTurn. Computed per turn from the trace
  // that already rode along on the last assistant message, rather than from the
  // mount-time `memorySummary` fetch above, which is always stale (see that effect's
  // comment) and which mislabelled `working` (within-session) as "long-term keys".
  const meter = lastTrace
    ? `session turns ${lastTrace.memory.within_session.turns.length} · long-term keys ${Object.keys(lastTrace.memory.across_sessions ?? {}).length}`
    : memorySummary;

  return (
    <main>
      <section className="front">
        <div className="panehead">What the customer sees</div>
        <div className="stream">
          {messages.length === 0 && (
            <p className="empty">
              Pick a customer, then ask for a product, a size, your plan or your points. The same question to a
              different customer takes a different path.
            </p>
          )}
          {messages.map(m => {
            const text = m.parts.filter(p => p.type === 'text').map(p => (p as any).text).join('');
            const tr = traceOf(m);
            return (
              <div key={m.id} className={'msg ' + (m.role === 'user' ? 'you' : 'bot')}>
                <div className="who">{m.role === 'user' ? `You · ${customerId}` : `Assistant · ${tr?.agent ?? ''} agent`}</div>
                <div className="bubble">{text}</div>
              </div>
            );
          })}
        </div>
        <div className="chips">
          {SUGGESTIONS.map(s => (
            <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
          ))}
        </div>
        <div className="composer">
          <input
            type="text"
            placeholder="Ask the assistant"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send(input); }}
          />
          <button className="send" disabled={status !== 'ready'} onClick={() => send(input)}>Send</button>
        </div>
      </section>

      <div className="visibility"><span>LINE OF VISIBILITY</span></div>

      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="panehead">What the system did · every step mapped to the M3 sequence diagrams</div>
        <div className="stream">
          {!lastTrace && (
            <p className="empty">
              The trace appears here: intent detection, agent routing, every tool contract invoked, every policy
              evaluation, and the tokens each model call cost.
            </p>
          )}
          {lastTrace?.trace.map(s => {
            const blocked = typeof s.label === 'string' && s.label.includes(': block');
            const detailText = s.detail == null ? '' : typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail);
            return (
              <div key={s.seq} className={'step' + (blocked ? ' blocked' : '')}>
                <div className="n">{s.seq}</div>
                <div className={'badge ' + s.stage}>{s.stage}</div>
                <div>
                  <span className="label">{s.label}</span>
                  {s.m3_ref && <span className="ref">{s.m3_ref}</span>}
                  {s.ms != null && <span className="ms">{s.ms} ms</span>}
                  {detailText && (
                    <div className="detail">{detailText.length > 300 ? detailText.slice(0, 300) + '…' : detailText}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="meter">
          <span>tools <b>{totals.tools}</b></span>
          <span>model calls <b>{totals.llm}</b></span>
          <span>tokens <b>{totals.tokens}</b></span>
          <span>policy checks <b>{totals.policy}</b></span>
          <span>{meter}</span>
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [customerId, setCustomerId] = useState(INITIAL_SESSION.customerId);
  const [sessionId, setSessionId] = useState(INITIAL_SESSION.sessionId);

  function switchCustomer(id: string) {
    const fresh = newSessionId(id);
    setCustomerId(id);
    setSessionId(fresh);
    try { sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ customerId: id, sessionId: fresh })); } catch { /* ignore */ }
  }

  return (
    <>
      <header>
        <div>
          <h1>Neu.Tail Digital Personalisation Assistant</h1>
          <div className="sub">Mission #4 prototype · five agents, one orchestrator, one shared context</div>
        </div>
        <div className="personas">
          {PERSONAS.map(p => (
            <button
              key={p.id}
              className="persona"
              aria-pressed={p.id === customerId}
              title={p.note}
              onClick={() => switchCustomer(p.id)}
            >
              {p.name} · {p.id}
            </button>
          ))}
        </div>
        <a href="/shop.html" style={{ fontSize: 12.5, color: 'var(--violet)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
          View storefront mockup →
        </a>
      </header>

      <ChatSession key={sessionId} customerId={customerId} sessionId={sessionId} />
    </>
  );
}
