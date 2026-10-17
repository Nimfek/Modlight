/**
 * A tiny in-memory stand-in for the Drizzle client, good enough to run
 * lib/folders.ts for real.
 *
 * Why not the usual "every builder method returns the same thenable" proxy
 * (tests/unit/api-caller.test.ts): that proxy ignores the WHERE clause, and the
 * WHERE clause is the entire subject here. The rule under test is that ownership
 * is folded into the query rather than checked afterwards — a stub that answers
 * the same rows whatever it is asked cannot tell a scoped query from an
 * unscoped one, so it would pass just as happily against code with the
 * ownership check deleted.
 *
 * So this one PARSES the predicate. Drizzle's `SQL` object is a tree of chunks:
 * a leaf is [Column, " = ", Param], `and()` joins leaves with " and ", and
 * `is null` / `in (...)` are the same shape with a different operator chunk.
 * Walking that gives a real row filter, which means deleting
 * `eq(folders.ownerId, userId)` from the production code makes a test go red
 * instead of green.
 *
 * Scope: exactly the query shapes lib/folders.ts and lib/data/folders.ts use.
 * Anything else throws loudly rather than quietly returning nothing — a fake
 * that shrugs is how a test ends up asserting the fake.
 */

import { folders as foldersTable, uploads as uploadsTable } from "@/lib/db/schema";

/* -------------------------------------------------------------------------- */
/* Table metadata                                                              */
/* -------------------------------------------------------------------------- */

export type Row = Record<string, unknown>;

interface TableMeta {
  name: string;
  /** snake_case column name -> the camelCase property rows are stored under. */
  byColumn: Map<string, string>;
}

function isColumn(v: unknown): v is { name: string; table: unknown } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { name?: unknown }).name === "string" &&
    (v as { table?: unknown }).table !== undefined
  );
}

function metaOf(table: object, name: string): TableMeta {
  const byColumn = new Map<string, string>();
  for (const [key, value] of Object.entries(table)) {
    if (isColumn(value)) byColumn.set(value.name, key);
  }
  return { name, byColumn };
}

const META = new Map<object, TableMeta>([
  [foldersTable, metaOf(foldersTable, "folders")],
  [uploadsTable, metaOf(uploadsTable, "uploads")],
]);

/* -------------------------------------------------------------------------- */
/* Predicate parsing                                                           */
/* -------------------------------------------------------------------------- */

interface Chunkish {
  queryChunks?: unknown[];
  value?: unknown;
  encoder?: unknown;
}

const chunksOf = (node: unknown): unknown[] | null => {
  const c = (node as Chunkish)?.queryChunks;
  return Array.isArray(c) ? c : null;
};
const isStringChunk = (v: unknown): v is { value: string[] } =>
  typeof v === "object" && v !== null && Array.isArray((v as Chunkish).value);
const isParam = (v: unknown): v is { value: unknown } =>
  typeof v === "object" && v !== null && (v as Chunkish).encoder !== undefined;

export type Predicate = (row: Row) => boolean;

/** Always-true, for a query with no WHERE at all. */
const ALWAYS: Predicate = () => true;

/** Every bound value under these chunks, in order. */
function paramsIn(nodes: unknown[], out: unknown[] = []): unknown[] {
  for (const node of nodes) {
    if (isParam(node)) {
      out.push(node.value);
      continue;
    }
    // `inArray` emits its values as a plain Array chunk, not a nested SQL node.
    if (Array.isArray(node)) {
      paramsIn(node, out);
      continue;
    }
    const nested = chunksOf(node);
    if (nested) paramsIn(nested, out);
  }
  return out;
}

function parseLeaf(chunks: unknown[], meta: TableMeta): Predicate {
  const columnIndex = chunks.findIndex(isColumn);
  const column = chunks[columnIndex] as { name: string };
  const key = meta.byColumn.get(column.name);
  if (!key) throw new Error(`fake-db: column ${column.name} is not on ${meta.name}`);

  const opChunk = chunks[columnIndex + 1];
  const op = isStringChunk(opChunk) ? opChunk.value.join("") : "";
  // Recursively, because `inArray` puts its list in a nested SQL node rather
  // than flat alongside the column.
  const values = paramsIn(chunks.slice(columnIndex + 1));

  if (/is not null/.test(op)) return (row) => row[key] !== null && row[key] !== undefined;
  if (/is null/.test(op)) return (row) => row[key] === null || row[key] === undefined;
  if (/\bin\b/.test(op)) return (row) => values.includes(row[key]);
  if (/=/.test(op)) return (row) => row[key] === values[0];

  throw new Error(`fake-db: unsupported operator "${op}" on ${meta.name}.${column.name}`);
}

export function parsePredicate(node: unknown, meta: TableMeta): Predicate {
  if (node === undefined || node === null) return ALWAYS;

  const chunks = chunksOf(node);
  if (!chunks) throw new Error("fake-db: WHERE clause is not a Drizzle SQL object");

  if (chunks.some(isColumn)) return parseLeaf(chunks, meta);

  // A composite: nested SQL nodes joined by literal chunks. The joining WORD is
  // read rather than assumed: treating an `or` as an `and` would make an
  // over-broad query look correctly scoped, which is the one mistake this whole
  // helper exists to catch. Drizzle never flattens a mixed group (an `or()`
  // nested inside an `and()` is its own SQL node), so a group carrying both
  // words is something this parser does not understand, and it says so rather
  // than picking one.
  const parts: Predicate[] = [];
  const joiners = new Set<"and" | "or">();
  for (const chunk of chunks) {
    if (isStringChunk(chunk)) {
      const text = chunk.value.join("");
      if (/\bor\b/.test(text)) joiners.add("or");
      if (/\band\b/.test(text)) joiners.add("and");
      continue;
    }
    if (chunksOf(chunk)) parts.push(parsePredicate(chunk, meta));
  }
  if (!parts.length) throw new Error("fake-db: could not parse WHERE clause");
  if (joiners.size > 1) throw new Error("fake-db: mixed AND/OR in one group");
  if (joiners.has("or")) return (row) => parts.some((p) => p(row));
  return (row) => parts.every((p) => p(row));
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface Store {
  folders: Row[];
  uploads: Row[];
}

export const store: Store = { folders: [], uploads: [] };

/** Every WHERE-bearing statement, so a test can assert on how it was scoped. */
export interface Statement {
  op: "select" | "insert" | "update" | "delete";
  table: string;
  /** snake_case column names appearing in the WHERE clause. */
  whereColumns: string[];
  set?: Row;
  values?: Row;
  inTransaction: boolean;
}

export const statements: Statement[] = [];

let uuidSeq = 0;

export function resetDb(seed: Partial<Store> = {}): void {
  store.folders = (seed.folders ?? []).map((r) => ({ ...r }));
  store.uploads = (seed.uploads ?? []).map((r) => ({ ...r }));
  statements.length = 0;
  uuidSeq = 0;
}

/** A syntactically valid uuid, so ids made here survive the shape check. */
export function fakeUuid(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function columnsIn(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== "object") return out;
  if (isColumn(node)) out.add(node.name);
  const chunks = chunksOf(node);
  if (chunks) for (const c of chunks) columnsIn(c, out);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

function rowsOf(meta: TableMeta): Row[] {
  return meta.name === "folders" ? store.folders : store.uploads;
}

/**
 * The literal SQL text of a node, used only to recognise which aggregate a
 * `sql\`...\`` field is asking for. Built by walking chunks rather than by
 * JSON.stringify, which cannot serialise these at all: a Column holds a
 * reference back to its table, and the table holds its columns.
 */
function renderText(node: unknown, depth = 0): string {
  if (!node || typeof node !== "object" || depth > 12) return "";
  if (isStringChunk(node)) return node.value.join("");
  const parts: string[] = [];
  const chunks = chunksOf(node) ?? (Array.isArray(node) ? node : null);
  if (chunks) for (const c of chunks) parts.push(renderText(c, depth + 1));
  return parts.join("");
}

/** Render a projection, which is either columns or one of two aggregates. */
function project(fields: Record<string, unknown> | undefined, matched: Row[], meta: TableMeta) {
  if (!fields) return matched.map((r) => ({ ...r }));

  const aggregates = Object.entries(fields).filter(([, f]) => !isColumn(f));
  if (aggregates.length) {
    const out: Row = {};
    for (const [key, field] of Object.entries(fields)) {
      if (isColumn(field)) {
        out[key] = matched[0]?.[meta.byColumn.get(field.name)!];
        continue;
      }
      const text = renderText(field);
      if (/count\(/.test(text)) out[key] = matched.length;
      else if (/sum\(/.test(text)) {
        out[key] = String(matched.reduce((n, r) => n + Number(r.size ?? 0), 0));
      } else throw new Error(`fake-db: unsupported aggregate for field "${key}"`);
    }
    return [out];
  }

  return matched.map((r) => {
    const out: Row = {};
    for (const [key, field] of Object.entries(fields)) {
      out[key] = r[meta.byColumn.get((field as { name: string }).name)!];
    }
    return out;
  });
}

interface BuilderState {
  op: Statement["op"];
  meta?: TableMeta;
  fields?: Record<string, unknown>;
  where?: unknown;
  limit?: number;
  set?: Row;
  values?: Row;
  returning: boolean;
  inTransaction: boolean;
}

function run(state: BuilderState): Row[] {
  const meta = state.meta;
  if (!meta) throw new Error("fake-db: statement never named a table");

  const rows = rowsOf(meta);
  const match = parsePredicate(state.where, meta);

  statements.push({
    op: state.op,
    table: meta.name,
    whereColumns: [...columnsIn(state.where)],
    set: state.set,
    values: state.values,
    inTransaction: state.inTransaction,
  });

  if (state.op === "select") {
    let matched = rows.filter(match);
    if (state.limit !== undefined) matched = matched.slice(0, state.limit);
    return project(state.fields, matched, meta);
  }

  if (state.op === "insert") {
    const row: Row = {
      id: fakeUuid(++uuidSeq),
      isPublic: false,
      sortOrder: 0,
      description: null,
      coverUploadId: null,
      createdAt: new Date(),
      ...state.values,
    };
    rows.push(row);
    return [{ ...row }];
  }

  if (state.op === "update") {
    const touched = rows.filter(match);
    for (const row of touched) Object.assign(row, state.set);
    return touched.map((r) => ({ ...r }));
  }

  // delete
  const kept = rows.filter((r) => !match(r));
  const removed = rows.filter(match);
  if (meta.name === "folders") store.folders = kept;
  else store.uploads = kept;
  return removed;
}

function builder(state: BuilderState): unknown {
  const self: Record<string, unknown> = {
    from(table: object) {
      state.meta = META.get(table);
      if (!state.meta) throw new Error("fake-db: unknown table");
      return self;
    },
    where(cond: unknown) {
      state.where = cond;
      return self;
    },
    set(v: Row) {
      state.set = v;
      return self;
    },
    values(v: Row) {
      state.values = v;
      return self;
    },
    returning(fields?: Record<string, unknown>) {
      state.returning = true;
      if (fields) state.fields = fields;
      return self;
    },
    limit(n: number) {
      state.limit = n;
      return self;
    },
    orderBy: () => self,
    groupBy: () => self,
    leftJoin: () => self,
    as: () => self,
    then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) {
      let result: Row[];
      try {
        result = run(state);
      } catch (e) {
        return err ? Promise.resolve().then(() => err(e)) : Promise.reject(e);
      }
      // `returning({...})` on an update projects; a plain returning() does not.
      const projected =
        state.op !== "select" && state.fields
          ? project(state.fields, result, state.meta!)
          : result;
      return Promise.resolve(projected).then(ok, err);
    },
    catch(err: (e: unknown) => unknown) {
      return (self.then as (a: unknown, b: unknown) => Promise<unknown>)((v: unknown) => v, err);
    },
  };
  return self;
}

/**
 * The Drizzle-shaped surface lib/folders.ts talks to. Declared rather than
 * inferred because `transaction` hands a client to its callback, which makes the
 * inferred type self-referential.
 */
export interface FakeClient {
  select: (fields?: unknown) => unknown;
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
  delete: (table: unknown) => unknown;
  transaction: <T>(cb: (tx: FakeClient) => Promise<T>) => Promise<T>;
}

function client(inTransaction: boolean): FakeClient {
  const start = (op: Statement["op"], fieldsOrTable?: unknown) => {
    const state: BuilderState = { op, returning: false, inTransaction };
    if (op === "select") {
      if (fieldsOrTable) state.fields = fieldsOrTable as Record<string, unknown>;
    } else {
      state.meta = META.get(fieldsOrTable as object);
      if (!state.meta) throw new Error("fake-db: unknown table");
    }
    return builder(state);
  };

  return {
    select: (fields?: unknown) => start("select", fields),
    insert: (table: unknown) => start("insert", table),
    update: (table: unknown) => start("update", table),
    delete: (table: unknown) => start("delete", table),
    // No rollback: nothing under test depends on one, and pretending to offer
    // it would be a worse lie than not offering it.
    transaction: async <T>(cb: (tx: FakeClient) => Promise<T>): Promise<T> => cb(client(true)),
  };
}

export const db = client(false);

/** Statements recorded against one table, in order. */
export function statementsFor(table: string, op?: Statement["op"]): Statement[] {
  return statements.filter((s) => s.table === table && (!op || s.op === op));
}
