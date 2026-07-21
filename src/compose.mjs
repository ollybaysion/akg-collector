// describe_table 결과 + LLM 추론 → akg db-schema/v1 문서.
//
// 이 모듈이 팩트/슬롯 경계를 집행한다: catalog 는 DB 에서 온 값을 그대로 옮기고,
// 사람 해석의 자리(purpose·columnDescs)만 추론값으로 채운다. 추론은 언제나
// tier "inferred" 로 착지한다 — confirmed 는 사람만 만든다(akg D4, 서버도 강제).

const CATALOG_KEYS = [
  "columns",
  "primaryKey",
  "foreignKeys",
  "indexes",
  "numRows",
  "lastAnalyzed",
  "tableComment",
];

/** 사람이 손댄 슬롯은 수집기가 덮지 않는다 (설계 D5). */
const FROZEN_TIERS = new Set(["confirmed", "deprecated"]);

class ComposeError extends Error {}

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
 * 추론값 하나를 슬롯으로. 기존 슬롯이 confirmed/deprecated 면 그대로 둔다.
 * 값이 없으면 scaffold(빈칸) — 억지로 채우지 않는다.
 */
function mergeSlot(existing, text, evidence) {
  if (existing && FROZEN_TIERS.has(existing.tier)) return existing;
  if (typeof text === "string" && text.trim())
    return { text: text.trim(), tier: "inferred", evidence };
  return existing ?? { text: null, tier: "scaffold" };
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
 * 카탈로그에서 사라진 컬럼의 슬롯 처리 — 서버 catalog-push 와 같은 규칙
 * (server/routes/docs.mjs): 아무도 안 채운 빈칸은 삭제, 채워진 값은 폐기 표시로 보존.
 */
function carryOrphans(columnDescs, baseDescs, knownNames) {
  for (const [name, slot] of Object.entries(baseDescs)) {
    if (knownNames.has(name)) continue;
    if (slot.tier === "scaffold") continue;
    columnDescs[name] = { ...slot, tier: "deprecated" };
  }
}

/**
 * @param {object} describe  describe_table 출력 (owner/table/columns/…)
 * @param {object|null} inference  parseInference() 결과 — 없으면 팩트만 채운다
 * @param {object} opts
 * @param {string} opts.fetchedAt  카탈로그 조회 시각 (호출자가 준다 = 결정적 테스트)
 * @param {string} [opts.model]  추론 모델 이름 — evidence 에 남는다
 * @param {"full"|"pointer"|"none"} [opts.inject]  신규 문서의 주입 강도 (기본 pointer)
 * @param {object|null} [opts.base]  기존 akg 문서 — 있으면 사람 작업을 보존하며 병합
 */
export function composeDbSchemaDoc(describe, inference, opts) {
  const owner = requireField(describe, "owner", "describe");
  const table = requireField(describe, "table", "describe");
  const fetchedAt = requireField(opts, "fetchedAt", "opts");
  const model = opts.model ?? "unknown";
  const base = opts.base ?? null;

  const catalog = toCatalog(describe, fetchedAt);
  const knownNames = new Set(catalog.columns.map((c) => c.name));

  const baseDescs = base?.body?.columnDescs ?? {};
  const columnDescs = {};
  for (const column of catalog.columns) {
    columnDescs[column.name] = mergeSlot(
      baseDescs[column.name],
      inference?.columns?.[column.name],
      columnEvidence(table, column, model),
    );
  }
  carryOrphans(columnDescs, baseDescs, knownNames);

  const purpose = mergeSlot(
    base?.body?.purpose,
    inference?.purpose,
    purposeEvidence(describe, model),
  );

  const body = { owner, table, catalog, purpose, columnDescs };
  // queries 는 이 수집기가 만들지 않는다 — 기존 문서에 있으면 그대로 보존한다.
  if (base?.body?.queries) body.queries = base.body.queries;

  return {
    schema: "db-schema/v1",
    id: docIdFor(owner, table),
    keywords: base?.keywords ?? [
      { kw: table.toLowerCase(), inject: opts.inject ?? "pointer" },
    ],
    status: base?.status ?? "active",
    body,
  };
}

export { ComposeError };
