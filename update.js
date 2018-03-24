'use strict';

const moment = require('moment');
const wait = require('wait.for');
const lib = require('./lib.js');

function main () {
  lib.start(function () {
    doProcess(function () {
      console.log('Finished');
      setTimeout(function () {
        process.exit();
      }, 5000);
    });
  });
}

function doProcess (callback) {
  wait.launchFiber(function () {
    var headBlock = wait.for(lib.getBlockHeader, lib.getProperties().head_block_number);
    var latestBlockMoment = moment(headBlock.timestamp, moment.ISO_8601);
    if (lib.getLastInfos().update_time === undefined ||
        lib.getLastInfos().update_time === null) {
      console.log('* Update time not defined, dont know when to update, fix by running scrape_and_queue.js');
      callback();
      return;
    }
    var updateTimeMoment = moment(lib.getLastInfos().update_time, moment.ISO_8601);

    if (updateTimeMoment.isBefore(latestBlockMoment)) {
      console.log('*** UPDATING FLAGLIST FROM QUEUE ***');
      // update
      var queue = wait.for(lib.getAllRecordsFromDb, lib.DB_QUEUE);
      if (queue === undefined || queue === null || queue.length === 0) {
        console.log('Nothing in queue! Exiting');
        callback();
        return;
      }
      queue.sort(function (a, b) {
        return b.total_extrapolated_roi - a.total_extrapolated_roi;
      });
      wait.for(lib.dropDb, lib.DB_FLAGLIST);
      for (var i = 0; i < queue.length; i++) {
        wait.for(lib.saveDb, lib.DB_FLAGLIST, queue[i]);
      }
      // make new update time
      lib.getLastInfos().update_time = moment(new Date()).add(Number(process.env.DAYS_UNTIL_UPDATE), 'day').toISOString();
      wait.for(lib.saveDb, lib.DB_RECORDS, lib.getLastInfos());
    } else {
      console.log('* Not updating flag list, not time to update yet');
    }
    callback();
  });
}

// START THIS SCRIPT
main();
