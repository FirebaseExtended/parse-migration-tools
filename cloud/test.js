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
//
// To run these tests you must first run
// npm install -g mocha
// npm install
//
// You must also move config.json.sample to config.json and fill in
// the appropriate values.
//
// After this you can test the library by running `npm test`
//
// Note: You'll need to re-delete node_modules/ before deploying to Parse.
// It seems that merely uploading this many files causes a weird failure mode that
// both fails the deploy and causes you to hit the quota limit.

var assert = require('chai').assert;
var config = require('./config.json');
var consts = require('./consts');
var _ = require('underscore');

var Parse = require('parse/node');
Parse.initialize(config.parse.app_id, config.parse.api_key);

// Patch Parse.Cloud to include an httpRequest object like it does in Cloud Code.
var fetch = require('node-fetch');
Parse.Cloud.httpRequest = function(opts) {
  return fetch(opts.url, opts).then(function(res) {
    return res.json()
  }).then(function(data) {
    return {data: data};
  });
};

var Migrator = require('./migrator');
var Firebase = require('./firebase-rest');
var root = Firebase({
  url: config.firebase.url,
  secret: config.firebase.key,
  parse: Parse
});

function randomString(len) {
  var key = "";
  var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (var i=0; i < len; i++) {
    key += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return key;
}

function randomRef() {
  return root.child('unitTests').child(randomString(10));
}

describe('firebase-rest', function() {
  it('should create proper URLs', function() {
    var url = "https://myapp.firebaseio.com"
    var ref = Firebase({url: url});

    // No key:
    assert.equal(ref.url(), url + '.json');
    assert.equal(
      ref.child('foo').child('/bar').url(),
      url + '/foo/bar.json');

    // with key:
    var key = "someMagicString";
    var ref = Firebase({url: url, key: key});
    assert.equal(ref.url(), url + ".json?auth=" + key);
    assert.equal(
      ref.child('foo').child('/bar').url(),
      url + '/foo/bar.json?auth=' + key);
  });

  it('should return null for missing values', function () {
    return randomRef().get().then(function(res) {
      assert.equal(res, null);
    });
  });

  it('should support round trips', function() {
    var ref = randomRef();
    return ref.put({foo: 'bar'}).then(function() {
      return ref.get();
    }).then(function(obj) {
      assert.deepEqual(obj, {foo: 'bar'});
    });
  });

  it('should support deletes', function() {
    var ref = randomRef();
    return ref.put({foo: 'bar'}).then(function() {
      return ref.delete();
    }).then(function() {
      return ref.get();
    }).then(function(obj) {
      assert.equal(obj, null);
    });
  });

  it('should support patch', function() {
    var ref = randomRef();
    return ref.put({foo: 'bar'}).then(function() {
      return ref.patch({hello: 'world'});
    }).then(function() {
      return ref.get();
    }).then(function(obj) {
      assert.deepEqual(obj, {
        foo: 'bar',
        hello: 'world'
      });
    });
  });

  it('should support post', function() {
    var ref = randomRef();
    return ref.post({foo: 'bar'}).then(function(res) {
      var child = ref.child(res.name);
      return child.get();
    }).then(function(obj) {
      assert.deepEqual(obj, {foo: 'bar'});
    });
  });
});

var latch = function() {
  var test = false;
  var fn = function() {
    test = true;
  };
  fn.assertFalse = function() {
    assert.isFalse(test);
  }
  fn.assertTrue = function() {
    assert.isTrue(test);
  }
  fn.reset = function() {
    test = false;
  }
  return fn;
}

describe('migrator', function() {
  var migrator;

  // An object that already existed but has been changed
  var changedObject = Parse.Object.fromJSON({
    className: 'Class',
    objectId: 'id',
    hello: 'world'
  });
  changedObject.set('foo', 'bar');
  var changedObjectRequest = {object: changedObject};

  // An object that did not exist
  var newObject = new Parse.User();
  newObject.set('foo', 'bar');
  var newObjectRequest = {object: newObject};

  // Create an object that keeps control flow for before/after
  // save triggers in promisy mode.
  var response = {
    success: function(val) {
      return val;
    },
    error: function(err) {
      return Parse.Promise.error(err);
    }
  }

  beforeEach(function() {
    migrator = new Migrator(Parse);
  });

  describe('general', function() {
    it('should accept strings or classes interchangeably', function() {
      migrator.beforeSave(Parse.User, function(){});
      migrator.migrateObject("_User", function(){});
      var handlers = migrator.handlers(Parse.User);
      assert.property(handlers, 'beforeSave');
      assert.property(handlers, 'migrateObject');
      assert.notProperty(handlers, 'afterSave');
    });

    it('should only allow a trigger registration once per class', function() {
      var allTriggers = [
        'beforeSave', 'afterSave',
        'beforeDelete', 'afterDelete',
        'migrateObject', 'migrateDelete'
      ];
      var noop = function() {};

      // We should be able to register every trigger for every class successfully.
      allTriggers.forEach(function(trigger) {
        migrator[trigger](Parse.User, noop);
      });

      // But cannot register a second time on the same class
      allTriggers.forEach(function(trigger) {
        assert.throws(function() {
          migrator[trigger](Parse.User, noop)
        });
      });

      // Registering on a new class is OK though
      allTriggers.forEach(function(trigger) {
        migrator[trigger]("NewClass", noop);
      });
    });

    it('should export different triggers for different classes', function() {
      classABeforeSave = latch();
      classBBeforeSave = latch();
      migrator.beforeSave('ClassA', classABeforeSave);
      migrator.beforeSave('ClassB', classBBeforeSave);

      request = {object: new Parse.Object('ClassA')};
      var exportedTrigger = migrator.getBeforeSave('ClassA');
      return exportedTrigger(request, response).then(function() {
        classABeforeSave.assertTrue();
        classBBeforeSave.assertFalse();
      });
    });
  });

  describe('exports', function() {
    var builtInTriggers = ['beforeSave', 'afterSave', 'beforeDelete', 'afterDelete'];
    var parseMock = {
      didRegister: {},
      Promise: Parse.Promise,
      Cloud: {
        job: function() {}
      },
      assertOnlyRegistered: function(expected) {
        _.each(parseMock.didRegister, function(value, key) {
          if (_.contains(expected, key)) {
            value.assertTrue();
          } else {
            value.assertFalse();
          }
        });
      },
      reset: function() {
        parseMock.didRegister = {};
        builtInTriggers.forEach(function(trigger) {
          var didRegister = latch();
          parseMock.Cloud[trigger] = function(klass, callback) {
            assert.equal(klass, 'Class');
            didRegister();
          };
          parseMock.didRegister[trigger] = didRegister;
        });
      }
    };

    beforeEach(function() {
      migrator = new Migrator(parseMock);
      parseMock.reset();
    });

    it('builtin types register themselves', function() {
      builtInTriggers.forEach(function(trigger) {
        parseMock.reset();
        migrator = new Migrator(parseMock);
        migrator[trigger]('Class', function(){});
        migrator.exportTriggers();

        parseMock.assertOnlyRegistered([trigger]);
      });
    });

    it('migrateDelete exports beforeDelete', function() {
      migrator.migrateDelete('Class', function(){});
      migrator.exportTriggers();

      parseMock.assertOnlyRegistered(['beforeDelete']);
    });

    it('migrateObject exports before/afterSave', function() {
      migrator.migrateObject('Class', function(){});
      migrator.exportTriggers();

      parseMock.assertOnlyRegistered(['beforeSave', 'afterSave']);
    });
  });

  describe('beforeSave', function() {
    it('should not run migrations for failed saves', function() {
      var ranMigration = latch();
      migrator.beforeSave('Class', function() {
        throw "Abort!";
      });
      migrator.migrateObject('Class', ranMigration);

      // Generate & call the exported Parse beforeSave trigger.
      var exportedTrigger = migrator.getBeforeSave('Class');
      return exportedTrigger(changedObjectRequest, response).then(function() {
        assert.fail("beforeSave should have aborted");
      }, function() {
        ranMigration.assertFalse();
      });
    });

    it('should not run migrations for objects without objectIds', function() {
      var ranBeforeSave = latch();
      var ranMigration = latch();
      migrator.beforeSave(Parse.User, ranBeforeSave);
      migrator.migrateObject(Parse.User, ranMigration);

      // Generate & call the exported Parse beforeSave trigger.
      var exportedTrigger = migrator.getBeforeSave(Parse.User)
      return exportedTrigger(newObjectRequest, response).then(function() {
        ranBeforeSave.assertTrue();
        ranMigration.assertFalse();
      });
    });

    it('should only run migrations for 2-pass migration tasks', function() {
      var secondPassObject = Parse.Object.fromJSON({
        className: 'SecondPass',
        objectId: 'objectId',
      });
      secondPassObject.set(consts.MIGRATION_KEY, consts.NEEDS_SECOND_PASS);
      var secondPassRequest = {object: secondPassObject};

      var ranBeforeSave = latch();
      var ranMigration = latch();
      migrator.beforeSave('SecondPass', ranBeforeSave);
      migrator.migrateObject('SecondPass', ranMigration);

      var exportedTrigger = migrator.getBeforeSave('SecondPass');
      return exportedTrigger(secondPassRequest, response).then(function(obj) {
        ranBeforeSave.assertFalse();
        ranMigration.assertTrue();
        assert.equal(obj.get(consts.MIGRATION_KEY), consts.FINISHED_SECOND_PASS);
      });
    });

    it('changing an object that needed a 2-pass migration should go back to IS_MIGRATED', function() {
      var json = {
        className: 'SecondPass',
        objectId: 'objectId',
      };
      json[consts.MIGRATION_KEY] = consts.FINISHED_SECOND_PASS;
      var object = Parse.Object.fromJSON(json);
      object.set('foo', 'bar');
      var request = {object: object};

      var ranBeforeSave = latch();
      var ranMigration = latch();
      migrator.beforeSave('SecondPass', ranBeforeSave);
      migrator.migrateObject('SecondPass', ranMigration);

      var exportedTrigger = migrator.getBeforeSave('SecondPass');
      return exportedTrigger(request, response).then(function(obj) {
        ranBeforeSave.assertTrue();
        ranMigration.assertTrue();
        assert.equal(obj.get(consts.MIGRATION_KEY), consts.IS_MIGRATED);
      });
    });

    it('should not set migration status without a migration function', function() {
      var didBeforeSave = latch();
      migrator.beforeSave('Class', didBeforeSave);

      var exportedTrigger = migrator.getBeforeSave('Class');
      return exportedTrigger(changedObjectRequest, response).then(function(object) {
        didBeforeSave.assertTrue();
        assert.isUndefined(object.get(consts.MIGRATION_KEY));
      });
    });
  });

  describe('afterSave', function() {
    it('should set NEEDS_SECOND_PASS for new objects (afterSave defined)', function() {
      var ranAfterSave = latch();
      var ranMigration = latch();
      migrator.afterSave(Parse.User, ranAfterSave);
      migrator.migrateObject(Parse.User, ranMigration);

      var newObject = new Parse.User()
      var didSave = false;
      newObject.save = function() {
        didSave = true;
        assert.equal(this.get(consts.MIGRATION_KEY), consts.NEEDS_SECOND_PASS);
      };
      var newObjectRequest = {object: newObject};

      // Generate & call the exported Parse beforeSave trigger.
      var exportedTrigger = migrator.getAfterSave(Parse.User)
      return exportedTrigger(newObjectRequest).then(function() {
        ranAfterSave.assertTrue();
        ranMigration.assertFalse();
        assert.isTrue(didSave);
      });
    });

    it('should set NEEDS_SECOND_PASS for new objects (afterSave undefined)', function() {
      var ranMigration = latch();
      migrator.migrateObject(Parse.User, ranMigration);

      var newObject = new Parse.User()
      var didSave = false;
      newObject.save = function() {
        didSave = true;
        assert.equal(this.get(consts.MIGRATION_KEY), consts.NEEDS_SECOND_PASS);
        return Parse.Promise.as();
      };
      var newObjectRequest = {object: newObject};

      // Generate & call the exported Parse beforeSave trigger.
      var exportedTrigger = migrator.getAfterSave(Parse.User)
      return exportedTrigger(newObjectRequest).then(function() {
        ranMigration.assertFalse();
        assert.isTrue(didSave);
      });
    });

    it('should run afterSave for final states', function() {
      var ranAfterSave = latch();
      var ranMigration = latch();
      var didSave = latch();
      migrator.afterSave(Parse.User, ranAfterSave);
      migrator.migrateObject(Parse.User, ranMigration);

      [consts.IS_MIGRATED, consts.FINISHED_SECOND_PASS].forEach(function(state) {
        ranAfterSave.reset();
        ranMigration.reset();
        didSave.reset();

        var json = {
          className: 'Class',
          objectId: 'objectId'
        };
        json[consts.MIGRATION_KEY] = state;
        var newObject = Parse.Object.fromJSON(json);
        newObject.save = didSave;
        var newObjectRequest = {object: newObject};

        // Generate & call the exported Parse beforeSave trigger.
        var exportedTrigger = migrator.getAfterSave(Parse.User)
        return exportedTrigger(newObjectRequest).then(function() {
          ranAfterSave.assertTrue();
          ranMigration.assertFalse();
          didSave.assertFalse();
        });
      });
    });

    it('should not set migration status without a migration script', function() {
      var ranAfterSave = latch();
      migrator.afterSave(Parse.User, ranAfterSave);

      var newObject = new Parse.User()
      var didSave = latch();
      newObject.save = function() {
        didSave();
        return Parse.Promise.as();
      };
      var newObjectRequest = {object: newObject};

      // Generate & call the exported Parse beforeSave trigger.
      var exportedTrigger = migrator.getAfterSave(Parse.User)
      return exportedTrigger(newObjectRequest).then(function() {
        ranAfterSave.assertTrue();
        didSave.assertFalse();
        assert.isUndefined(newObject.get(consts.MIGRATION_KEY));
      });
    });
  });

  describe('beforeDelete', function() {
    var object = Parse.Object.fromJSON({
      'className': 'Class',
      'objectId': 'id'
    });
    var request = {object: object};

    it('should not migrate a cancelled delete', function() {
      var didMigrate = latch();
      var didCallBeforeDelete = latch();
      migrator.beforeDelete('Class', function() {
        didCallBeforeDelete();
        throw "I changed my mind! I want to live!";
      });
      migrator.migrateDelete('Class', didMigrate);

      var exportedTrigger = migrator.getBeforeDelete('Class');
      return exportedTrigger(request, response).then(function() {
        assert.fail("Should have cancelled deletion");
      }, function() {
        didCallBeforeDelete.assertTrue();
        didMigrate.assertFalse();
      });
    });

    it('should migrate a successful delete', function() {
      var didMigrate = latch();
      var didDelete = latch();
      migrator.beforeDelete('Class', didDelete);
      migrator.migrateDelete('Class', didMigrate);

      var exportedTrigger = migrator.getBeforeDelete('Class');
      return exportedTrigger(request, response).then(function() {
        didDelete.assertTrue();
        didMigrate.assertTrue();
      });
    });

    it('should work with just migrateDelete', function() {
      var didMigrate = latch();
      migrator.migrateDelete('Class', didMigrate);

      var exportedTrigger = migrator.getBeforeDelete('Class');
      return exportedTrigger(request, response).then(function() {
        didMigrate.assertTrue();
      });
    });

    it('should work with just afterDelete', function() {
      var didDelete = latch();
      migrator.beforeDelete('Class', didDelete);

      var exportedTrigger = migrator.getBeforeDelete('Class');
      return exportedTrigger(request, response).then(function() {
        didDelete.assertTrue();
      });
    });
  });

  describe('afterDelete', function() {
    it('should call afterDelete', function() {
      didAfterDelete = latch();
      migrator.afterDelete('Class', didAfterDelete);

      var exportedTrigger = migrator.getAfterDelete('Class');
      var request = {object: new Parse.User()};

      return exportedTrigger(request).then(function() {
        didAfterDelete.assertTrue();
      });
    });
  });

  describe('migration job', function() {
    it('should handle a smoke test (live traffic)', function() {
      // This involves a lot of network requests; give it a minute
      this.timeout(60 * 1000);
      consts.BATCH_SIZE = 2;
      var classNameA = 'MigrationJobTest_' + randomString(10);
      var classNameB = 'MigrationJobTest_' + randomString(10);
      var objects = [];

      // Should not call before/AfterSave if we're only changing the migraiton
      // status
      var calledBeforeSave = latch();
      var calledAfterSave = latch();
      var migratedLatch = {};
      var migratedObjectIds = {};
      _.each([classNameA, classNameB], function(klass) {
        objects.push(new Parse.Object(klass, {
          condition: 'not_migrated',
        }));
        objects.push(new Parse.Object(klass, {
          condition: 'already_migrated',
          migrationStatus: 1,
        }));
        objects.push(new Parse.Object(klass, {
          condition: 'finished_second_pass',
          migrationStatus: 2,
        }));
        objects.push(new Parse.Object(klass, {
          condition: 'needs_second_pass',
          migrationStatus: 3,
        }));

        migratedLatch[klass] = latch();
        migrator.beforeSave(klass, calledBeforeSave);
        migrator.afterSave(klass, calledAfterSave);
        migrator.migrateObject(klass, function(obj) {
          migratedLatch[klass].assertFalse(); // only migrate once
          migratedLatch[klass]();
          assert.equal(obj.get('condition'), 'not_migrated');
          migratedObjectIds[klass] = obj.id;
        });
      });

      return Parse.Object.saveAll(objects).then(function() {
        return migrator.getImportJob()(undefined, response);
      }).then(function(migrated) {
        assert.equal(migrated, 2);
        calledBeforeSave.assertFalse();
        calledAfterSave.assertFalse();
        migratedLatch[classNameA].assertTrue();
        migratedLatch[classNameB].assertTrue();

        var fetchMigrated = _.map(migratedObjectIds, function(id, klass) {
          var obj = new Parse.Object(klass)
          obj.id = id;
          return obj.fetch();
        });
        return Parse.Promise.when(fetchMigrated);
      }).then(function(objects) {
        _.each(objects, function(obj) {
          assert.equal(obj.get(consts.MIGRATION_KEY), consts.JUST_IMPORTED);
        });
      });
    });
  });
});
