var express = require('express');
var logfmt = require('logfmt');
var http = require('http');
var MongoClient = require('mongodb').MongoClient;
var _ = require('underscore');
var config = require('./config');

var KEEN_SERVER = "http://api.keen.io";
var mongoUri = process.env.MONGOLAB_URI || process.env.MONGOHQ_URL || 'mongodb://localhost/keen-cache';


var mongoDb;

  // db.collection('mydocs', function(er, collection) {
  //   collection.insert({'mykey': 'myvalue'}, {safe: true}, function(er,rs) {
  //   });
  // });

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
  }
  else {
    // Only allow cross-domain request. Requests that are coming from a non-authorized
    // domain or do not respect CORS are rejected.
    console.warn("Origin server not authorized: ", req.headers.origin);
    res.send(403);
  }

  if (req.method == 'OPTIONS') {
    res.send(200);
  }
  else {
    next();
  }
}

var cacheLookup = function(req, res, next) {
  mongoDb.collection('cache', function(er, collection) {
    // Get the most recent object from cache and serve it.
    collection.findOne({ 'request': req.url }, { 'sort': {'cachedAt': -1} }, function(err, item) {
      if (item) {
        res.statusCode = 200;
        res.send(item.response);
      }
      else {
        next();
      }
    });
  });
}

var proxyRequest = function(req, res, next) {
  var proxyRequest = http.get(KEEN_SERVER + req.url, function(proxyResponse) {
    res.statusCode = proxyResponse.statusCode;

    var response = "";
    proxyResponse.on('data', function(chunk) {
      // This is not awesome because we keep the potentially large response
      // in memory.
      // Writing in chunks in mongodb would be hard though.
      response += chunk;
    });
    proxyResponse.on('end', function() {
      mongoDb.collection('cache', function(er, collection) {
        collection.insert({ 'request': req.url, 'response': response, 'cachedAt': new Date() }, {}, function (er, rs) {
          if (er) {
            console.error("Error inserting data in cache - er=", er, " rs=", rs);
          }
        });
      });
      res.send(response);
    });
  }).on('error', function(error) {
    res.send(JSON.encode({ 'error': error }));
  });
}

app.configure(function() {
  app.use(logfmt.requestLogger());
  app.use(allowCrossDomain);
  app.use(cacheLookup);
  app.use(proxyRequest);
});

var port = Number(process.env.PORT || 5000);

MongoClient.connect(mongoUri, function(err, db) {
  mongoDb = db;

  mongoDb.collection('cache', function(er, collection) {
    // You need to drop the index if you want to change the expiry settings
    // db.cache.dropIndexes() in the mongo console.
    collection.ensureIndex( { "cachedAt": 1 }, { expireAfterSeconds: 600 }, function(er, indexName) {
      if (er) {
        console.error("Error creating index: ", er);
      }
    });
  });
  app.listen(port, function() {
    console.log("Listening on port " + port);
  });
  // db.log.events.ensureIndex( { "createdAt": 1 }, { expireAfterSeconds: 3600 } )

});
