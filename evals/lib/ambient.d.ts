// providers.ts references two Workers-only type surfaces that this eval harness never
// actually exercises (evals/lib/harness.ts only calls callOpenAI): the `Ai` type used by
// callWorkersAI's signature and body (so `any`, not `unknown` - its body calls `ai.run(...)`
// and still gets typechecked even though nothing here calls the function), and the
// Workers-flavored generic `Response.json<T>()` overload used by callAnthropic/callOpenAI
// (lib.dom's own `Response.json()` takes no type argument). Both are narrow, local
// augmentations - not a full import of @cloudflare/workers-types' global surface, which
// would collide with @types/node's own globals (Response, Request, Buffer, crypto, etc.)
// just to satisfy these two unused-here type references.
declare global {
  type Ai = any;
  interface Response {
    json<T = unknown>(): Promise<T>;
  }
}
export {};
