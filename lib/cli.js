var assert = require('assert');
var Server = require('./server.js');

class Cli {
    static execute(options) {
        assert(options.httpPort, 'httpPort is invalid.');
        assert(options.httpsPort, 'httpsPort is invalid.');
        assert(options.bind, 'bind is not specified.');
        assert(options.email, 'email is not specified.');
        assert(options.configFilePath, 'configFilePath is not specified.');

        var server = new Server(options);

        return server.start();
    }
}

module.exports = Cli;
