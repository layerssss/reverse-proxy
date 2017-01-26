#!/usr/bin/env node


var Cli = require('../lib/cli.js');
var commander = require('commander');

Promise.resolve()
    .then(() => {
        commander.version(require('../package.json').version)
            .option('-p --http-port [integer]', 'HTTP port')
            .option('-s --https-port [integer]', 'HTTPS PORT')
            .option('-b --bind [string]', 'HTTP bind')
            .option('-c --config [path]', 'Config file')
            .option('-e --email [email]', 'Email')
            .option('-d --debug', 'Enable debug')
            .parse(process.argv);
    })
    .then(() => commander.args.length && Promise.reject(new Error('Please use pathifier --help to see the usage.'))) // eslint-disable-line no-console
    .then(() => Cli.execute({
        httpPort: commander.httpPort,
        httpsPort: commander.httpsPort,
        bind: commander.bind,
        configFile: commander.config,
        email: commander.email

    }))
    .catch((error) => {
        if (commander.debug) {
            if (error.stack) {
                for (var line of error.stack.split('\n')) {
                    console.error(line); // eslint-disable-line no-console
                }
            }
        } else {
            console.error(error.message); // eslint-disable-line no-console
        }

        process.exit(1);
    });
