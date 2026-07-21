// LLM 응답 → 검증된 추론 결과.
//
// 사내 LLM 이 구조화 출력을 네이티브로 지원하지 않을 수 있으므로, 파서가
// 방어를 전담한다: 코드펜스를 벗기고, JSON 을 찾아 파싱하고, **실제 카탈로그에
// 있는 컬럼만** 통과시킨다. 모델이 지어낸 컬럼은 조용히 통과시키지 않고 센다.

class InferParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "InferParseError";
  }
}

/** ```json … ``` 펜스 제거 후 첫 번째 JSON 객체만 남긴다. */
function extractJson(raw) {
  const text = String(raw).trim();
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start)
    throw new InferParseError("응답에서 JSON 객체를 찾지 못했습니다");
  return unfenced.slice(start, end + 1);
}

function asText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

/**
 * @param {string|object} raw  LLM 원문 응답 (문자열) 또는 이미 파싱된 객체
 * @param {{columns: {name: string}[]}} context  실제 카탈로그 — 화이트리스트 원천
 * @returns {{purpose: string|null, columns: Record<string,string>,
 *            dropped: string[], missing: string[]}}
 */
export function parseInference(raw, context) {
  const known = new Map(
    (context?.columns ?? []).map((c) => [c.name.toUpperCase(), c.name]),
  );
  if (known.size === 0)
    throw new InferParseError("context.columns 가 비어 있습니다");

  let parsed;
  if (raw && typeof raw === "object") {
    parsed = raw;
  } else {
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (err) {
      if (err instanceof InferParseError) throw err;
      throw new InferParseError(`JSON 파싱 실패: ${err.message}`);
    }
  }

  const columns = {};
  const dropped = [];
  const source = parsed.columns;
  if (source && typeof source === "object") {
    for (const [rawName, rawText] of Object.entries(source)) {
      // 모델이 대소문자를 흔들어도 실제 컬럼명으로 되돌린다.
      const actual = known.get(String(rawName).trim().toUpperCase());
      const text = asText(rawText);
      if (!actual) {
        dropped.push(String(rawName));
        continue;
      }
      if (text) columns[actual] = text;
    }
  }

  // 모델이 빠뜨린 컬럼 — 억지로 채우지 않고 보고만 한다(슬롯은 scaffold 로 남는다).
  const missing = [...known.values()].filter((name) => !(name in columns));

  return {
    purpose: asText(parsed.purpose),
    columns,
    dropped,
    missing,
  };
}

export { InferParseError };
