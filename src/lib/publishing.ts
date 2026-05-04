export const WORK_KINDS = ["novel", "manga", "anime"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const SERIES_STATUSES = ["ongoing", "completed", "hiatus"] as const;
export type SeriesStatus = (typeof SERIES_STATUSES)[number];

export const PUBLICATION_STATUSES = [
    "draft",
    "processing",
    "submitted",
    "changes_requested",
    "approved",
    "published",
    "rejected",
    "archived",
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const WORK_VISIBILITIES = ["private", "unlisted", "public"] as const;
export type WorkVisibility = (typeof WORK_VISIBILITIES)[number];

export const CONTENT_TYPES = [
    "novel_chapter",
    "manga_chapter",
    "anime_episode",
    "anime_trailer",
    "bonus",
] as const;
export type WorkContentType = (typeof CONTENT_TYPES)[number];

export const STORAGE_BUCKETS = [
    "creator-covers",
    "creator-thumbnails",
    "manga-pages",
    "anime-posters",
    "anime-media",
    "subtitles",
    "release-attachments",
    "staging",
] as const;
export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

export const ASSET_KINDS = [
    "cover",
    "thumbnail",
    "poster",
    "manga_page",
    "subtitle",
    "video_manifest",
    "video_source",
    "video_transcode",
    "attachment",
    "placeholder",
    "other",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_ROLES = [
    "cover",
    "thumbnail",
    "poster",
    "gallery",
    "manga_page",
    "subtitle",
    "video_manifest",
    "video_source",
    "video_transcode",
    "attachment",
    "preview",
] as const;
export type AssetRole = (typeof ASSET_ROLES)[number];

export const ASSET_PROCESSING_STATUSES = [
    "staged",
    "uploaded",
    "processing",
    "ready",
    "failed",
    "archived",
] as const;
export type AssetProcessingStatus = (typeof ASSET_PROCESSING_STATUSES)[number];

export const MINT_TYPES = [
    "collectible",
    "supporter",
    "limited_edition",
    "access_pass",
] as const;
export type MintType = (typeof MINT_TYPES)[number];

export const MINT_STATUSES = [
    "disabled",
    "draft",
    "pending_review",
    "approved",
    "live",
    "paused",
    "sold_out",
    "ended",
] as const;
export type MintStatus = (typeof MINT_STATUSES)[number];
export type MintScope = "work" | "release";

export interface CreatorWork {
    id: string;
    creator_wallet: string;
    kind: WorkKind;
    title: string;
    slug?: string | null;
    description: string;
    genres: string[];
    language: string;
    series_status: SeriesStatus;
    publication_status: PublicationStatus;
    visibility: WorkVisibility;
    minting_enabled: boolean;
    published_at?: string | null;
    release_metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface WorkRelease {
    id: string;
    work_id: string;
    sequence_number: number;
    title: string;
    summary: string;
    content_type: WorkContentType;
    publication_status: PublicationStatus;
    visibility: WorkVisibility;
    body_text: string;
    scheduled_at?: string | null;
    published_at?: string | null;
    duration_ms?: number | null;
    release_metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface AssetFileRecord {
    id: string;
    owner_wallet: string;
    storage_provider: "supabase" | "s3" | "r2" | "b2" | "spaces" | "local";
    bucket: StorageBucket;
    object_path: string;
    kind: AssetKind;
    mime_type: string;
    original_filename: string;
    size_bytes: number;
    checksum_sha256: string;
    width?: number | null;
    height?: number | null;
    duration_ms?: number | null;
    status: AssetProcessingStatus;
    is_public: boolean;
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface AssetVariantRecord {
    id: string;
    asset_file_id: string;
    variant_key: string;
    bucket: StorageBucket;
    object_path: string;
    mime_type: string;
    size_bytes: number;
    width?: number | null;
    height?: number | null;
    duration_ms?: number | null;
    status: Exclude<AssetProcessingStatus, "staged" | "uploaded">;
    metadata: Record<string, unknown>;
    created_at: string;
}

export interface WorkAssetLink {
    id: string;
    work_id?: string | null;
    release_id?: string | null;
    asset_file_id: string;
    role: AssetRole;
    sort_order: number;
    is_primary: boolean;
    created_at: string;
}

export interface WorkMintRecord {
    id: string;
    work_id?: string | null;
    release_id?: string | null;
    creator_wallet: string;
    mint_scope: MintScope;
    mint_type: MintType;
    status: MintStatus;
    collection_address?: string | null;
    tree_address?: string | null;
    mint_address?: string | null;
    metadata_uri: string;
    max_supply?: number | null;
    minted_count: number;
    mint_price: number;
    currency: string;
    setup_tx_signature?: string | null;
    verified_at?: string | null;
    verification_state?: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface LinkedAssetVariant extends AssetVariantRecord {
    publicUrl: string | null;
}

export interface LinkedCreatorAsset extends WorkAssetLink {
    file: AssetFileRecord & {
        publicUrl: string | null;
    };
    variants: LinkedAssetVariant[];
}

export interface PublisherValidationIssue {
    field: string;
    message: string;
}

export interface WorkDraftInput {
    kind: WorkKind;
    title: string;
    description?: string;
    genres?: string[];
    language?: string;
    visibility?: WorkVisibility;
}

export interface ReleaseDraftInput {
    workKind: WorkKind;
    sequenceNumber: number;
    title: string;
    contentType?: WorkContentType;
    bodyText?: string;
    visibility?: WorkVisibility;
}

export interface MintIntentDraftInput {
    mintType: MintType;
    metadataUri: string;
    txSignature: string;
    mintPrice: number;
    maxSupply?: number | null;
    collectionAddress?: string;
    treeAddress?: string;
    mintAddress?: string;
}

const BUCKET_BY_ASSET_KIND: Record<AssetKind, StorageBucket> = {
    cover: "creator-covers",
    thumbnail: "creator-thumbnails",
    poster: "anime-posters",
    manga_page: "manga-pages",
    subtitle: "subtitles",
    video_manifest: "anime-media",
    video_source: "anime-media",
    video_transcode: "anime-media",
    attachment: "release-attachments",
    placeholder: "creator-thumbnails",
    other: "staging",
};

const ROLE_BY_ASSET_KIND: Record<AssetKind, AssetRole> = {
    cover: "cover",
    thumbnail: "thumbnail",
    poster: "poster",
    manga_page: "manga_page",
    subtitle: "subtitle",
    video_manifest: "video_manifest",
    video_source: "video_source",
    video_transcode: "video_transcode",
    attachment: "attachment",
    placeholder: "preview",
    other: "attachment",
};

export function slugifyWorkTitle(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

export function getDefaultBucketForAssetKind(kind: AssetKind): StorageBucket {
    return BUCKET_BY_ASSET_KIND[kind];
}

export function getDefaultRoleForAssetKind(kind: AssetKind): AssetRole {
    return ROLE_BY_ASSET_KIND[kind];
}

export function isPublishedStatus(status: PublicationStatus): boolean {
    return status === "published";
}

export function getDefaultContentTypeForWorkKind(kind: WorkKind): WorkContentType {
    if (kind === "manga") return "manga_chapter";
    if (kind === "anime") return "anime_episode";
    return "novel_chapter";
}

export function canAssetBePublic(kind: AssetKind): boolean {
    return kind === "cover" || kind === "thumbnail" || kind === "poster";
}

export function buildAssetObjectPath(input: {
    wallet: string;
    workId: string;
    releaseId?: string;
    kind: AssetKind;
    filename: string;
}): string {
    const safeFile = sanitizeStorageName(input.filename);
    const segments = [
        sanitizeStorageName(input.wallet),
        sanitizeStorageName(input.workId),
    ];

    if (input.releaseId) {
        segments.push(sanitizeStorageName(input.releaseId));
    }

    segments.push(input.kind, safeFile);
    return segments.join("/");
}

export function sanitizeStorageName(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120) || "file";
}

export function compareNaturalNames(a: string, b: string): number {
    return a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "base",
    });
}

export function sortNamedItemsNaturally<T extends { name: string }>(items: T[]): T[] {
    return [...items].sort((left, right) => compareNaturalNames(left.name, right.name));
}

export function validateWorkDraft(input: WorkDraftInput): PublisherValidationIssue[] {
    const issues: PublisherValidationIssue[] = [];

    if (!WORK_KINDS.includes(input.kind)) {
        issues.push({ field: "kind", message: "Unsupported work kind." });
    }

    if (!input.title.trim()) {
        issues.push({ field: "title", message: "Title is required." });
    }

    if (input.title.trim().length > 160) {
        issues.push({ field: "title", message: "Title must be 160 characters or fewer." });
    }

    if ((input.description || "").length > 5000) {
        issues.push({ field: "description", message: "Description must be 5000 characters or fewer." });
    }

    if ((input.genres || []).length > 12) {
        issues.push({ field: "genres", message: "Use 12 genres or fewer." });
    }

    return issues;
}

export function validateReleaseDraft(input: ReleaseDraftInput): PublisherValidationIssue[] {
    const issues: PublisherValidationIssue[] = [];

    if (input.sequenceNumber <= 0) {
        issues.push({ field: "sequenceNumber", message: "Sequence number must be greater than zero." });
    }

    if (!input.title.trim()) {
        issues.push({ field: "title", message: "Release title is required." });
    }

    if (input.workKind === "novel" && !(input.bodyText || "").trim()) {
        issues.push({ field: "bodyText", message: "Novel releases need chapter text." });
    }

    return issues;
}

export function validateMintIntentDraft(input: MintIntentDraftInput): PublisherValidationIssue[] {
    const issues: PublisherValidationIssue[] = [];

    if (!MINT_TYPES.includes(input.mintType)) {
        issues.push({ field: "mintType", message: "Unsupported mint type." });
    }

    if (!input.metadataUri.trim()) {
        issues.push({ field: "metadataUri", message: "Metadata URL is required." });
    } else {
        try {
            const url = new URL(input.metadataUri);
            if (url.protocol !== "https:") {
                issues.push({ field: "metadataUri", message: "Metadata URL must use https." });
            }
        } catch {
            issues.push({ field: "metadataUri", message: "Metadata URL must be a valid URL." });
        }
    }

    if (!input.txSignature.trim()) {
        issues.push({ field: "txSignature", message: "Verified transaction signature is required." });
    }

    if (!Number.isFinite(input.mintPrice) || input.mintPrice < 0) {
        issues.push({ field: "mintPrice", message: "Mint price must be zero or greater." });
    }

    if (input.maxSupply != null) {
        if (!Number.isInteger(input.maxSupply) || input.maxSupply <= 0) {
            issues.push({ field: "maxSupply", message: "Max supply must be a positive whole number." });
        }
    }

    return issues;
}
