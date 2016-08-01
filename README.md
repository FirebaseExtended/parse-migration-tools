# Parse Migration Tools

This is a set of code to help you think about migrating from Parse to Firebase.
This project compliments the talk "Migrate to Firebase" from Google I/O and the Parse migration guide for Firebase. For additional information see:

* [The talk](https://www.youtube.com/watch?v=RWM9J6Mvu-4) on YouTube
* [The slides](https://migrateto.firebaseapp.io) on Firebase Hosting
* The Parse migration Guide ([iOS](https://firebase.google.com/support/guides/parse-ios) or [Android](https://firebase.google.com/support/guides/parse-android))

We intend to cover the following areas with code tools. Checked sections are ready for use:

- [x] Migrate Parse Data to Firebase using Cloud Code.
- [ ] Migrate Users from Parse Social to Firebase Auth client-side.
- [ ] Migrate devices from Parse Push to Firebase Notifications by keeping Parse channels in sync with Firebase topics.
- [ ] Guides for using Firebase Storage to back your Parse Files.

## Parse Data

The Firebase and Parse data models are very different. You will build
a cleaner app if you start by thinking about how your app's data would be laid
out if it were written on Firebase from the beginning. Once you know how your
natural Firebase structure would look, you can probably describe how an
individual ParseObject would map to the Firebase Realtime
Database. We offer two files to help you migrate from Parse:

 1. `migrator.js` A tool that allows you to keep your existing Cloud Code *and* use Cloud Code to migrate data out of Parse.
 2. `firebase-rest.js` A simple wrapper that helps you talk to Firebase in Cloud Code (where the Firebase Node module doesn't work).
 
Imagine you have a `BlogPost` class in Parse with the following fields:

* **title** *(String)* Name the post
* **body** *(String)* Blog contents
* **keywords** *(String)* Originally you chose to do text searches on a space separated list
* **keywords_list** *(Array)* You realized later that Parse can search an array better and added Cloud Code to put **keywords** into **keywords_list**

You probably have Cloud Code like:

```js
Parse.Cloud.beforeSave('BlogPost', function(request, response) {
  var object = request.object;
  if (object.isDirty('keywords_list')) {
    response.error('keywords_list is managed by Cloud Code only');
    return;
  }
  object.set('keywords_list', object.get('keywords').split(' '));
  response.success(object);
}
```

A logical structure for your blog posts in Firebase might look like:

```json
{
  "posts": {
    "aBlogPostID": {
      "title": "Firebase expands to become a unified app platform",
      "body": "Eighteen months ago, Firebase joined Google...",
      "keywords": ["googleio", "announcements"],
    },
  },
  "keywords": {
    "googleio": {
      "aBlogPostID": true,
      "anotherBlogAboutGoogleIO": true
    },
    "announcements": {
      "aBlogPostID": true
    }
  }
}
```

A few things are noticeably different in this structure:

1. We no longer use the legacy `"keywords"` string. `"keywords"` in Firebase is the value of `"keywords_list"` in Parse.
2. The values from `"keywords_list"` are stored in a different location so we can look up blogs related to a `"googleio"` by reading the keys under `"/keywords/googleio"`. We also have `"keywords"` inside the blog post. This lets us clean up a blog post by knowing all of its references under `"keywords"` and lets us display a blog post's keywords inline if we want.

Migrator can help us do this very easily in 3 steps:

1. Change our Parse.beforeSave to a Migrator.beforeSave. This is the same except it works with promises instead of callbacks.
2. Describe how we would copy an object from Parse to Firebase
3. (optional) Describe how we translate a Parse object deletion to Fireabse

We would do this with the following Cloud Code:

```js
var _ = require('underscore');
var migrator = require('cloud/migrator.js')(Parse);
var ref = require('cloud/firebase.js')({
  url: 'https://my-firebase-database-url.firebaseio.com',
  key: 'if-my-firebase-database-is-secured-this-key-gives-me-admin-access',
  parse: Parse
});

// Notice this is almost the same (and actually a bit simpler) than the original beforeSave
migrator.beforeSave('BlogPost', function(request) {
  var object = request.object;
  if (object.isDirty('keywords_list')) {
    throw 'keywords_list is managed by Cloud Code only';
  }
  object.set('keywords_list', object.get('keywords').split(' '));
  return object;
}

// When an object is created, this is run just after the afterSave (we need a second pass
// to get an object ID). When the object is modified, this is run between beforeSave and
// afterSave.
migrator.migrateObject('BlogPost', function(object) {
  // We're setting the full object
  var saveObject = ref.child('posts').child(object.id).put({
    title: object.get('title'),
    body: object.get('body'),
    keywords: object.get('keywords')
  });
  
  // But using a deep update to only adjust keywords
  var keywordsUpdate = {};
  _.each(object.get('keywords'), function(keyword) {
    keywordsUpdate['keywords/' + keyword + '/' + object.id] = true;
  });
  
  return Parse.Promise.when(saveObject, ref.patch(keywordsUpdate));
});

// This is run between beforeDelete and afterDelete.
migrator.migrateDelete('BlogPost', function(object) {
  // Setting a value to null in Firebase deletes it
  var updates = {};
  _.each(object.get('keywords'), function(keyword) {
    updates['keywords/' + keyword + '/' + object.id] = null;
  });
  updates['posts/' + object.id] = null;
  return ref.patch(updates);
});

// generate Parse.Cloud triggers.
migrator.exportTriggers();
```

This will ensure all changes that happen on your old app get translated to Firebase.
This will create a `beforeSave` and `afterSave` trigger for `BlogPost` as well as a Cloud Job
called `"import"`. Schedule this job to run every 15 minutes to automatically migrate all
data from Parse into Firebase.

In new versions of your app, you should make sure that writes to Parse (either from the Firebase
backend or from an app that dual-writes to Parse and Firebase) sets `migrationStatus` to `1` in
Parse to short-circuit the migration logic.

## Parse Files

Parse has not yet decided how they plan to migrate Parse Files to other
backends
([discussion](https://github.com/ParsePlatform/parse-server/wiki/Configuring-File-Adapters
)). When they do, we expect they will continue with their plan to
support Google Cloud Storage.

Parse Server already supports Google Cloud Storage, and there's an
[adapter](https://www.npmjs.com/package/parse-server-gcs-adapter) that lets you do this.
Because Firebase Storage is built on top of Google Cloud Storage, this
means you can use one backend for both your Parse Files and Firebase
Storage.
