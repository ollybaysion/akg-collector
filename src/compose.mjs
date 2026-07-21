// describe_table 결과 + LLM 추론 → akg db-schema/v1 문서.
//
// 이 모듈이 팩트/슬롯 경계를 집행한다: catalog 는 DB 에서 온 값을 그대로 옮기고,
// 사람 해석의 자리(purpose·columnDescs)만 추론값으로 채운다. 추론은 언제나
// tier "inferred" 로 착지한다 — confirmed 는 사람만 만든다(akg D4, 서버도 강제).
//
// **이 함수는 신규 문서만 만든다.** akg 에 이미 문서가 있는 테이블은 push 단계에서
// 통째로 건너뛴다(수집 결과를 버린다) — 기존 문서와 병합하지 않는다. 그래서 여기에
// 사람 작업 보존 로직이 없다: 덮어쓸 일 자체가 생기지 않는다.

const CATALOG_KEYS = [
  "columns",
  "primaryKey",
  "foreignKeys",
  "indexes",
  "numRows",
  "lastAnalyzed",
  "tableComment",
];

class ComposeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ComposeError";
  }
}

function requireField(obj, key, where) {
  const v = obj?.[key];
  if (v === undefined || v === null || v === "")
    throw new ComposeError(`${where}: "${key}" 가 없습니다`);
  return v;
}

/** akg 는 id 를 lower(owner.table) 로 강제한다 (src/envelope.mjs SEMANTIC_CHECKS). */
export function docIdFor(owner, table) {
  return `${owner}.${table}`.toLowerCase();
}

/**
 * describe_table 출력에서 akg catalog 필드를 만든다.
 * 스키마가 additionalProperties:false 라 모르는 키는 반드시 버려야 한다.
 */
function toCatalog(describe, fetchedAt) {
  const catalog = { columns: requireField(describe, "columns", "describe") };
  catalog.primaryKey = describe.primaryKey ?? [];
  for (const key of CATALOG_KEYS) {
    if (key === "columns" || key === "primaryKey") continue;
    if (describe[key] !== undefined) catalog[key] = describe[key];
  }
  catalog.fetchedAt = fetchedAt;
  return catalog;
}

/**
 * 추론값 하나를 슬롯으로. 값이 없으면 scaffold(빈칸) — 억지로 채우지 않는다.
 * evidence 는 값이 있을 때만 붙인다(빈칸에는 근거를 달지 않는다).
 */
function slotFor(text, evidence) {
  if (typeof text === "string" && text.trim())
    return { text: text.trim(), tier: "inferred", evidence };
  return { text: null, tier: "scaffold" };
}

/**
 * 컬럼 슬롯의 evidence. 값이 있는 슬롯은 evidence 가 비면 서버가 거부한다
 * (server/edit.mjs) — 그래서 규격을 여기서 고정한다: 기계 사실 먼저, 추론 주체 마지막.
 */
function columnEvidence(table, column, model) {
  const parts = [`${table}.${column.name} ${column.type}`];
  if (column.nullable === false) parts.push("NOT NULL");
  const lines = [`catalog: ${parts.join(", ")}`];
  if (column.comment) lines.push(`comment: ${column.comment}`);
  lines.push(`llm: ${model} 추론`);
  return lines;
}

function purposeEvidence(describe, model) {
  const lines = [
    `catalog: ${describe.table} (컬럼 ${describe.columns.length}개, PK ${(describe.primaryKey ?? []).join("+") || "없음"})`,
  ];
  if (describe.tableComment) lines.push(`comment: ${describe.tableComment}`);
  lines.push(`llm: ${model} 추론`);
  return lines;
}

/**
 * @param {object} describe  describe_table 출력 (owner/table/columns/…)
 * @param {object|null} inference  parseInference() 결과 — 없으면 팩트만 채운다
 * @param {object} opts
 * @param {string} opts.fetchedAt  카탈로그 조회 시각 (호출자가 준다 = 결정적 테스트)
 * @param {string} [opts.model]  추론 모델 이름 — evidence 에 남는다
 * @param {"full"|"pointer"|"none"} [opts.inject]  신규 문서의 주입 강도 (기본 pointer)
 */
export function composeDbSchemaDoc(describe, inference, opts) {
  const owner = requireField(describe, "owner", "describe");
  const table = requireField(describe, "table", "describe");
  const fetchedAt = requireField(opts, "fetchedAt", "opts");
  const model = opts.model ?? "unknown";

  const catalog = toCatalog(describe, fetchedAt);

  const columnDescs = {};
  for (const column of catalog.columns) {
    columnDescs[column.name] = slotFor(
      inference?.columns?.[column.name],
      columnEvidence(table, column, model),
    );
  }

  return {
    schema: "db-schema/v1",
    id: docIdFor(owner, table),
    keywords: [{ kw: table.toLowerCase(), inject: opts.inject ?? "pointer" }],
    // 비활성으로 착지한다(akg #8). 조회·미리보기는 되고 주입만 안 된다 — 주입
    // 예산이 턴당 문서 2개뿐이라, 뼈대 수백 개가 사람이 확정한 문서와 같은 2칸을
    // 놓고 경쟁하면 안 된다. 활성화는 approver 가 문서를 보고 결정한다.
    // (배치 라우트도 서버에서 이 값을 강제하지만, 여기서 맞춰야 dry-run 출력이
    //  실제로 만들어질 문서와 같아진다.)
    status: "inactive",
    body: {
      owner,
      table,
      catalog,
      purpose: slotFor(inference?.purpose, purposeEvidence(describe, model)),
      columnDescs,
    },
  };
}

export { ComposeError };
