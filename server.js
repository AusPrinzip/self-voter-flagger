'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');

var app = express();
app.set('port', process.env.PORT || 5000);
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json());

const MAX_BUFFER_SIZE = 1024 * 2000; // 2MB

/*  '/test'
 *    GET: tests this server is operational
 */

app.get('/test', function (req, res) {
  // handleError(res, err.message, 'Failed to get generic item.');
  res.status(200).json(
    {
      'result': 'success',
      'message': 'GET /test endpoint is working'
    }
  );
});

app.get('/run', function (req, res) {
  if (!req.query.api_key) {
    console.error('/run api_key not supplied');
    res.json({
      status: '401',
      error: 'api_key error',
      message: 'api_key not supplied'
    });
    return;
  } else if (req.query.api_key.localeCompare(process.env.API_KEY) !== 0) {
    console.error('/run api_key not supplied');
    res.json({
      status: '401',
      error: 'api_key error',
      message: 'api_key incorrect'
    });
    return;
  }
  // else api_key is corrected
  res.json({
    status: '200',
    message: 'running bot'
  });
  var files = ['update.js', 'bot.js', 'flag.js'];
  var loopFunc = function () {
    var file = files.pop();
    if (file !== undefined && file !== null) {
      startChildProcess('node', file, loopFunc);
    } else {
      console.log('FINISHED RUNNING SCRIPTS');
      setTimeout(function () {
        process.exit();
      }, 5000);
    }
  };
  startChildProcess('node', files.pop(), loopFunc);
});

function startChildProcess (proc, arg, callback) {
  var child = require('child_process').spawn(proc, [arg]);

  child.stdout.on('data', function (data) {
    console.log('stdout: ' + data);
  });
  child.stderr.on('data', function (data) {
    console.log('stderr: ' + data);
  });
  child.on('close', function (code) {
    console.log('child process exited with code ' + code);
    callback();
  });
}

// Start server
app.listen(app.get('port'), function () {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;
