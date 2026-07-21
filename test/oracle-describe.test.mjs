import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  describeTable,
  DescribeError,
  COLUMNS_SQL,
  STATS_SQL,
  PK_SQL,
  FK_SQL,
  INDEXES_SQL,
} from "../src/oracle/describe.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/describe/fdc_sensor.json", import.meta.url)),
);

// fixtures/describe/fdc_sensor.json 을 만들어낼 법한 원시 Oracle 카탈로그 행 — describe.mjs
// 의 SQL 을 실제로 돌리는 게 아니라, run() 이 이런 shape 을 돌려준다고 가정하고 매핑만 검증한다.
const RAW = {
  columns: [
    {
      COLUMN_NAME: "SNSR_ID",
      DATA_TYPE: "VARCHAR2",
      CHAR_LENGTH: 20,
      DATA_LENGTH: 20,
      DATA_PRECISION: null,
      DATA_SCALE: null,
      NULLABLE: "N",
      DATA_DEFAULT: null,
      COMMENT: "센서 식별자",
    },
    {
      COLUMN_NAME: "EQP_ID",
      DATA_TYPE: "VARCHAR2",
      CHAR_LENGTH: 20,
      DATA_LENGTH: 20,
      DATA_PRECISION: null,
      DATA_SCALE: null,
      NULLABLE: "N",
      DATA_DEFAULT: null,
      COMMENT: null,
    },
    {
      COLUMN_NAME: "MEAS_TIME",
      DATA_TYPE: "DATE",
      CHAR_LENGTH: null,
      DATA_LENGTH: 7,
      DATA_PRECISION: null,
      DATA_SCALE: null,
      NULLABLE: "N",
      DATA_DEFAULT: null,
      COMMENT: null,
    },
    {
      COLUMN_NAME: "MEAS_VAL",
      DATA_TYPE: "NUMBER",
      CHAR_LENGTH: null,
      DATA_LENGTH: 22,
      DATA_PRECISION: 18,
      DATA_SCALE: 6,
      NULLABLE: "Y",
      DATA_DEFAULT: null,
      COMMENT: null,
    },
  ],
  stats: [
    {
      NUM_ROWS: 128374,
      LAST_ANALYZED: new Date("2026-07-20T00:00:00Z"),
      TABLE_COMMENT: "설비 센서 계측 이력",
    },
  ],
  pk: [{ COLUMN_NAME: "SNSR_ID" }, { COLUMN_NAME: "MEAS_TIME" }],
  fk: [{ COLUMN_NAME: "EQP_ID", REF_TABLE: "FDC_EQUIPMENT", REF_COLUMN: "EQP_ID" }],
  indexes: [
    { INDEX_NAME: "IX_FDC_SENSOR_EQP", UNIQUENESS: "NONUNIQUE", COLUMN_NAME: "EQP_ID" },
    { INDEX_NAME: "IX_FDC_SENSOR_EQP", UNIQUENESS: "NONUNIQUE", COLUMN_NAME: "MEAS_TIME" },
  ],
};

function fakeRun(overrides = {}) {
  const table = { ...RAW, ...overrides };
  return async (sql) => {
    if (sql === COLUMNS_SQL) return table.columns;
    if (sql === STATS_SQL) return table.stats;
    if (sql === PK_SQL) return table.pk;
    if (sql === FK_SQL) return table.fk;
    if (sql === INDEXES_SQL) return table.indexes;
    throw new Error(`fakeRun: 모르는 SQL — ${sql}`);
  };
}

test("원시 카탈로그 행을 조립하면 기존 describe 픽스처와 완전히 같다", async () => {
  const describe = await describeTable(fakeRun(), "TESTUSER", "FDC_SENSOR");
  assert.deepEqual(describe, fixture);
});

test("owner/table 없이는 던진다", async () => {
  await assert.rejects(() => describeTable(fakeRun(), "", "FDC_SENSOR"), DescribeError);
  await assert.rejects(() => describeTable(fakeRun(), "TESTUSER", ""), DescribeError);
});

test("컬럼이 하나도 없으면 테이블이 없는 것으로 보고 던진다", async () => {
  await assert.rejects(
    () => describeTable(fakeRun({ columns: [] }), "TESTUSER", "NOPE"),
    DescribeError,
  );
});

test("PK·UNIQUE 제약이 만든 인덱스는 제외한다 — SQL 의 NOT EXISTS 가 이미 걸러 보낸다고 가정", async () => {
  // fakeRun 이 이미 필터링된 결과를 흉내내므로, 여기서는 그 결과가 그대로 통과하는지만 본다.
  const describe = await describeTable(fakeRun(), "TESTUSER", "FDC_SENSOR");
  assert.equal(describe.indexes.length, 1);
  assert.deepEqual(describe.indexes[0], {
    name: "IX_FDC_SENSOR_EQP",
    unique: false,
    columns: ["EQP_ID", "MEAS_TIME"],
  });
});

test("DATA_DEFAULT 의 개행·공백을 정리하고, 빈 문자열은 null 로 남긴다", async () => {
  const describe = await describeTable(
    fakeRun({
      columns: [
        { ...RAW.columns[0], DATA_DEFAULT: " 'N' \n" },
        { ...RAW.columns[1], DATA_DEFAULT: "   " },
      ],
    }),
    "TESTUSER",
    "FDC_SENSOR",
  );
  assert.equal(describe.columns[0].default, "'N'");
  assert.equal(describe.columns[1].default, null);
});
