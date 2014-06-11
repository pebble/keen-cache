var express = require('express');

var FakeKeen = (function () {

  var app = null;
  var requests = [];
  var nextResponse = null;

  return {
    start: start,
    getLastRequest: getLastRequest,
    setNextResponse: setNextResponse,
    clear: clear
  };

  function start(port) {
    app = express();
    app.configure(function () {
      app.use(handleRequest);
    });
    app.listen(port);
  }

  function getLastRequest() {
    return requests.pop();
  }

  function handleRequest(req, res) {
    requests.push(req);
    res.json(200, nextResponse);
    nextResponse = null;
  }

  function setNextResponse(response) {
    nextResponse = response;
  }

  function clear() {
    nextResponse = null;
    requests = [];
  }

}());

module.exports = FakeKeen;