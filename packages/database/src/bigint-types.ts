import { types, type CustomTypesConfig } from 'pg';

// The OID of PostgreSQL's `int8` type, which is what `BIGINT` is called on the wire.
const INT8_OID = 20;

/** Converts the text that PostgreSQL sends for one value. */
export type TypeParser = (value: string) => unknown;

function parseBigint(value: string): bigint {
  return BigInt(value);
}

/**
 * Chooses the parser for a column type: `BIGINT` becomes a `bigint` and every
 * other type keeps the parser that `pg` ships.
 */
export function getTypeParserWithBigint(
  oid: number,
  format?: 'text' | 'binary',
): TypeParser {
  if (oid === INT8_OID && format !== 'binary') {
    return parseBigint;
  }
  // `pg-types` declares the parser it returns as `any`; this is the only place
  // where it is narrowed.
  return types.getTypeParser(oid, format) as TypeParser;
}

/**
 * Type parsers for one pool. They are attached to the pool instead of
 * registered with `pg.types.setTypeParser`, which is global to the process and
 * would also change every other client created in it.
 *
 * Only `int8` itself is converted. `COUNT(*)` is an `int8`, so it arrives as a
 * `bigint` too, while `numeric` results such as `SUM` over a `BIGINT` column
 * and `BIGINT[]` arrays keep the strings that `pg` returns for them.
 */
export const bigintTypes: CustomTypesConfig = {
  getTypeParser: getTypeParserWithBigint,
};
