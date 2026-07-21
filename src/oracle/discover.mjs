// ① discover — 스키마 안의 대상 테이블 목록.
//
// run 은 주입된다(pool.mjs 의 관례) — 테스트가 실 Oracle 없이 매핑만 검증한다.

class DiscoverError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscoverError";
  }
}

const DISCOVER_SQL = `
  SELECT table_name AS table_name
  FROM all_tables
  WHERE owner = :owner
  ORDER BY table_name
`;

const DISCOVER_SQL_LIKE = `
  SELECT table_name AS table_name
  FROM all_tables
  WHERE owner = :owner
    AND table_name LIKE :like ESCAPE '\\'
  ORDER BY table_name
`;

/**
 * @param {(sql: string, binds: object) => Promise<object[]>} run
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} [opts.like]  Oracle LIKE 패턴 (예: 'FDC_%') — 없으면 스키마 전체
 * @returns {Promise<string[]>} 테이블명 목록 (owner 는 호출자가 이미 안다)
 */
export async function discoverTables(run, opts) {
  const owner = opts?.owner;
  if (!owner) throw new DiscoverError("owner 가 필요합니다");

  const rows = opts.like
    ? await run(DISCOVER_SQL_LIKE, { owner, like: opts.like })
    : await run(DISCOVER_SQL, { owner });

  return rows.map((row) => row.TABLE_NAME);
}

export { DiscoverError, DISCOVER_SQL, DISCOVER_SQL_LIKE };
