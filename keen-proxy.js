var KeenProxy = require('./lib/keen-proxy.js');

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

var port = Number(process.env.PORT || 5000);

var keenProxy = new KeenProxy(config);
keenProxy.run(port);
