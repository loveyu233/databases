import { DatabaseType } from "../../types";

export function applySafetyLimit(sql: string, maxRows: number, type: DatabaseType): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (maxRows < 0 || !/^select\b/i.test(trimmed) || /\blimit\s+\d+/i.test(trimmed)) {
    return sql;
  }

  const safeLimit = Math.max(1, maxRows);
  return type === "postgres"
    ? `${trimmed} LIMIT ${safeLimit}`
    : `${trimmed} LIMIT ${safeLimit}`;
}

export function sliceRows<T>(rows: T[], maxRows: number): T[] {
  return maxRows < 0 ? rows : rows.slice(0, maxRows);
}
