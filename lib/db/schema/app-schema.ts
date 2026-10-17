import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * uploads — one row per stored file (the heart of the app).
 * URL shape: /{userCode}/{code}.{ext} (the shape ShareX configs expect).
 */
export const uploads = pgTable(
  "uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Owner, or NULL for a file that outlived its account ("orphaned").
     *
     * Nullable + ON DELETE SET NULL. Under the
     * previous ON DELETE CASCADE, removing an account silently destroyed every
     * byte it had ever uploaded — with no way to keep a shared file alive and no
     * chance to reconsider. Now the admin chooses at deletion time (see
     * app/actions/admin.ts) and anything kept lands in Admin → Orphaned files.
     *
     * An orphan is deliberately NOT reachable in public: the first URL segment
     * is the owner's tag, and with no owner there is no tag to resolve — so
     * lib/media/serve.ts returns 404 for them. They exist to be reviewed and
     * either re-homed by hand or purged, not to keep serving traffic.
     */
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),

    code: varchar("code", { length: 64 }).notNull(), // public short code ({mediaCode})
    filename: varchar("filename", { length: 512 }).notNull(), // original name
    ext: varchar("ext", { length: 32 }).notNull().default(""),
    // 'file' (uploaded) | 'paste' (text snippet created in-app)
    kind: varchar("kind", { length: 16 }).notNull().default("file"),
    // syntax language for pastes (e.g. 'ts', 'json'); null for files
    language: varchar("language", { length: 32 }),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    storageKey: text("storage_key").notNull(), // path inside the storage driver
    checksum: varchar("checksum", { length: 64 }), // sha256 (dedup / integrity)

    // image/video metadata for nice previews
    width: integer("width"),
    height: integer("height"),
    /**
     * Frames in the file: 1 for a still, >1 for an animation, NULL for "nobody
     * has counted" — imported rows, and everything uploaded before this column
     * existed.
     *
     * It exists so "Download as…" can describe THIS file rather than its
     * container. Without it a still WebP was labelled "single frame" under every
     * target, which reads as a warning about losing an animation the file never
     * had. NULL keeps the old, format-based guess (lib/media/convert-targets.ts).
     */
    frames: integer("frames"),
    /**
     * Playing time in seconds, and the average frame rate, for audio and video.
     * NULL for everything else and for every row uploaded before these columns
     * existed (scripts/backfill-av-metadata.ts fills those).
     *
     * `frames` above is a COUNT and is missing on roughly one production video
     * in twenty - an MPEG-TS stream wearing an .mp4 name, a WebM, a damaged MP4.
     * `fps` was present on all 59 sampled, so between the two, "how many picture
     * frames does this file hold" always has an answer (lib/media/av-meta.ts,
     * frameCount). That total is what makes a stuttering recording diagnosable:
     * bits per pixel is size / (width * height * frames), and the ShareX capture
     * that started this measured 0.0044 against the 0.050 to 0.098 of the same
     * user's healthy recordings.
     *
     * Double precision rather than real: a long recording is five digits of
     * seconds before the decimal point, which float4 cannot carry to
     * millisecond resolution.
     */
    durationSeconds: doublePrecision("duration_seconds"),
    fps: doublePrecision("fps"),
    blurhash: varchar("blurhash", { length: 64 }),
    thumbKey: text("thumb_key"), // cached thumbnail storage key (optional)

    published: boolean("published").notNull().default(true), // public/listed
    deleteToken: varchar("delete_token", { length: 64 }).notNull(), // per-media delete link

    // engagement
    views: integer("views").notNull().default(0),
    downloads: integer("downloads").notNull().default(0),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),

    // advantage features
    expiresAt: timestamp("expires_at", { withTimezone: true }), // time-based expiry
    maxViews: integer("max_views"), // burn-after-N-views
    passwordHash: text("password_hash"), // password-protected file

    /**
     * Which generation of the owner's DEFAULT password this file was stamped
     * with, or NULL when the password was picked by hand for this file alone.
     *
     * Two salted hashes never reveal whether they hide the same password, so
     * "is this file on the account default?" has to be written down rather than
     * derived. It is the sole thing that lets a recipient's "remember for 30
     * days" cookie open a file it was not minted for, which is exactly why a
     * hand-picked password stores NULL: that file always asks.
     */
    passwordVersion: integer("password_version"),

    /**
     * When this file's BYTES were last replaced by a conversion, and what
     * extension they carried before the first one. NULL on everything that has
     * never been converted, which is almost every row.
     *
     * Neither column is load-bearing: the code, the storage key and the type all
     * live in the columns above, and an in-place conversion rewrites those. They
     * exist to answer the one question a converted file provokes - "why does this
     * link end in .mp4 and give me a GIF?" - which is otherwise unanswerable
     * because the extension in a URL is decorative (lib/media/urls.ts). They also
     * give a later cache-buster something honest to key on: /raw is served
     * `immutable` for a year, so a reader who fetched the old bytes keeps them.
     */
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    originalExt: varchar("original_ext", { length: 32 }),

    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft-delete (trash)

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uploads_code_idx").on(t.code),
    uniqueIndex("uploads_delete_token_idx").on(t.deleteToken),
    index("uploads_owner_idx").on(t.ownerId),
    index("uploads_created_idx").on(t.createdAt),
    index("uploads_deleted_idx").on(t.deletedAt),
    index("uploads_folder_idx").on(t.folderId),
    // The dashboard's default query is "my files, newest first" — a single
    // composite index serves it far better than two independent ones.
    index("uploads_owner_created_idx").on(t.ownerId, t.createdAt.desc()),
    /**
     * "Do I already have these bytes?" — POST /api/uploads/check asks it with up
     * to 500 checksums at a time, and every ShareX upload asks it once.
     *
     * Composite and owner-first because the answer is only ever wanted within
     * one account: without it Postgres walks that owner's whole slice of the
     * table (8600 rows for the largest account here) and filters, per upload.
     * lib/data/duplicates.ts predicted this index for its own grouped scan; the
     * upload-time check is what made it worth having.
     */
    index("uploads_owner_checksum_idx").on(t.ownerId, t.checksum),
  ],
);

/**
 * folders — the single organisational unit, replacing tags and the earlier
 * `albums` table.
 *
 * A file lives in exactly one folder (uploads.folderId, 1:N) so "move" has the
 * obvious file-explorer meaning. Folders nest via parentId. Flipping isPublic
 * turns a folder into a shareable gallery (the old album behaviour) without
 * introducing a second concept.
 *
 * File *type* is derived from uploads.mimeType, so there is no auto-tagging
 * table to keep in sync.
 */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull(),
    description: text("description"),
    isPublic: boolean("is_public").notNull().default(false),
    coverUploadId: uuid("cover_upload_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("folders_owner_idx").on(t.ownerId),
    index("folders_parent_idx").on(t.parentId),
    // Slugs are unique per owner AND per parent, so "screenshots" may exist
    // inside two different parents without clashing.
    //
    // This index only covers nested folders: Postgres treats NULLs as distinct,
    // so root folders (parentId = NULL) slip through it. A companion partial
    // index — folders_owner_root_slug_idx, added by hand in the migration —
    // enforces uniqueness for those. Keep both.
    uniqueIndex("folders_owner_parent_slug_idx").on(t.ownerId, t.parentId, t.slug),
  ],
);

/** per-user upload tokens for ShareX / API (token stored hashed). */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull().default("ShareX"),
    /**
     * What this token may do: 'upload' | 'read' | 'write' | 'full'.
     * Meanings and the subset lattice live in lib/api-token.ts.
     *
     * NOT NULL and deliberately WITHOUT a default. The migration adds the column
     * with `DEFAULT 'full'` so every row that already existed is backfilled to
     * what it could already do, then drops the default in the same file — so
     * from that moment an INSERT that forgets to name a scope is a constraint
     * violation instead of a silently unlimited credential.
     */
    scope: varchar("scope", { length: 16 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(), // sha256 of the token
    preview: varchar("preview", { length: 12 }).notNull().default(""), // last chars, for display
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_tokens_hash_idx").on(t.tokenHash),
    index("api_tokens_user_idx").on(t.userId),
    // Authentication already refuses a scope it does not recognise (fail closed,
    // lib/api-token.ts). This stops one being written at all, so the refusal
    // path only ever has to handle a downgrade or a hand-edited row.
    check("api_tokens_scope_check", sql`${t.scope} in ('upload', 'read', 'write', 'full')`),
  ],
);

/** global key/value runtime settings (admin-configurable). */
export const settings = pgTable("settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value"),
});

/** audit / activity log. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    action: varchar("action", { length: 64 }).notNull(),
    detail: jsonb("detail"),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt), index("audit_user_idx").on(t.userId)],
);

/** Built-in URL shortener: /s/{code} -> target (with click counting + expiry). */
export const shortLinks = pgTable(
  "short_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 64 }).notNull(),
    target: text("target").notNull(),
    passwordHash: text("password_hash"), // optional: gate page asks for it before redirect
    clicks: integer("clicks").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("short_links_code_idx").on(t.code),
    index("short_links_owner_idx").on(t.ownerId),
  ],
);

/**
 * client_settings — the desktop client's own configuration, one row per account
 * per client kind.
 *
 * Exists so a hotkey set follows the person rather than the machine
 * (docs/decyzje-modlight-app.md, "Ustawienia w chmurze"). The payload is opaque
 * to the server on purpose: see lib/client-settings.ts for why, and for the
 * caps that make an opaque, user-written jsonb column safe to keep on a shared
 * host.
 *
 * `client` is a discriminator, not a free-form label — a second client gets its
 * own row instead of colliding with the desktop one, and the set of legal values
 * is an allowlist in lib/client-settings.ts so the row count stays bounded.
 */
export const clientSettings = pgTable(
  "client_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    client: varchar("client", { length: 32 }).notNull().default("desktop"),

    /**
     * Bumped by the server on every replace, and never by the client.
     *
     * A column rather than a field inside the blob, because it is the one part
     * of the document the server has to be able to change atomically: the write
     * that raises it is the same statement that matched on its old value, so two
     * machines saving at once cannot both believe they won. A number carried
     * inside opaque jsonb could only be trusted as far as the client that wrote
     * it, which is exactly the client the check exists to catch.
     *
     * 0 means "nothing stored" and only ever appears in a GET response; a stored
     * row starts at 1.
     */
    version: integer("version").notNull().default(0),

    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Doubles as the owner index: owner_id is the leftmost column, so every
    // "this account's settings" lookup uses it. A second, owner-only index would
    // be write amplification on a table a background process saves to on a
    // timer, in exchange for nothing this table's queries can use.
    uniqueIndex("client_settings_owner_client_idx").on(t.ownerId, t.client),
  ],
);

export type ClientSettingsRow = typeof clientSettings.$inferSelect;
export type ShortLink = typeof shortLinks.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type NewUpload = typeof uploads.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type ApiToken = typeof apiTokens.$inferSelect;
