var Server = require('./server.js');

class Cli {
    static execute(options) {
        if (!options.configFile) return Promise.reject(new Error('Must specify a config file.'));
        if (!options.email) return Promise.reject(new Error('Must provide an email.'));

        var server = new Server(options.configFile, options.email);

        return server.listen(
            options.bind,
            options.httpPort || 80,
            options.httpsPort || 443
        );
    }
}

module.exports = Cli;
