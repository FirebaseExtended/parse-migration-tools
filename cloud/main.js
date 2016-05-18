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
// providing a single callback per class. If you deploy this cloud code, you'll automatically start
// syncing objects to Firebase as they are written. To sync old objects, you should schedule
// "importToFirebase" to run every 15 minutes in the Jobs dashboard for your app.
// (Parse Cloud Jobs are only allowed to run for 15 minutes, so this job runs for ~14.5m
// and resumes its import task every time it is rescheduled)
//
// *********************************************************
// WARNING: Parse does not let you deploy only Cloud Code. If you use Parse Hosting, please make sure
// you have the latest copy of your website in a `public` folder. If you forget, use `parse rollback`
// to revert both this code and the fact that you blew away your website.
// ********************************************************
//
// To register a class to be migrated, call addMigration after it is defiend. You pass a callback that
// accepts a Parse.Object and returns a Promise.
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
//
// If you've chosen to do a gradual migration and have an app that is double-writing to both Parse and Firebase,
// you can set 'migratedToFirebase' to 1 to prevent it from doing the extra work of a migration server-side
// as well.
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

// MANAGED CODE SECTION; you shouldn't need to touch anything below this line:
var _ = require('underscore');

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

    // Using Parse.Promise.as here lets us handle the result of migration() correctly
    // whether it is a Promise or not.
    return Parse.Promise.as(migration(req.object))
    .then(function() {
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
      console.log("Starting migration of class " + klass);
      migrateClass(klass, migration, deadline, status);
    });
  });
  lastMigration.then(function() {
    console.log("Done with initial sync!");
    status.success();
  }, function(error) {
    status.error(error)
  });
});

function migrateClass(klass, migration, deadline, status) {
  if (Date.now() > deadline) {
    console.log("Shutting down to avoid unclean exit from Parse Cloud Jobs");
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
      console.log("Migrated " + migrations + " " + klass + " records");
    });

  }).then(function(migrated) {
    // Recursion is the for loop of async.
    if (migrated == BATCH_SIZE) {
      return migrateClass(klass, migration, deadline, status);
    }
    console.log("Done migrating " + klass + " class");
  }, function(error) {
    status.error(error);
  });
};
