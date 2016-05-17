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

// Welcome! This migration script helps you handle common tasks in a Parse
// migration. This main.js helps you use two different goals:
// 1. Migrate a ParseObject to Firebase (on demand or automatically)
//    This is achieved with both an afterSave trigger and a cloud function "migrate"
//    which takes a "class" parameter and an "objectId" or "objectIds" parameter.
// 2. Optionally make the app read-only. This helps if you don't want to worry
//    about your initial sync overwriting a live migration.
//
// CAUTION! The Parse CLI *must* deploy both Cloud Code and Parse Hosting for all deploys.
// PLEASE make sure you copy any website code to the public directory or you will wipe
// away your website when you use this.

// CONFIG SECTION:
// When this is set, writes will fail. Use this if you are using an initial sync
// and it doesn't take care to avoid overwriting your continuous sync.
var MAKE_APP_READ_ONLY = false;

// If MAKE_APP_READ_ONLY is true, this must include the list of Parse subclasses.
// You can use either a true class (e.g. Parse.Installation) or a string
// ("_Installation)
var ALL_CLASSES = [Parse.User, Parse.Installation];

// If you have a version of your app that already has the Firebase SDK, it can do
// migrations for you. This is the list of minimum versions which will *not* be
// migrated.
// Note: this strategy depends on the ParseInstallation. If you do not use Installations,
// all versions will be migrated.
var DO_NOT_MIGRATE_VERSIONS = {
  // "myapp.ios": "1.2.3"
};

// Call this with a callback for each class you'd like to migrate. The callback accepts
// a ParseObject and may return a promise.
// e.g.:
// addMigration("Record", function(record) {
//   return Parse.Cloud.httpRequest({
//     method: "POST",
//     url: "https://myfirebasedatabase.firebaseio.com/records/" + record.id + ".json?key=YOURSECRETKEY",
//     headers: {
//       "Content-Type": "application/json"
//     },
//     body: JSON.stringify(record)
//  });
// });
//
// Note: it's very likely your data model will look different in Parse and Firebase. If you
//   choose to save multiple paths to Firebase, you can use Pasre.Promise.when to return a Promise
//   that waits for all of them to finish.
var CLASS_MIGRATIONS = {};
function addMigration(klass, callback) {
  if (typeof klass === "string") {
    CLASS_MIGRATIONS[klass] = callback;
  } else {
    CLASS_MIGRATIONS[(new Class()).className] = callback;
  }
}

// MANAGED CODE SECTION; you shouldn't need to touch anything below this line:
var _ = require('underscore');

// Task 1: making an app read-only:
if (MAKE_APP_READ_ONLY) {
  _.each(ALL_CLASSES, function(klass) {
    Parse.Cloud.beforeSave(klass, function(req, resp) {
      resp.error("Sorry, we are currently performing scheduled maintenance.");
    })
  });
}

// Task 2: making an app do live migrations
function versionCompare(left, right) {
  var leftSplit = _.split(left);
  var rightSplit = _.split(right);
  var i = 0;
  while (true) {
    if (i >= leftSplit.length || i >= rightSplit.length) {
      return leftSplit.length - rightSplit.length;
    }
    if (leftSplit[i] < rightSplit[i]) {
      return -1
    } else if (leftSplit[i] > rightSplit[i]) {
      return 1
    }
  }
}

function needsMigration(installationId) {
  if (!installationId) {
    console.log("No InstallationId; migrating to be safe");
    return Parse.Promise.as(true);
  }

  console.log("Checking whether installationId " + installationId + " needs migration");
  var query = (new Parse.Query(Parse.Installation));
  return query.get(installationId).then(function(installation) {
    var version = installation.get("appVersion");
    var appName = installation.get("appName");
    if (!version || !appName) {
      console.log("Installation does not have built-in fields 'appVersion' and 'appName'" +
                  " this typically means the SDK is very old. Migrating to be safe");
      return true;
    }
    var migratedVersion = DO_NOT_MIGRATE_VERSION[appName];
    if (!migratedVersion) {
      console.log("warning: do not know a version for the app " + appName +
                  " that is already migrated. Migrating to be safe");
      return true;
    }
    return 0 < versionCompare(version, migratedVersion);
  }, function(error) {
    if (error.code == 101) {
      // Object not found; the app doesn't save Installations for this client
      // (most commonly the JS SDK)
      console.log("Installation " + installationId + " does not have an actual " +
                  "Installation object; migrating to be safe");
      return Parse.Promise.as(true);
    }
    console.error("Unexpected error: " + JSON.stringify(error));
  });
}

_.each(CLASS_MIGRATIONS, function(migration, klass) {
  Parse.Cloud.afterSave(klass, function(req, resp) {
    return needsMigration(req.installationId).then(function(doesNeed) {
      if (doesNeed) {
        return migration(req.object);
      }
    });
  });
});

// 3. Define a migration function. This is used if you want to scan across your app and force
//    a migration. BE CAREFUl in this case that your migration function checks to avoid blowing
//    away newer data or put your app in read-only mode.
Parse.Cloud.define("migrate", function(req, resp) {
  var klass = req.params['class'];
  if (!klass) {
    resp.error("Missing mandatory param 'class'");
    return;
  }
  var query = new Parse.Query(klass);

  if (req.params.objectId) {
    query = query.equalTo("objectId", req.params.objectId);
  } else if (req.params.objectIds) {
    console.log("Migrating " + JSON.stringify(req.params.objectIds));
    query = query.containedIn("objectId", req.params.objectIds);
  } else {
    resp.error("Must provide param objectId or [objectIds]");
    return;
  }

  var allPromises = [];
  query.each(function(obj) {
    console.log("Migrating ", obj.id);
    allPromises.push(CLASS_MIGRATIONS[klass](obj));
  }).then(function() {;
    // Black magic: we could return the promise from the migration in the function above,
    //  but that forces all requests to happen in sequence. This trick lets us issue requests
    // to Firebase as fast as we can receive them. When we're done *sending* requests, we
    // know what all requests are but have not necessarily finished them all. This lets us
    // wait until all requests are done.
    return Parse.Promise.when(allPromises)
  }).then(function() {
    resp.success({});
  }, function(error) {
    resp.error(error);
  });
});
