'use strict';

const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const lib = require('./lib.js');

var app = express();
app.set('port', process.env.PORT || 5000);
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json());

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
  exec('node update.js && node bot.js && node flag.js', (err, stdout, stderr) => {
    if (err) {
      console.log('Run bot failed');
      console.error(err);
      return;
    }
    console.log('*** ERRORS *** (we expect node install errors because of weird request lib install)');
    console.log(`stderr: ${stderr}`);
    console.log('*** General bot run output ***');
    console.log(`stdout: ${stdout}`);
    console.log('Run bot finished');
  });
});

app.get('/laststats', function (req, res) {
  lib.getRecordFromDb(lib.DB_GENERAL, {}, function (err, data) {
    if (err || data === undefined || data === null ||
        data.last_stats === undefined || data.last_stats === null) {
      res.json({
        status: '500',
        error: 'internal error',
        message: 'couldnt get last stats from db'
      });
      console.log('/laststats error, couldnt get last stats from db');
      return;
    }
    res.json(data.last_stats);
    console.log('/laststats success, returned last stats from general DB');
  });
});

// Start server
app.listen(app.get('port'), function () {
  lib.startWithoutSteem(function () {
    console.log('Node app is running on port', app.get('port'));
  });
});

module.exports = app;
