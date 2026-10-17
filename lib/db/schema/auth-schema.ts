import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  bigint,
  integer,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),

    /**
     * Login name, separate from `name` (which is a display label and not
     * unique). People sign in with a username OR an email, and most know
     * their account as `alicja`, `bobby`, `admin` —
     * forcing them to remember which address they registered with would be a
     * regression, so sign-in resolves this to an email first.
     */
    username: text("username"),

    /**
     * The user's "tag" — the first segment of every public URL:
     * https://host/{userCode}/{code}.{ext}. User-editable; previous values are
     * kept in `user_code_aliases` so old links never break.
     */
    userCode: text("user_code"),

    /**
     * How `code` (the second URL segment) is generated for NEW uploads.
     * Existing uploads keep whatever code they were created with, so changing
     * this never invalidates a link that is already in circulation.
     * See lib/naming.ts for the available schemes.
     */
    namingScheme: text("naming_scheme").default("random"),
    /** Custom pattern, used only when namingScheme = 'custom'. */
    namingPattern: text("naming_pattern"),

    /**
     * Words per code for the `words` scheme: `funny-cat` (2),
     * `misty-golden-otter` (3). Clamped to 2–4 in lib/naming.ts.
     */
    namingWordCount: integer("naming_word_count").default(2),

    /**
     * Characters per code for the `random-chars` scheme. Minimum 5 (~550
     * million codes over the 56-symbol unambiguous alphabet); the generator
     * widens beyond this on its own if a collision ever proves the pool is
     * saturated.
     */
    namingRandomLength: integer("naming_random_length").default(6),

    /**
     * Which public origin THIS user's links are generated with, e.g.
     * "https://h.example.com". NULL = the deployment default (config.appUrl).
     *
     * Purely cosmetic for existing links: every name in `config.appDomains`
     * points at the same application and keeps serving every file, so switching
     * changes what future links *read* as and breaks nothing already shared.
     * Validated against that list on read (lib/media/urls.ts) as well as on
     * write, since the value is echoed into ShareX configs and OG tags.
     */
    preferredDomain: text("preferred_domain"),

    /** Opt-in: expose /u/{userCode} as a public gallery of this user's files. */
    publicProfile: boolean("public_profile").default(false),

    /**
     * Admin-only: drop the tag segment from the links of NEW uploads, so they
     * read https://host/name.png instead of https://host/tag/name.png.
     *
     * Only an admin may turn this on (enforced server-side in
     * app/actions/account.ts): a tagless code lives in the ROOT namespace, which
     * is shared with every top-level app route, so it is not something an
     * arbitrary account gets to claim. Links already shared keep their tag and
     * keep resolving — this only changes what is generated from now on.
     */
    skipTagInUrl: boolean("skip_tag_in_url").default(false),

    /**
     * Permission to create short links without the /{userCode}/ prefix, i.e. at
     * the root of the shortener domain (https://s.example.com/name). Admins
     * always may; everyone else needs this flag. Default off, because the root
     * short-link namespace is global and first-come-first-served.
     */
    allowRootShortLinks: boolean("allow_root_short_links").default(false),

    /**
     * Folder new uploads land in when none is given (null = no folder).
     *
     * Declared without a Drizzle-level `.references()` on purpose: folders live
     * in app-schema, which already imports this module, and a back-reference
     * would close an import cycle. `folders.parentId` does the same. The FK
     * (ON DELETE SET NULL) is added by hand in the migration.
     */
    defaultFolderId: uuid("default_folder_id"),

    // bigint: quotas are byte counts. int4 tops out at 2.14 GB, which real
    // installs blow past immediately (production had a user at 8.49 GB and
    // 20 GiB per-account limits).
    usedQuota: bigint("used_quota", { mode: "number" }).default(0),
    maxQuota: bigint("max_quota", { mode: "number" }).default(-1),
    hideUploads: boolean("hide_uploads").default(false),
    copyRaw: boolean("copy_raw").default(false),

    /**
     * Password stamped on every NEW upload (panel and ShareX alike), hashed with
     * the same scrypt scheme as a per-file password. NULL = the feature is off,
     * which is also how it is switched off: there is no separate flag, so an
     * account never holds a default password it is not using.
     *
     * Copied onto each upload rather than referenced, on purpose: rotating the
     * default must not silently change the password of links already shared.
     */
    defaultPasswordHash: text("default_password_hash"),

    /**
     * Generation counter for the above, bumped on EVERY change (set, replace and
     * clear alike).
     *
     * This is what makes "remember for 30 days" revocable. Salted hashes cannot
     * be compared across files, so an upload records the generation it was
     * stamped under (uploads.password_version) and the recipient's cookie is
     * signed over the same number. Bumping it leaves every cookie in
     * circulation matching nothing that is uploaded from now on.
     */
    defaultPasswordVersion: integer("default_password_version").notNull().default(0),
    // Must stay in step with DEFAULT_THEME in lib/themes.ts. They were "modern"
    // and "default" respectively - two different literals that happened to render
    // the same skin, so nobody noticed they had drifted.
    theme: text("theme").default("discord"),

    /**
     * Storage key of this account's wallpaper, or NULL for none.
     *
     * Kept out of `uploads` on purpose: it is decoration, not a shared file, so
     * it must not appear in the dashboard, count against quota, or be reachable
     * at a /{tag}/{code} link. The bytes are always a re-encoded WebP written by
     * app/api/background/route.ts, never the file the user picked.
     *
     * The key ends in a random token, which is what makes the public URL
     * cacheable forever: replacing the wallpaper writes a new key, so the old
     * URL is simply never requested again.
     */
    backgroundKey: text("background_key"),

    /**
     * How strongly the theme's own background colour veils the wallpaper, 0-100.
     *
     * Not a nicety: a photograph behind a file manager destroys contrast, and
     * the twelve skins disagree wildly about how much they need. The veil is
     * painted in the skin's own `--background`, so one number keeps text legible
     * on every one of them and the viewer's light/dark mode stays honest.
     */
    backgroundDim: integer("background_dim").notNull().default(70),

    locale: text("locale"),
  },
  (t) => [
    uniqueIndex("user_user_code_idx").on(t.userCode),
    uniqueIndex("user_username_idx").on(t.username),
  ],
);

/**
 * Historical `user_code` values. When a user changes their tag, the old one is
 * parked here and keeps resolving forever — otherwise every link already shared
 * with that tag would 404.
 */
export const userCodeAliases = pgTable(
  "user_code_aliases",
  {
    code: text("code").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("user_code_aliases_user_idx").on(t.userId)],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
  },
  (table) => [
    index("twoFactor_secret_idx").on(table.secret),
    index("twoFactor_userId_idx").on(table.userId),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  twoFactors: many(twoFactor),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, {
    fields: [twoFactor.userId],
    references: [user.id],
  }),
}));
