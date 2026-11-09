# akg-collector

Oracle 스키마를 읽어 [agent-knowledge-governance](https://github.com/ollybaysion/agent-knowledge-governance)(akg)의
`db-schema` 문서를 만드는 수집기. `crawl` 하위 명령은 레포 md 같은 원천 글을 akg 수집 계약
JSONL 로 낸다(아래 "crawl" 절).

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
⑤ push       akg API — GET 으로 존재 확인, 없으면 배치로 1커밋. 있으면 스킵
             (--refresh-facts 를 주면 스킵 대신 PUT /facts 로 팩트만 갱신 — 슬롯은 서버가 보존)
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

# 기존 문서는 기본 스킵. 팩트(컬럼·PK·FK 등)가 낡았거나 빈 문서를 채우려면 --refresh-facts
npx akg-collector run --owner FDC --refresh-facts --push        # 기존 문서 = 팩트만 갱신(LLM 호출 없음)
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

**`--refresh-facts` 는 기존 문서를 스킵 대신 팩트 갱신으로 처리한다** — describe 만
다시 돌려 akg `PUT /api/docs/:type/:id/facts` 로 보낸다. 갱신 시맨틱은 전부 서버
(`server/facts.mjs` `mergeFacts`) 소유다: 팩트는 통째로 교체, 살아있는 슬롯 값은
보존, 사라진 컬럼의 슬롯은 scaffold→drop / 사람 작성분→deprecated. 이 경로에 LLM
호출이 없는 건 구조다 — facts 경로로 온 슬롯 값은 서버가 전부 scaffold 로 리셋하므로
(해석 주장은 propose 몫) 추론해 봐야 버려진다. 새 컬럼의 의미 채우기는 propose 경로가
담당한다. 신규 문서와 달리 배치 엔드포인트가 없어 문서별 PUT(=문서별 1커밋)이다.

## crawl — 원천 글을 JSONL 로

원천(레포 폴더 · 사내 위키 · 사내 사이트 · VOC 티켓)마다 가져오는 법은 다르다. akg 가 받는
모양은 하나다. 그래서 **크롤러 인터페이스 하나 + 공통 러너 하나 + 구현 여럿** 으로 나눈다.
구현은 "목록을 얻는 법" 과 "글 하나를 md 로 가져오는 법" 만 안다. 러너가 검증 · 상한 ·
출력 · 실패 셈을 한 곳에서 한다. 원천 접속 정보는 크롤러 옵션으로 받는다.

```bash
npx akg-collector crawl repo-fs --root ~/src/fdc-app --include 'docs/**/*.md' > fdc-app.jsonl
npx akg-collector crawl repo-fs --root ~/src/fdc-app/docs --name fdc-app-docs   # include 기본값 **/*.md
```

`repo-fs` 옵션:

| 옵션 | 뜻 |
| --- | --- |
| `--root <폴더>` | 필수. 읽을 폴더 |
| `--include <글롭>` | root 기준 글롭. 여러 번 줄 수 있다. 기본값 `**/*.md`. 점으로 시작하는 폴더 · 파일과 `node_modules` 는 건너뛴다 |
| `--name <이름>` | ref 앞 이름. 기본값은 root 폴더 이름. 폴더 이름이 원천을 가리지 못할 때(`docs` · 워크트리 이름) 준다 |

`repo-fs` 의 칸:

- `ref` = `<이름>@<root 기준 상대 경로>`
- `title` = `#` 과 빈칸으로 시작하는 첫 줄. 없으면 확장자를 뺀 파일 이름
- git 폴더: `createdAt` = 첫 커밋의 author 시각, `updatedAt` = 마지막 커밋의 author 시각
- git 이 아닌 폴더 · 커밋 안 된 파일: `updatedAt` = 파일 mtime, `createdAt` 은 비운다

### 출력

stdout 에 한 줄 = 글 하나(akg 설계 §5.1). 마지막 줄은 완료 마커다.

```jsonl
{"ref":"fdc-app@docs/sensor-guide.md","title":"센서 가이드","mime":"text/markdown","text":"# 센서 가이드\n…","updatedAt":"2026-03-04T05:06:07.000Z","createdAt":"2026-01-02T03:04:05.000Z"}
{"done":{"listed":3,"emitted":1,"oversize":["fdc-app@docs/huge.md"],"failed":["fdc-app@docs/locked.md"],"duplicate":[]}}
```

- 글 줄의 키는 `ref` · `title` · `mime` · `text` · `updatedAt` · `createdAt` · `keywords` · `sourceUrl` 뿐이다.
  `mime` 은 늘 `text/markdown` 이다(CS4). 시각은 UTC ISO 8601 로 맞춘다.
- `ref` · `title` · `keywords` 의 제어문자를 지우고 길이를 자른다(ref 512 · title 200 · 키워드 64 글자, CS12).
- `text` 가 256 KB(UTF-8)를 넘는 글은 글 줄 대신 `oversize` 에 싣는다(CS5).
- 같은 ref 가 또 나오면 뒤 것을 `duplicate` 에 싣는다.
- fetch 가 실패한 글은 `failed` 에 싣고 stderr 에 까닭을 쓴다. 나머지 글은 그대로 나간다. exit 0.
- 마커의 `listed` = `emitted` + `oversize` + `failed` + `duplicate` 수다.

exit 코드:

| 코드 | 뜻 |
| --- | --- |
| 0 | 마커까지 냈다. list 가 원천 전부를 냈다 |
| 1 | list 가 중간에 실패했다. 마커가 없다 — 받는 쪽은 이 출력으로 고아를 판정하지 않는다(CS2) |
| 2 | 사용법 오류(모르는 크롤러 이름 · 빠진 옵션) |

### 구현 더하는 법

1. `src/crawl/<이름>.mjs` 에 `argv → 크롤러` 함수를 둔다. 크롤러는 아래 셋을 가진다.

   ```js
   // name: string                              레지스트리 이름
   // list(): AsyncIterable<CrawlRef>           지금 원천에 있는 글 전부. 본문 없이
   // fetch(ref: CrawlRef): Promise<CrawlItem>  글 하나의 본문(md)
   // CrawlRef  = { ref, title, sourceUrl?, updatedAt?, createdAt? }
   // CrawlItem = CrawlRef & { text, keywords? }
   ```

   - `list` 는 원천 전부를 빠짐없이 낸다. 받는 쪽이 이 목록으로 고아를 판정한다.
     끝까지 못 돌면 던진다.
   - `ref` 는 원천 안에서 바뀌지 않는 값으로 짓는다(위키라면 페이지 ID). 같은 원천을 두 번
     돌리면 같은 ref 가 나와야 한다.
   - `fetch` 는 글 하나만 책임진다. 실패하면 던진다 — 러너가 `failed` 에 싣고 다음 글로 간다.
   - 인증 · 페이지 넘김 · HTML → md 변환은 구현이 한다.
2. `src/crawl/registry.mjs` 의 `CRAWLERS` 에 `"<이름>": <함수>` 한 줄을 더한다.
3. 테스트는 `test/crawl-repo-fs.test.mjs` 꼴로 둔다. 러너 규칙은 `test/crawl-runner.test.mjs` 가 지킨다.

## 지금 구현된 것 (Phase 0~4, 전 단계 완료)

테스트는 fixture 와 주입된 가짜 fetch·DB 커넥션만으로 전부 돈다 — 네트워크를 타지
않는다. 다만 akg 쪽은 로컬에 띄운 실 akg 서버로 한 번 끝까지 태워봤다(아래 "앞으로").

- `src/compose.mjs` — describe 결과 + 추론 → akg `db-schema/v1` 문서
- `src/infer/prompt.mjs` — 추론 프롬프트 빌더
- `src/infer/parse.mjs` — LLM 응답 파서 + **환각 차단**
- `src/infer/run.mjs` — 테이블 하나 추론 + **교정 재시도 루프**
- `src/llm/openai.mjs` — OpenAI 호환 클라이언트 (사내 LLM 연결점)
- `src/oracle/discover.mjs` — ① discover, 스키마의 테이블 목록
- `src/oracle/describe.mjs` — ② describe, 컬럼·PK·FK·인덱스·통계 조립
- `src/oracle/types.mjs` — Oracle 카탈로그 타입 행 → `VARCHAR2(20)` 같은 표기
- `src/oracle/pool.mjs` — `oracledb` 커넥션 풀 (Oracle 연결점)
- `src/akg/client.mjs` — akg HTTP 클라이언트, GET(존재확인)·POST(생성)·배치
- `src/push.mjs` — ⑤ push, 존재하면 스킵 정책 + 크기 기준 청크(`chunkBySize`)
- `src/collect.mjs` — 테이블 하나 end-to-end (존재확인 → describe → infer → compose → push)
- `src/cli.mjs` — 다섯 커맨드 오케스트레이션, 실 클라이언트는 주입받는다
- `bin/akg-collector.mjs` — CLI 진입점, 커맨드별로 필요한 접속 정보만 요구
- `src/crawl/runner.mjs` — crawl 러너: list → fetch, 검증 · 상한 · JSONL · 완료 마커
- `src/crawl/registry.mjs` — 크롤러 이름 → 만드는 함수
- `src/crawl/repo-fs.mjs` — `repo-fs` 크롤러(폴더 + 글롭 + git 시각)
- `src/crawl/cli.mjs` — `crawl <이름>` 하위 명령, exit 코드

```bash
npm test    # 105 테스트
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
const result = await pushDocs(client, docs, { runId: "import-2026-07-22" });
// { created: [...id], skipped: [...id], commits }
```

(재개/resume 은 위 "CLI" 절 — infer 비용까지 아끼는 pre-check 는 `src/collect.mjs`.)

**적재는 주입에 닿지 않는다.** 문서는 `inactive` 로 착지한다 — akg 대시보드에서
읽고 미리보기할 수 있지만 미러로 나가지 않아 세션에 주입되지 않는다. 주입 예산이
턴당 문서 2개뿐이라, 뼈대 수백 개가 사람이 확정한 문서와 같은 2칸을 놓고 경쟁하면
안 되기 때문이다. 무엇을 실제로 주입할지는 akg 에서 approver 가 문서를 보고 정한다.

`akg #13` 의 배치 라우트(`POST /api/docs/:type/batch`)로 **N개를 1커밋**에 올린다.
테이블마다 POST 하면 테이블 수만큼 커밋이 생겨 부트스트랩 한 번이 감사 로그를
뒤덮는다. 청크는 개수가 아니라 **직렬화 크기**로 자른다(`chunkBySize`) — 컬럼 수에
따라 문서 크기가 몇 배씩 달라서, 개수로 자르면 어떤 배치는 본문 상한을 넘고 어떤
배치는 상한을 한참 밑돈다.

배치는 전량 아니면 전무라, 이미 있는 id 가 하나라도 섞이면 그 청크는 아무것도 안
쓰이고 409 로 그 id 들을 알려준다. `pushDocs` 는 그것들을 빼고 한 번 다시 보낸다.

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

**신규 문서의 기본 주입 강도는 `pointer`.** 비활성 착지가 1차 방어라면 이건 2차다 —
활성화된 뒤에도 한 턴에 들어가는 건 한 줄 포인터(~20토큰)뿐이다. `full` 승격도
활성화와 마찬가지로 사람이 문서를 보고 결정한다.

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
- `src/akg/client.mjs` 는 이제 실 akg 인스턴스로 검증됐다(#6). 픽스처 Oracle +
  가짜 LLM 으로 40 테이블을 로컬 akg 서버에 실제로 올려, 커밋 1개·전량 비활성·주입
  인덱스 빈 상태·감사에 runId·재실행 시 전량 스킵·활성화하면 인덱스 등재까지
  확인했다. 남은 건 사내 akg 인스턴스라는 것뿐이다.
- 재푸시 기본은 여전히 **"이미 있으면 스킵"** 이고, 스키마가 바뀐 테이블은
  `--refresh-facts` 로 팩트만 갱신한다(#10). 갱신 시맨틱은 서버 `mergeFacts` 가
  정한다 — collector 는 describe 결과를 보낼 뿐, 언제 덮고 언제 두는가를 스스로
  판단하지 않는다. 이 경로도 사내 실 akg 로는 아직 라이브 검증 전이다.
