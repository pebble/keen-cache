var _ = require('underscore');
var express = require('express');
var logfmt = require('logfmt');
var http = require('http');
var querystring = require('querystring');
var MongoClient = require('mongodb').MongoClient;
var Keen = require('keen.io');
var winston = require('winston');

var config = {
  // URL of your MongoDB database
  mongoUri: process.env.MONGOLAB_URI || process.env.MONGOHQ_URL || 'mongodb://localhost/keen-cache',

  // Keen Server you want to use (in-case you want to use chain proxies ;)
  keen_server: process.env.KEEN_SERVER || "http://api.keen.io",

  // List of domains that will be "allowed" (if the browser respect CORS) to query this proxy
  allowedDomains: JSON.parse(process.env.ALLOWED_DOMAINS),

  // Your Keen.io master key
  masterKey: process.env.KEEN_MASTER_KEY,

  // A new "master key" that you generate for your proxy
  // > require('crypto').randomBytes(16).toString('hex');
  publicKey: process.env.KEEN_PROXY_MASTER_KEY,

  // Define the levels of log you want
  // silly, verbose, info, http, warn, error, silent
  logLevel: process.env.LOG_LEVEL || 'info'
};


var logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({ level: config.logLevel })
  ]
});

var mongoDb;

var app = express();

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
    logger.warn("Origin server not authorized: ", req.headers.origin);
    res.send(403);
  }
}

// This end point takes a public request and adds an authorization key
var enforceScopedKey = function(req, res, next) {
  var publicScopedKey = req.query.api_key;

  try {
    var scopedParams = Keen.decryptScopedKey(config.publicKey, publicScopedKey);

    logger.verbose("Successfully decrypted scopedParams: %s for request: %s", JSON.stringify(scopedParams), req.url);

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
    logger.warn("Unable to decrypt scoped key. Rejecting request.");
    res.send(403);
  }
}

var cacheLookup = function(req, res, next) {
  mongoDb.collection('cache', function(er, collection) {
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
        logger.warn("Error looking up item in cache: ", err);
        next();
      }
    });
  });
}

var proxyRequest = function(req, res, next) {
  logger.verbose("Sending request: %s", config.keen_server + req.url);
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
        mongoDb.collection('cache', function(er, collection) {
          // Remove the api_key from the url we save in cache because it changes for every request.
          var uniqueUrl = req.url.replace(/api_key=.*?&/, '');
          collection.insert({ 'request': uniqueUrl, 'response': response, 'cachedAt': new Date() }, {}, function (er, rs) {
            if (er) {
              logger.warn("Error inserting data in cache - er=", er, " rs=", rs);
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

app.configure(function() {
  app.use(logfmt.requestLogger());
  app.use(allowCrossDomain);
  app.use(enforceScopedKey);
  app.use(cacheLookup);
  app.use(proxyRequest);
});

var port = Number(process.env.PORT || 5000);

MongoClient.connect(config.mongoUri, function(err, db) {
  mongoDb = db;

  mongoDb.collection('cache', function(er, collection) {
    // You need to drop the index if you want to change the expiry settings
    // db.cache.dropIndexes() in the mongo console.
    collection.ensureIndex( { "cachedAt": 1 }, { expireAfterSeconds: 600 }, function(er, indexName) {
      if (er) {
        logger.error("Error creating index: ", er);
      }
    });
  });
  app.listen(port, function() {
    logger.info("Listening on port " + port);
  });
});
