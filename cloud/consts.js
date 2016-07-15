// Copyright 2016 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

module.exports = {
  // Key used to track the state machine for the migrator
  MIGRATION_KEY: "migrationStatus",

  // The object is already migrated/is in a stable state. Objects which
  // had an objectId at the time of thier last migration have this state.
  IS_MIGRATED: 1,

  // Normally Migrator's generated cloud code runs the following steps:
  // Parse beforeSave:
  //   Migrator.beforeSave
  //   Migrator.migrateObject
  // Parse saves
  // Parse afterSave:
  //   Migrator.afterSave
  //
  // This path leaves migrationStatus as 1 (IS_MIGRATED).
  // To ensure that Migrator.migrateObject can always provide an objectId,
  // we do a special dance for new objects:
  //
  // Parse beforeSave #1 (no objectId):
  //   Migrator.beforeSave
  // Parse saves
  // Parse afterSave #1
  //   Migrator.afterSave
  //   (set migrationStatus to NEEDS_SECOND_PASS and resave)
  // Parse beforeSave #2 (with objectId):
  //   Migrator.migrateObject
  //   (set migrationStatus to FINISHED_SECOND_PASS)
  // Parse saves
  // Parse afterSave #2:
  //   (do nothing)
  //
  // This means we can't guarantee whether migrateObject happens before
  // or after afterSave. We choose to do this because it's the only way to
  // avoid breaking code that depends on request.object.existed().
  FINISHED_SECOND_PASS: 2,

  // A temporary state used to migrate newly created objects.
  // See FINISHED_SECOND_PASS for full documentation.
  NEEDS_SECOND_PASS: 3,

  // Another hack around the state machine:
  // when we run our initial import, we need to set various fields (e.g.
  // that the object is migrated) but we might also want to set various
  // fields about the Firebase copy of the data. The first write after this
  // state skips a logical beforeSave trigger to avoid weird side effects.
  JUST_IMPORTED: 4,

  // The number of records that are queried at once in the migration job.
  // This is exported so it can be lowered in tests.
  IMPORT_BATCH_SIZE: 1000,

  // The number of records you can send to a bulk save request in Parse.
  SAVE_BATCH_SIZE: 50
};
