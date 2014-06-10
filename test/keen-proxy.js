var should = require('should');
var Keen = require('keen.io');
var request = require('request');
var querystring = require('querystring');
var MongoClient = require('mongodb').MongoClient;

var KeenProxy = require('../lib/keen-proxy');
var FakeKeen = require('./fake-keen');

var PROXY_PORT = 5000;
var FAKE_PORT = 5001;

describe('KeenProxy', function () {

  var config = {
    mongoUri: 'mongodb://localhost/keen-cache-test',
    keen_server: 'http://localhost:' + FAKE_PORT,
    allowedDomains: [ 'http://localhost' ],
    masterKey: require('crypto').randomBytes(16).toString('hex'),
    publicKey: require('crypto').randomBytes(16).toString('hex'),
    logLevel: 'NONE',
    logRequests: false
  };

  var cacheBase = 'http://localhost:' + PROXY_PORT;

  var keenProxy = null;
  var keenServer = null;

  before(function (done) {
    keenProxy = new KeenProxy(config);
    keenProxy.run(PROXY_PORT);
    done();
  });

  before(function (done) {
    FakeKeen.start(FAKE_PORT);
    done();
  });

  beforeEach(function (done) {
    MongoClient.connect(config.mongoUri, function (err, db) {
      db.collection('cache', function (err, collection) {
        collection.drop(function(err, reply) {
          db.close();
          done();
        });
      });
    });
  });

  beforeEach(function (done) {
    done();
    FakeKeen.clear();
  });

  describe('Enforces cross domain requests', function (done) {

    it('should prevent requests from a non-supported domain', function (done) {

      var headers = { Origin: 'BAD DOMAIN' };

      request({ url: cacheBase, headers: headers }, function (err, res, body) {
        res.statusCode.should.equal(403);
        done();
      });

    });

    it('should prevent requests without an origin set', function (done) {

      request({ url: cacheBase }, function (err, res, body) {
        res.statusCode.should.equal(403);
        done();
      });

    });

    it('should send an success response on OPTIONS request with valid domain', function (done) {

      var headers = { Origin: config.allowedDomains[0] };

      request({ url: cacheBase, headers: headers, method: 'OPTIONS' }, function (err, res, body) {
        res.statusCode.should.equal(200);
        body.should.equal('OK');
        done();
      });

    });

    it('should allow requests coming from valid domain', function (done) {

      var headers = { Origin: config.allowedDomains[0] };
      var scopedKey = Keen.encryptScopedKey(config.publicKey, {
        allowed_operations: [ 'read' ]
      });
      var qs = querystring.stringify({ api_key: scopedKey });
      var url = cacheBase + '/3.0/projects/PROJECT_ID/?' + qs;

      request({ url: url, headers: headers }, function (err, res, body) {
        res.statusCode.should.equal(200);
        done();
      });

    });

  });


  describe('Validates incoming requests against scoped key', function (done) {

    it('should respond with an error with an invalid scoped key', function (done) {

      var headers = { Origin: config.allowedDomains[0] };
      var scopedKey = 'BUTTS';
      var qs = querystring.stringify({ api_key: scopedKey });
      var url = cacheBase + '/3.0/projects/PROJECT_ID/?' + qs;

      request({ url: url, headers: headers }, function (err, res, body) {
        res.statusCode.should.equal(403);
        done();
      });

    });

    it('should respond with an error if the keys don\'t match', function (done) {

      var headers = { Origin: config.allowedDomains[0] };
      var badKey = require('crypto').randomBytes(16).toString('hex');
      badKey.should.not.equal(config.publicKey);
      var scopedKey = Keen.encryptScopedKey(badKey, {
        allowed_operations: [ 'read' ]
      });
      var qs = querystring.stringify({ api_key: scopedKey });
      var url = cacheBase + '/3.0/projects/PROJECT_ID/?' + qs;

      request({ url: url, headers: headers }, function (err, res, body) {
        res.statusCode.should.equal(403);
        done();
      });

    });

    it('should overwrite the request filters with those in the key', function (done) {

      var headers = { Origin: config.allowedDomains[0] };
      var keyFilters = [{
        foo: 'bar'
      }];
      var requestFilters = [{
        bar: 'foo'
      }];
      var scopedKey = Keen.encryptScopedKey(config.publicKey, {
        allowed_operations: [ 'read' ],
        filters: keyFilters
      });
      var qs = querystring.stringify({ api_key: scopedKey, filters: requestFilters });
      var url = cacheBase + '/3.0/projects/PROJECT_ID/?' + qs;

      request({ url: url, headers: headers }, function (err, res, body) {
        res.statusCode.should.equal(200);
        var req = FakeKeen.getLastRequest();
        var filters = JSON.parse(req.query.filters);
        filters.should.eql(keyFilters);
        filters.should.not.eql(requestFilters);
        done();
      });

    });

    it('should prevent requests with an analysisType different to scoped key', function (done) {

      var headers = { Origin: config.allowedDomains[0] };
      var filters = [{
        foo: 'bar'
      }];
      var scopedKey = Keen.encryptScopedKey(config.publicKey, {
        allowed_operations: [ 'read' ],
        analysisType: 'SOMETHING',
        filters: filters
      });
      var qs = querystring.stringify({ api_key: scopedKey, filters: filters });
      var url = cacheBase + '/3.0/projects/PROJECT_ID/SOMETHING_ELSE?' + qs;

      request({ url: url, headers: headers }, function (err, res, body) {
        res.statusCode.should.equal(403);
        done();
      });

    });

    it('should allow requests with a matching analysisType', function (done) {

      var headers = { Origin: config.allowedDomains[0] };
      var filters = [{
        foo: 'bar'
      }];
      var scopedKey = Keen.encryptScopedKey(config.publicKey, {
        allowed_operations: [ 'read' ],
        analysisType: 'SOMETHING',
        filters: filters
      });
      var qs = querystring.stringify({ api_key: scopedKey, filters: filters });
      var url = cacheBase + '/3.0/projects/PROJECT_ID/SOMETHING?' + qs;

      request({ url: url, headers: headers }, function (err, res, body) {
        res.statusCode.should.equal(200);
        done();
      });

    });

    it('should allow requests without an analysisType', function (done) {

      var headers = { Origin: config.allowedDomains[0] };
      var filters = [{
        foo: 'bar'
      }];
      var scopedKey = Keen.encryptScopedKey(config.publicKey, {
        allowed_operations: [ 'read' ],
        filters: filters
      });
      var qs = querystring.stringify({ api_key: scopedKey, filters: filters });
      var url = cacheBase + '/3.0/projects/PROJECT_ID/SOMETHING?' + qs;

      request({ url: url, headers: headers }, function (err, res, body) {
        res.statusCode.should.equal(200);
        done();
      });

    });

  });


  describe('Caches requests', function (done) {

    it('uses cache for second identical request', function (done) {

      var headers = { Origin: config.allowedDomains[0] };
      var filters = [{
        foo: 'bar'
      }];
      var scopedKey = Keen.encryptScopedKey(config.publicKey, {
        allowed_operations: [ 'read' ],
        filters: filters
      });
      var qs = querystring.stringify({ api_key: scopedKey, filters: filters });
      var url = cacheBase + '/3.0/projects/PROJECT_ID/?' + qs;

      request({ url: url, headers: headers }, function (err, res, body) {
        res.statusCode.should.equal(200);
        var req1 = FakeKeen.getLastRequest();
        req1.should.not.equal(undefined);
        request({ url: url, headers: headers }, function (err, res, body) {
          var req2 = FakeKeen.getLastRequest();
          should(req2).equal(undefined);
          done();
        });

      });

    })

  });

});