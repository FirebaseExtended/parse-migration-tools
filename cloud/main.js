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

// Welcome, this tool helps you completely migrate your data to Firebase. If
// you deploy this cloud code, you'll automatically start syncing objects to
// Firebase as they are written. To sync old objects, you should schedule the
// "import" job to run every 15 minutes in the Jobs dashboard for your app.
// (Parse Cloud Jobs are only allowed to run for 15 minutes, so this job runs for ~14.5m
// and resumes its import task every time it is rescheduled)
//
// *********************************************************
// WARNING: Parse does not let you deploy only Cloud Code. If you use Parse Hosting, please make sure
// you have the latest copy of your website in a `public` folder. If you forget, use `parse rollback`
// to revert both this code and the fact that you blew away your website.
// ********************************************************
//
// You should change all your Parse.Cloud.beforeSave/afterSave/beforeDelete/afterDelete code to use
// migrate.beforeSave/afterSave/beforeDelete/afterDelete. These functions are the same as their Parse.Cloud
// counterpart except they return Promises rather than using a response object and they play nicely with
// the new migrateObject and migrateDelete (for when an object is deleted in Parse and needs to be deleted
// from Firebase as well).
//
// For this library to have any effect at all, you must end your main.js with migrator.exportTriggers(Parse);

var migrator = require('cloud/migrator.js')(Parse);
var ref = require('cloud/firebase-rest.js')({
  url: 'YOUR_FIREBASE_DATABASE_URL'
  key: 'YOUR_OPTIONAL_FIREBASE_DATABSE_KEY',
  parse: Parse
});

// YOUR CODE HERE
// migrator.beforeSave(Parse.User, function(request) {
//   if (request.object.isNew()) {
//     throw "Please download the latest copy of this app to create new users";
//   }
//   // you can return nothing, a modified copy of request.object, or a Promise.
// });
//
// migrator.migrateObject(Parse.User, function(object) {
//   // Note: this simply copies the object's JSON format under profiles/<parseUserId>.
//   // You want to do something more sophisitcated if you have pointer relationships.
//   return ref.child("/profiles/").child(object.id).put(object);
// });
//
// END YOUR CODE
// You must include the next line:

migrator.exportTriggers();
