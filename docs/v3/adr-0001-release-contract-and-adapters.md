# ADR 0001 — v3 release contract, store ports and platform adapters

Status: Accepted (2026-10-17). Scope: P0 (#69) deliverables — minimum release
contract, capability matrix rationale, threat model, cache rules. No production
change is implied by this document.

## Context

AiringCal v2 is a single-user Bangumi calendar: an offline writer (QingLong →
`node-jobs`) publishes a snapshot plus images into Cloudflare (D1/R2/KV), and one
read Worker (`airing-cal-frontend`) serves HTML, `/api/*` and `/image/:hash`.
v3 must keep that public behaviour while making the core portable across
Cloudflare and Tencent EdgeOne (and later Docker/Compose), with a verified,
reversible v2→v3 migration.

Two storage questions had to be answered before adapters could be written:

1. What is the **minimum release contract** every platform must store?
2. Which platform primitive satisfies it (KV vs object store vs Blob)?

## Decision 1 — Minimum release contract

A release is:

| Object | Key | Mutability |
|---|---|---|
| Snapshot | `snapshots/v1/<generation>-<content_hash>.json` | immutable, content-addressed |
| Manifest | `public/manifest.json` | immutable per generation, verified against the pointer |
| Pointer | `public/current-release.json` | **mutable**, the only moving part |
| Images | `images/<hash>/original`, `images/<hash>/thumb.v1.webp`, `thumb.v2.webp` | immutable, content-addressed |

Pointer schema (`PublicReleasePointer`, `schema_version: 1`): `generation`,
`content_hash`, `artifact_ref`, `published_at_unix`. A reader loads the pointer,
reads the artifact, and **fails closed** unless `snapshot.generation`/`content_hash`
match the pointer and, when present, `public/manifest.json` agrees with both.

Consequences: no listing/scans on the read path; a release is verified by three
object reads; the single mutable object is the pointer.

## Decision 2 — Storage port (`PublicStore`) instead of per-platform readers

`PublicStore` = `getCurrentRelease` + `getSnapshotBytes` + `putImmutableObject` +
`commitRelease(expected, next) → committed | conflict | unsupported`.

`commitRelease` returning `unsupported` is a first-class outcome: a platform
without conditional writes cannot own the pointer, and publishing must fail closed
(`publishBuilderCheckpoint` maps it to `cas_unsupported`) rather than risk a torn
release. This is why the same `handlePortableReadRequest` can serve every
platform while publishing safety is a per-platform capability.

## Decision 3 — Platform primitives (verified against vendor docs, 2026-10-17)

| Platform | Primitive | Read | Immutable put | Pointer CAS |
|---|---|---|---|---|
| Cloudflare | R2 | `get` | `put(onlyIf: If-None-Match: *)` | `put(onlyIf: If-Match: httpEtag)` ✔ |
| EdgeOne | Makers **Blob** | `get({type})`, `getWithHeaders` | `set` + read-back verify | none → `unsupported` |
| EdgeOne | Makers KV | `get` | — | — |
| Docker/Compose | filesystem | `readFile` | `wx` create + byte compare | temp-file + `rename` ✔ |

Rejected: **EdgeOne KV** — its keys allow only numbers/letters/underscores
(≤512 B), so `public/current-release.json` and `snapshots/v1/…` cannot be
expressed; it is also eventually consistent (≤60 s) with no etag. Blob keeps the
same key layout as R2/filesystem, which is what makes cross-store parity testable.

Rejected: a per-platform snapshot format — the frontend contract is one JSON
payload; splitting is only justified by measured production size (see Decision 5).

## Decision 4 — Cache rules (from `packages/v3-core/src/read-contract.ts`)

| Route | `Cache-Control` |
|---|---|
| `/api/collections` | `public, max-age=30, s-maxage=300, stale-while-revalidate=120` |
| `/api/calendar` | `public, max-age=60, s-maxage=600, stale-while-revalidate=300` |
| `/api/config`, `/api/version`, other JSON | `public, max-age=60` |
| `/image/:hash(/thumb)` | `public, max-age=31536000, immutable` + `CDN-Cache-Control: max-age=31536000` |
| errors / retired routes | `no-store` |

Rationale: the pointer is the only mutable object, so long-lived immutable image
caching is safe; API responses stay short-lived so a pointer flip is visible
within a minute at the edge.

## Decision 5 — Single snapshot JSON (measured, not assumed)

`packages/v3-core/src/snapshot-payload-metrics.test.ts` builds the 48-item
synthetic fixture (`docs/v3/fixtures/public-snapshot-48-synthetic.json`), asserts
it is non-trivial (>10 KB) and that **gzip stays under 500 KiB**, and verifies the
on-disk bytes round-trip with the declared hash/generation. A production-sized
sample is still missing (#69 gap), so the decision is: **single JSON now**, revisit
splitting only if a real anonymized export exceeds the gzip guard. Readers pin a
generation, so a future split can be introduced versioned without breaking parity.

## Threat model (public/private boundary)

- **Private**: builder SQLite checkpoint (leases, sync runs, collection rows,
  `subject_media` detail), credentials (`BGM_TOKEN`, Cloudflare/EdgeOne tokens).
  Never published; backups are operator files.
- **Public**: only the projected snapshot (allowlisted fields in
  `PublicCollectionItemV1` / `PublicCalendarSubjectV1`), images, manifest, pointer.
  The projection is an explicit allowlist: `projectPublicSnapshotInput`
  (`packages/v3-core/src/project-public-snapshot.ts`) drops `private !== true`
  collections and `toPublicCollectionItem` copies only the public fields — there is
  no field for `comment`, the `private` flag, `subject_json`, or credentials. The
  same filter exists on the media path (`mediaSubjectsFromFetch`).
- **Failure modes**: a missing/invalid pointer or manifest mismatch → 503
  `NO_RELEASE` (no stale or partial serving); a pointer CAS loss →
  `cas_conflict`; a platform without CAS → `cas_unsupported`.
- **Not covered here**: platform-level access control (bucket public/private
  settings), CDN cache poisoning, and rate limits — these need staging
  verification (#72).

## Consequences

- Every platform needs only three read operations; adapters are thin.
- Publishing safety is explicit per platform; EdgeOne publishing requires an
  R2-owned or single-writer pointer.
- Capability-matrix rows stay **candidate** until an authenticated staging run
  (`docs/v3/p0-contract-audit.md`); this ADR records what is code-verified vs
  doc-verified vs unverified.
