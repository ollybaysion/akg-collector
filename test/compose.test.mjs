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
  assert.equal(doc.id, "testuser.fdc_sensor");
  assert.equal(doc.status, "active");
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

test("id 는 lower(owner.table) 이다", () => {
  assert.equal(docIdFor("TESTUSER", "FDC_SENSOR"), "testuser.fdc_sensor");
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

test("모델이 빠뜨린 컬럼은 빈칸으로 남는다", () => {
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

test("confirmed 슬롯은 절대 덮지 않는다", () => {
  const base = {
    schema: "db-schema/v1",
    id: "testuser.fdc_sensor",
    keywords: [{ kw: "fdc_sensor", inject: "full" }],
    status: "active",
    body: {
      owner: "TESTUSER",
      table: "FDC_SENSOR",
      catalog: { columns: [], primaryKey: [], fetchedAt: "2026-01-01T00:00:00Z" },
      purpose: {
        text: "사람이 확정한 설명",
        tier: "confirmed",
        evidence: ["사람 검토"],
      },
      columnDescs: {
        EQP_ID: { text: "확정된 컬럼 설명", tier: "confirmed", evidence: ["x"] },
      },
    },
  };

  const doc = composeDbSchemaDoc(describe, inference(), { ...OPTS, base });

  assert.deepEqual(doc.body.purpose, base.body.purpose);
  assert.deepEqual(doc.body.columnDescs.EQP_ID, base.body.columnDescs.EQP_ID);
  // 확정 안 된 슬롯은 정상적으로 갱신된다.
  assert.equal(doc.body.columnDescs.MEAS_TIME.tier, "inferred");
});

test("기존 문서의 keywords·status 는 보존한다", () => {
  const base = {
    schema: "db-schema/v1",
    id: "testuser.fdc_sensor",
    keywords: [{ kw: "fdc_sensor", inject: "full" }],
    status: "archived",
    body: {
      owner: "TESTUSER",
      table: "FDC_SENSOR",
      catalog: { columns: [], primaryKey: [], fetchedAt: "2026-01-01T00:00:00Z" },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: {},
    },
  };

  const doc = composeDbSchemaDoc(describe, null, { ...OPTS, base });

  // 재수집이 사람이 올려둔 주입 강도를 pointer 로 되돌리면 안 된다.
  assert.deepEqual(doc.keywords, [{ kw: "fdc_sensor", inject: "full" }]);
  assert.equal(doc.status, "archived");
});

test("사라진 컬럼: 빈칸은 삭제하고 채워진 값은 deprecated 로 보존한다", () => {
  const base = {
    schema: "db-schema/v1",
    id: "testuser.fdc_sensor",
    keywords: [{ kw: "fdc_sensor", inject: "pointer" }],
    status: "active",
    body: {
      owner: "TESTUSER",
      table: "FDC_SENSOR",
      catalog: { columns: [], primaryKey: [], fetchedAt: "2026-01-01T00:00:00Z" },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: {
        GONE_EMPTY: { text: null, tier: "scaffold" },
        GONE_FILLED: {
          text: "없어진 컬럼의 설명",
          tier: "confirmed",
          evidence: ["사람 검토"],
        },
      },
    },
  };

  const doc = composeDbSchemaDoc(describe, null, { ...OPTS, base });

  assert.equal(doc.body.columnDescs.GONE_EMPTY, undefined);
  assert.deepEqual(doc.body.columnDescs.GONE_FILLED, {
    text: "없어진 컬럼의 설명",
    tier: "deprecated",
    evidence: ["사람 검토"],
  });
});

test("기존 queries 는 건드리지 않는다", () => {
  const base = {
    schema: "db-schema/v1",
    id: "testuser.fdc_sensor",
    keywords: [{ kw: "fdc_sensor", inject: "pointer" }],
    status: "active",
    body: {
      owner: "TESTUSER",
      table: "FDC_SENSOR",
      catalog: { columns: [], primaryKey: [], fetchedAt: "2026-01-01T00:00:00Z" },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: {},
      queries: [{ note: { text: "대표 쿼리", tier: "confirmed", evidence: ["x"] }, sql: "SELECT 1" }],
    },
  };

  const doc = composeDbSchemaDoc(describe, null, { ...OPTS, base });
  assert.deepEqual(doc.body.queries, base.body.queries);
});
