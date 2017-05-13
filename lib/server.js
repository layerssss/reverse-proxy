var Http = require('http');
var Https = require('https');
var LeSni = require('le-sni-auto');
var Le = require('greenlock');
var Cookie = require('cookie');
var Uuid = require('uuid');
var Url = require('url');
var Moment = require('moment');
var Qs = require('qs');
var Fs = require('fs');
var Assert = require('assert');
var Utility = require('./utility.js');

class Server {
    constructor(options) {
        this._options = options;
        this.hosts = [];

        this._challengeValues = {};
        this._sessions = {};

        this.configWatcher = Fs.watch(this._options.configFilePath, {
            persistent: false
        }, () => {
            this.initConfig(this._options.configFilePath).catch(error => console.error(error.message)); // eslint-disable-line no-console
        });

        this.initConfig(this._options.configFilePath).catch(error => console.error(error.message)); // eslint-disable-line no-console
    }

    initConfig(path) {
        return Utility.readFile(path, 'utf8')
            .then(JSON.parse)
            .then(config => {
                var hosts = [];

                Assert(config.hosts);
                Assert.equal(config.hosts.constructor, Array);

                for (var host of config.hosts) {
                    Assert(host.hostname);
                    Assert(host.upstream);

                    if (host.securedByGithub) {
                        Assert(host.securedByGithub.clientId);
                        Assert(host.securedByGithub.clientSecret);
                        Assert(host.securedByGithub.org);
                    }

                    hosts.push(host);
                    console.log('Configuration loaded for ' + host.hostname); // eslint-disable-line no-console
                }

                this.hosts = hosts;
                console.log('Configuration reloaded.'); // eslint-disable-line no-console
            });
    }
    _challengeValuesFor(domain) {
        if (!this.hosts.filter(branch => branch.hostname == domain).length) return {};

        if (!this._challengeValues[domain]) this._challengeValues[domain] = {};

        return this._challengeValues[domain];
    }

    _getSession(request, response) {
        var cookies = Cookie.parse(request.headers.cookie || '');
        var session = this._sessions[cookies.acceptit_session_id];
        if (!session) {
            if (!response) return null;
            var session_id = Uuid.v4();
            session = this._sessions[session_id] = {
                id: session_id
            };
            setTimeout(() => {
                delete this._sessions[session_id];
            }, Moment.duration(7, 'days').asMilliseconds());

            response.setHeader('Set-Cookie', [
                Cookie.serialize('acceptit_session_id', session_id, {
                    expires: Moment().add(7, 'days').toDate(),
                    maxAge: Moment.duration(7, 'days').asSeconds()
                })
            ]);
        }
        return session;
    }

    _updateRequestHeaders(request, ssl) {
        request.headers['x-forwarded-host'] = request.headers['x-forwarded-host'] || request.headers['host'];

        var realIp = null;
        realIp = request.headers['X-Real-Ip'] || request.headers['X-Client-Ip'];
        realIp = realIp || request.socket.remoteAddress;

        var protocol = ssl ? 'https' : 'http';

        request.headers['X-Real-Ip'] = realIp;
        request.headers['X-Client-Ip'] = realIp;
        request.headers['X-Forwarded-For'] = request.headers['X-Forwarded-For'] || realIp;
        request.headers['X-Forwarded-Proto'] = protocol;
        request.headers['X-Forwarded-Scheme'] = protocol;
        request.headers['X-Forwarded-Port'] = request.headers['X-Forwarded-Port'] || request.socket.localPort;

        delete request.headers['host'];
    }

    _proxyRequest(host, request, response, ssl) {
        if (host.redirect) {
            response.writeHead(302, {
                'Location': host.upstream
            });
            response.end('Page temporarily moved to: ' + host.upstream + request.url);
            return Promise.resolve();
        }

        var proxyRequest;
        var proxyResponse;
        var upstreamUrl = Url.parse(host.upstream);

        console.log(request.method + ' ' + request.url); // eslint-disable-line no-console

        this._updateRequestHeaders(request, ssl);

        return Promise.resolve()
            .then(() => new Promise((resolve, reject) => {
                if (upstreamUrl.protocol == 'http:') {
                    proxyRequest = Http.request({
                        method: request.method,
                        path: request.url,
                        hostname: upstreamUrl.hostname,
                        port: upstreamUrl.port,
                        auth: upstreamUrl.auth,
                        headers: request.headers
                    });
                } else if (upstreamUrl.protocol == 'https:') {
                    proxyRequest = Https.request({
                        method: request.method,
                        path: request.url,
                        hostname: upstreamUrl.hostname,
                        port: upstreamUrl.port,
                        auth: upstreamUrl.auth,
                        headers: request.headers
                    });
                } else return reject(new Error('Unknown unstream protocol: ' + upstreamUrl.protocol));

                proxyRequest.on('response', (r) => {
                    proxyResponse = r;
                    resolve();
                });

                proxyRequest.on('clientError', reject);
                proxyRequest.on('error', reject);
                
                request.on('aborted', () => reject(new Error('Request aborted.')));

                request.pipe(proxyRequest);
            }))
            .then(() => new Promise((resolve, reject) => {
                response.writeHead(
                    proxyResponse.statusCode,
                    proxyResponse.statusMessage,
                    proxyResponse.headers
                );

                proxyResponse.pipe(response);
                proxyResponse.on('end', resolve);
                proxyResponse.on('aborted', () => reject(new Error('Response aborted.')));
            }));
    }

    _handleRequest(request, response, ssl) {
        return Promise.resolve()
            .then(() => {
                var requestHost = String(request.headers.host).toLowerCase();
                var challengePath = '/.well-known/acme-challenge/';

                if (request.url.startsWith(challengePath)) {
                    var key = request.url.substring(challengePath.length);
                    var value = this._challengeValuesFor(requestHost)[key];

                    if (value) return value;
                }


                for (var host of this.hosts) {
                    if (requestHost != host.hostname) continue;

                    if (!ssl) {
                        if (host.allowInsecure && !host.securedByGithub) return this._proxyRequest(host, request, response, ssl);

                        // Redirect to secure URL
                        response.writeHead(302, {
                            'Location': 'https://' + requestHost + request.url
                        });
                        return;
                    }

                    if (host.noSecure) {
                        // Redirect to insecure URL
                        response.writeHead(302, {
                            'Location': 'http://' + requestHost + request.url
                        });
                        return;
                    }

                    if (!host.securedByGithub) return this._proxyRequest(host, request, response, ssl);

                    var session = this._getSession(request, response);
                    var [requestPath, requestQueryString] = request.url.split('?');
                    var requestQuery = Qs.parse(requestQueryString || '');

                    if (requestPath == '/' && requestQuery['code']) {
                        return Utility.requestHttpsJSON(
                                'POST',
                                'github.com',
                                '/login/oauth/access_token', {
                                    client_id: host.securedByGithub.clientId,
                                    client_secret: host.securedByGithub.clientSecret,
                                    code: requestQuery['code'],
                                    redirect_uri: 'https://' + requestHost + '/',
                                    state: session.id
                                }
                            )
                            .then(data => {
                                session.accessToken = data['access_token'];
                                return Promise
                                    .all([
                                        Utility.requestHttpsJSON('GET', 'api.github.com', '/user', {
                                            access_token: session.accessToken
                                        }),
                                        Utility.requestHttpsJSON('GET', 'api.github.com', '/user/orgs', {
                                            access_token: session.accessToken
                                        })
                                    ])
                                    .then(([user, orgs]) => {
                                        session.user = user;
                                        session.org = orgs.filter(o => o.login == host.securedByGithub.org)[0];

                                        response.writeHead(302, {
                                            'Location': 'https://' + requestHost + (session.redirectUrl || '/')
                                        });
                                        return;
                                    });
                            });
                    }

                    if (!session.user) {

                        if (String(request.headers['accept']).match(/text\/html/)) {
                            session.redirectUrl = request.url;
                        }

                        response.writeHead(302, {
                            'Location': 'https://github.com/login/oauth/authorize?' + Qs.stringify({
                                client_id: host.securedByGithub.clientId,
                                redirect_uri: 'https://' + requestHost + '/',
                                scope: 'user read:org repo',
                                state: session.id
                            })
                        });
                        return;
                    }

                    if (!session.org) {
                        return Promise.reject(new Error('Access Denied.'));
                    }

                    return this._proxyRequest(host, request, response, ssl);
                }

                return Promise.reject(new Error('Website not found.'));
            });
    }

    _handleUpgrade(request, socket, head, ssl) {
        var requestHost = String(request.headers.host).toLowerCase();

        for (var host of this.hosts) {
            if (requestHost != host.hostname) continue;

            if (!ssl) {
                if (!host.allowInsecure) return socket.end();
                if (host.securedByGithub) return socket.end();
            }

            if (ssl && host.noSecure) return socket.end();

            if (host.securedByGithub) {
                var session = this._getSession(request);
                if (!session || !session.user || !session.org) return socket.end(); // stop visitor without event session
            }

            if (host.redirect) {
                return socket.end();
            }

            var proxyRequest;
            this._updateRequestHeaders(request, ssl);
            var upstreamUrl = Url.parse(host.upstream);
            if (upstreamUrl.protocol == 'http:') {
                proxyRequest = Http.request({
                    method: request.method,
                    path: request.url,
                    hostname: upstreamUrl.hostname,
                    port: upstreamUrl.port,
                    auth: upstreamUrl.auth,
                    headers: request.headers
                });
            } else if (upstreamUrl.protocol == 'https:') {
                proxyRequest = Https.request({
                    method: request.method,
                    path: request.url,
                    hostname: upstreamUrl.hostname,
                    port: upstreamUrl.port,
                    auth: upstreamUrl.auth,
                    headers: request.headers
                });
            } else return socket.end();
            proxyRequest.flushHeaders();

            proxyRequest.on('error', error => {
                console.error(error.message);
                socket.end();
            });

            proxyRequest.on('upgrade', (proxyResponse, proxySocket) => {
                socket.write('HTTP/1.1 ' + proxyResponse.statusCode + ' ' + proxyResponse.statusMessage + '\r\n');

                Object.keys(proxyResponse.headers).forEach((key) => {
                    socket.write(key + ': ' + proxyResponse.headers[key] + '\r\n');
                });
                socket.write('\r\n');

                proxySocket.pipe(socket);
                socket.pipe(proxySocket);
            });

            return;
        }

        socket.end();
    }

    start() {
        var nodeHttpServer;
        var nodeHttpsServer;

        return Promise.resolve()
            .then(() => {
                var le_challenger = {
                    set: (args, domain, key, value, cb) => {
                        this._challengeValuesFor(domain)[key] = value;
                        cb();
                    },
                    get: (args, domain, key, cb) => {
                        cb(null, this._challengeValuesFor(domain)[key]);
                    },
                    remove: (args, domain, key, cb) => {
                        delete this._challengeValuesFor(domain)[key];
                        cb(null);
                    },
                    getOptions: () => {
                        return {};
                    }
                };

                var le = Le.create({
                    server: Le.productionServerUrl,
                    challenges: {
                        'http-01': le_challenger
                    }
                });

                var leSniCallback = LeSni.create({
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
                            email: this._options.email,
                            agreeTos: true
                        });
                    }
                }).sniCallback;


                nodeHttpServer = Http.createServer();
                nodeHttpsServer = Https.createServer({
                    SNICallback: (domain, cb) => {
                        for (var host of this.hosts) {
                            if (host.hostname != domain) continue;

                            return leSniCallback(domain, cb);
                        }

                        cb(new Error('Hostname not found.'));
                    }
                });


                nodeHttpServer.on('request', (request, response) => {
                    this._handleRequest(request, response, false)
                        .then(result => {
                            response.end(result);
                        })
                        .catch(error => {
                            if (!response.headerSent) response.writeHead(500, {
                                'Content-Type': 'text/plain'
                            });
                            response.end(error.stack);
                        });
                });

                nodeHttpsServer.on('request', (request, response) => {
                    this._handleRequest(request, response, true)
                        .then(result => {
                            response.end(result);
                        })
                        .catch(error => {
                            if (!response.headerSent) response.writeHead(500, {
                                'Content-Type': 'text/plain'
                            });
                            response.end(error.stack);
                        });
                });

                nodeHttpServer.on('upgrade', (request, socket, head) => {
                    this._handleUpgrade(request, socket, head, false);
                });
                nodeHttpsServer.on('upgrade', (request, socket, head) => {
                    this._handleUpgrade(request, socket, head, true);
                });
            })
            .then(() => new Promise((resolve, reject) => {
                nodeHttpServer.on('error', (error) => reject(error));

                nodeHttpServer.listen(
                    this._options.httpPort,
                    this._options.bind,
                    () => resolve()
                );
            }))
            .then(() => new Promise((resolve, reject) => {
                nodeHttpsServer.on('error', (error) => reject(error));

                nodeHttpsServer.listen(
                    this._options.httpsPort,
                    this._options.bind,
                    () => resolve()
                );
            }));
    }
}

module.exports = Server;
