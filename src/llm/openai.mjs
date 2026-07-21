// OpenAI 호환 Chat Completions 클라이언트.
//
// 사내 LLM 을 붙일 자리다. 엔드포인트 모양만 OpenAI 호환이면 되고, 그 외의 것
// (response_format·tool calling 등 최신 확장)은 **가정하지 않는다** — 지원 여부가
// 배포마다 다르기 때문이다. 구조화 출력은 프롬프트와 파서로 얻는다(src/infer/).
//
// fetch 는 주입 가능하다(akg 의 sync.mjs·propose 관례) — 테스트가 네트워크를 타지 않는다.

class LlmError extends Error {
  constructor(message, { status = null, body = null, cause = null } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
    this.cause = cause;
  }
}

/** 다시 걸어볼 가치가 있는 실패인가 — 4xx 는 다시 걸어도 같은 답이다. */
function isRetryable(status) {
  return status === null || status === 408 || status === 429 || status >= 500;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} opts
 * @param {string} opts.baseUrl   예: http://llm.internal/v1
 * @param {string} [opts.apiKey]  사내 게이트웨이가 인증을 안 걸면 생략 가능
 * @param {string} opts.model
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]     기본 60초 — 느린 온프렘을 상정
 * @param {number} [opts.maxAttempts]   기본 3 (재시도 가능한 실패에 한해)
 * @param {(ms:number)=>Promise<void>} [opts.sleepImpl]
 */
export function createOpenAiClient({
  baseUrl,
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = 60_000,
  maxAttempts = 3,
  sleepImpl = realSleep,
}) {
  if (!baseUrl) throw new LlmError("baseUrl 이 필요합니다");
  if (!model) throw new LlmError("model 이 필요합니다");
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;

  async function once(messages, temperature) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "content-type": "application/json" };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, temperature }),
        signal: controller.signal,
      });

      const body = await res.json().catch(() => null);
      if (!res.ok)
        throw new LlmError(`LLM HTTP ${res.status}`, {
          status: res.status,
          body,
        });

      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim())
        // 200 인데 내용이 없는 건 응답 형식이 다르다는 뜻 — 조용히 넘기면 안 된다.
        throw new LlmError("응답에 choices[0].message.content 가 없습니다", {
          status: res.status,
          body,
        });

      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    model,

    /** @returns {Promise<string>} 모델이 낸 원문 텍스트 */
    async complete(messages, { temperature = 0 } = {}) {
      let last = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await once(messages, temperature);
        } catch (err) {
          last =
            err instanceof LlmError
              ? err
              : new LlmError(`LLM 호출 실패: ${err.message}`, { cause: err });
          if (!isRetryable(last.status) || attempt === maxAttempts) throw last;
          await sleepImpl(attempt * 1000);
        }
      }
      throw last;
    },
  };
}

export { LlmError };
