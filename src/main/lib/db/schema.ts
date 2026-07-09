export type SettingRow = {
    key: string;
    value: string | null;
};

export type AppStateRow = {
    key: string;
    value: string;
    updatedAt: string;
};

export type SchemaStateRow = {
    key: string;
    value: string;
    updatedAt: string;
};

export type TableColumnSpec = {
    name: string;
    type: "TEXT" | "INTEGER" | "BLOB";
    notNull?: boolean;
    primaryKey?: boolean;
    defaultSql?: string;
    aliases?: string[];
    boolean?: boolean;
};

export type TableIndexSpec = {
    name: string;
    columns: string[];
    unique?: boolean;
};

export type TableForeignKeySpec = {
    columns: string[];
    refTable: string;
    refColumns: string[];
    onDelete?: "cascade" | "no action";
    onUpdate?: "cascade" | "no action";
};

export type TableSpec = {
    name: string;
    aliases?: string[];
    columns: TableColumnSpec[];
    compositePrimaryKey?: string[];
    indexes?: TableIndexSpec[];
    foreignKeys?: TableForeignKeySpec[];
};

export const APP_SCHEMA_VERSION = 4;

export const TABLE_SPECS: TableSpec[] = [
    {
        name: "setting",
        columns: [
            { name: "key", type: "TEXT", primaryKey: true, notNull: true },
            { name: "value", type: "TEXT" },
        ],
    },
    {
        name: "app_state",
        columns: [
            { name: "key", type: "TEXT", primaryKey: true, notNull: true },
            { name: "value", type: "TEXT", notNull: true },
            { name: "updated_at", type: "TEXT", notNull: true },
        ],
    },
    {
        name: "_schema_state",
        columns: [
            { name: "key", type: "TEXT", primaryKey: true, notNull: true },
            { name: "value", type: "TEXT", notNull: true },
            { name: "updated_at", type: "TEXT", notNull: true },
        ],
    },
    {
        name: "download_collection",
        columns: [
            { name: "id", type: "TEXT", primaryKey: true, notNull: true },
            { name: "share_id", type: "TEXT", notNull: true },
            { name: "source_url", type: "TEXT", notNull: true },
            { name: "password_plain", type: "TEXT" },
            { name: "name", type: "TEXT", notNull: true },
            { name: "root_id", type: "TEXT", notNull: true },
            { name: "segment_size", type: "INTEGER", notNull: true },
            { name: "expires", type: "INTEGER", notNull: true },
            { name: "tree_json", type: "TEXT", notNull: true },
            { name: "save_path", type: "TEXT", notNull: true },
            { name: "status", type: "TEXT", notNull: true },
            { name: "created_at", type: "TEXT", notNull: true },
            { name: "updated_at", type: "TEXT", notNull: true },
            { name: "elapsed_ms", type: "INTEGER", notNull: true, defaultSql: "0" },
            { name: "error", type: "TEXT" },
        ],
        indexes: [
            { name: "idx_download_collection_status", columns: ["status"] },
            { name: "idx_download_collection_created_at", columns: ["created_at"] },
        ],
    },
    {
        name: "download_file",
        columns: [
            { name: "id", type: "TEXT", primaryKey: true, notNull: true },
            { name: "collection_id", type: "TEXT", notNull: true },
            { name: "remote_id", type: "TEXT", notNull: true },
            { name: "path", type: "TEXT", notNull: true },
            { name: "name", type: "TEXT", notNull: true },
            { name: "size", type: "INTEGER", notNull: true },
            { name: "selected", type: "INTEGER", notNull: true, defaultSql: "0", boolean: true },
            { name: "status", type: "TEXT", notNull: true },
            { name: "downloaded_bytes", type: "INTEGER", notNull: true, defaultSql: "0" },
            {
                name: "paused_by_user",
                type: "INTEGER",
                notNull: true,
                defaultSql: "0",
                boolean: true,
            },
            { name: "created_at", type: "TEXT", notNull: true },
            { name: "updated_at", type: "TEXT", notNull: true },
            { name: "error", type: "TEXT" },
        ],
        indexes: [
            { name: "idx_download_file_collection_id", columns: ["collection_id"] },
            { name: "idx_download_file_status", columns: ["status"] },
            { name: "idx_download_file_remote_id", columns: ["remote_id"] },
        ],
        foreignKeys: [
            {
                columns: ["collection_id"],
                refTable: "download_collection",
                refColumns: ["id"],
                onDelete: "cascade",
                onUpdate: "cascade",
            },
        ],
    },
    {
        name: "download_chunk",
        columns: [
            { name: "collection_id", type: "TEXT", notNull: true },
            { name: "file_id", type: "TEXT", notNull: true },
            { name: "chunk_index", type: "INTEGER", notNull: true },
            { name: "offset", type: "INTEGER", notNull: true },
            { name: "size", type: "INTEGER", notNull: true },
            { name: "status", type: "TEXT", notNull: true },
            { name: "downloaded_bytes", type: "INTEGER", notNull: true, defaultSql: "0" },
            { name: "attempts", type: "INTEGER", notNull: true, defaultSql: "0" },
            { name: "updated_at", type: "TEXT", notNull: true },
            { name: "error", type: "TEXT" },
        ],
        compositePrimaryKey: ["file_id", "chunk_index"],
        indexes: [
            { name: "idx_download_chunk_collection_id", columns: ["collection_id"] },
            { name: "idx_download_chunk_status", columns: ["status"] },
        ],
        foreignKeys: [
            {
                columns: ["collection_id"],
                refTable: "download_collection",
                refColumns: ["id"],
                onDelete: "cascade",
                onUpdate: "cascade",
            },
            {
                columns: ["file_id"],
                refTable: "download_file",
                refColumns: ["id"],
                onDelete: "cascade",
                onUpdate: "cascade",
            },
        ],
    },
    {
        name: "upload_collection",
        columns: [
            { name: "id", type: "TEXT", primaryKey: true, notNull: true },
            { name: "name", type: "TEXT", notNull: true },
            { name: "description", type: "TEXT", notNull: true, defaultSql: "''" },
            { name: "password_plain", type: "TEXT" },
            { name: "share_id", type: "TEXT" },
            { name: "share_link", type: "TEXT" },
            { name: "collection_uuid", type: "TEXT", notNull: true },
            { name: "upload_token", type: "TEXT", notNull: true },
            { name: "tree_json", type: "TEXT", notNull: true },
            { name: "segment_size", type: "INTEGER", notNull: true, defaultSql: "16777216" },
            { name: "expires", type: "INTEGER", notNull: true },
            { name: "status", type: "TEXT", notNull: true },
            { name: "created_at", type: "TEXT", notNull: true },
            { name: "updated_at", type: "TEXT", notNull: true },
            { name: "elapsed_ms", type: "INTEGER", notNull: true, defaultSql: "0" },
            { name: "error", type: "TEXT" },
        ],
        indexes: [
            { name: "idx_upload_collection_status", columns: ["status"] },
            { name: "idx_upload_collection_created_at", columns: ["created_at"] },
        ],
    },
    {
        name: "upload_file",
        columns: [
            { name: "id", type: "TEXT", primaryKey: true, notNull: true },
            { name: "collection_id", type: "TEXT", notNull: true },
            { name: "remote_id", type: "TEXT", notNull: true },
            { name: "path", type: "TEXT", notNull: true },
            { name: "name", type: "TEXT", notNull: true },
            { name: "size", type: "INTEGER", notNull: true },
            { name: "fs_path", type: "TEXT", notNull: true },
            { name: "source_mtime_ms", type: "INTEGER", notNull: true },
            { name: "status", type: "TEXT", notNull: true },
            { name: "uploaded_bytes", type: "INTEGER", notNull: true, defaultSql: "0" },
            {
                name: "paused_by_user",
                type: "INTEGER",
                notNull: true,
                defaultSql: "0",
                boolean: true,
            },
            { name: "created_at", type: "TEXT", notNull: true },
            { name: "updated_at", type: "TEXT", notNull: true },
            { name: "error", type: "TEXT" },
        ],
        indexes: [
            { name: "idx_upload_file_collection_id", columns: ["collection_id"] },
            { name: "idx_upload_file_status", columns: ["status"] },
            { name: "idx_upload_file_remote_id", columns: ["remote_id"] },
        ],
        foreignKeys: [
            {
                columns: ["collection_id"],
                refTable: "upload_collection",
                refColumns: ["id"],
                onDelete: "cascade",
                onUpdate: "cascade",
            },
        ],
    },
    {
        name: "upload_chunk",
        columns: [
            { name: "collection_id", type: "TEXT", notNull: true },
            { name: "file_id", type: "TEXT", notNull: true },
            { name: "chunk_index", type: "INTEGER", notNull: true },
            { name: "offset", type: "INTEGER", notNull: true },
            { name: "size", type: "INTEGER", notNull: true },
            { name: "status", type: "TEXT", notNull: true },
            { name: "uploaded_bytes", type: "INTEGER", notNull: true, defaultSql: "0" },
            { name: "attempts", type: "INTEGER", notNull: true, defaultSql: "0" },
            { name: "updated_at", type: "TEXT", notNull: true },
            { name: "error", type: "TEXT" },
        ],
        compositePrimaryKey: ["file_id", "chunk_index"],
        indexes: [
            { name: "idx_upload_chunk_collection_id", columns: ["collection_id"] },
            { name: "idx_upload_chunk_status", columns: ["status"] },
        ],
        foreignKeys: [
            {
                columns: ["collection_id"],
                refTable: "upload_collection",
                refColumns: ["id"],
                onDelete: "cascade",
                onUpdate: "cascade",
            },
            {
                columns: ["file_id"],
                refTable: "upload_file",
                refColumns: ["id"],
                onDelete: "cascade",
                onUpdate: "cascade",
            },
        ],
    },
];
