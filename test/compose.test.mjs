import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeDbSchemaDoc, docIdFor } from "../src/compose.mjs";
import { parseInference } from "../src/infer/parse.mjs";

const describe = JSON.parse(
  readFileSync(new URL("../fixtures/describe/fdc_sensor.json", import.meta.url)),
);
const rawResponse = readFileSync(
  new URL("../fixtures/infer/fdc_sensor.txt", import.meta.url),
  "utf8",
);

const FETCHED_AT = "2026-07-21T14:00:00Z";
const OPTS = { fetchedAt: FETCHED_AT, model: "inhouse-llm" };

const inference = () => parseInference(rawResponse, describe);

test("추론 없이 부르면 팩트만 있고 슬롯은 전부 빈칸이다", () => {
  const doc = composeDbSchemaDoc(describe, null, OPTS);

  assert.equal(doc.schema, "db-schema/v1");
  assert.equal(doc.id, "fdc_sensor");
  // 적재는 주입에 닿지 않는다(akg #8, 이 레포 #6) — 활성화는 approver 몫.
  assert.equal(doc.status, "inactive");
  assert.deepEqual(doc.body.purpose, { text: null, tier: "scaffold" });
  for (const name of ["SNSR_ID", "EQP_ID", "MEAS_TIME", "MEAS_VAL"])
    assert.deepEqual(doc.body.columnDescs[name], {
      text: null,
      tier: "scaffold",
    });
});

test("신규 문서의 기본 주입 강도는 pointer 다", () => {
  const doc = composeDbSchemaDoc(describe, null, OPTS);
  assert.deepEqual(doc.keywords, [{ kw: "fdc_sensor", inject: "pointer" }]);
});

test("id 는 lower(table) 이다 — owner 는 id 를 한정하지 않는다", () => {
  assert.equal(docIdFor("FDC_SENSOR"), "fdc_sensor");
});

test("카탈로그는 describe 를 그대로 옮기되 모르는 키는 버린다", () => {
  const noisy = { ...describe, rowCountEstimate: 1, extraJunk: { a: 1 } };
  const doc = composeDbSchemaDoc(noisy, null, OPTS);

  assert.deepEqual(Object.keys(doc.body.catalog).sort(), [
    "columns",
    "fetchedAt",
    "foreignKeys",
    "indexes",
    "lastAnalyzed",
    "numRows",
    "primaryKey",
    "tableComment",
  ]);
  assert.equal(doc.body.catalog.fetchedAt, FETCHED_AT);
  assert.equal(doc.body.catalog.numRows, 128374);
});

test("추론값은 inferred 로 착지하고 evidence 규격을 지킨다", () => {
  const doc = composeDbSchemaDoc(describe, inference(), OPTS);

  const slot = doc.body.columnDescs.EQP_ID;
  assert.equal(slot.tier, "inferred");
  assert.match(slot.text, /FDC_EQUIPMENT/);
  assert.deepEqual(slot.evidence, [
    "catalog: FDC_SENSOR.EQP_ID VARCHAR2(20), NOT NULL",
    "llm: inhouse-llm 추론",
  ]);

  // 카탈로그 코멘트가 있으면 근거에 함께 남는다.
  assert.deepEqual(doc.body.columnDescs.SNSR_ID.evidence, [
    "catalog: FDC_SENSOR.SNSR_ID VARCHAR2(20), NOT NULL",
    "comment: 센서 식별자",
    "llm: inhouse-llm 추론",
  ]);
});

test("모델이 빠뜨린 컬럼은 근거 없는 빈칸으로 남는다", () => {
  const doc = composeDbSchemaDoc(describe, inference(), OPTS);
  assert.deepEqual(doc.body.columnDescs.MEAS_VAL, {
    text: null,
    tier: "scaffold",
  });
});

test("환각 컬럼은 문서에 들어가지 않는다", () => {
  const doc = composeDbSchemaDoc(describe, inference(), OPTS);
  assert.equal(doc.body.columnDescs.MEAS_VALUE, undefined);
  assert.equal(doc.body.columnDescs.CREATED_BY, undefined);
});

test("기존 문서를 병합하지 않는다 — 언제나 신규 문서 모양으로 만든다", () => {
  // 정책: akg 에 이미 문서가 있는 테이블은 push 단계에서 통째로 스킵한다(수집 결과를
  // 버린다). compose 는 병합을 모르며, base 같은 걸 넘겨도 무시한다.
  const doc = composeDbSchemaDoc(describe, null, {
    ...OPTS,
    base: { keywords: [{ kw: "x", inject: "full" }], status: "archived" },
  });

  assert.deepEqual(doc.keywords, [{ kw: "fdc_sensor", inject: "pointer" }]);
  assert.equal(doc.status, "inactive");
  assert.equal(doc.body.queries, undefined);
});

test("describe 에 owner/table 이 없으면 거부한다", () => {
  assert.throws(() => composeDbSchemaDoc({ columns: [] }, null, OPTS), {
    message: /owner/,
  });
});
