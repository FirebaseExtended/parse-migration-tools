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
// This library helps build the Cloud Code you need to migrate from
// Parse to another backend. It is modeled as a newer version of Cloud Code;
// all functions are Promise based--they take an old object and return a
// Promise. In the case of a before* trigger, that Promise can resolves to a
// Parse Object to replace what object should be written.
//
// This library runs before* triggers, migrate code, and then after* triggers.
// New objects will need an additional save to be migrated because they are
// missing their objectID in the first pass.

var _ = require('underscore');

function classString(klass) {
  if (_.isString(klass)) {
    return klass;
  } else {
    return (new klass()).className;
  }
}

// Tests run under Node, which has a different import path than Cloud Code
var IS_NODE = (typeof process !== 'undefined' &&
               !!process.versions &&
               !!process.versions.node &&
               !process.version.electron);
var consts = IS_NODE ? require('./consts') : require('cloud/consts.js');
var MAXIMUM_DURATION = 14.5 * 60 * 1000;
var ThisIsNotAResponseObject =  {
      success: function() {
        throw "The migration tool expects you to return promises, not use callbacks";
      },
      error: function() {
        throw "The migration tool expects you to return promises, not use callbacks";
      }
    };

var Migrator = function(Parse) {
  this._triggers = {};

  // These four functions are like the built-in Parse Cloud Code
  // triggers, but for simplicity's sake they return Promises instead
  // of using a callback object. This allows us to have one uniform
  // response
  this.beforeSave = this._registerFn("beforeSave");
  this.afterSave = this._registerFn("afterSave");
  this.beforeDelete = this._registerFn("beforeDelete");
  this.afterDelete = this._registerFn("afterDelete");

  // Migrate functions are a new trigger type. These methods are called between
  // before/afterSave triggers. The migrateObject function is also used to
  // create jobs/functions.
  this.migrateObject = this._registerFn("migrateObject");
  this.migrateDelete = this._registerFn("migrateDelete");
  this.bulkImport = this._registerFn("bulkImport");

  this._parse = Parse;
};

Migrator.prototype._registerFn = function(triggerType) {
  var self = this;
  return function(klass, callback) {
    var key = classString(klass);
    var obj = self._triggers[key] || {};
    if (!_.isUndefined(obj[triggerType])) {
      throw "Already registered a " + triggerType + " trigger for " + klass;
    }
    obj[triggerType] = callback;
    self._triggers[key] = obj;
  }
};

Migrator.prototype.handlers = function(klass) {
  return this._triggers[classString(klass)] || {};
};

// exportTriggers exports all the necessary Parse Cloud Code.
// The actual functions being registered are generated with getXYZ so we
// can more easily test invocation of these functions.
Migrator.prototype.exportTriggers = function() {
  var self = this;
  _.each(this._triggers, function(handlers, klass) {
    if (!_.isUndefined(handlers.beforeSave) || !_.isUndefined(handlers.migrateObject)) {
      self._parse.Cloud.beforeSave(klass, self.getBeforeSave(klass));
    }

    if (!_.isUndefined(handlers.afterSave) || !_.isUndefined(handlers.migrateObject)) {
      self._parse.Cloud.afterSave(klass, self.getAfterSave(klass));
    }

    if (!_.isUndefined(handlers.beforeDelete) || !_.isUndefined(handlers.migrateDelete)) {
      self._parse.Cloud.beforeDelete(klass, self.getBeforeDelete(klass));
    }

    if (!_.isUndefined(handlers.afterDelete)) {
      self._parse.Cloud.afterDelete(klass, self.getAfterDelete(klass));
    }
  });

  self._parse.Cloud.job("import", self.getImportJob());
};

Migrator.prototype.getBeforeSave = function(klass) {
  var handlers = this.handlers(klass),
    beforeSave = handlers.beforeSave,
    migrate = handlers.migrateObject,
    _Parse = this._parse,
    _Promise = _Parse.Promise;

  return function(request, response) {
    var obj;
    // Reasons to skip the logical beforeSave:
    // * it isn't defined (only migration is)
    // * we are skipping it because we needed a 2-pass migration for a new object
    // * we are skipping everything because we made changes for the import job
    // See consts.js for a full explanation of the state machine.
    var changed = request.object.dirtyKeys();
    if (request.object.dirty(consts.MIGRATION_KEY) &&
        request.object.get(consts.MIGRATION_KEY) === consts.JUST_IMPORTED) {
        return;
    }
    var shouldBeforeSave = !_.isUndefined(beforeSave) &&
      !(changed.length === 1 && changed[0] === consts.MIGRATION_KEY);

    return _Promise.as().then(function() {
      if (shouldBeforeSave) {
        return beforeSave(request, ThisIsNotAResponseObject);
      }
    }).then(function(maybeNew) {
      obj = maybeNew instanceof _Parse.Object ? maybeNew : request.object;

      // Hybrid apps can explicitly opt-out.
      if (obj.get(consts.MIGRATION_KEY) === consts.IS_MIGRATED || !migrate) {
        return obj;
      }

      if (obj.isNew()) {
        // Will re-dirty the object in afterSave so another beforeSave
        // catches this case with the objectId available.
        return obj;
      }

      // won't save unless the migration succeeds. The difference between
      // these two state machines is explained in consts.js
      if (obj.get(consts.MIGRATION_KEY) === consts.NEEDS_SECOND_PASS) {
        obj.set(consts.MIGRATION_KEY, consts.FINISHED_SECOND_PASS);
      } else {
        obj.set(consts.MIGRATION_KEY, consts.IS_MIGRATED);
      }
      return _Promise.as().then(function() {
        return migrate && migrate(obj);
      }).then(function(maybeNew) {
        return maybeNew instanceof _Parse.Object ? maybeNew : obj;
      });

    }).then(function() {
      return response.success(obj);
    }, function(err) {
      return response.error(err);
    });
  }
};

Migrator.prototype.getAfterSave = function(klass) {
  var handlers = this.handlers(klass),
    afterSave = handlers.afterSave,
    migrate = handlers.migrateObject,
    _Promise = this._parse.Promise,
    maybeTouch = function(request) {
      var obj = request.object;
      if (obj.existed() || _.isUndefined(migrate)) {
        return _Promise.as();
      }
      obj.set(consts.MIGRATION_KEY, consts.NEEDS_SECOND_PASS);
      return obj.save();
    }

  if (_.isUndefined(afterSave)) {
    return maybeTouch;
  }

  return function(request) {
    // We don't have long and there is no failure mode. Let's do this in parallel:
    return _Promise.all([afterSave(request), maybeTouch(request)]);
  }
};

Migrator.prototype.getBeforeDelete = function(klass) {
  var handlers = this.handlers(klass),
    beforeDelete = handlers.beforeDelete,
    migrateDelete = handlers.migrateDelete,
    _Promise = this._parse.Promise;

  return function(request, response) {
    return _Promise.as().then(function() {
      return beforeDelete && beforeDelete(request, ThisIsNotAResponseObject);
    }).then(function() {
      return migrateDelete && migrateDelete(request.object);
    }).then(function() {
      return response.success();
    }, function(err) {
      return response.error(err);
    });
  };
};

Migrator.prototype.getAfterDelete = function(klass) {
  var afterDelete = this.handlers(klass).afterDelete,
    _Promise = this._parse.Promise;
  return function(request) {
    return _Promise.as().then(afterDelete);
  }
};

// Get bulk import returns a function that runs either the user's explicit
// importer or the migration function. Any changes made by the import function
// plus a change to the object's migration state are applied to the objects,
// which are saved back in bulk.
// Returns the number of objects imported.
Migrator.prototype.getBulkImport = function(klass) {
  var migrate = this.handlers(klass).migrateObject,
    bulkImport = this.handlers(klass).bulkImport,
      _Promise = this._parse.Promise;
      _Parse = this._parse;

  if (_.isUndefined(migrate) && _.isUndefined(bulkImport)) {
    return undefined;
  }

  return function(objects) {
    var migrations;
    if (_.isUndefined(bulkImport)) {
      // If the user has not defined a bulkImport method, we first let them run their
      // migration methods in parallel. After they all complete, we batch the saves
      // in a Parse.Object.saveAll request. We sequence these methods because saveAll
      // counts in Parse as N requests and a parallel save is likely to make customers
      // hit their throughput limit.
      migrations = _.map(objects, function(object) {
        return _Promise.as().then(function() {
          return migrate(object);
        }).then(function(maybeChanged) {
          var ret = maybeChanged instanceof _Parse.Object ? maybeChanged : object;
          ret.set(consts.MIGRATION_KEY, consts.JUST_IMPORTED);
          return ret;
        });
      });
    } else {
      migrations = bulkImport(objects).then(function(changed) {
        return _.map(changed, function(object) {
          object.set(consts.MIGRATION_KEY, consts.JUST_IMPORTED);
        });
      });
    }

    return _Promise.when(migrations).then(function(objects) {
      var saveBack = _Promise.as();
      for (var start = 0; start < objects.length; start += consts.SAVE_BATCH_SIZE) {
        var slice = objects.slice(start, start + consts.SAVE_BATCH_SIZE);
        saveBack = saveBack.then(function() {
          var p = new _Promise();
          _Parse.Object.saveAll(slice, {
            success: function() { p.resolve() },
            error: function(err) { p.reject(err) }
          });
          return p;
        });
      }
      return saveBack.then(function() {
        return objects.length;
      });
    });
  }
};


Migrator.prototype.getImportJob = function() {
  var self = this,
    _Promise = this._parse.Promise;
  return function(request, status) {
    var deadline = new Date() + MAXIMUM_DURATION;

    var lastMigration = _Promise.as(0);
    console.log("Starting import pass");
    var totalMigrated = 0;
    _.each(self._triggers, function(handlers, klass) {
      var importer = self.getBulkImport(klass);
      if (_.isUndefined(importer)) {
        console.log(klass + " has no migration or bulkImport function; nothing to import");
        return;
      } else {
        console.log("Will import class " +  klass);
      }

      lastMigration = lastMigration.then(function(migrated) {
        totalMigrated += migrated;
        console.log("Starting import of class " + klass);
        return self._migrateClass(klass, importer);
      });
    });
    return lastMigration.then(function(migrated) {
      totalMigrated += migrated;
    }).then(function() {
      var message = "Done with an import pass";
      if (totalMigrated === 0) {
        message = "Completed initial import!";
      }
      console.log(message);
      status.success(message);
      return totalMigrated;
    }, function(error) {
      return status.error(error)
    });
  }
};

Migrator.prototype._migrateClass = function(klass, bulkImport, deadline) {
  var self = this,
    _Promise = this._parse.Promise;
  if (Date.now() > deadline) {
    console.log("Shutting down to avoid unclean exit from Parse Cloud Jobs");
    return _Promise.as(0);
  }

  // if we use any kind of sort (even objectId) then notEqualTo will eventually
  // be inefficient and we can time out without even migrating a single object.
  // We could alternatively keep a separate migration table and track of the most
  // recent timestamp migrated (using ObjectIDs to break ties). This could work
  // but tends to make cases like new object migrations much harder. It also
  // violates the assumption that your hybrid clients can opt out of migrations
  // by setting "migrationStatus" to 1 on the client.
  var query = new self._parse.Query(klass)
    .notContainedIn(
      consts.MIGRATION_KEY,
      [
        consts.IS_MIGRATED,
        consts.NEEDS_SECOND_PASS,
        consts.FINISHED_SECOND_PASS,
        consts.JUST_IMPORTED
      ]
    ).limit(consts.BATCH_SIZE);

  // For each batch, map that batch to a migration of a single record and
  // then setting that record's migration status to done. Then wait for
  // that batch to complete before resolving the outer promise that lets
  // us fetch a new batch.
  return query.find().then(bulkImport).then(function(migrated) {
    // We know we've migrated everything when the last batch didn't hit our limit.
    // Otherwise, recursion is the for loop of async.
    if (migrated === consts.BATCH_SIZE) {
      return self._migrateClass(klass, migration, deadline).then(function(accum) {
        return accum + migrated;
      });
    }
    console.log("Done migrating " + klass + " class");
    return migrated;
  });
};

module.exports = function(parse) { return new Migrator(parse); };
