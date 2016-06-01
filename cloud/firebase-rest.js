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

// The real Firebase SDK for JavaScript is a powerful Node.js library, but Cloud Code
// is not Node.js compatible. This simple wrapper allows you to make common requests
// to Firebase over the REST API.

// usage:
// var ref = require('firebase.js')({
//   url: "https://myfirebaseurl.firebaseio.com",
//   key: "optionalSecretKeyToBypassSecurityRules",
//   parse: Parse);
// to create a ref from config.json
// Access to the Parse object is necessary for networking support.
//
// A ref supports child(path), get(), put(value), post(value), delete(value)
// This class is very minimal and does not guarantee sanity checking will be
// done client-side. All network requests return Promises.

var Firebase = function(opts) {
  this._parse = opts.parse;
  this._url = opts.url;
  this._key = opts.key;
}

// child returns a reference to a path below this reference. child
// does not affect the current reference.
Firebase.prototype.child = function(path) {
  if (typeof path != "string" || path.length == 0) {
    throw "Firebase.child() expected a non-empty string";
  }

  if (this._url[this._url.length - 1] != '/' && path[0] != '/') {
    path = '/' + path;
  }
  return new Firebase({
    parse: this._parse,
    url: this._url + path,
    key: this._key
  });
}

// url returns the full URL referenced by this path, including a key if necessary.
Firebase.prototype.url = function() {
  if (this._key) {
    return this._url + ".json?auth=" + this._key;
  }
  return this._url + ".json";
}

Firebase.prototype._ajax = function(method, body) {
  var headers = {};
  if (body) {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  return this._parse.Cloud.httpRequest({
    method: method,
    url: this.url(),
    headers: headers,
    body: body
  }).then(function(response) {
    return response.data;
  });
}

Firebase.prototype.get = function() {
  return this._ajax("GET");
}

// put sets the entire contents pointed to by this reference
// to data.
Firebase.prototype.put = function(data) {
  return this._ajax("PUT", data);
}

// patch works like put but does not modify any keys that are
// not in data.
Firebase.prototype.patch = function(data) {
  return this._ajax("PATCH", data);
}

// post creates a new key at this reference with the value data.
Firebase.prototype.post = function(data) {
  return this._ajax("POST", data);
}

// delete deletes all data at this reference.
Firebase.prototype.delete = function() {
  return this._ajax("DELETE");
}

module.exports = function(opts) {
  return new Firebase(opts);
};
