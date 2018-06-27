var fs = require("fs");
var Qs = require("qs");
var Https = require("https");

module.exports = class Utility {
  static requestHttpsJSON(method, hostname, path, data) {
    return new Promise((resolve, reject) => {
      if (!method.match(/post|put|patch|delete/i)) {
        path += "?" + Qs.stringify(data);
      }

      var requestOptions = {
        method: method,
        hostname: hostname,
        port: 443,
        path: path,
        headers: {
          "User-Agent": "Acceptit",
          Accept: "application/json"
        }
      };

      if (method.match(/post|put|patch|delete/i)) {
        requestOptions.headers["Content-Type"] = "application/json";
      }

      var request = Https.request(requestOptions);
      request.on("error", reject);

      if (method.match(/post|put|patch|delete/i)) {
        request.end(JSON.stringify(data));
      } else {
        request.end();
      }

      request.on("response", response => {
        if (
          !response.headers["content-type"].match(/^(text|application)\/json/)
        )
          return reject(
            new Error(
              "Not able to handle type: " + response.headers["content-type"]
            )
          );
        var buffers = [];
        response.on("data", data => {
          buffers.push(data);
        });

        response.on("error", error => {
          reject(error);
        });

        response.on("end", () => {
          var data = Buffer.concat(buffers).toString("utf8");

          try {
            data = JSON.parse(data);
          } catch (error) {
            return reject(error);
          }

          if (response.statusCode != 200) {
            return reject(
              new Error(
                [
                  "Error ",
                  response.statusCode,
                  ": ",
                  data.message || response.statusMessage,
                  " (" + path + ")"
                ].join("")
              )
            );
          }

          var error_message = data.error_description || data.error;
          if (error_message) return reject(new Error(error_message));

          resolve(data);
        });
      });
    });
  }

  static readFile(path, encode) {
    return new Promise((resolve, reject) => {
      fs.readFile(path, encode, (error, data) => {
        if (error) return reject(error);
        resolve(data);
      });
    });
  }
};
