// 추론 프롬프트 빌더.
//
// 사내 LLM 의 성능을 가정하지 않는다: 지시를 짧게, 출력 형식을 하나로 고정하고,
// 예시를 그대로 베끼게 한다. 판단은 프롬프트가 아니라 파서(parse.mjs)가 막는다.

const SYSTEM = [
  "너는 Oracle 데이터베이스 스키마를 읽고 각 테이블과 컬럼이 무엇인지 설명하는 도우미다.",
  "주어진 카탈로그 정보만 근거로 삼는다. 모르면 비워 둔다 — 지어내지 않는다.",
  "출력은 JSON 객체 하나뿐이다. 설명, 인사말, 코드펜스를 붙이지 않는다.",
].join("\n");

const SHAPE = `{
  "purpose": "이 테이블이 무엇을 담는지 한두 문장",
  "columns": {
    "COLUMN_NAME": "이 컬럼이 무엇인지 한 문장"
  }
}`;

function columnLine(column) {
  const bits = [`- ${column.name} ${column.type}`];
  if (column.nullable === false) bits.push("NOT NULL");
  if (column.comment) bits.push(`-- ${column.comment}`);
  return bits.join(" ");
}

function sampleBlock(sampleRows) {
  if (!sampleRows?.length) return null;
  return ["샘플 데이터(일부):", JSON.stringify(sampleRows, null, 2)].join("\n");
}

/**
 * @param {object} describe  describe_table 출력
 * @param {{sampleRows?: object[]}} [opts]  샘플 행은 기본 미포함 — 호출자가 명시할 때만
 * @returns {{messages: {role: string, content: string}[]}}
 */
export function buildInferPrompt(describe, opts = {}) {
  const sections = [
    `테이블: ${describe.owner}.${describe.table}`,
    describe.tableComment ? `테이블 코멘트: ${describe.tableComment}` : null,
    `기본키: ${(describe.primaryKey ?? []).join(", ") || "없음"}`,
    describe.foreignKeys?.length
      ? `외래키:\n${describe.foreignKeys
          .map((fk) => `- ${fk.column} → ${fk.refTable}.${fk.refColumn}`)
          .join("\n")}`
      : null,
    `컬럼:\n${describe.columns.map(columnLine).join("\n")}`,
    sampleBlock(opts.sampleRows),
    `아래 형식의 JSON 만 출력한다. columns 의 키는 위 컬럼 이름과 정확히 같아야 한다.\n${SHAPE}`,
  ].filter(Boolean);

  return {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: sections.join("\n\n") },
    ],
  };
}
