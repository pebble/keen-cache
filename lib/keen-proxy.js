var _ = require('underscore');
var express = require('express');
var logfmt = require('logfmt');
var http = require('http');
var querystring = require('querystring');
var Keen = require('keen.io');
var winston = require('winston');
var MongoClient = require('mongodb').MongoClient;

var KeenProxy = function(config) {
  var self = this;

  // Initialize our logger
  self.logger = new (winston.Logger)({
    transports: [
      new (winston.transports.Console)({ level: config.logLevel })
    ]
  });


  /* *** Private functions *** */

  // Decide whether this request should be authorized or not, based on the CORS headers
  var allowCrossDomain = function(req, res, next) {
    if (req.headers.origin && _.contains(config.allowedDomains, req.headers.origin)) {
      res.header('Access-Control-Allow-Origin', req.headers.origin);
      if(req.headers['access-control-request-method']) {
          res.header('Access-Control-Allow-Methods', req.headers['access-control-request-method']);
      }
      if(req.headers['access-control-request-headers']) {
        res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
      }
      res.header('Access-Control-Max-Age', 60 * 60 /* * 24 * 365 */);

      if (req.method == 'OPTIONS') {
        res.send(200);
      }
      else {
        next();
      }
    }
    else {
      // Only allow cross-domain request. Requests that are coming from a non-authorized
      // domain or do not respect CORS are rejected.
      self.logger.warn("Origin server not authorized: ", req.headers.origin);
      res.send(403);
    }
  }

  // This middleware takes an incoming request, decrypt the scoped key and uses the encrypted
  // information to overwrite information contained in the original request and then prepare
  // a new one for keen.io servers.
  // This way a "smart" user can not change the values that are defined in the scoped key.
  var enforceScopedKey = function(req, res, next) {
    var publicScopedKey = req.query.api_key;

    try {
      var scopedParams = Keen.decryptScopedKey(config.publicKey, publicScopedKey);

      self.logger.verbose("Successfully decrypted scopedParams: %s for request: %s", JSON.stringify(scopedParams), req.url);

      // If we succesfully recognized the scope key, let's do some checks and then
      // pass this on to Keen.io

      // Prepare a new scoped key for Keen.io - We keep all the params in there, maybe
      // some day soon Keen.io will support filtering on them too.
      var privateScopedKey = Keen.encryptScopedKey(config.masterKey, scopedParams);
      req.query.api_key = privateScopedKey;

      // Overwrite the query parameters with the one set in the scopedKey
      _.extend(req.query, scopedParams);

      // If overwriting filters, rewrite them a-la-mode Keen.io
      if (_.has(scopedParams, 'filters')) {
        req.query.filters = JSON.stringify(req.query.filters);
      }

      // Rewrite the URL with the new query parameters
      req.url = req.path + '?' + querystring.stringify(req.query);

      next();
    }
    catch (e) {
      self.logger.warn("Unable to decrypt scoped key. Rejecting request.");
      res.send(403);
    }
  }

  // Search for a request in our cache - Do not use the scoped key to do that search
  // (otherwise we would never get a hit because the scoped key incudes a random iv)
  var cacheLookup = function(req, res, next) {
    self.mongoDb.collection('cache', function(er, collection) {
      // Get the most recent object from cache and serve it.

      // Remove the api_key from the url we save in cache because it changes for every request.
      var uniqueUrl = req.url.replace(/api_key=.*?&/, '');

      collection.findOne({ 'request': uniqueUrl }, {}, { 'sort': { 'cachedAt': -1 }}, function(err, item) {
        if (!err) {
          if (item) {
            res.statusCode = 200;
            res.send(item.response);
          }
          else {
            next();
          }
        }
        else {
          self.logger.warn("Error looking up item in cache: ", err);
          next();
        }
      });
    });
  }

  // Make a request to keen server and cache the response if it's a 200
  var proxyRequest = function(req, res, next) {
    self.logger.verbose("Sending request: %s", config.keen_server + req.url);
    var proxyRequest = http.get(config.keen_server + req.url, function(proxyResponse) {
      res.statusCode = proxyResponse.statusCode;

      var response = "";
      proxyResponse.on('data', function(chunk) {
        // This is not awesome because we keep the potentially large response
        // in memory.
        // Writing in chunks in mongodb would be hard though.
        response += chunk;
      });
      proxyResponse.on('end', function() {
        // Only cache the response if the status is 200
        if (proxyResponse.statusCode == 200) {
          self.mongoDb.collection('cache', function(er, collection) {
            // Remove the api_key from the url we save in cache because it changes for every request.
            var uniqueUrl = req.url.replace(/api_key=.*?&/, '');
            collection.insert({ 'request': uniqueUrl, 'response': response, 'cachedAt': new Date() }, {}, function (er, rs) {
              if (er) {
                self.logger.warn("Error inserting data in cache - er=", er, " rs=", rs);
              }
            });
          });
        }
        res.send(response);
      });
    }).on('error', function(error) {
      res.statusCode = 500;
      res.send(JSON.encode({ 'error': error }));
    });
  }

  // Initialize and run the actual proxy server
  var runProxy = function(port) {
    var app = express();

    app.configure(function() {
      app.use(logfmt.requestLogger());
      app.use(allowCrossDomain);
      app.use(enforceScopedKey);
      app.use(cacheLookup);
      app.use(proxyRequest);
    });

    app.listen(port, function() {
      self.logger.info("Listening on port " + port);
    });
  };


  /* *** Public function *** */

  this.run = function(port) {
    MongoClient.connect(config.mongoUri, function(err, db) {
      self.mongoDb = db;

      if (err) {
        self.logger.error("Unable to connect to MongoDB (%s): %j", config.mongoUri, err);
      }
      else {
        self.mongoDb.collection('cache', function(er, collection) {
          // You need to drop the index if you want to change the expiry settings
          // db.cache.dropIndexes() in the mongo console.
          collection.ensureIndex( { "cachedAt": 1 }, { expireAfterSeconds: 600 }, function(er, indexName) {
            if (er) {
              self.logger.error("Error creating index: ", er);
            }
            else {
              runProxy(port);
            }
          });
        });
      }
    });
  };
  return this;
};

module.exports = KeenProxy;
