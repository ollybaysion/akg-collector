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

    /**
     * N개를 1커밋으로 (akg #13 `POST /api/docs/:type/batch`).
     * 서버가 무엇을 보내든 비활성으로 착지시킨다.
     *
     * 세 가지 응답만 의미가 있다:
     *  - 201  전부 생성됨
     *  - 409  이미 있는 id 가 섞였다 — 배치는 전량 아니면 전무라 아무것도 안 쓰였다.
     *         호출자가 그 id 들을 빼고 다시 부를 수 있게 목록을 돌려준다.
     *  - 413  본문이 상한을 넘었다 — 청크를 줄여야 한다. 다시 걸어도 같은 답이므로
     *         재시도 대상이 아니다(isRetryable 이 4xx 를 이미 걸러낸다).
     *
     * @returns {Promise<{created: string[]}|{alreadyExists: string[]}>}
     */
    async createDocs(type, docs, { runId } = {}) {
      const { status, body } = await call("POST", `/api/docs/${type}/batch`, {
        docs,
        ...(runId ? { runId } : {}),
      });
      if (status === 201) return { created: body.created ?? [], rev: body.rev };
      if (status === 409) return { alreadyExists: body.ids ?? [] };
      if (status === 413)
        throw new AkgApiError(
          `akg 배치가 본문 상한을 넘었습니다(${docs.length}개). 청크를 줄이세요.`,
          { status, body },
        );
      throw new AkgApiError(`akg 배치 실패: HTTP ${status}`, { status, body });
    },

    /**
     * 기존 문서의 팩트만 교체한다 (akg #12 `PUT /api/docs/:type/:id/facts`).
     *
     * 슬롯 보존은 전적으로 서버(server/facts.mjs mergeFacts) 책임이다: 주소가
     * 살아있는 슬롯은 값이 남고, 사라진 주소는 scaffold→drop / 사람 작성분→
     * deprecated 로 접힌다. body 에 슬롯 값이 실려 있어도 서버가 전부 scaffold 로
     * 리셋하므로 — 이 클라이언트는 compose 출력을 그대로 보내면 된다.
     *
     * @param {object} doc  composeDbSchemaDoc() 출력 (body 를 꺼내 보낸다)
     * @returns {Promise<{created: boolean, rev: string,
     *                     orphans: {address: string, outcome: string}[]}>}
     *   created=true 는 문서가 없어서 새로 생겼다는 뜻(서버가 inactive 로 착지).
     */
    async putFacts(type, id, doc) {
      const { status, body } = await call(
        "PUT",
        `/api/docs/${type}/${id}/facts`,
        { body: doc.body },
      );
      if (status === 200 || status === 201)
        return {
          created: status === 201,
          rev: body.rev,
          orphans: body.orphans ?? [],
        };
      throw new AkgApiError(`akg facts PUT 실패: HTTP ${status}`, { status, body });
    },
  };
}

export { AkgApiError };
