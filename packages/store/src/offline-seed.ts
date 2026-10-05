// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The bundled seed. Imported lazily by the offline client so the JSON stays
// out of the app shell until offline mode is used.
import auditLog from '../seed/audit-log.json'
import collectionItems from '../seed/collection-items.json'
import collections from '../seed/collections.json'
import comments from '../seed/comments.json'
import creatorFeatured from '../seed/creator-featured.json'
import creatorLinks from '../seed/creator-links.json'
import creators from '../seed/creators.json'
import downloads from '../seed/downloads.json'
import follows from '../seed/follows.json'
import likes from '../seed/likes.json'
import listingFiles from '../seed/listing-files.json'
import listingVersions from '../seed/listing-versions.json'
import listings from '../seed/listings.json'
import makes from '../seed/makes.json'
import librarySettings from '../seed/library-settings.json'
import printProfiles from '../seed/print-profiles.json'
import profiles from '../seed/profiles.json'
import users from '../seed/users.json'
import type { SeedData } from './rows'

/**
 * The JSON files are generated from generateSeed() and checked against it and
 * against the row schemas in seed.test.ts, so the cast here is safe.
 */
export function bundledSeed(): SeedData {
  const raw = {
    users,
    profiles,
    library_settings: librarySettings,
    creators,
    creator_links: creatorLinks,
    follows,
    listings,
    listing_versions: listingVersions,
    listing_files: listingFiles,
    print_profiles: printProfiles,
    creator_featured: creatorFeatured,
    likes,
    comments,
    makes,
    collections,
    collection_items: collectionItems,
    downloads,
    audit_log: auditLog,
  }
  return raw as unknown as SeedData
}
