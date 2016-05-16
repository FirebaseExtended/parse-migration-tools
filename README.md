# Mygration

This is a set of code to help you think about migrating from Parse to Firebase.
It is a personal project wholly owned by Google Inc, intended to
compliment [Migrate to
Firebase](https://events.google.com/io2016/schedule?sid=b4641ff7-0bef-e511-a517-00155d5066d7#day1/b4641ff7-0bef-e511-a517-00155d5066d7).

We intend to cover the following areas, though many changes won't be
ready until after the talk.

- [x] Migrate Parse Data to Firebase using Cloud Code.
- [ ] Migrate Users from Parse Social to Firebase Auth client-side.
- [ ] Migrate devices from Parse Push to Firebase Notifications by keeping Parse channels in sync with Firebase topics.
- [ ] Guides for using Firebase Storage to back your Parse Files.

## Parse Data

It's scholastically cleanest to have your backends do all the migration
work for you, but in reality it's often easier to write clients that
understand a migration is happening. If you're really fancy, you can use
features like Firebase Remote Config to choose whether the source of
truth should be Parse or Firebase.

The Firebase and Parse data models are too different, to paper over. You
really should think about how your app would have structured its data if
it were written in Firebase to begin with. Once you know how your
natural Firebase structure would look, you can probably describe how an
individual ParseObject would map to data in the Firebase Realtime
Database. We have some basic cloud code that, given a transformation
function, will automatically migrate all of your data from Parse to
Firebase and _keep_ migrating new data. You can find this in the cloud
folder.

## Parse Files

Parse has not yet decided how they plan to migrate Parse Files to other
backends
([discussion](github.com/ParsePlatform/parse-server/wiki/Configuring-File-Adapters
)). When they do, we expect they will continue with their plan to
support Google Cloud Storage.

Parse Server already supports Google Cloud Storage, and there's an
[adapter](https://www.npmjs.com/package/parse-server-gcs-adapter) that lets you do this.
Because Firebase Storage is built on top of Google Cloud Storage, this
means you can use one backend for both your Parse Files and Firebase
Storage.
