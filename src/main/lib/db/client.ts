import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
    AppStateRow,
    SchemaStateRow,
    SettingRow,
    TableColumnSpec,
    TableForeignKeySpec,
    TableIndexSpec,
    TableSpec,
} from "./schema";

import { APP_SCHEMA_VERSION, TABLE_SPECS } from "./schema";

type SqlValue = string | number | bigint | Uint8Array | Buffer | null;
type SqlParams = SqlValue[];
type TableInfoRow = {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
};
type ForeignKeyRow = {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
};
type IndexListRow = {
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
};
type IndexInfoRow = {
    seqno: number;
    cid: number;
    name: string;
};
type ExistingTableShape = {
    tableName: string;
    columns: TableInfoRow[];
    foreignKeys: TableForeignKeySpec[];
    indexes: TableIndexSpec[];
};
type ReconcileCandidate = {
    spec: TableSpec;
    actualName: string | null;
    shape: ExistingTableShape | null;
};
type NonPromise<T> = T extends PromiseLike<unknown> ? never : T;

function quoteIdentifier(value: string) {
    return `"${value.replaceAll('"', '""')}"`;
}

function normalizeDefaultSql(value: string | null | undefined) {
    if (value == null) {
        return null;
    }

    let normalized = value.trim();
    while (normalized.startsWith("(") && normalized.endsWith(")") && normalized.length > 1) {
        normalized = normalized.slice(1, -1).trim();
    }

    return normalized.toUpperCase() === "NULL" ? "NULL" : normalized;
}

function normalizeType(value: string | null | undefined) {
    return (value ?? "").trim().toUpperCase();
}

function sortStrings(values: string[]) {
    return [...values].sort((left, right) => left.localeCompare(right));
}

function normalizeForeignKeySignature(foreignKey: TableForeignKeySpec) {
    return JSON.stringify({
        columns: foreignKey.columns,
        onDelete: foreignKey.onDelete ?? "no action",
        onUpdate: foreignKey.onUpdate ?? "no action",
        refColumns: foreignKey.refColumns,
        refTable: foreignKey.refTable,
    });
}

function normalizeIndexSignature(index: TableIndexSpec) {
    return JSON.stringify({
        columns: index.columns,
        name: index.name,
        unique: Boolean(index.unique),
    });
}

function normalizeSqlValue(value: SqlValue) {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    return value;
}

function buildColumnDefinition(column: TableColumnSpec, compositePrimaryKey?: string[]) {
    const parts = [quoteIdentifier(column.name), column.type];
    if (column.primaryKey && !compositePrimaryKey) {
        parts.push("PRIMARY KEY");
    }
    if (column.notNull) {
        parts.push("NOT NULL");
    }
    if (column.defaultSql != null) {
        parts.push(`DEFAULT ${column.defaultSql}`);
    }
    return parts.join(" ");
}

function buildCreateTableSql(spec: TableSpec, tableName = spec.name) {
    const compositePrimaryKey =
        spec.compositePrimaryKey && spec.compositePrimaryKey.length > 0
            ? spec.compositePrimaryKey
            : null;
    const definitions = spec.columns.map((column) =>
        buildColumnDefinition(column, compositePrimaryKey ?? undefined),
    );

    if (compositePrimaryKey) {
        definitions.push(`PRIMARY KEY (${compositePrimaryKey.map(quoteIdentifier).join(", ")})`);
    }

    for (const foreignKey of spec.foreignKeys ?? []) {
        definitions.push(
            [
                `FOREIGN KEY (${foreignKey.columns.map(quoteIdentifier).join(", ")})`,
                `REFERENCES ${quoteIdentifier(foreignKey.refTable)} (${foreignKey.refColumns
                    .map(quoteIdentifier)
                    .join(", ")})`,
                `ON DELETE ${(foreignKey.onDelete ?? "no action").toUpperCase()}`,
                `ON UPDATE ${(foreignKey.onUpdate ?? "no action").toUpperCase()}`,
            ].join(" "),
        );
    }

    return `CREATE TABLE ${quoteIdentifier(tableName)} (${definitions.join(", ")})`;
}

function buildIndexSql(tableName: string, index: TableIndexSpec) {
    return [
        "CREATE",
        index.unique ? "UNIQUE" : null,
        "INDEX IF NOT EXISTS",
        quoteIdentifier(index.name),
        "ON",
        quoteIdentifier(tableName),
        `(${index.columns.map(quoteIdentifier).join(", ")})`,
        index.where ? `WHERE ${index.where}` : null,
    ]
        .filter(Boolean)
        .join(" ");
}

class DatabaseTransaction {
    public constructor(private readonly db: DatabaseClient) {}

    public run(sql: string, params: SqlParams = []) {
        return this.db.run(sql, params);
    }

    public get<T>(sql: string, params: SqlParams = []) {
        return this.db.get<T>(sql, params);
    }

    public all<T>(sql: string, params: SqlParams = []) {
        return this.db.all<T>(sql, params);
    }
}

export class DatabaseClient {
    private readonly sqlite: DatabaseSync;
    private readonly statements = new Map<string, StatementSync>();

    public readonly settings = {
        get: async (key: string) => {
            return this.get<SettingRow>(
                `SELECT "key", "value" FROM "setting" WHERE "key" = ? LIMIT 1`,
                [key],
            );
        },
        getValue: async (key: string) => (await this.settings.get(key))?.value ?? null,
        list: async () =>
            this.all<SettingRow>(`SELECT "key", "value" FROM "setting" ORDER BY "key"`),
        insert: async (row: SettingRow) => {
            this.run(`INSERT INTO "setting" ("key", "value") VALUES (?, ?)`, [row.key, row.value]);
        },
        upsert: async (key: string, value: string | null) => {
            this.run(
                `INSERT INTO "setting" ("key", "value") VALUES (?, ?)
                 ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
                [key, value],
            );
        },
        updateValue: async (key: string, value: string | null) => {
            this.run(`UPDATE "setting" SET "value" = ? WHERE "key" = ?`, [value, key]);
        },
        delete: async (key: string) => {
            this.run(`DELETE FROM "setting" WHERE "key" = ?`, [key]);
        },
        insertIfMissing: async (key: string, value: string | null) => {
            this.run(`INSERT OR IGNORE INTO "setting" ("key", "value") VALUES (?, ?)`, [
                key,
                value,
            ]);
        },
    };

    public readonly appState = {
        get: async (key: string) => {
            return this.get<AppStateRow>(
                `SELECT "key", "value", "updated_at" AS "updatedAt"
                 FROM "app_state" WHERE "key" = ? LIMIT 1`,
                [key],
            );
        },
        getValue: async (key: string) => (await this.appState.get(key))?.value ?? null,
        list: async () =>
            this.all<AppStateRow>(
                `SELECT "key", "value", "updated_at" AS "updatedAt"
                 FROM "app_state" ORDER BY "key"`,
            ),
        listByPrefix: async (prefix: string) =>
            this.all<AppStateRow>(
                `SELECT "key", "value", "updated_at" AS "updatedAt"
                 FROM "app_state" WHERE "key" LIKE ? ORDER BY "key"`,
                [`${prefix}%`],
            ),
        upsert: async (key: string, value: string, updatedAt: string) => {
            this.run(
                `INSERT INTO "app_state" ("key", "value", "updated_at") VALUES (?, ?, ?)
                 ON CONFLICT("key") DO UPDATE
                 SET "value" = excluded."value", "updated_at" = excluded."updated_at"`,
                [key, value, updatedAt],
            );
        },
        delete: async (key: string) => {
            this.run(`DELETE FROM "app_state" WHERE "key" = ?`, [key]);
        },
    };

    public readonly schemaState = {
        get: async (key: string) => {
            return this.get<SchemaStateRow>(
                `SELECT "key", "value", "updated_at" AS "updatedAt"
                 FROM "_schema_state" WHERE "key" = ? LIMIT 1`,
                [key],
            );
        },
        upsert: async (key: string, value: string, updatedAt: string) => {
            this.run(
                `INSERT INTO "_schema_state" ("key", "value", "updated_at") VALUES (?, ?, ?)
                 ON CONFLICT("key") DO UPDATE
                 SET "value" = excluded."value", "updated_at" = excluded."updated_at"`,
                [key, value, updatedAt],
            );
        },
    };

    public constructor(path: string) {
        this.sqlite = new DatabaseSync(path);
        this.sqlite.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
        `);
    }

    public prepare(sql: string) {
        const cached = this.statements.get(sql);
        if (cached) {
            return cached;
        }

        const statement = this.sqlite.prepare(sql);
        this.statements.set(sql, statement);
        return statement;
    }

    public get<T>(sql: string, params: SqlParams = []) {
        const statement = this.prepare(sql);
        const row = statement.get(...params.map(normalizeSqlValue)) as T | undefined;
        return row ?? null;
    }

    public all<T>(sql: string, params: SqlParams = []) {
        const statement = this.prepare(sql);
        return statement.all(...params.map(normalizeSqlValue)) as T[];
    }

    public run(sql: string, params: SqlParams = []) {
        const statement = this.prepare(sql);
        return statement.run(...params.map(normalizeSqlValue));
    }

    public exec(sql: string) {
        this.sqlite.exec(sql);
    }

    public transaction<T>(fn: (tx: DatabaseTransaction) => NonPromise<T>): NonPromise<T> {
        this.sqlite.exec("BEGIN IMMEDIATE");
        const tx = new DatabaseTransaction(this);
        try {
            const result = fn(tx);
            this.sqlite.exec("COMMIT");
            return result;
        } catch (error) {
            this.sqlite.exec("ROLLBACK");
            throw error;
        }
    }

    public async reconcile() {
        const tableNames = new Set(
            this.all<{ name: string }>(
                `SELECT "name" FROM "sqlite_schema" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`,
            ).map((row) => row.name),
        );
        const candidates = TABLE_SPECS.map((spec) =>
            this.buildReconcileCandidate(spec, tableNames),
        );

        this.exec(`PRAGMA foreign_keys = OFF`);
        try {
            for (const candidate of candidates) {
                this.reconcileTable(candidate);
            }
            this.exec(`PRAGMA foreign_keys = ON`);
            await this.schemaState.upsert(
                "app_schema_version",
                String(APP_SCHEMA_VERSION),
                new Date().toISOString(),
            );
        } catch (error) {
            this.exec(`PRAGMA foreign_keys = ON`);
            throw error;
        }
    }

    private buildReconcileCandidate(spec: TableSpec, tableNames: Set<string>): ReconcileCandidate {
        const actualName =
            [spec.name, ...(spec.aliases ?? [])].find((name) => tableNames.has(name)) ?? null;
        if (!actualName) {
            return { spec, actualName: null, shape: null };
        }

        return {
            spec,
            actualName,
            shape: this.readTableShape(actualName),
        };
    }

    private readTableShape(tableName: string): ExistingTableShape {
        const columns = this.all<TableInfoRow>(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
        const foreignKeyRows = this.all<ForeignKeyRow>(
            `PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`,
        );
        const indexList = this.all<IndexListRow>(
            `PRAGMA index_list(${quoteIdentifier(tableName)})`,
        );
        const foreignKeys = this.groupForeignKeys(foreignKeyRows);
        const indexes = indexList
            .filter((index) => index.origin !== "pk")
            .map((index) => ({
                columns: this.all<IndexInfoRow>(`PRAGMA index_info(${quoteIdentifier(index.name)})`)
                    .sort((left, right) => left.seqno - right.seqno)
                    .map((row) => row.name),
                name: index.name,
                unique: Boolean(index.unique),
            }));

        return {
            tableName,
            columns,
            foreignKeys,
            indexes,
        };
    }

    private groupForeignKeys(rows: ForeignKeyRow[]) {
        const grouped = new Map<number, TableForeignKeySpec>();
        for (const row of rows.sort((left, right) => {
            if (left.id !== right.id) {
                return left.id - right.id;
            }
            return left.seq - right.seq;
        })) {
            const current = grouped.get(row.id) ?? {
                columns: [],
                refColumns: [],
                refTable: row.table,
                onDelete: row.on_delete.toLowerCase() as TableForeignKeySpec["onDelete"],
                onUpdate: row.on_update.toLowerCase() as TableForeignKeySpec["onUpdate"],
            };
            current.columns.push(row.from);
            current.refColumns.push(row.to);
            grouped.set(row.id, current);
        }

        return [...grouped.values()];
    }

    private reconcileTable(candidate: ReconcileCandidate) {
        if (!candidate.actualName || !candidate.shape) {
            this.exec(buildCreateTableSql(candidate.spec));
            this.ensureIndexes(candidate.spec);
            return;
        }

        const action = this.getReconcileAction(candidate.spec, candidate.shape);
        if (action.type === "noop") {
            this.ensureIndexes(candidate.spec);
            return;
        }

        if (action.type === "add-columns") {
            for (const column of action.columns) {
                this.exec(
                    `ALTER TABLE ${quoteIdentifier(candidate.shape.tableName)} ADD COLUMN ${buildColumnDefinition(column)}`,
                );
            }
            this.ensureIndexes(candidate.spec);
            return;
        }

        this.rebuildTable(candidate.spec, candidate.shape);
    }

    private getReconcileAction(spec: TableSpec, shape: ExistingTableShape) {
        if (shape.tableName !== spec.name) {
            return { type: "rebuild" as const };
        }

        const existingByName = new Map(shape.columns.map((column) => [column.name, column]));
        const extraColumns = shape.columns.filter(
            (column) => !spec.columns.some((target) => target.name === column.name),
        );
        if (extraColumns.length > 0) {
            return { type: "rebuild" as const };
        }

        const missingColumns: TableColumnSpec[] = [];
        for (const target of spec.columns) {
            const existing = existingByName.get(target.name);
            if (!existing) {
                const hasAlias = (target.aliases ?? []).some((alias) => existingByName.has(alias));
                if (hasAlias) {
                    return { type: "rebuild" as const };
                }

                if (target.notNull && target.defaultSql == null) {
                    return { type: "rebuild" as const };
                }

                missingColumns.push(target);
                continue;
            }

            if (normalizeType(existing.type) !== normalizeType(target.type)) {
                return { type: "rebuild" as const };
            }

            if (Boolean(existing.notnull) !== Boolean(target.notNull)) {
                return { type: "rebuild" as const };
            }

            if (
                (spec.compositePrimaryKey?.length ?? 0) === 0 &&
                Boolean(target.primaryKey) !== existing.pk > 0
            ) {
                return { type: "rebuild" as const };
            }

            if (
                normalizeDefaultSql(existing.dflt_value) !== normalizeDefaultSql(target.defaultSql)
            ) {
                return { type: "rebuild" as const };
            }
        }

        const existingCompositePk = sortStrings(
            shape.columns
                .filter((column) => column.pk > 0)
                .sort((a, b) => a.pk - b.pk)
                .map((column) => column.name),
        );
        const targetCompositePk = sortStrings(spec.compositePrimaryKey ?? []);
        if (JSON.stringify(existingCompositePk) !== JSON.stringify(targetCompositePk)) {
            return { type: "rebuild" as const };
        }

        const existingForeignKeys = new Set(
            shape.foreignKeys.map((foreignKey) => normalizeForeignKeySignature(foreignKey)),
        );
        const targetForeignKeys = new Set(
            (spec.foreignKeys ?? []).map((foreignKey) => normalizeForeignKeySignature(foreignKey)),
        );
        if (
            existingForeignKeys.size !== targetForeignKeys.size ||
            [...targetForeignKeys].some((signature) => !existingForeignKeys.has(signature))
        ) {
            return { type: "rebuild" as const };
        }

        return missingColumns.length > 0
            ? { type: "add-columns" as const, columns: missingColumns }
            : { type: "noop" as const };
    }

    private rebuildTable(spec: TableSpec, shape: ExistingTableShape) {
        const tempTableName = `__new_${spec.name}`;
        const sourceColumns = new Set(shape.columns.map((column) => column.name));
        const insertColumns: string[] = [];
        const selectExpressions: string[] = [];

        for (const target of spec.columns) {
            const sourceName = this.findSourceColumnName(target, sourceColumns);
            insertColumns.push(quoteIdentifier(target.name));
            selectExpressions.push(
                `${this.buildCopyExpression(target, sourceName)} AS ${quoteIdentifier(target.name)}`,
            );
        }

        this.transaction(() => {
            this.exec(buildCreateTableSql(spec, tempTableName));
            this.exec(
                `INSERT INTO ${quoteIdentifier(tempTableName)} (${insertColumns.join(", ")})
                 SELECT ${selectExpressions.join(", ")} FROM ${quoteIdentifier(shape.tableName)}`,
            );
            this.exec(`DROP TABLE ${quoteIdentifier(shape.tableName)}`);
            this.exec(
                `ALTER TABLE ${quoteIdentifier(tempTableName)} RENAME TO ${quoteIdentifier(spec.name)}`,
            );
            this.ensureIndexes(spec);
        });
    }

    private findSourceColumnName(target: TableColumnSpec, sourceColumns: Set<string>) {
        if (sourceColumns.has(target.name)) {
            return target.name;
        }

        const aliasMatches = (target.aliases ?? []).filter((alias) => sourceColumns.has(alias));
        if (aliasMatches.length === 1) {
            return aliasMatches[0];
        }

        if (aliasMatches.length > 1) {
            throw new Error(`Ambiguous column aliases for ${target.name}`);
        }

        return null;
    }

    private buildCopyExpression(target: TableColumnSpec, sourceName: string | null) {
        if (!sourceName) {
            if (target.defaultSql != null) {
                return target.defaultSql;
            }

            return "NULL";
        }

        const sourceSql = quoteIdentifier(sourceName);
        if (!target.boolean) {
            return sourceSql;
        }

        const fallback = target.defaultSql ?? "0";
        return `CASE
            WHEN ${sourceSql} IS NULL THEN ${fallback}
            WHEN LOWER(CAST(${sourceSql} AS TEXT)) IN ('1', 'true') THEN 1
            ELSE 0
        END`;
    }

    private ensureIndexes(spec: TableSpec) {
        const existingIndexes = new Set(
            this.all<IndexListRow>(`PRAGMA index_list(${quoteIdentifier(spec.name)})`).map((row) =>
                normalizeIndexSignature({
                    columns: this.all<IndexInfoRow>(
                        `PRAGMA index_info(${quoteIdentifier(row.name)})`,
                    )
                        .sort((left, right) => left.seqno - right.seqno)
                        .map((column) => column.name),
                    name: row.name,
                    unique: Boolean(row.unique),
                }),
            ),
        );

        for (const index of spec.indexes ?? []) {
            if (existingIndexes.has(normalizeIndexSignature(index))) {
                continue;
            }

            this.exec(buildIndexSql(spec.name, index));
        }
    }
}
