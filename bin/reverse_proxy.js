#!/usr/bin/env node


var Cli = require('../lib/cli.js');
var commander = require('commander');

Promise.resolve()
    .then(() => {
        commander.version(require('../package.json').version)
            .option('-p --http-port [integer]', 'HTTP port', ((i, d) => parseInt(i || d)), 80)
            .option('-s --https-port [integer]', 'HTTPS PORT', ((i, d) => parseInt(i || d)), 443)
            .option('-b --bind [string]', 'HTTP bind', '0.0.0.0')
            .option('-e --email [string]', 'email', process.env['EMAIL'])
            .option('-c --config-file-path [path]', 'Config file path')
            .option('-d --debug', 'Enable debug')
            .parse(process.argv);
    })
    .then(() => commander.args.length && Promise.reject(new Error('Please use pathifier --help to see the usage.'))) // eslint-disable-line no-console
    .then(() => Cli.execute(commander))
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
