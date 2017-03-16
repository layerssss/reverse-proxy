var Https = require('https');
var Http = require('http');
var LeSni = require('le-sni-auto');
var Le = require('greenlock');
var Website = require('pathifier').Website;
var Fs = require('fs');

class Server {
    constructor(configFilePath, email) {
        this.email = email;
        this.hosts = {};
        this.configWatcher = Fs.watch(configFilePath, {
            persistent: false
        }, () => {
            this.initConfig(configFilePath).catch(error => console.error(error.message)); // eslint-disable-line no-console
        });
        this.initConfig(configFilePath).catch(error => console.error(error.message)); // eslint-disable-line no-console
    }

    initConfig(path) {
        return new Promise(
                (resolve, reject) => {
                    Fs.readFile(path, 'utf8', (error, data) => {
                        if (error) return reject(error);
                        resolve(data);
                    });
                }
            ).then(JSON.parse)
            .then(config => {
                var hosts = {};
                if (!config.websites) throw new Error('websites must be configured.');
                if (config.websites.constructor !== Array) throw new Error('websites must be an array.');
                for (var websiteConfig of config.websites) {
                    try {
                        hosts[websiteConfig.hostname] = hosts[websiteConfig.hostname.toLowerCase()] || [];
                        hosts[websiteConfig.hostname].push(new Website({
                            upstreamOrigin: websiteConfig.upstreamOrigin,
                            path: websiteConfig.path || ''
                        }));
                    } catch (error) {
                        console.error('Website not loaded: ' + error.message); // eslint-disable-line no-console
                        console.error(websiteConfig); // eslint-disable-line no-console
                    }
                }
                this.hosts = hosts;

                var redirections = {};
                if (config.redirections) {
                    for (var redirection of config.redirections) {
                        if (config.redirections.constructor !== Array) throw new Error('redirections must be an array.');
                        try {
                            if (!redirection.targetLocation) throw new Error('redirection.targetLocation must be specified.');
                            if (redirection.hostname) {
                                redirections[redirection.hostname] = redirection.targetLocation;
                            }
                        } catch (error) {
                            console.error('Redirection not loaded: ' + error.message); // eslint-disable-line no-console
                            console.error(redirection); // eslint-disable-line no-console
                        }
                    }
                }
                this.redirections = redirections;
                console.log('Configuration reloaded.'); // eslint-disable-line no-console
            });
    }

    handleRequest(request, response, protocol) {
        var host;
        for (host in this.hosts) {
            if (!request.headers.host) continue;
            if (request.headers.host.toLowerCase() == host) {
                return response.writeHead('302', 'Temperarily Moved.', {
                    'Location': this.hosts[host]
                });
            }
        }

        for (host in this.hosts) {
            if (!request.headers.host && host) continue;
            if (request.headers.host && request.headers.host.toLowerCase() !== host) continue;
            var websites = this.hosts[host];
            var websitesReversed = [...websites];
            websitesReversed.reverse();
            for (var website of websitesReversed) {
                if (website.match(request.url)) {
                    return website.handleRequest(request, response, protocol);
                }
            }
        }

        response.writeHead('404', 'No website found.');
        response.end('No website found.');
    }

    listen(bind, httpPort, httpsPort) {
        var challengeValues = {};

        var httpServer = Http.createServer((request, response) => {
            var host = request.headers.host;
            var url = request.url;
            var challenge_path = '/.well-known/acme-challenge/';

            if (challengeValues[host] && url.startsWith(challenge_path)) {
                var value = challengeValues[host][url.substring(challenge_path.length)];

                if (value) {
                    return response.end(value);
                }
            }

            this.handleRequest(request, response, 'http');
        });

        var challenger = {
            set: (args, domain, key, value, cb) => {
                challengeValues[domain] = challengeValues[domain] || {};
                challengeValues[domain][key] = value;
                cb();
            },
            get: (args, domain, key, cb) => {
                challengeValues[domain] = challengeValues[domain] || {};
                cb(null, challengeValues[domain][key]);
            },
            remove: (args, domain, key, cb) => {
                challengeValues[domain] = challengeValues[domain] || {};
                delete challengeValues[domain][key];
                cb(null);
            },
            getOptions: () => {
                return {};
            }
        };

        challenger.loopback = challenger.get;
        challenger.test = challenger.set;

        var le = Le.create({
            server: Le.productionServerUrl,
            challenges: {
                'http-01': challenger
            }
        });

        var httpsServer = Https.createServer({
            SNICallback: LeSni.create({
                renewWithin: 10 * 24 * 60 * 60 * 1000, // 10 days
                renewBy: 5 * 24 * 60 * 60 * 1000, // 5 days
                tlsOptions: {
                    rejectUnauthorized: true,
                    requestCert: false,
                    ca: null,
                    crl: null
                },
                getCertificatesAsync: (domain) => {
                    return le.register({
                        domains: [domain],
                        email: this.email,
                        agreeTos: true
                    });
                }
            }).sniCallback
        }, (request, response) => {
            this.handleRequest(request, response, 'https');
        });

        return Promise.all([
            new Promise((resolve, reject) => {
                httpServer.on('error', reject);
                httpServer.on('listening', () => resolve(httpServer));
                httpServer.listen(httpPort, bind);
            }),
            new Promise((resolve, reject) => {
                httpsServer.on('error', reject);
                httpsServer.on('listening', () => resolve(httpsServer));
                httpsServer.listen(httpsPort, bind);
            })
        ]);
    }
}

module.exports = Server;
