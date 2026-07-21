# akg-collector

Oracle 스키마를 읽어 [agent-knowledge-governance](https://github.com/ollybaysion/agent-knowledge-governance)(akg)의
`db-schema` 문서를 만드는 수집기.

**팩트는 DB 에서, 의미는 LLM 에서, 확정은 사람이.** akg 의 3티어가 이 분업을 그대로 담는다.

| 출처 | 들어가는 자리 | 티어 |
| --- | --- | --- |
| 카탈로그 (컬럼·타입·PK·코멘트) | `body.catalog` | 팩트 — 티어 없음 |
| LLM 추론 (테이블 용도·컬럼 의미) | `purpose` · `columnDescs` | `inferred` |
| 사람 확인 | 같은 슬롯 | `confirmed` — akg 서버에서 승격 |

**문서:** [docs/usage.html](docs/usage.html) (커맨드 레퍼런스) ·
[docs/onprem-verification.html](docs/onprem-verification.html) (사내 반입 전 검증 체크리스트)

## 왜 별도 레포인가

akg 는 **런타임 의존성 0** 이 규율이다(ajv 조차 수제 검증기). Oracle 드라이버와 LLM
클라이언트를 akg 안에 넣으면 그 규율이 깨진다. 그래서 수집기는 밖에 살고 akg 에는
**HTTP API 로만** 접근한다.

## 파이프라인

```text
① discover   대상 테이블 목록
② describe   테이블별 구조 (컬럼·타입·NULL·코멘트·PK·FK)
③ infer      LLM 추론 — 테이블 1개 = 호출 1회
④ compose    akg 문서 조립 (팩트 + 슬롯 + evidence)
⑤ push       akg API — GET 으로 존재 확인, 없으면 POST. 있으면 스킵(PUT 없음)
```

③이 테이블 단위인 이유: 컬럼 의미는 그 테이블 전체를 봐야 제대로 나온다.
`SNSR_ID` 가 무엇인지는 옆에 `EQP_ID`·`MEAS_TIME` 이 있는 걸 봐야 안다.

## CLI

```bash
npm install   # oracledb 는 6.x thin 모드라 Oracle Instant Client 설치 없이도 붙는다
              # (127.0.0.1:1521 로 실제 접속 시도까지 로컬에서 검증됨 — 연결 자체는
              # 당연히 사내에서만 성공한다)

# discover·describe 는 Oracle 접속 정보만 있으면 된다
export ORACLE_USER=... ORACLE_PASSWORD=... ORACLE_CONNECT_STRING=host:1521/service
npx akg-collector discover --owner FDC
npx akg-collector describe --owner FDC --table FDC_SENSOR

# infer 는 LLM 접속 정보도 필요
export AKG_LLM_URL=http://llm.internal/v1 AKG_LLM_KEY=...   # 사내 게이트웨이가 인증 안 걸면 KEY 생략
npx akg-collector infer --owner FDC --table FDC_SENSOR

# push·run 은 akg 접속 정보도 필요. 기본은 dry-run — 실제로 만들려면 --push
export AKG_BASE_URL=http://akg.internal AKG_EDITOR_TOKEN=...
npx akg-collector push --owner FDC --table FDC_SENSOR           # dry-run
npx akg-collector push --owner FDC --table FDC_SENSOR --push    # 실제 생성

# run 은 discover 로 스키마 전체를 훑거나, 테이블을 직접 지정한다
npx akg-collector run --owner FDC --push                        # 스키마 전체
npx akg-collector run --owner FDC --tables FDC_SENSOR,FDC_EQUIPMENT --push
npx akg-collector run --owner FDC --tables-file ./bootstrap.txt --push  # 한 줄에 테이블 하나, # 주석 허용
```

커맨드가 실제로 안 쓰는 접속 정보는 요구하지 않는다 — `discover`/`describe`는 Oracle
뿐이고, `infer`는 LLM 이 더 필요하고, `push`/`run`은 akg 까지 필요하다
(`bin/akg-collector.mjs`).

`run --tables`/`--tables-file` 은 discover 를 건너뛴다 — 스키마 안의 테이블을 전부
훑고 싶지 않을 때(부트스트랩 대상을 미리 골라둔 경우 등) 쓴다. `--tables-file` 은
`--tables` 로 감당하기 부담스러운 수백 줄짜리 목록을 위한 것이다.

**`run`/`push` 의 재개(resume)는 스킵 정책 자체다** — akg 에 이미 문서가 있는
테이블은 describe·infer 도 하기 전에 걸러진다(`src/collect.mjs`). 파이프라인을
중단된 지점부터 다시 시작한다는 개념의 별도 상태 파일은 없다: 처음부터 다시 돌려도
결과가 같다.

## 지금 구현된 것 (Phase 0~4, 전 단계 완료)

fixture 와 주입된 가짜 fetch·DB 커넥션만으로 전부 도는 상태다 — 아직 아무 네트워크도 타지 않는다.

- `src/compose.mjs` — describe 결과 + 추론 → akg `db-schema/v1` 문서
- `src/infer/prompt.mjs` — 추론 프롬프트 빌더
- `src/infer/parse.mjs` — LLM 응답 파서 + **환각 차단**
- `src/infer/run.mjs` — 테이블 하나 추론 + **교정 재시도 루프**
- `src/llm/openai.mjs` — OpenAI 호환 클라이언트 (사내 LLM 연결점)
- `src/oracle/discover.mjs` — ① discover, 스키마의 테이블 목록
- `src/oracle/describe.mjs` — ② describe, 컬럼·PK·FK·인덱스·통계 조립
- `src/oracle/types.mjs` — Oracle 카탈로그 타입 행 → `VARCHAR2(20)` 같은 표기
- `src/oracle/pool.mjs` — `oracledb` 커넥션 풀 (Oracle 연결점)
- `src/akg/client.mjs` — akg HTTP 클라이언트, GET(존재확인)·POST(생성)
- `src/push.mjs` — ⑤ push, 존재하면 스킵 정책
- `src/collect.mjs` — 테이블 하나 end-to-end (존재확인 → describe → infer → compose → push)
- `src/cli.mjs` — 다섯 커맨드 오케스트레이션, 실 클라이언트는 주입받는다
- `bin/akg-collector.mjs` — CLI 진입점, 커맨드별로 필요한 접속 정보만 요구

```bash
npm test    # 74 단언
```

`oracledb` 는 `package.json` 의존성으로만 선언돼 있다. `run(sql, binds)` 을 실제로
구현하는 `pool.mjs` 만 그걸 import 하고, discover/describe 는 그 함수를 주입받는 순수
매핑 로직이라 테스트가 걸치지 않는다 — 그래서 드라이버를 설치하지 않아도 `npm test`
는 그대로 돈다.

### akg 연결

`editor` 역할 Bearer 토큰 하나로 존재확인(GET)·생성(POST) 둘 다 커버한다 — akg 의
role 랭크가 `viewer < editor < approver` 라서다(`agent` 는 이 사다리 밖 별도 역할이라
GET 도 POST 도 못 한다). 토큰은 akg 서버의 `akg-user.mjs add <id> editor` 로 발급한다.

```js
const client = createAkgClient({
  baseUrl: "http://akg.internal",
  token: process.env.AKG_EDITOR_TOKEN,
});
const result = await pushDoc(client, composeDbSchemaDoc(describe, inference, opts));
// { id, skipped: true, reason: "already_exists" } 또는 { id, skipped: false, rev }
```

(재개/resume 은 위 "CLI" 절 — infer 비용까지 아끼는 pre-check 는 `src/collect.mjs`.)

**사람 검토 없이 문서가 바로 라이브된다.** `editor` 토큰으로 직접 생성하는 쪽을 택한
건 이미 있는 문서를 절대 건드리지 않는다는 전제(병합 없음) 때문에 안전하다고 판단해서
다 — 하지만 이건 akg 의 propose→adopt 거버넌스 경로를 우회하는 선택이다. 사내 반입
전에 재확인이 필요하다.

### LLM 연결

OpenAI 호환 Chat Completions 엔드포인트면 붙는다. `response_format`·tool calling 같은
확장은 **가정하지 않는다** — 배포마다 지원이 달라서다. 구조화 출력은 프롬프트와
파서로 얻는다.

```js
const client = createOpenAiClient({
  baseUrl: "http://llm.internal/v1",
  apiKey: process.env.AKG_LLM_KEY, // 사내 게이트웨이가 인증을 안 걸면 생략 가능
  model: "inhouse-llm",
});
const { inference, attempts, error } = await inferTable(describe, { client });
```

재시도는 두 층으로 갈라져 있다. **전송 실패**(429·5xx·네트워크)는 클라이언트가 백오프로
다시 걸고, **형식 위반**(JSON 이 아님)은 `inferTable` 이 모델에게 무엇이 틀렸는지 알려주고
다시 시킨다. 4xx 는 다시 걸어도 같은 답이라 즉시 포기한다.

## 설계 규율

**환각은 화이트리스트로 막는다.** 파서는 실제 카탈로그에 있는 컬럼만 통과시킨다.
모델이 지어낸 컬럼은 버리고 세며(`dropped`), 빠뜨린 컬럼은 억지로 채우지 않고
빈칸으로 남긴다(`missing`). 대소문자만 흔들린 건 실제 컬럼명으로 되돌린다.

**이미 문서가 있는 테이블은 통째로 건너뛴다.** akg 에 해당 문서가 있으면 그 테이블의
수집 결과는 **버린다** — 병합하지 않는다. 그래서 사람이 채운 슬롯을 덮어쓸 경로가
아예 존재하지 않고, 수집기는 "빈칸 채우기"가 아니라 **"없는 문서 만들기"** 하나만 한다.
기존 문서 갱신이 필요해지면 그건 별도 기능으로 다시 설계한다.

**추론은 언제나 `inferred`.** `confirmed` 는 사람만 만든다 — akg 서버도 이를 강제하므로
(`applyEdit`) 수집기가 우회할 방법은 없고, 우회하려 하지도 않는다.

**신규 문서의 기본 주입 강도는 `pointer`.** 부트스트랩으로 수백 개를 넣어도 한 턴에
들어가는 건 한 줄 포인터(~20토큰)뿐이라 주입 예산을 잠식하지 않는다. `full` 승격은
사람이 문서를 보고 결정한다.

**evidence 규격.** 값이 있는 슬롯은 근거가 비면 akg 서버가 거부한다. 그래서 형식을
고정한다 — 기계 사실 먼저, 추론 주체 마지막:

```json
[
  "catalog: FDC_SENSOR.EQP_ID VARCHAR2(20), NOT NULL",
  "comment: 설비 식별자",
  "llm: <모델명> 추론"
]
```

**샘플 데이터는 기본 OFF.** 실제 값 몇 행을 보여주면 추론 정확도가 오르지만
개인정보·영업기밀이 LLM 으로 나간다. 온프렘 LLM 일 때만 명시적으로 켠다.

## 앞으로 — 사내 반입 전 남은 것

파이프라인 다섯 단계(discover~push)와 CLI 는 다 구현됐다. 로컬에서 못 끝낸 건 실
네트워크·DB 가 필요한 부분뿐이다:

- `src/oracle/` 의 SQL 은 사내 Oracle 19c 로 아직 라이브 검증되지 않았다 — 컬럼·PK·
  FK·인덱스 매핑은 `test/oracle-describe.test.mjs` 가 기존
  `fixtures/describe/fdc_sensor.json` 과 바이트 단위로 같아지는 것으로 검증했지만,
  그건 SQL 이 아니라 SQL 이 **돌려준다고 가정한 행**의 매핑일 뿐이다.
- `oracledb` 실 접속은 (가짜 주소로) 끝까지 타봤다 — 6.x thin 모드라 Instant Client
  없이 붙는다는 것까지는 확인됐지만, 사내 서버로의 실제 연결·쿼리 실행은 아직이다.
- `src/akg/client.mjs` 도 실 akg 인스턴스 응답으로 검증된 적은 없다.
- `editor` 토큰으로 문서를 사람 검토 없이 바로 생성하는 판단(위 "akg 연결" 절)은
  사내 반입 전 재확인이 필요하다.
