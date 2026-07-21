# akg-collector

Oracle 스키마를 읽어 [agent-knowledge-governance](https://github.com/ollybaysion/agent-knowledge-governance)(akg)의
`db-schema` 문서를 만드는 수집기.

**팩트는 DB 에서, 의미는 LLM 에서, 확정은 사람이.** akg 의 3티어가 이 분업을 그대로 담는다.

| 출처 | 들어가는 자리 | 티어 |
| --- | --- | --- |
| 카탈로그 (컬럼·타입·PK·코멘트) | `body.catalog` | 팩트 — 티어 없음 |
| LLM 추론 (테이블 용도·컬럼 의미) | `purpose` · `columnDescs` | `inferred` |
| 사람 확인 | 같은 슬롯 | `confirmed` — akg 서버에서 승격 |

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
⑤ push       akg API (POST 신규 / PUT 기존)
```

③이 테이블 단위인 이유: 컬럼 의미는 그 테이블 전체를 봐야 제대로 나온다.
`SNSR_ID` 가 무엇인지는 옆에 `EQP_ID`·`MEAS_TIME` 이 있는 걸 봐야 안다.

## 지금 구현된 것 (Phase 0)

네트워크 없이 fixture 만으로 도는 코어다.

- `src/compose.mjs` — describe 결과 + 추론 → akg `db-schema/v1` 문서
- `src/infer/prompt.mjs` — 추론 프롬프트 빌더
- `src/infer/parse.mjs` — LLM 응답 파서 + **환각 차단**

```bash
npm test    # 20 단언, 의존성 0
```

## 설계 규율

**환각은 화이트리스트로 막는다.** 파서는 실제 카탈로그에 있는 컬럼만 통과시킨다.
모델이 지어낸 컬럼은 버리고 세며(`dropped`), 빠뜨린 컬럼은 억지로 채우지 않고
빈칸으로 남긴다(`missing`). 대소문자만 흔들린 건 실제 컬럼명으로 되돌린다.

**사람이 손댄 것은 덮지 않는다.** `confirmed`·`deprecated` 슬롯은 재수집이 건드리지
않는다. 사람이 `inject: "full"` 로 올려둔 문서를 재수집이 `pointer` 로 되돌리지도 않는다.

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

## 앞으로

- Phase 1 — LLM 클라이언트 (OpenAI 호환 API, base URL·모델 주입)
- Phase 2 — Oracle 어댑터
- Phase 3 — akg push + 재개(중단된 지점부터)
- Phase 4 — CLI (`discover` / `describe` / `infer` / `push` / `run`)

실 DB 는 사내에서만 접근 가능하므로 로컬 검증은 fixture 로 한다.
