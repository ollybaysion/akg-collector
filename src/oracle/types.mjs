// Oracle 카탈로그 행 → 사람이 읽는 타입 문자열 (예: VARCHAR2(20), NUMBER(18,6)).
//
// TIMESTAMP·CLOB 등은 DATA_TYPE 자체가 이미 완성형이라 손대지 않는다. 길이·정밀도가
// 별도 컬럼인 타입(문자열·NUMBER)만 조립한다.

const CHAR_TYPES = new Set(["VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR", "RAW"]);

/**
 * @param {{DATA_TYPE: string, CHAR_LENGTH?: number|null, DATA_LENGTH?: number|null,
 *          DATA_PRECISION?: number|null, DATA_SCALE?: number|null}} row  ALL_TAB_COLUMNS 행
 * @returns {string}
 */
export function formatType(row) {
  const type = row.DATA_TYPE;

  if (CHAR_TYPES.has(type))
    return `${type}(${row.CHAR_LENGTH ?? row.DATA_LENGTH})`;

  if (type === "NUMBER") {
    const precision = row.DATA_PRECISION;
    if (precision == null) return "NUMBER";
    const scale = row.DATA_SCALE;
    return scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
  }

  return type;
}
