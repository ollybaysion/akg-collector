// discover.mjs·describe.mjs 가 기대하는 run(sql, binds) 을 실제 Oracle 커넥션 풀로 구현한다.
//
// 이 파일만 `oracledb` 를 import 한다 — discover/describe 는 순수 매핑 로직이라 이 파일을
// 걸치지 않고도 테스트된다. 그래서 드라이버가 설치돼 있지 않아도 `npm test`는 그대로 돈다.

import oracledb from "oracledb";

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
// DATA_DEFAULT 등 CLOB 컬럼을 LOB 핸들이 아니라 문자열로 바로 받는다.
oracledb.fetchAsString = [oracledb.CLOB];

/**
 * @param {object} opts
 * @param {string} opts.user
 * @param {string} opts.password
 * @param {string} opts.connectString  예: "host:1521/service"
 * @param {number} [opts.poolMin]
 * @param {number} [opts.poolMax]
 * @returns {Promise<{run: (sql: string, binds?: object) => Promise<object[]>, close: () => Promise<void>}>}
 */
export async function createOraclePool(opts) {
  const pool = await oracledb.createPool({
    user: opts.user,
    password: opts.password,
    connectString: opts.connectString,
    poolMin: opts.poolMin ?? 0,
    poolMax: opts.poolMax ?? 4,
  });

  return {
    async run(sql, binds = {}) {
      const conn = await pool.getConnection();
      try {
        const result = await conn.execute(sql, binds);
        return result.rows;
      } finally {
        await conn.close();
      }
    },
    async close() {
      await pool.close(10);
    },
  };
}
