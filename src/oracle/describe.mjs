// ② describe — 테이블 하나의 구조 (컬럼·타입·NULL·코멘트·PK·FK·인덱스).
//
// 출력 shape 은 fixtures/describe/fdc_sensor.json 과 정확히 같아야 한다 — compose.mjs·
// infer/prompt.mjs 가 이미 그 shape 을 계약으로 삼고 있다. 여기서 새로 정의하지 않는다.
//
// 5개 조회는 서로 독립이라 병렬로 던진다. run 은 주입된다(pool.mjs 의 관례) — 테스트는
// 가짜 run 으로 매핑 로직만 검증하고 실 Oracle 은 타지 않는다.

import { formatType } from "./types.mjs";

class DescribeError extends Error {
  constructor(message) {
    super(message);
    this.name = "DescribeError";
  }
}

const COLUMNS_SQL = `
  SELECT c.column_name    AS column_name,
         c.data_type      AS data_type,
         c.char_length    AS char_length,
         c.data_length    AS data_length,
         c.data_precision AS data_precision,
         c.data_scale     AS data_scale,
         c.nullable       AS nullable,
         c.data_default   AS data_default,
         cc.comments      AS comment
  FROM all_tab_columns c
  LEFT JOIN all_col_comments cc
    ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
  WHERE c.owner = :owner AND c.table_name = :table
  ORDER BY c.column_id
`;

const STATS_SQL = `
  SELECT t.num_rows      AS num_rows,
         t.last_analyzed AS last_analyzed,
         tc.comments     AS table_comment
  FROM all_tables t
  LEFT JOIN all_tab_comments tc ON tc.owner = t.owner AND tc.table_name = t.table_name
  WHERE t.owner = :owner AND t.table_name = :table
`;

const PK_SQL = `
  SELECT cc.column_name AS column_name
  FROM all_constraints c
  JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
  WHERE c.owner = :owner AND c.table_name = :table AND c.constraint_type = 'P'
  ORDER BY cc.position
`;

// r_owner/r_constraint_name 을 곧장 join 해서 참조 테이블·컬럼까지 한 번에 가져온다 —
// 앱 쪽에서 로컬/참조 컬럼을 position 으로 다시 짝지을 필요가 없다.
const FK_SQL = `
  SELECT c.constraint_name AS constraint_name,
         cc.column_name    AS column_name,
         r.table_name      AS ref_table,
         rc.column_name    AS ref_column
  FROM all_constraints c
  JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
  JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
  JOIN all_cons_columns rc
    ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
  WHERE c.owner = :owner AND c.table_name = :table AND c.constraint_type = 'R'
  ORDER BY c.constraint_name, cc.position
`;

// PK/UNIQUE 제약이 만든 백업 인덱스는 뺀다 — primaryKey 필드와 중복이다.
const INDEXES_SQL = `
  SELECT ic.index_name AS index_name,
         i.uniqueness  AS uniqueness,
         ic.column_name AS column_name
  FROM all_indexes i
  JOIN all_ind_columns ic
    ON ic.index_owner = i.owner AND ic.index_name = i.index_name AND ic.table_name = i.table_name
  WHERE i.table_owner = :owner AND i.table_name = :table
    AND NOT EXISTS (
      SELECT 1 FROM all_constraints con
      WHERE con.owner = i.owner AND con.table_name = i.table_name
        AND con.constraint_type IN ('P', 'U') AND con.index_name = i.index_name
    )
  ORDER BY ic.index_name, ic.column_position
`;

/** Oracle 이 돌려주는 DATA_DEFAULT 는 뒤에 개행이 붙는 CLOB 텍스트다. 빈 값은 null. */
function normalizeDefault(value) {
  if (typeof value !== "string") return value ?? null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** oracledb 는 DATE/TIMESTAMP 열을 JS Date 로 돌려준다. 자정 UTC 는 밀리초를 떼서 남긴다. */
function normalizeDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace(".000Z", "Z");
}

function groupIndexes(rows) {
  const byName = new Map();
  for (const row of rows) {
    if (!byName.has(row.INDEX_NAME))
      byName.set(row.INDEX_NAME, {
        name: row.INDEX_NAME,
        unique: row.UNIQUENESS === "UNIQUE",
        columns: [],
      });
    byName.get(row.INDEX_NAME).columns.push(row.COLUMN_NAME);
  }
  return [...byName.values()];
}

/**
 * @param {(sql: string, binds: object) => Promise<object[]>} run
 * @param {string} owner
 * @param {string} table
 * @returns {Promise<object>} fixtures/describe/*.json 과 같은 shape
 */
export async function describeTable(run, owner, table) {
  if (!owner || !table)
    throw new DescribeError("owner/table 이 필요합니다");

  const [columnRows, statsRows, pkRows, fkRows, indexRows] = await Promise.all([
    run(COLUMNS_SQL, { owner, table }),
    run(STATS_SQL, { owner, table }),
    run(PK_SQL, { owner, table }),
    run(FK_SQL, { owner, table }),
    run(INDEXES_SQL, { owner, table }),
  ]);

  if (columnRows.length === 0)
    throw new DescribeError(`${owner}.${table}: 컬럼을 찾지 못했습니다 (테이블이 없나?)`);

  const stats = statsRows[0] ?? {};

  return {
    owner,
    table,
    columns: columnRows.map((row) => ({
      name: row.COLUMN_NAME,
      type: formatType(row),
      nullable: row.NULLABLE === "Y",
      default: normalizeDefault(row.DATA_DEFAULT),
      comment: row.COMMENT ?? null,
    })),
    primaryKey: pkRows.map((row) => row.COLUMN_NAME),
    foreignKeys: fkRows.map((row) => ({
      column: row.COLUMN_NAME,
      refTable: row.REF_TABLE,
      refColumn: row.REF_COLUMN,
    })),
    indexes: groupIndexes(indexRows),
    numRows: stats.NUM_ROWS ?? null,
    lastAnalyzed: normalizeDate(stats.LAST_ANALYZED),
    tableComment: stats.TABLE_COMMENT ?? null,
  };
}

export { DescribeError, COLUMNS_SQL, STATS_SQL, PK_SQL, FK_SQL, INDEXES_SQL };
