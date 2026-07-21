// akg HTTP 클라이언트 — 문서 존재 확인(GET) + 신규 생성(POST).
//
// akg 는 런타임 의존성 0 규율이라 HTTP API 로만 접근한다(README "왜 별도 레포인가").
// editor 역할 토큰 하나로 존재확인·생성을 다 커버한다 — akg 의 role 랭크는
// viewer < editor < approver 라서(agent 는 이 사다리 밖 별도 역할) editor 토큰이면
// viewer 전용인 GET 도, editor 전용인 POST 도 둘 다 통과한다.
//
// fetch 는 주입 가능하다(llm/openai.mjs 관례) — 테스트가 네트워크를 안 탄다.

class AkgApiError extends Error {
  constructor(message, { status = null, body = null, cause = null } = {}) {
    super(message);
    this.name = "AkgApiError";
    this.status = status;
    this.body = body;
    this.cause = cause;
  }
}

/** 다시 걸어볼 가치가 있는 실패인가 — 4xx(404·409 포함)는 다시 걸어도 같은 답이다. */
function isRetryable(status) {
  return status === null || status === 408 || status === 429 || status >= 500;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} opts
 * @param {string} opts.baseUrl   akg 서버 주소
 * @param {string} opts.token     editor 역할 Bearer 토큰
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]     기본 30초
 * @param {number} [opts.maxAttempts]   기본 3 (재시도 가능한 실패에 한해)
 * @param {(ms:number)=>Promise<void>} [opts.sleepImpl]
 */
export function createAkgClient({
  baseUrl,
  token,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  maxAttempts = 3,
  sleepImpl = realSleep,
}) {
  if (!baseUrl) throw new AkgApiError("baseUrl 이 필요합니다");
  if (!token) throw new AkgApiError("token 이 필요합니다");
  const root = String(baseUrl).replace(/\/+$/, "");

  async function once(method, path, jsonBody) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(jsonBody !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      // 재시도 대상 상태는 여기서 예외로 만든다 — 404·409 는 이 클라이언트의 정상
      // 결과(존재하지 않음/이미 있음)라서 예외로 다루지 않는다.
      if (isRetryable(res.status))
        throw new AkgApiError(`akg HTTP ${res.status}`, { status: res.status, body });
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(method, path, jsonBody) {
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await once(method, path, jsonBody);
      } catch (err) {
        last =
          err instanceof AkgApiError
            ? err
            : new AkgApiError(`akg 호출 실패: ${err.message}`, { cause: err });
        if (!isRetryable(last.status) || attempt === maxAttempts) throw last;
        await sleepImpl(attempt * 1000);
      }
    }
    throw last;
  }

  return {
    /**
     * @returns {Promise<object|null>} 문서 json, 없으면 null
     */
    async getDoc(type, id) {
      const { status, body } = await call("GET", `/api/docs/${type}/${id}`);
      if (status === 404) return null;
      if (status !== 200)
        throw new AkgApiError(`akg GET 실패: HTTP ${status}`, { status, body });
      return body.json;
    },

    /**
     * @param {object} doc  composeDbSchemaDoc() 출력
     * @returns {Promise<{alreadyExists: true}|{alreadyExists: false, rev: string, json: object}>}
     */
    async createDoc(type, doc) {
      const { status, body } = await call("POST", `/api/docs/${type}`, doc);
      if (status === 409) return { alreadyExists: true };
      if (status !== 201)
        throw new AkgApiError(`akg POST 실패: HTTP ${status}`, { status, body });
      return { alreadyExists: false, rev: body.rev, json: body.json };
    },
  };
}

export { AkgApiError };
