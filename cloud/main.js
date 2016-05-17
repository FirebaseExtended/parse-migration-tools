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

// Welcome, this tool helps you completely migrate your data to Firebase by just
// providing a single callback per class.

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

// An overly simplistic migration implementation. Isn't handling pointers etc.:
var myFirebaseDatabase = "";
function moveTo(klass) {
  return function(object) {
    var endpoint = klass + "/" + object.id + ".json";
    return Parse.Cloud.httpRequest({
      "method": "PUT",
      "url": "https://" + myFirebaseDatabase + ".firebaseio.com/" + endpoint,
      "headers": {
        "Content-Type": "application/json"
      },
      "body": JSON.stringify(object)
    });
  }
}

// Optional: if you have a version of your app that already has the Firebase SDK, it can do
// migrations for you. This is the list of minimum versions which will *not* be
// migrated.
// Note: this strategy depends on the ParseInstallation. If you do not use Installations,
// all versions will be migrated.
var DO_NOT_MIGRATE_VERSIONS = {
  // "myapp.ios": "1.2.3"
};


// MANAGED CODE SECTION; you shouldn't need to touch anything below this line:
var _ = require('underscore');

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
  if (Object.keys(DO_NOT_MIGRATE_VERSIONS).length == 0) {
    return Parse.Promise.as(true);
  }
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

// To ensure the app migrates its data only once, we use a migratedToFirebase
// key to make sure we call the migration function on every update while also
// doing a backfill. This is GoodEnough (TM) for most people, but there's a
// possible race condition where an intial import is sent at the same time as
// a record update. If you need protection against this, make sure your migration
// function uses a transaction in Fireabse.
_.each(CLASS_MIGRATIONS, function(migration, klass) {
  Parse.Cloud.beforeSave(klass, function(req, resp) {
    // Prevent infinite loops from the initial import:
    var changed = req.object.dirtyKeys();
    if (changed.length === 1 && changed[0] === "migratedToFirebase") {
      resp.success();
      return;
    }

    // Don't write with the key "undefined" when an object is new. Will be
    // picked up by job.
    if (req.object.isNew()) {
      resp.success();
      return;
    }

    return needsMigration(req.installationId).then(function(doesNeed) {
      if (doesNeed) {
        return migration(req.object);
      }
    }).then(function() {
      req.object.set("migratedToFirebase", 1);
      resp.success(req.object);
    }, function(error) {
      resp.error(error);
    });
  });
});

// Cloud Code is allowed to run for 15m. Shut down after 14.5 to avoid
// unclean termination.
var MAXIMUM_DURATION = 14.5 * 60 * 1000;
var BATCH_SIZE = 1000;
Parse.Cloud.job("importToFirebase", function(request, status) {
  var deadline = new Date() + MAXIMUM_DURATION;

  var lastMigration = Parse.Promise.as();
  _.each(CLASS_MIGRATIONS, function(migration, klass) {
    lastMigration = lastMigration.then(function() {
      status.message("Starting migration of class " + klass);
      migrateClass(klass, migration, deadline, status);
    });
  });
  lastMigration.then(function() {
    status.message("Done with initial sync!");
    status.success();
  }, function(error) {
    status.error(error)
  });
});

function migrateClass(klass, migration, deadline, status) {
  if (Date.now() > deadline) {
    status.message("Shutting down to avoid unclean exit from Parse Cloud Jobs");
    return Parse.Promise.as();
  }
  var query = new Parse.Query(klass)
    .notEqualTo("migratedToFirebase", 1)
    .limit(BATCH_SIZE)
    .addAscending("objectId")
  var migrated = 0;

  return query.find().then(function(objects) {
    migrated = objects.length;
    var migrations = _.map(objects, function(object) {
      return Parse.Promise.as(migration(object)).then(function() {
        object.set("migratedToFirebase", 1);
        return object.save();
      });
    });
    return Parse.Promise.when(migrations).then(function() {
      status.message("Migrated " + migrations + " " + klass + " records");
    });

  }).then(function(migrated) {
    // Recursion is the for loop of async.
    if (migrated == BATCH_SIZE) {
      return migrateClass(klass, migration, deadline, status);
    }
    status.message("Done migrating " + klass + " class");
  }, function(error) {
    status.error(error);
  });
};
